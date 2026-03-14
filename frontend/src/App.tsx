import { useEffect, useReducer, useRef } from "react";
import { api, Device, ApiError } from "./api";
import DeviceGrid from "./components/DeviceGrid";

const POLL_INTERVAL_MS = 3000;

type State =
  | { phase: "loading" }
  | { phase: "ready"; devices: Device[]; lastFetch: Date }
  | { phase: "error"; message: string };

type Action =
  | { type: "DEVICES_LOADED"; devices: Device[] }
  | { type: "FETCH_ERROR"; message: string };

function reducer(_state: State, action: Action): State {
  switch (action.type) {
    case "DEVICES_LOADED":
      return { phase: "ready", devices: action.devices, lastFetch: new Date() };
    case "FETCH_ERROR":
      return { phase: "error", message: action.message };
  }
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, { phase: "loading" });
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
    fetchDevices();
    timerRef.current = setInterval(fetchDevices, POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const devices = state.phase === "ready" ? state.devices : [];
  const lastFetch = state.phase === "ready" ? state.lastFetch : null;

  return (
    <div className="app">
      <header className="topbar">
        <span className="topbar-logo">LGL Uplink Portal</span>
      </header>

      <main className="main">
        <div className="page-header">
          <h1>Devices</h1>
          {lastFetch && (
            <span className="last-fetch">
              Updated {lastFetch.toLocaleTimeString()}
            </span>
          )}
        </div>

        {state.phase === "loading" && (
          <p className="status-msg">Loading devices…</p>
        )}
        {state.phase === "error" && (
          <p className="status-msg error">Error: {state.message}</p>
        )}
        {state.phase === "ready" && <DeviceGrid devices={devices} />}
      </main>
    </div>
  );
}
