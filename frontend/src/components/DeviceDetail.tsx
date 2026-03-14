import { useState, useEffect, useRef } from "react";
import { api, ApiError, Device, LiveTelemetry, DeviceConfig, BondPath, DeviceConfigSnapshot } from "../api";

interface Props {
  device: Device;
  onClose: () => void;
  isAdmin: boolean;
}

const PIPELINES = [
  { value: "h264_v4l2_usb", label: "H.264 V4L2 USB" },
  { value: "h265_v4l2_usb", label: "H.265 V4L2 USB" },
  { value: "h264_qsv",      label: "H.264 Intel QSV" },
];

const RESOLUTIONS = ["1920x1080", "1280x720", "854x480", "640x360"];

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
    pipeline: undefined, // comes from encoder.pipeline
    resolution: undefined, // comes from encoder.resolution
    framerate: snap.framerate,
    bitrate_min_kbps: snap.bitrate_min_kbps,
    bitrate_max_kbps: snap.bitrate_max_kbps,
    srt_host: snap.srt_host,
    srt_port: snap.srt_port,
    srt_latency_ms: snap.srt_latency_ms,
    bond_enabled: snap.bond_enabled,
    bond_relay_host: snap.bond_relay_host ?? undefined,
    bond_relay_port: snap.bond_relay_port ?? undefined,
    bond_local_port: snap.bond_local_port ?? undefined,
    bond_keepalive_ms: snap.bond_keepalive_ms ?? undefined,
  };
}

