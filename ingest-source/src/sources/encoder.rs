//! Encoder source: SRTLA relay that accepts bonded streams from uplink-core encoders.
//!
//! Listens for SRTLA connections on `srtla_listen_port`.
//! Re-assembles the bonded SRT stream and makes it available on `internal_port`
//! as a plain SRT listener, so destination workers can connect as SRT callers.

use anyhow::{Context, Result};
use log::{debug, info, warn};
use rand::RngCore;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::time::Instant;
use tokio::net::UdpSocket;
use tokio::time::{self, Duration};

use crate::EncoderConfig;

// SRTLA protocol constants
const SRTLA_ID_LEN: usize = 256;
const SRTLA_ID_HALF: usize = 128;
const MAX_PACKET_SIZE: usize = 1500;
const RECV_ACK_INT: usize = 10;
const MAX_CONNS_PER_GROUP: usize = 8;
const MAX_GROUPS: usize = 200;
const CONN_TIMEOUT: Duration = Duration::from_secs(10);
const GROUP_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u16)]
enum SrtlaType {
    Keepalive = 0x9000,
    Ack       = 0x9100,
    Reg1      = 0x9200,
    Reg2      = 0x9201,
    Reg3      = 0x9202,
    RegErr    = 0x9210,
    RegNgp    = 0x9211,
}

impl SrtlaType {
    fn from_u16(v: u16) -> Option<Self> {
        match v {
            0x9000 => Some(Self::Keepalive),
            0x9100 => Some(Self::Ack),
            0x9200 => Some(Self::Reg1),
            0x9201 => Some(Self::Reg2),
            0x9202 => Some(Self::Reg3),
            0x9210 => Some(Self::RegErr),
            0x9211 => Some(Self::RegNgp),
            _ => None,
        }
    }
}

fn parse_type(data: &[u8]) -> Option<SrtlaType> {
    if data.len() < 2 { return None; }
    SrtlaType::from_u16(u16::from_be_bytes([data[0], data[1]]))
}

fn parse_id(data: &[u8]) -> Option<[u8; SRTLA_ID_LEN]> {
    if data.len() < 2 + SRTLA_ID_LEN { return None; }
    let mut id = [0u8; SRTLA_ID_LEN];
    id.copy_from_slice(&data[2..2 + SRTLA_ID_LEN]);
    Some(id)
}

fn build_reg2(sender_id: &[u8], receiver_random: &[u8; SRTLA_ID_HALF]) -> Vec<u8> {
    let mut pkt = Vec::with_capacity(2 + SRTLA_ID_LEN);
    pkt.extend_from_slice(&(SrtlaType::Reg2 as u16).to_be_bytes());
    pkt.extend_from_slice(&sender_id[..SRTLA_ID_HALF]);
    pkt.extend_from_slice(receiver_random);
    pkt
}

fn build_reg3()    -> [u8; 2] { (SrtlaType::Reg3   as u16).to_be_bytes() }
fn build_reg_err() -> [u8; 2] { (SrtlaType::RegErr as u16).to_be_bytes() }
fn build_reg_ngp() -> [u8; 2] { (SrtlaType::RegNgp as u16).to_be_bytes() }
fn build_keepalive() -> [u8; 2] { (SrtlaType::Keepalive as u16).to_be_bytes() }

fn build_srtla_ack(seq_nums: &[u32]) -> Vec<u8> {
    let mut pkt = Vec::with_capacity(4 + seq_nums.len() * 4);
    let header: u32 = (SrtlaType::Ack as u32) << 16;
    pkt.extend_from_slice(&header.to_be_bytes());
    for &seq in seq_nums.iter().take(RECV_ACK_INT) {
        pkt.extend_from_slice(&seq.to_be_bytes());
    }
    pkt
}

fn srt_data_seq(data: &[u8]) -> Option<u32> {
    if data.len() < 4 { return None; }
    let first = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
    if first & 0x8000_0000 == 0 { Some(first) } else { None }
}

fn is_srt_ack(data: &[u8]) -> bool {
    data.len() >= 2 && u16::from_be_bytes([data[0], data[1]]) == 0x8002
}


struct SenderPath {
    addr: SocketAddr,
    last_seen: Instant,
    recv_seqs: Vec<u32>,
}

