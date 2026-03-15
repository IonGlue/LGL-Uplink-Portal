import { useState, useEffect, useRef } from "react";
import { api, ApiError, Device, LiveTelemetry, DeviceConfig, BondPath, DeviceConfigSnapshot, VideoOutputDeviceInfo } from "../api";

interface Props {
  device: Device;
  onClose: () => void;
  onNicknameChange?: (id: string, nickname: string | null) => void;
  onDeviceArchived?: () => void;
  onDeviceDeleted?: () => void;
  isAdmin: boolean;
}

const PIPELINES = [
  { value: "h264_v4l2_usb", label: "H.264 V4L2 USB" },
  { value: "h265_v4l2_usb", label: "H.265 V4L2 USB" },
  { value: "h264_qsv",      label: "H.264 Intel QSV" },
];

const RESOLUTIONS = ["1920x1080", "1280x720", "854x480", "640x360"];

const SMPTE_RATES = [
  { value: "23.976", label: "23.976 fps" },
  { value: "24",     label: "24 fps" },
  { value: "25",     label: "25 fps (PAL)" },
  { value: "29.97",  label: "29.97 fps (NTSC)" },
  { value: "30",     label: "30 fps" },
  { value: "50",     label: "50 fps" },
  { value: "59.94",  label: "59.94 fps" },
  { value: "60",     label: "60 fps" },
];