export default function DeviceDetail({ device, onClose, isAdmin }: Props) {
  const [telemetry, setTelemetry] = useState<LiveTelemetry | null>(null);
  const [tab, setTab] = useState<"overview" | "network" | "settings" | "streaming" | "control">("overview");
  const [cmdBusy, setCmdBusy] = useState(false);
  const [cmdMsg, setCmdMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [config, setConfig] = useState<DeviceConfig>({});
  const [bondPaths, setBondPaths] = useState<BondPath[]>([]);
  const [configBusy, setConfigBusy] = useState(false);
  const [configMsg, setConfigMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const configSeeded = useRef(false);

  const isOffline = device.connection_status === "offline";

  // Live telemetry via WebSocket, REST fallback
  useEffect(() => {
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
      // Seed from full config snapshot
      setConfig({
        ...configFromSnapshot(snap),
        pipeline: telemetry.encoder.pipeline,
        resolution: telemetry.encoder.resolution,
      });
      setBondPaths(snap.bond_paths.map((p) => ({ interface: p.interface, priority: p.priority })));
    } else {
      // Fallback: seed just what's in encoder stats
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
      });
      setConfigMsg({ ok: true, text: "Streaming destination updated." });
    } catch (e) {
      setConfigMsg({ ok: false, text: e instanceof ApiError ? e.message : "Failed to save" });
    } finally {
      setConfigBusy(false);
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
  const interfaces = telemetry?.available_interfaces ?? [];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="modal-header">
          <div className="modal-title-row">
            <span className={`status-dot dot-${cs}`} />
            <h2 className="modal-title">{device.hostname}</h2>
            <span className={`state-badge state-${cs}`}>{statusLabel}</span>
            {isOffline && (
              <span className="modal-offline-badge">Device Offline</span>
            )}
          </div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {/* Offline banner */}
        {isOffline && (
          <div className="modal-offline-strip">
            <span>⚠ This device is offline — last seen {device.last_seen_at
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
                <Stat label="Data age"        value={telemetry.age_ms} unit="ms" />
                {telemetry.config && <>
                  <Stat label="Capture device" value={telemetry.config.capture_device} />
                  <Stat label="Framerate"      value={telemetry.config.framerate} unit="fps" />
                  <Stat label="Target bitrate" value={telemetry.config.bitrate_max_kbps.toLocaleString()} unit="kbps" />
                  <Stat label="SRT destination" value={`${telemetry.config.srt_host}:${telemetry.config.srt_port}`} />
                  <Stat label="Bonding"        value={telemetry.config.bond_enabled ? "Enabled" : "Disabled"} />
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
              {telemetry ? (
                telemetry.paths.length > 0 ? <>
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
                </> : (
                  <p className="status-msg">
                    No active bond paths — device is streaming directly via SRT or encoder is idle.
                  </p>
                )
              ) : (
                <p className="status-msg">
                  {isOffline ? "Device is offline — no network data." : "Waiting for telemetry…"}
                </p>
              )}
            </div>
          )}

          {/* ── Settings ──────────────────────────────────────────── */}
          {tab === "settings" && (
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
                      {captureDevices.map((d) => <option key={d} value={d}>{d}</option>)}
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
                    <option value="">— unchanged —</option>
                    {PIPELINES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label>Resolution</label>
                  <select className="select-input" value={config.resolution ?? ""}
                    onChange={(e) => setConfig({ ...config, resolution: e.target.value || undefined })}>
                    <option value="">— unchanged —</option>
                    {RESOLUTIONS.map((r) => <option key={r}>{r}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label>Framerate</label>
                  <input className="text-input" type="number" min={1} max={60} placeholder="30"
                    value={config.framerate ?? ""}
                    onChange={(e) => setConfig({ ...config, framerate: e.target.value ? Number(e.target.value) : undefined })} />
                </div>
              </div>

              {/* Encoder */}
              <SectionTitle>Encoder</SectionTitle>
              <p className="settings-hint">
                Set the target bitrate. The encoder adapts between min and target based on network conditions.
              </p>
              <div className="settings-grid">
                <div className="field">
                  <label>Target bitrate (kbps)</label>
                  <input className="text-input" type="number" min={100} max={100000} placeholder="8000"
                    value={config.bitrate_max_kbps ?? ""}
                    onChange={(e) => setConfig({ ...config, bitrate_max_kbps: e.target.value ? Number(e.target.value) : undefined })} />
                </div>
                <div className="field">
                  <label>Min bitrate (kbps)</label>
                  <input className="text-input" type="number" min={100} max={100000} placeholder="2000"
                    value={config.bitrate_min_kbps ?? ""}
                    onChange={(e) => setConfig({ ...config, bitrate_min_kbps: e.target.value ? Number(e.target.value) : undefined })} />
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
                          {interfaces.length > 0 ? (
                            <select className="select-input"
                              value={p.interface}
                              onChange={(e) => updatePath(i, "interface", e.target.value)}>
                              <option value="">— select interface —</option>
                              {interfaces.map((iface) => (
                                <option key={iface} value={iface}>{iface}</option>
                              ))}
                              {/* Also show the current value if not in the list */}
                              {p.interface && !interfaces.includes(p.interface) && (
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
                        <button type="button" className="btn-remove-path" onClick={() => removePath(i)}>✕</button>
                      </div>
                    ))}
                    <button type="button" className="btn btn-secondary" style={{ width: "auto", marginTop: 4 }}
                      onClick={addPath}>
                      + Add interface
                    </button>
                  </div>
                </>
              )}

              {/* Primary network interface */}
              {interfaces.length > 0 && (
                <>
                  <SectionTitle>Primary Network Interface</SectionTitle>
                  <p className="settings-hint">
                    The interface currently used for the primary path. Set it explicitly to prefer a specific connection.
                  </p>
                  <div className="settings-grid">
                    <div className="field">
                      <label>Primary interface</label>
                      <select className="select-input"
                        value=""
                        onChange={() => {}}>
                        <option value="">— auto (by priority) —</option>
                        {interfaces.map((iface) => (
                          <option key={iface} value={iface}>{iface}</option>
                        ))}
                      </select>
                    </div>
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
          )}

          {/* ── Streaming ─────────────────────────────────────────── */}
          {tab === "streaming" && (
            <form className="settings-form" onSubmit={handleSaveStreaming}>
              <SectionTitle>SRT Destination</SectionTitle>
              <p className="settings-hint">
                The SRT ingest endpoint this device streams to. Used when bonding is disabled.
                Set the relay host in Settings → Bonding to use multi-path bonding instead.
              </p>
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
              </div>

              <div className="protocol-note">
                <span className="protocol-tag">SRT</span>
                <span className="protocol-hint">More protocols coming soon (RTMP, RIST)</span>
              </div>

              {configMsg && (
                <p className={configMsg.ok ? "cmd-success" : "cmd-error"}>{configMsg.text}</p>
              )}
              <div className="settings-actions">
                {isAdmin ? (
                  <button type="submit" className="btn btn-primary" style={{ width: "auto" }}
                    disabled={configBusy || isOffline}>
                    {configBusy ? "Saving…" : "Save destination"}
                  </button>
                ) : (
                  <p className="status-msg">Admin role required to change settings.</p>
                )}
              </div>
            </form>
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
                  ▶ Start Encoder
                </button>
                <button className="btn btn-danger" disabled={cmdBusy || isOffline}
                  onClick={() => sendCmd({ cmd: "stop" })}>
                  ■ Stop Encoder
                </button>
              </div>
              <div className="control-section">
                <h3 className="control-section-title">Target Bitrate</h3>
                <p className="settings-hint" style={{ marginBottom: 12 }}>
                  Sets the maximum bitrate the encoder targets. The encoder adapts down to the minimum when network is congested.
                </p>
                <BitrateControl onSend={sendCmd} busy={cmdBusy || isOffline} telemetry={telemetry} />
              </div>
              {cmdMsg && (
                <p className={cmdMsg.ok ? "cmd-success" : "cmd-error"}>{cmdMsg.text}</p>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

function BitrateControl({
  onSend, busy, telemetry,
}: {
  onSend: (cmd: object) => void;
  busy: boolean;
  telemetry: LiveTelemetry | null;
}) {
  const currentTarget = telemetry?.config?.bitrate_max_kbps ?? telemetry?.encoder.bitrate_kbps ?? 8000;
  const currentMin = telemetry?.config?.bitrate_min_kbps ?? Math.round(currentTarget * 0.5);

  const [target, setTarget] = useState(String(currentTarget));
  const [min, setMin] = useState(String(currentMin));

  // Refresh displayed values when telemetry arrives
  useEffect(() => {
    if (telemetry?.config) {
      setTarget(String(telemetry.config.bitrate_max_kbps));
      setMin(String(telemetry.config.bitrate_min_kbps));
    }
  }, [telemetry?.config?.bitrate_max_kbps, telemetry?.config?.bitrate_min_kbps]);

  return (
    <div className="bitrate-control">
      <div className="bitrate-inputs">
        <div className="field">
          <label>Target (kbps)</label>
          <input className="text-input" type="number" min={100} max={100000}
            value={target} onChange={(e) => setTarget(e.target.value)} />
        </div>
        <div className="field">
          <label>Min (kbps)</label>
          <input className="text-input" type="number" min={100} max={100000}
            value={min} onChange={(e) => setMin(e.target.value)} />
        </div>
      </div>
      <button className="btn btn-secondary" style={{ width: "auto" }} disabled={busy}
        onClick={() => onSend({ cmd: "set_bitrate_range", min_kbps: Number(min), max_kbps: Number(target) })}>
        Set bitrate
      </button>
    </div>
  );
}
