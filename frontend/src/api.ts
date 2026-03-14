// ── Types ─────────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  display_name: string;
  role: string;
  org_id: string;
}

export interface Device {
  id: string;
  device_id: string;
  hostname: string;
  version: string;
  status: "online" | "offline";
  last_state: string;
  /** Combined status: "offline" | "online" | "connecting" | "streaming" */
  connection_status: "offline" | "online" | "connecting" | "streaming";
  last_seen_at: string | null;
  assigned_users: string[];
  control_claimed_by: string | null;
  enrollment_state: string;
}

export interface PendingDevice {
  id: string;
  device_id: string;
  hardware_id: string;
  hostname: string;
  version: string;
  enrollment_code: string;
  status: string;
  registered_at: string;
}

export interface DevicesResponse {
  devices: Device[];
}

export interface PathStats {
  interface: string;
  bitrate_kbps: number;
  rtt_ms: number;
  loss_pct: number;
  in_flight: number;
  window: number;
}

export interface EncoderStats {
  pipeline: string;
  bitrate_kbps: number;
  fps: number;
  resolution: string;
}

/** Full config snapshot reported by the device in every telemetry push. */
export interface DeviceConfigSnapshot {
  pipeline_variant: string;
  capture_device: string;
  framerate: number;
  bitrate_min_kbps: number;
  bitrate_max_kbps: number;
  srt_host: string;
  srt_port: number;
  srt_latency_ms: number;
  bond_enabled: boolean;
  bond_relay_host: string | null;
  bond_relay_port: number | null;
  bond_local_port: number | null;
  bond_keepalive_ms: number | null;
  bond_paths: Array<{ interface: string; priority: number }>;
}

export interface LiveTelemetry {
  ts: number;
  state: string;
  paths: PathStats[];
  encoder: EncoderStats;
  /** Full current device configuration — always present in new firmware. */
  config?: DeviceConfigSnapshot;
  /** Available video capture devices on this machine. */
  available_capture_devices?: string[];
  /** Available network interfaces on this machine. */
  available_interfaces?: string[];
  uptime_secs: number;
  age_ms: number;
}

export interface BondPath {
  interface: string;
  priority: number;
}

/** Full device configuration — mirrors the device's uplink.toml completely. */
export interface DeviceConfig {
  // Video input
  capture_device?: string;
  pipeline?: string;
  resolution?: string;
  framerate?: number;

  // Encoder
  bitrate_min_kbps?: number;
  bitrate_max_kbps?: number;

  // SRT destination (direct, no bonding)
  srt_host?: string;
  srt_port?: number;
  srt_latency_ms?: number;

  // Bonding
  bond_enabled?: boolean;
  bond_relay_host?: string;
  bond_relay_port?: number;
  bond_local_port?: number;
  bond_keepalive_ms?: number;
  bond_paths?: BondPath[];
}

// ── Auth token storage ─────────────────────────────────────────────────────────

const TOKEN_KEY = "lgl_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(t: string) {
  localStorage.setItem(TOKEN_KEY, t);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

// ── HTTP client ────────────────────────────────────────────────────────────────

const BASE = "/api/v1";

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers as Record<string, string>),
  };

  const res = await fetch(`${BASE}${path}`, { ...options, headers });

  if (res.status === 401) {
    clearToken();
    window.location.reload();
    throw new ApiError(401, "Unauthorized");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (body as { error?: string }).error ?? res.statusText);
  }

  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ── API surface ────────────────────────────────────────────────────────────────

export const api = {
  // Auth
  async login(email: string, password: string): Promise<{ token: string; user: User }> {
    return request("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  },

  async me(): Promise<User> {
    return request("/auth/me");
  },

  // Devices
  devices(params?: { status?: string; state?: string }) {
    const qs = new URLSearchParams(
      Object.entries(params ?? {}).filter(([, v]) => v) as [string, string][]
    ).toString();
    return request<DevicesResponse>(`/devices${qs ? `?${qs}` : ""}`);
  },

  device(id: string) {
    return request<Device>(`/devices/${id}`);
  },

  // Enrollment
  pendingDevices() {
    return request<{ devices: PendingDevice[] }>("/devices/pending");
  },

  enrollDevice(id: string, code: string) {
    return request<{ enrolled: boolean }>(`/devices/${id}/enroll`, {
      method: "POST",
      body: JSON.stringify({ code }),
    });
  },

  rejectDevice(id: string) {
    return request<{ rejected: boolean }>(`/devices/${id}/reject`, {
      method: "POST",
    });
  },

  claimDeviceToOrg(id: string) {
    return request<{ assigned: boolean }>(`/devices/${id}/claim-to-org`, {
      method: "POST",
    });
  },

  // Telemetry
  liveTelemetry(id: string) {
    return request<LiveTelemetry>(`/devices/${id}/telemetry/live`);
  },

  // Control
  claimControl(id: string) {
    return request<{ claimed: boolean; expires_at: string }>(`/devices/${id}/control/claim`, {
      method: "POST",
    });
  },

  releaseControl(id: string) {
    return request<{ released: boolean }>(`/devices/${id}/control/release`, {
      method: "POST",
    });
  },

  sendCommand(id: string, cmd: object) {
    return request<{ status: string }>(`/devices/${id}/control/command`, {
      method: "POST",
      body: JSON.stringify(cmd),
    });
  },

  setConfig(id: string, config: DeviceConfig) {
    return request<{ status: string }>(`/devices/${id}/control/command`, {
      method: "POST",
      body: JSON.stringify({ cmd: "set_config", ...config }),
    });
  },

  // Websocket stream URL helper (auth via query param)
  telemetryStreamUrl(id: string): string {
    const token = getToken() ?? "";
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${window.location.host}/api/v1/devices/${id}/telemetry/stream?token=${token}`;
  },
};