function formatUptime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function Stat({ label, value, unit }: { label: string; value: string | number; unit?: string }) {
  return (
    <div className="stat-cell">
      <span className="stat-label">{label}</span>
      <span className="stat-value">
        {value}{unit && <span className="stat-unit"> {unit}</span>}
      </span>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="settings-section-title">{children}</h3>;
}

/** Seed config form from telemetry config snapshot. */
function configFromSnapshot(snap: DeviceConfigSnapshot): DeviceConfig {
  return {
    capture_device: snap.capture_device,
    pipeline: snap.pipeline_variant,
    framerate: snap.framerate,
    bitrate_min_kbps: snap.bitrate_min_kbps,
    bitrate_max_kbps: snap.bitrate_max_kbps,
    srt_host: snap.srt_host,
    srt_port: snap.srt_port,
    srt_latency_ms: snap.srt_latency_ms,
    // Don't pre-fill passphrase — device never sends the actual value.
    // The form starts blank; entering a value changes it, leaving blank = no change.
    bond_enabled: snap.bond_enabled,
    bond_relay_host: snap.bond_relay_host ?? undefined,
    bond_relay_port: snap.bond_relay_port ?? undefined,
    bond_local_port: snap.bond_local_port ?? undefined,
    bond_keepalive_ms: snap.bond_keepalive_ms ?? undefined,
  };
}

export default function DeviceDetail({ device, onClose, onNicknameChange, onDeviceArchived, onDeviceDeleted, isAdmin }: Props) {
  const [telemetry, setTelemetry] = useState<LiveTelemetry | null>(null);
  const [tab, setTab] = useState<"overview" | "network" | "settings" | "streaming" | "control">("overview");
  const [cmdBusy, setCmdBusy] = useState(false);
  const [cmdMsg, setCmdMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [config, setConfig] = useState<DeviceConfig>({});
  const [bondPaths, setBondPaths] = useState<BondPath[]>([]);
  const [configBusy, setConfigBusy] = useState(false);
  const [configMsg, setConfigMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Bitrate sliders (in streaming tab)
  const [targetBitrate, setTargetBitrate] = useState(8000);
  const [minBitrate, setMinBitrate] = useState(2000);
  const [bitrateBusy, setBitrateBusy] = useState(false);
  const [bitrateMsg, setBitrateMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // SRT URL paste — passphrase hint (not sent to device, shown for reference)
  const [srtPassphraseHint, setSrtPassphraseHint] = useState<string | null>(null);

  // Nickname editing
  const [nicknameDraft, setNicknameDraft] = useState(device.nickname ?? "");
  const [nicknameEditing, setNicknameEditing] = useState(false);
  const [nicknameBusy, setNicknameBusy] = useState(false);

  // Archive / delete
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [dangerMsg, setDangerMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const configSeeded = useRef(false);

  const isOffline = device.connection_status === "offline";

  // Live telemetry via WebSocket, REST fallback + immediate seed fetch
  useEffect(() => {
    // 1. Immediately fetch via REST to seed settings without waiting for WS
    api.liveTelemetry(device.id).then((t) => setTelemetry(t)).catch(() => {});

    // 2. Open WS for continuous live updates
    const url = api.telemetryStreamUrl(device.id);
    const ws = new WebSocket(url);
    wsRef.current = ws;
    let fallbackTimer: ReturnType<typeof setInterval> | null = null;

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "telemetry") setTelemetry(msg.data as LiveTelemetry);
      } catch { /* ignore */ }
    };

    ws.onerror = () => {
      fallbackTimer = setInterval(async () => {
        try { setTelemetry(await api.liveTelemetry(device.id)); } catch { /* ignore */ }
      }, 1000);
    };

    return () => {
      ws.close();
      if (fallbackTimer) clearInterval(fallbackTimer);
    };
  }, [device.id]);

  // Seed config form from first telemetry snapshot (includes full config)
  useEffect(() => {
    if (!telemetry || configSeeded.current) return;
    configSeeded.current = true;

    const snap = telemetry.config;
    if (snap) {
      setConfig({
        ...configFromSnapshot(snap),
        resolution: telemetry.encoder.resolution,
      });
      setBondPaths(snap.bond_paths.map((p) => ({ interface: p.interface, priority: p.priority })));
      setTargetBitrate(snap.bitrate_max_kbps);
      setMinBitrate(snap.bitrate_min_kbps);
    } else {
      setConfig({
        pipeline: telemetry.encoder.pipeline,
        resolution: telemetry.encoder.resolution,
      });
    }
  }, [telemetry]);

  async function sendCmd(cmd: object) {
    setCmdBusy(true);
    setCmdMsg(null);
    try {
      await api.claimControl(device.id).catch(() => {});
      await api.sendCommand(device.id, cmd);
      setCmdMsg({ ok: true, text: "Command sent." });
    } catch (e) {
      setCmdMsg({ ok: false, text: e instanceof ApiError ? e.message : "Command failed" });
    } finally {
      setCmdBusy(false);
    }
  }

  async function handleSaveConfig(e: React.FormEvent) {
    e.preventDefault();
    setConfigBusy(true);
    setConfigMsg(null);
    try {
      await api.claimControl(device.id).catch(() => {});
      const payload: DeviceConfig = {
        ...config,
        bond_paths: config.bond_enabled ? bondPaths : undefined,
      };
      await api.setConfig(device.id, payload);
      setConfigMsg({ ok: true, text: "Configuration applied — device is updating." });
    } catch (e) {
      setConfigMsg({ ok: false, text: e instanceof ApiError ? e.message : "Failed to save" });
    } finally {
      setConfigBusy(false);
    }
  }

  async function handleSaveStreaming(e: React.FormEvent) {
    e.preventDefault();
    setConfigBusy(true);
    setConfigMsg(null);
    try {
      await api.claimControl(device.id).catch(() => {});
      await api.setConfig(device.id, {
        srt_host: config.srt_host,
        srt_port: config.srt_port,
        srt_latency_ms: config.srt_latency_ms,
        // Send passphrase only when non-empty (empty = no change).
        // To CLEAR a passphrase use the dedicated Clear button.
        ...(config.srt_passphrase ? { srt_passphrase: config.srt_passphrase } : {}),
      });
      // Clear the passphrase input after save (don't keep plaintext in form)
      setConfig((c) => ({ ...c, srt_passphrase: undefined }));
      setSrtPassphraseHint(null);
      setConfigMsg({ ok: true, text: "Streaming destination updated." });
    } catch (e) {
      setConfigMsg({ ok: false, text: e instanceof ApiError ? e.message : "Failed to save" });
    } finally {
      setConfigBusy(false);
    }
  }

  async function handleApplyBitrate() {
    if (minBitrate > targetBitrate) {
      setBitrateMsg({ ok: false, text: "Min bitrate must be ≤ target bitrate." });
      return;
    }
    setBitrateBusy(true);
    setBitrateMsg(null);
    try {
      await api.claimControl(device.id).catch(() => {});
      await api.sendCommand(device.id, {
        cmd: "set_bitrate_range",
        min_kbps: minBitrate,
        max_kbps: targetBitrate,
      });
      setBitrateMsg({ ok: true, text: "Bitrate updated." });
    } catch (e) {
      setBitrateMsg({ ok: false, text: e instanceof ApiError ? e.message : "Failed" });
    } finally {
      setBitrateBusy(false);
    }
  }

  async function handleSaveNickname() {
    setNicknameBusy(true);
    try {
      const name = nicknameDraft.trim() || null;
      await api.updateNickname(device.id, name);
      setNicknameEditing(false);
      onNicknameChange?.(device.id, name);
    } catch {
      // ignore — nickname update failure is non-critical
    } finally {
      setNicknameBusy(false);
    }
  }

  async function handleArchive() {
    setArchiveBusy(true);
    setDangerMsg(null);
    try {
      if (device.archived) {
        await api.unarchiveDevice(device.id);
        setDangerMsg({ ok: true, text: "Device restored from archive." });
      } else {
        await api.archiveDevice(device.id);
        setDangerMsg({ ok: true, text: "Device archived." });
      }
      onDeviceArchived?.();
    } catch (e) {
      setDangerMsg({ ok: false, text: e instanceof ApiError ? e.message : "Failed" });
    } finally {
      setArchiveBusy(false);
    }
  }

  async function handleDelete() {
    setDeleteBusy(true);
    setDangerMsg(null);
    try {
      await api.deleteDevice(device.id);
      onDeviceDeleted?.();
      onClose();
    } catch (e) {
      setDangerMsg({ ok: false, text: e instanceof ApiError ? e.message : "Failed to delete" });
    } finally {
      setDeleteBusy(false);
    }
  }

  function addPath() {
    setBondPaths([...bondPaths, { interface: "", priority: 1 }]);
  }

  function removePath(i: number) {
    setBondPaths(bondPaths.filter((_, idx) => idx !== i));
  }

  function updatePath(i: number, field: keyof BondPath, value: string | number) {
    setBondPaths(bondPaths.map((p, idx) => idx === i ? { ...p, [field]: value } : p));
  }

  const cs = device.connection_status;
  const statusLabel =
    cs === "streaming" ? "Streaming"
    : cs === "connecting" ? "Connecting"
    : cs === "online" ? "Online"
    : "Offline";

  const captureDevices = telemetry?.available_capture_devices ?? [];
  const ifaces = telemetry?.available_interfaces ?? [];
  const ifaceNames = ifaces.map((i) => i.name);
  const videoOutputs: VideoOutputDeviceInfo[] = telemetry?.available_video_outputs ?? [];

  /** Parse an SRT URL like srt://host:port?passphrase=xxx and populate config fields.
   *  Returns the passphrase string if present (for display), or null. */
  function parseSrtUrl(raw: string): string | null {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("srt://")) return null;
    try {
      const u = new URL("https://" + trimmed.slice(6));
      const host = u.hostname;
      const port = u.port ? Number(u.port) : undefined;
      const passphrase = u.searchParams.get("passphrase");
      setConfig((c) => ({
        ...c,
        ...(host ? { srt_host: host } : {}),
        ...(port ? { srt_port: port } : {}),
        ...(passphrase ? { srt_passphrase: passphrase } : {}),
      }));
      setSrtPassphraseHint(passphrase);
      return passphrase;
    } catch {
      return null;
    }
  }

  const displayName = device.nickname?.trim() || device.hostname;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="modal-header">
          <div className="modal-title-block">
            <div className="modal-title-row">
              <span className={`status-dot dot-${cs}`} />
              {nicknameEditing ? (
                <div className="nickname-edit-row">
                  <input
                    className="text-input nickname-input"
                    type="text"
                    placeholder={device.hostname}
                    value={nicknameDraft}
                    onChange={(e) => setNicknameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); handleSaveNickname(); }
                      if (e.key === "Escape") setNicknameEditing(false);
                    }}
                    maxLength={100}
                    autoFocus
                  />
                  <button className="btn btn-primary nickname-save-btn" onClick={handleSaveNickname} disabled={nicknameBusy}>
                    {nicknameBusy ? "…" : "Save"}
                  </button>
                  <button className="btn btn-secondary nickname-save-btn" onClick={() => { setNicknameEditing(false); setNicknameDraft(device.nickname ?? ""); }}>
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  <h2 className="modal-title">{displayName}</h2>
                  {device.nickname && (
                    <span className="modal-hostname-sub">{device.hostname}</span>
                  )}
                  {isAdmin && (
                    <button className="btn-icon-ghost" title="Edit name" onClick={() => setNicknameEditing(true)}>Edit</button>
                  )}
                </>
              )}
              <span className={`state-badge state-${cs}`}>{statusLabel}</span>
              {isOffline && (
                <span className="modal-offline-badge">Offline</span>
              )}
            </div>
          </div>
          <button className="modal-close" onClick={onClose}>x</button>
        </div>

        {/* Offline banner */}
        {isOffline && (
          <div className="modal-offline-strip">
            <span>Device offline — last seen {device.last_seen_at
              ? new Date(device.last_seen_at).toLocaleString()
              : "never"}. Settings shown are last known values.</span>
          </div>
        )}

        {/* Tabs */}
        <div className="modal-tabs">
          {(["overview", "network", "settings", "streaming", "control"] as const).map((t) => (
            <button key={t} className={`tab-btn ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        <div className="modal-body">

          {/* ── Overview ──────────────────────────────────────────── */}
          {tab === "overview" && (
            <div className="stat-grid">
              <Stat label="Device ID"  value={device.device_id.slice(0, 16) + "…"} />
              <Stat label="Version"    value={device.version} />
              <Stat label="Status"     value={statusLabel} />
              {telemetry ? <>
                <Stat label="Uptime"          value={formatUptime(telemetry.uptime_secs)} />
                <Stat label="Pipeline"        value={telemetry.encoder.pipeline} />
                <Stat label="Resolution"      value={telemetry.encoder.resolution} />
                <Stat label="Encoder bitrate" value={telemetry.encoder.bitrate_kbps.toLocaleString()} unit="kbps" />
                <Stat label="FPS"             value={telemetry.encoder.fps.toFixed(1)} />
                <Stat label="Paths active"    value={telemetry.paths.length} />
                <Stat label="Total bitrate"   value={telemetry.paths.reduce((s, p) => s + p.bitrate_kbps, 0).toLocaleString()} unit="kbps" />
                {telemetry.age_ms !== undefined && (
                  <Stat label="Data age" value={telemetry.age_ms} unit="ms" />
                )}
                {telemetry.config && <>
                  <Stat label="Capture device"  value={telemetry.config.capture_device} />
                  <Stat label="Framerate"        value={telemetry.config.framerate} unit="fps" />
                  <Stat label="Target bitrate"   value={telemetry.config.bitrate_max_kbps.toLocaleString()} unit="kbps" />
                  <Stat label="Min bitrate"      value={telemetry.config.bitrate_min_kbps.toLocaleString()} unit="kbps" />
                  <Stat label="SRT destination"  value={`${telemetry.config.srt_host}:${telemetry.config.srt_port}`} />
                  <Stat label="Bonding"          value={telemetry.config.bond_enabled ? "Enabled" : "Disabled"} />
                </>}
              </> : (
                <div className="no-telemetry-row">
                  {isOffline
                    ? <p className="status-msg offline-hint">Device is offline — no live data available.</p>
                    : <p className="status-msg">Waiting for telemetry from device…</p>}
                </div>
              )}
            </div>
          )}

          {/* ── Network ───────────────────────────────────────────── */}
          {tab === "network" && (
            <div>
              {/* Available interfaces */}
              {ifaces.length > 0 ? (
                <>
                  <SectionTitle>Network Interfaces</SectionTitle>
                  <table className="data-table" style={{ marginBottom: 24 }}>
                    <thead>
                      <tr>
                        <th>Interface</th>
                        <th>IP Addresses</th>
                        <th>MAC</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ifaces.map((iface) => (
                        <tr key={iface.name}>
                          <td className="mono">{iface.name}</td>
                          <td className="mono" style={{ fontSize: 12 }}>
                            {iface.ip_addresses.length > 0
                              ? iface.ip_addresses.join(", ")
                              : <span style={{ color: "var(--text-dim)" }}>—</span>}
                          </td>
                          <td className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                            {iface.mac_address ?? "—"}
                          </td>
                          <td>
                            <span className={iface.is_up ? "iface-up" : "iface-down"}>
                              {iface.is_up ? "Up" : "Down"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              ) : telemetry ? (
                <p className="status-msg" style={{ paddingBottom: 16 }}>
                  No interface data in this firmware version.
                </p>
              ) : null}

              {/* Active bond paths */}
              {telemetry ? (
                telemetry.paths.length > 0 ? (
                  <>
                    <SectionTitle>Active Bond Paths</SectionTitle>
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Interface</th><th>Bitrate</th><th>RTT</th>
                          <th>Loss</th><th>In-flight</th><th>Window</th>
                        </tr>
                      </thead>
                      <tbody>
                        {telemetry.paths.map((p) => (
                          <tr key={p.interface}>
                            <td className="mono">{p.interface}</td>
                            <td>{p.bitrate_kbps.toLocaleString()} kbps</td>
                            <td className={p.rtt_ms > 100 ? "val-warn" : ""}>{p.rtt_ms.toFixed(1)} ms</td>
                            <td className={p.loss_pct > 1 ? "val-warn" : ""}>{p.loss_pct.toFixed(2)}%</td>
                            <td>{p.in_flight}</td>
                            <td>{p.window.toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="stat-grid" style={{ marginTop: 16 }}>
                      <Stat label="Total bitrate" value={telemetry.paths.reduce((s, p) => s + p.bitrate_kbps, 0).toLocaleString()} unit="kbps" />
                      <Stat label="Active paths"  value={telemetry.paths.length} />
                    </div>
                  </>
                ) : (
                  <p className="status-msg">
                    No active bond paths — streaming directly via SRT or encoder is idle.
                  </p>
                )
              ) : (
                !ifaces.length && (
                  <p className="status-msg">
                    {isOffline ? "Device is offline — no network data." : "Waiting for telemetry…"}
                  </p>
                )
              )}

              {/* Video output connectors */}
              {videoOutputs.length > 0 && (
                <>
                  <SectionTitle>Video Output</SectionTitle>
                  <table className="data-table" style={{ marginBottom: 8 }}>
                    <thead>
                      <tr>
                        <th>Connector</th>
                        <th>Type</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {videoOutputs.map((o) => (
                        <tr key={o.name}>
                          <td className="mono">{o.name}</td>
                          <td>{o.connector_type}</td>
                          <td>
                            <span className={o.connected ? "iface-up" : "iface-down"}>
                              {o.connected ? "Connected" : "No display"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}

          {/* ── Settings ──────────────────────────────────────────── */}
          {tab === "settings" && (
            !telemetry ? (
              <div className="no-telemetry-row">
                <p className="status-msg">
                  {isOffline
                    ? "Device is offline — settings unavailable."
                    : "Loading device configuration…"}
                </p>
              </div>
            ) : (
            <form className="settings-form" onSubmit={handleSaveConfig}>

              {/* Video input */}
              <SectionTitle>Video Input</SectionTitle>
              <div className="settings-grid">
                <div className="field">
                  <label>Capture device</label>
                  {captureDevices.length > 0 ? (
                    <select className="select-input"
                      value={config.capture_device ?? ""}
                      onChange={(e) => setConfig({ ...config, capture_device: e.target.value || undefined })}>
                      <option value="">— select device —</option>
                      {captureDevices.map((d) => (
                        <option key={d.path} value={d.path}>{d.name} ({d.path})</option>
                      ))}
                      {config.capture_device && !captureDevices.some((d) => d.path === config.capture_device) && (
                        <option value={config.capture_device}>{config.capture_device} (current)</option>
                      )}
                    </select>
                  ) : (
                    <input className="text-input" type="text" placeholder="/dev/video0"
                      value={config.capture_device ?? ""}
                      onChange={(e) => setConfig({ ...config, capture_device: e.target.value || undefined })} />
                  )}
                </div>
                <div className="field">
                  <label>Pipeline</label>
                  <select className="select-input" value={config.pipeline ?? ""}
                    onChange={(e) => setConfig({ ...config, pipeline: e.target.value || undefined })}>
                    {PIPELINES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                    {config.pipeline && !PIPELINES.some((p) => p.value === config.pipeline) && (
                      <option value={config.pipeline}>{config.pipeline}</option>
                    )}
                  </select>
                </div>
                <div className="field">
                  <label>Resolution</label>
                  <select className="select-input" value={config.resolution ?? ""}
                    onChange={(e) => setConfig({ ...config, resolution: e.target.value || undefined })}>
                    {RESOLUTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
                    {config.resolution && !RESOLUTIONS.includes(config.resolution) && (
                      <option value={config.resolution}>{config.resolution}</option>
                    )}
                  </select>
                </div>
                <div className="field">
                  <label>Framerate</label>
                  <select className="select-input"
                    value={config.framerate ?? ""}
                    onChange={(e) => setConfig({ ...config, framerate: e.target.value || undefined })}>
                    {SMPTE_RATES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                    {config.framerate && !SMPTE_RATES.some((r) => r.value === config.framerate) && (
                      <option value={config.framerate}>{config.framerate}</option>
                    )}
                  </select>
                </div>
              </div>

              {/* Bonding */}
              <SectionTitle>Bonding</SectionTitle>
              <div className="settings-grid">
                <div className="field field-toggle">
                  <label>Enable bonding</label>
                  <label className="toggle">
                    <input type="checkbox"
                      checked={config.bond_enabled ?? false}
                      onChange={(e) => setConfig({ ...config, bond_enabled: e.target.checked })} />
                    <span className="toggle-track" />
                  </label>
                </div>
                <div className="field">
                  <label>Relay host</label>
                  <input className="text-input" type="text" placeholder="relay.example.com"
                    value={config.bond_relay_host ?? ""}
                    onChange={(e) => setConfig({ ...config, bond_relay_host: e.target.value || undefined })} />
                </div>
                <div className="field">
                  <label>Relay port</label>
                  <input className="text-input" type="number" min={1} max={65535} placeholder="5000"
                    value={config.bond_relay_port ?? ""}
                    onChange={(e) => setConfig({ ...config, bond_relay_port: e.target.value ? Number(e.target.value) : undefined })} />
                </div>
                <div className="field">
                  <label>Local handoff port</label>
                  <input className="text-input" type="number" min={1} max={65535} placeholder="6000"
                    value={config.bond_local_port ?? ""}
                    onChange={(e) => setConfig({ ...config, bond_local_port: e.target.value ? Number(e.target.value) : undefined })} />
                </div>
                <div className="field">
                  <label>Keepalive (ms)</label>
                  <input className="text-input" type="number" min={100} max={10000} placeholder="1000"
                    value={config.bond_keepalive_ms ?? ""}
                    onChange={(e) => setConfig({ ...config, bond_keepalive_ms: e.target.value ? Number(e.target.value) : undefined })} />
                </div>
              </div>

              {/* Bond paths */}
              {config.bond_enabled && (
                <>
                  <SectionTitle>Bond Paths</SectionTitle>
                  <p className="settings-hint">
                    List all network interfaces to bond. Lower priority = preferred.
                    Equal priority paths share traffic.
                  </p>
                  <div className="bond-paths">
                    {bondPaths.map((p, i) => (
                      <div key={i} className="bond-path-row">
                        <div className="field" style={{ flex: 2 }}>
                          {i === 0 && <label>Interface</label>}
                          {ifaceNames.length > 0 ? (
                            <select className="select-input"
                              value={p.interface}
                              onChange={(e) => updatePath(i, "interface", e.target.value)}>
                              <option value="">— select interface —</option>
                              {ifaceNames.map((name) => (
                                <option key={name} value={name}>{name}</option>
                              ))}
                              {p.interface && !ifaceNames.includes(p.interface) && (
                                <option value={p.interface}>{p.interface} (current)</option>
                              )}
                            </select>
                          ) : (
                            <input className="text-input" type="text" placeholder="eth0 / usb0 / wlan0"
                              value={p.interface}
                              onChange={(e) => updatePath(i, "interface", e.target.value)} />
                          )}
                        </div>
                        <div className="field" style={{ flex: 1 }}>
                          {i === 0 && <label>Priority</label>}
                          <input className="text-input" type="number" min={1} max={10} placeholder="1"
                            value={p.priority}
                            onChange={(e) => updatePath(i, "priority", Number(e.target.value))} />
                        </div>
                        <button type="button" className="btn-remove-path" onClick={() => removePath(i)}>x</button>
                      </div>
                    ))}
                    <button type="button" className="btn btn-secondary" style={{ width: "auto", marginTop: 4 }}
                      onClick={addPath}>
                      + Add interface
                    </button>
                  </div>
                </>
              )}

              {/* Save */}
              {configMsg && (
                <p className={configMsg.ok ? "cmd-success" : "cmd-error"}>{configMsg.text}</p>
              )}
              <div className="settings-actions">
                {isAdmin ? (
                  <button type="submit" className="btn btn-primary" style={{ width: "auto" }}
                    disabled={configBusy || isOffline}>
                    {configBusy ? "Applying…" : "Apply to device"}
                  </button>
                ) : (
                  <p className="status-msg">Admin role required to change settings.</p>
                )}
              </div>

            </form>
            )
          )}

          {/* ── Streaming ─────────────────────────────────────────── */}
          {tab === "streaming" && (
            <div className="settings-form">

              {/* Bitrate */}
              <SectionTitle>Bitrate</SectionTitle>
              <p className="settings-hint">
                The encoder targets the maximum bitrate and adapts down to the minimum when the network is congested.
              </p>
              <div className="slider-group">
                <div className="slider-row">
                  <label>Target bitrate</label>
                  <div className="slider-value-row">
                    <input type="range" className="bitrate-slider"
                      min={1000} max={40000} step={100}
                      value={targetBitrate}
                      onChange={(e) => setTargetBitrate(Number(e.target.value))} />
                    <span className="slider-value">{(targetBitrate / 1000).toFixed(1)} Mbps</span>
                  </div>
                </div>
                <div className="slider-row">
                  <label>Minimum bitrate</label>
                  <div className="slider-value-row">
                    <input type="range" className="bitrate-slider"
                      min={1000} max={40000} step={100}
                      value={minBitrate}
                      onChange={(e) => setMinBitrate(Number(e.target.value))} />
                    <span className="slider-value">{(minBitrate / 1000).toFixed(1)} Mbps</span>
                  </div>
                </div>
              </div>
              {bitrateMsg && (
                <p className={bitrateMsg.ok ? "cmd-success" : "cmd-error"}>{bitrateMsg.text}</p>
              )}
              {isAdmin && (
                <div className="settings-actions">
                  <button className="btn btn-secondary" style={{ width: "auto" }}
                    disabled={bitrateBusy || isOffline}
                    onClick={handleApplyBitrate}>
                    {bitrateBusy ? "Applying…" : "Apply bitrate"}
                  </button>
                </div>
              )}

              {/* SRT destination */}
              <form onSubmit={handleSaveStreaming}>
                <SectionTitle>SRT Destination</SectionTitle>
                <p className="settings-hint">
                  The SRT ingest endpoint this device streams to. Used when bonding is disabled.
                  Configure the relay host in Settings → Bonding for multi-path bonding.
                </p>

                {/* SRT URL quick-paste */}
                <div className="field" style={{ marginBottom: 12 }}>
                  <label>Paste SRT URL</label>
                  <input className="text-input" type="text"
                    placeholder="srt://live.example.com:1234?passphrase=secret"
                    onPaste={(e) => {
                      const text = e.clipboardData.getData("text");
                      if (text.trim().startsWith("srt://")) {
                        e.preventDefault();
                        parseSrtUrl(text);
                      }
                    }}
                    onChange={(e) => {
                      if (e.target.value.trim().startsWith("srt://")) {
                        parseSrtUrl(e.target.value);
                        e.target.value = "";
                      }
                    }}
                  />
                  <span className="settings-hint" style={{ marginTop: 4 }}>
                    Paste an SRT URL to auto-fill host and port below.
                  </span>
                  {srtPassphraseHint && (
                    <p className="status-msg" style={{ marginTop: 4 }}>
                      Passphrase from URL auto-filled in the field below.
                    </p>
                  )}
                </div>

                <div className="settings-grid">
                  <div className="field">
                    <label>Host / IP</label>
                    <input className="text-input" type="text" placeholder="ingest.example.com"
                      value={config.srt_host ?? ""}
                      onChange={(e) => setConfig({ ...config, srt_host: e.target.value || undefined })} />
                  </div>
                  <div className="field">
                    <label>Port</label>
                    <input className="text-input" type="number" min={1} max={65535} placeholder="5000"
                      value={config.srt_port ?? ""}
                      onChange={(e) => setConfig({ ...config, srt_port: e.target.value ? Number(e.target.value) : undefined })} />
                  </div>
                  <div className="field">
                    <label>Latency (ms)</label>
                    <input className="text-input" type="number" min={20} max={8000} placeholder="200"
                      value={config.srt_latency_ms ?? ""}
                      onChange={(e) => setConfig({ ...config, srt_latency_ms: e.target.value ? Number(e.target.value) : undefined })} />
                  </div>
                  <div className="field">
                    <label>
                      Passphrase
                      {telemetry?.config?.srt_passphrase_set === true && (
                        <span className="settings-hint" style={{ marginLeft: 8, color: "var(--color-yellow, #EAB308)" }}>
                          currently set
                        </span>
                      )}
                      {telemetry?.config?.srt_passphrase_set === false && (
                        <span className="settings-hint" style={{ marginLeft: 8 }}>not set</span>
                      )}
                    </label>
                    <input className="text-input" type="password" placeholder="Leave blank to keep current"
                      value={config.srt_passphrase ?? ""}
                      onChange={(e) => setConfig({ ...config, srt_passphrase: e.target.value || undefined })}
                      autoComplete="new-password" />
                    <span className="settings-hint" style={{ marginTop: 4 }}>
                      10–79 characters. Leave blank to keep the current passphrase.
                      {telemetry?.config?.srt_passphrase_set && (
                        <> <button type="button" className="btn-link" style={{ marginLeft: 4 }}
                          onClick={() => setConfig({ ...config, srt_passphrase: "" })}>
                          Clear passphrase
                        </button></>
                      )}
                    </span>
                  </div>
                </div>

                <div className="protocol-note">
                  <span className="protocol-tag">SRT</span>
                  <span className="protocol-hint">More protocols coming soon (RTMP, RIST)</span>
                </div>

                {configMsg && (
                  <p className={configMsg.ok ? "cmd-success" : "cmd-error"}>{configMsg.text}</p>
                )}
                {isAdmin && (
                  <div className="settings-actions" style={{ marginTop: 12 }}>
                    <button type="submit" className="btn btn-primary" style={{ width: "auto" }}
                      disabled={configBusy || isOffline}>
                      {configBusy ? "Saving…" : "Save destination"}
                    </button>
                  </div>
                )}
              </form>

            </div>
          )}

          {/* ── Control ───────────────────────────────────────────── */}
          {tab === "control" && (
            <div>
              {isOffline && (
                <div className="control-offline-warning">
                  Device is offline — commands cannot be sent.
                </div>
              )}
              <div className="control-grid">
                <button className="btn btn-success" disabled={cmdBusy || isOffline}
                  onClick={() => sendCmd({ cmd: "start" })}>
                  Start Encoder
                </button>
                <button className="btn btn-danger" disabled={cmdBusy || isOffline}
                  onClick={() => sendCmd({ cmd: "stop" })}>
                  Stop Encoder
                </button>
                <button className="btn btn-secondary" disabled={cmdBusy || isOffline}
                  onClick={() => sendCmd({ cmd: "restart" })}>
                  Restart Encoder
                </button>
              </div>
              {cmdMsg && (
                <p className={cmdMsg.ok ? "cmd-success" : "cmd-error"}>{cmdMsg.text}</p>
              )}
            </div>
          )}

          {/* ── Danger Zone (admin only) ────────────────────────── */}
          {isAdmin && (
            <div className="danger-zone">
              <h3 className="danger-zone-title">Danger Zone</h3>

              <div className="danger-zone-actions">
                {/* Archive / Unarchive */}
                <div className="danger-action">
                  <div className="danger-action-info">
                    <span className="danger-action-label">
                      {device.archived ? "Restore device" : "Archive device"}
                    </span>
                    <span className="danger-action-desc">
                      {device.archived
                        ? "Move this device back to the active list."
                        : "Hide this device from the main view. It can be restored later."}
                    </span>
                  </div>
                  <button
                    className={`btn ${device.archived ? "btn-secondary" : "btn-warning"}`}
                    disabled={archiveBusy}
                    onClick={handleArchive}
                  >
                    {archiveBusy ? "..." : device.archived ? "Restore" : "Archive"}
                  </button>
                </div>

                {/* Permanent delete (only if archived) */}
                {device.archived && (
                  <div className="danger-action">
                    <div className="danger-action-info">
                      <span className="danger-action-label">Delete device permanently</span>
                      <span className="danger-action-desc">
                        This will permanently remove the device and all its data. This action cannot be undone.
                      </span>
                    </div>
                    {!deleteConfirm ? (
                      <button className="btn btn-danger" onClick={() => setDeleteConfirm(true)}>
                        Delete
                      </button>
                    ) : (
                      <div className="delete-confirm-row">
                        <button
                          className="btn btn-danger"
                          disabled={deleteBusy}
                          onClick={handleDelete}
                        >
                          {deleteBusy ? "Deleting..." : "Confirm delete"}
                        </button>
                        <button
                          className="btn btn-secondary"
                          onClick={() => setDeleteConfirm(false)}
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {dangerMsg && (
                <p className={dangerMsg.ok ? "cmd-success" : "cmd-error"}>{dangerMsg.text}</p>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