struct ConnectionGroup {
    full_id: [u8; SRTLA_ID_LEN],
    paths: Vec<SenderPath>,
    srt_socket: Option<UdpSocket>,
    srt_downstream: SocketAddr,
    last_active: Instant,
    last_addr: SocketAddr,
}

impl ConnectionGroup {
    fn find_path(&self, addr: &SocketAddr) -> Option<usize> {
        self.paths.iter().position(|p| p.addr == *addr)
    }

    fn add_path(&mut self, addr: SocketAddr) -> bool {
        if self.paths.len() >= MAX_CONNS_PER_GROUP {
            warn!("max connections per group reached, rejecting {addr}");
            return false;
        }
        if self.find_path(&addr).is_none() {
            self.paths.push(SenderPath {
                addr,
                last_seen: Instant::now(),
                recv_seqs: Vec::with_capacity(RECV_ACK_INT),
            });
        }
        true
    }
}

struct RelayState {
    socket: UdpSocket,
    srt_forward_addr: SocketAddr,
    groups: HashMap<[u8; SRTLA_ID_LEN], ConnectionGroup>,
    addr_to_id: HashMap<SocketAddr, [u8; SRTLA_ID_LEN]>,
}

impl RelayState {
    async fn handle_packet(&mut self, data: &[u8], from: SocketAddr) {
        if let Some(srtla_type) = parse_type(data) {
            self.handle_srtla_control(srtla_type, data, from).await;
            return;
        }

        let Some(group_id) = self.addr_to_id.get(&from) else {
            debug!("dropping packet from unregistered {from}");
            return;
        };
        let group_id = *group_id;
        let Some(group) = self.groups.get_mut(&group_id) else { return; };

        group.last_active = Instant::now();
        group.last_addr = from;

        if let Some(seq) = srt_data_seq(data) {
            if let Some(path_idx) = group.find_path(&from) {
                group.paths[path_idx].last_seen = Instant::now();
                group.paths[path_idx].recv_seqs.push(seq);
                if group.paths[path_idx].recv_seqs.len() >= RECV_ACK_INT {
                    let seqs: Vec<u32> = group.paths[path_idx].recv_seqs.drain(..).collect();
                    let ack = build_srtla_ack(&seqs);
                    let _ = self.socket.send_to(&ack, from).await;
                }
            }
        }

        if group.srt_socket.is_none() {
            match UdpSocket::bind("0.0.0.0:0").await {
                Ok(sock) => group.srt_socket = Some(sock),
                Err(e) => { warn!("failed to create downstream socket: {e}"); return; }
            }
        }
        if let Some(srt_sock) = &group.srt_socket {
            let _ = srt_sock.send_to(data, group.srt_downstream).await;
        }
    }

    async fn handle_srtla_control(&mut self, srtla_type: SrtlaType, data: &[u8], from: SocketAddr) {
        match srtla_type {
            SrtlaType::Reg1 => {
                if self.groups.len() >= MAX_GROUPS {
                    let _ = self.socket.send_to(&build_reg_err(), from).await;
                    return;
                }
                let Some(sender_id) = parse_id(data) else { return; };
                let mut receiver_half = [0u8; SRTLA_ID_HALF];
                rand::thread_rng().fill_bytes(&mut receiver_half);
                let mut full_id = [0u8; SRTLA_ID_LEN];
                full_id[..SRTLA_ID_HALF].copy_from_slice(&sender_id[..SRTLA_ID_HALF]);
                full_id[SRTLA_ID_HALF..].copy_from_slice(&receiver_half);
                info!("REG1 from {from}: creating group");
                let group = ConnectionGroup {
                    full_id,
                    paths: Vec::new(),
                    srt_socket: None,
                    srt_downstream: self.srt_forward_addr,
                    last_active: Instant::now(),
                    last_addr: from,
                };
                self.groups.insert(full_id, group);
                let reg2 = build_reg2(&sender_id, &receiver_half);
                let _ = self.socket.send_to(&reg2, from).await;
                info!("REG2 sent to {from}");
            }
            SrtlaType::Reg2 => {
                let Some(full_id) = parse_id(data) else { return; };
                // The HashMap lookup already validates the full_id (sender-half +
                // server-random-half).  A missing entry means the group was never
                // created (no prior REG1) or has expired, so reply NGP.
                if let Some(group) = self.groups.get_mut(&full_id) {
                    if group.add_path(from) {
                        self.addr_to_id.insert(from, full_id);
                        info!("REG2 from {from}: path added to group");
                        let _ = self.socket.send_to(&build_reg3(), from).await;
                    } else {
                        let _ = self.socket.send_to(&build_reg_err(), from).await;
                    }
                } else {
                    let _ = self.socket.send_to(&build_reg_ngp(), from).await;
                }
            }
            SrtlaType::Keepalive => {
                let _ = self.socket.send_to(&build_keepalive(), from).await;
                if let Some(gid) = self.addr_to_id.get(&from) {
                    if let Some(g) = self.groups.get_mut(gid) {
                        if let Some(idx) = g.find_path(&from) {
                            g.paths[idx].last_seen = Instant::now();
                        }
                        g.last_active = Instant::now();
                    }
                }
            }
            _ => {
                debug!("unexpected SRTLA {:?} from {from}", srtla_type);
            }
        }
    }

