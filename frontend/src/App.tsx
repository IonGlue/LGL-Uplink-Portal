import { useEffect, useReducer, useRef, useState } from "react";
import { api, Device, ApiError, User, getToken, setToken, clearToken } from "./api";
import DeviceGrid from "./components/DeviceGrid";
import DeviceDetail from "./components/DeviceDetail";
import EnrollmentPanel from "./components/EnrollmentPanel";
import Login from "./components/Login";

const POLL_INTERVAL_MS = 3000;

type AppState =
  | { phase: "auth-check" }
  | { phase: "login"; loginError?: string }
  | { phase: "ready"; user: User; devices: Device[]; lastFetch: Date }
  | { phase: "error"; message: string };

type Action =
  | { type: "AUTH_OK"; user: User }
  | { type: "LOGIN_ERROR"; message: string }
  | { type: "LOGOUT" }
  | { type: "DEVICES_LOADED"; devices: Device[] }
  | { type: "FETCH_ERROR"; message: string };

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "AUTH_OK":
      return { phase: "ready", user: action.user, devices: [], lastFetch: new Date() };
    case "LOGIN_ERROR":
      return { phase: "login", loginError: action.message };
    case "LOGOUT":
      return { phase: "login" };
    case "DEVICES_LOADED":
      if (state.phase !== "ready") return state;
      return { ...state, devices: action.devices, lastFetch: new Date() };
    case "FETCH_ERROR":
      return { phase: "error", message: action.message };
  }
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, { phase: "auth-check" });
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // On mount: check if we have a stored token
  useEffect(() => {
    const token = getToken();
    if (!token) {
      dispatch({ type: "LOGOUT" });
      return;
    }
    api.me()
      .then((user) => dispatch({ type: "AUTH_OK", user }))
      .catch(() => {
        clearToken();
        dispatch({ type: "LOGOUT" });
      });
  }, []);

  async function handleLogin(email: string, password: string) {
    try {
      const { token, user } = await api.login(email, password);
      setToken(token);
      dispatch({ type: "AUTH_OK", user });
    } catch (e) {
      dispatch({
        type: "LOGIN_ERROR",
        message: e instanceof ApiError ? e.message : "Login failed",
      });
    }
  }

  function handleLogout() {
    clearToken();
    dispatch({ type: "LOGOUT" });
    setSelectedDevice(null);
  }

  // Poll devices when authenticated
  async function fetchDevices() {
    try {
      const data = await api.devices();
      dispatch({ type: "DEVICES_LOADED", devices: data.devices });
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Failed to fetch devices";
      dispatch({ type: "FETCH_ERROR", message: msg });
    }
  }

  useEffect(() => {
    if (state.phase !== "ready") return;
    fetchDevices();
    timerRef.current = setInterval(fetchDevices, POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [state.phase]);

  // Keep selected device in sync with poll updates
  useEffect(() => {
    if (state.phase !== "ready" || !selectedDevice) return;
    const updated = state.devices.find((d) => d.id === selectedDevice.id);
    if (updated) setSelectedDevice(updated);
  }, [state.phase === "ready" && (state as { devices: Device[] }).devices]);

  // ── Render ────────────────────────────────────────────────────────────────

  if (state.phase === "auth-check") {
    return (
      <div className="app">
        <p className="status-msg">Loading…</p>
      </div>
    );
  }

  if (state.phase === "login") {
    return <Login onLogin={handleLogin} error={state.loginError} />;
  }

  const { user, devices, lastFetch } = state as { user: User; devices: Device[]; lastFetch: Date };
  const isAdmin = user.role === "admin";

  return (
    <div className="app">
      {/* Top bar */}
      <header className="topbar">
        <span className="topbar-logo">LGL<span className="logo-accent">OS</span></span>
        <div className="topbar-right">
          <span className="topbar-user">{user.email}</span>
          <span className="topbar-role">{user.role}</span>
          <button className="btn btn-ghost" onClick={handleLogout}>Sign out</button>
        </div>
      </header>

      <main className="main">
        {/* Enrollment banner (admin only) */}
        {isAdmin && (
          <EnrollmentPanel onEnrolled={fetchDevices} />
        )}

        {/* Device list header */}
        <div className="page-header">
          <h1>Encoders</h1>
          {lastFetch && (
            <span className="last-fetch">Updated {lastFetch.toLocaleTimeString()}</span>
          )}
        </div>

        {state.phase === "error" && (
          <p className="status-msg error">Error: {(state as { message: string }).message}</p>
        )}

        <DeviceGrid
          devices={devices}
          onSelect={(d) => setSelectedDevice(d)}
        />
      </main>

      {/* Device detail modal */}
      {selectedDevice && (
        <DeviceDetail
          device={selectedDevice}
          onClose={() => setSelectedDevice(null)}
          isAdmin={isAdmin}
        />
      )}
    </div>
  );
}
