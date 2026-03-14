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
  last_seen_at: string | null;
  assigned_users: string[];
  control_claimed_by: string | null;
}

export interface DevicesResponse {
  devices: Device[];
}

const BASE = "/api/v1";

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };

  const res = await fetch(`${BASE}${path}`, { ...options, headers });

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

export const api = {
  devices(params?: { status?: string; state?: string }) {
    const qs = new URLSearchParams(
      Object.entries(params ?? {}).filter(([, v]) => v) as [string, string][]
    ).toString();
    return request<DevicesResponse>(`/devices${qs ? `?${qs}` : ""}`);
  },
};