    async fn recv_downstream_responses(&self, buf: &mut [u8]) {
        for group in self.groups.values() {
            if let Some(srt_sock) = &group.srt_socket {
                match srt_sock.try_recv(buf) {
                    Ok(len) => {
                        let data = &buf[..len];
                        if is_srt_ack(data) {
                            for path in &group.paths {
                                let _ = self.socket.send_to(data, path.addr).await;
                            }
                        } else {
                            let _ = self.socket.send_to(data, group.last_addr).await;
                        }
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(e) => debug!("downstream recv: {e}"),
                }
            }
        }
        tokio::task::yield_now().await;
    }

    fn cleanup_stale(&mut self) {
        let mut stale = Vec::new();
        let mut empty = Vec::new();
        for (id, group) in &mut self.groups {
            group.paths.retain(|p| {
                if p.last_seen.elapsed() > CONN_TIMEOUT {
                    info!("removing stale path {}", p.addr);
                    stale.push(p.addr);
                    false
                } else {
                    true
                }
            });
            if group.paths.is_empty() && group.last_active.elapsed() > GROUP_TIMEOUT {
                info!("removing empty group");
                empty.push(*id);
            }
        }
        for addr in stale { self.addr_to_id.remove(&addr); }
        for id in empty { self.groups.remove(&id); }
    }
}

pub async fn run(id: String, internal_port: u16, config: EncoderConfig) -> Result<()> {
    let srtla_addr: SocketAddr = format!("0.0.0.0:{}", config.srtla_listen_port).parse()?;
    // Destination workers connect as SRT callers to internal_port.
    // The relay forwards raw SRT UDP packets to 127.0.0.1:internal_port.
    let srt_forward_addr: SocketAddr = format!("127.0.0.1:{}", internal_port).parse()?;

    info!(
        "[{id}] encoder source: SRTLA relay on {srtla_addr} → forwarding SRT to {srt_forward_addr}"
    );

    let socket = UdpSocket::bind(srtla_addr)
        .await
        .with_context(|| format!("failed to bind SRTLA on {srtla_addr}"))?;

    let mut relay = RelayState {
        socket,
        srt_forward_addr,
        groups: HashMap::new(),
        addr_to_id: HashMap::new(),
    };

    let mut sigterm = tokio::signal::unix::signal(
        tokio::signal::unix::SignalKind::terminate()
    ).context("failed to install SIGTERM handler")?;

    let mut cleanup_timer = time::interval(Duration::from_secs(10));
    let mut buf = [0u8; MAX_PACKET_SIZE];
    let mut downstream_buf = [0u8; MAX_PACKET_SIZE];

    loop {
        tokio::select! {
            result = relay.socket.recv_from(&mut buf) => {
                let (len, from) = result.context("recv failed")?;
                relay.handle_packet(&buf[..len], from).await;
            }
            _ = relay.recv_downstream_responses(&mut downstream_buf) => {}
            _ = cleanup_timer.tick() => {
                relay.cleanup_stale();
            }
            _ = tokio::signal::ctrl_c() => {
                info!("[{id}] shutting down (SIGINT)");
                break;
            }
            _ = sigterm.recv() => {
                info!("[{id}] shutting down (SIGTERM)");
                break;
            }
        }
    }

    Ok(())
}
