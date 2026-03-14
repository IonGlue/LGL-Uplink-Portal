import { useEffect, useReducer, useRef } from "react";
import { api, Device, User, ApiError } from "./api";
import Login from "./components/Login";
import DeviceGrid from "./components/DeviceGrid";

const POLL_INTERVAL_MS = 3000;

type Session = { token: string; user: User };

type State =
  | { phase: "login"; error?: string }
  | { phase: "loading"; session: Session }
  | { phase: "ready"; session: Session; devices: Device[]; lastFetch: Date }
  | { phase: "error"; session: Session; message: string };

type Action =
  | { type: "LOGIN_SUCCESS"; session: Session }
  | { type: "LOGIN_ERROR"; message: string }
  | { type: "DEVICES_LOADED"; devices: Device[] }
  | { type: "FETCH_ERROR"; message: string }
  | { type: "LOGOUT" };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "LOGIN_SUCCESS":
      return { phase: "loading", session: action.session };
    case "LOGIN_ERROR":
      return { phase: "login", error: action.message };
    case "DEVICES_LOADED":
      if (state.phase === "loading" || state.phase === "ready" || state.phase === "error")
        return { phase: "ready", session: state.session, devices: action.devices, lastFetch: new Date() };
      return state;
    case "FETCH_ERROR":
      if (state.phase === "loading" || state.phase === "ready" || state.phase === "error")
        return { phase: "error", session: state.session, message: action.message };
      return state;
    case "LOGOUT":
      return { phase: "login" };
  }
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, { phase: "login" });
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchDevices(token: string) {
    try {
      const data = await api.devices(token);
      dispatch({ type: "DEVICES_LOADED", devices: data.devices });
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Failed to fetch devices";
      dispatch({ type: "FETCH_ERROR", message: msg });
    }
  }

  useEffect(() => {
    if (state.phase === "loading" || state.phase === "ready" || state.phase === "error") {
      const { token } = state.session;
      fetchDevices(token);
      timerRef.current = setInterval(() => fetchDevices(token), POLL_INTERVAL_MS);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase === "login" ? "login" : state.phase === "loading" ? "loading" : "authed"]);

  async function handleLogin(email: string, password: string) {
    try {
      const res = await api.login(email, password);
      dispatch({ type: "LOGIN_SUCCESS", session: { token: res.token, user: res.user } });
    } catch (e) {
      const msg = e instanceof ApiError
        ? e.status === 401 ? "Invalid email or password" : e.message
        : "Login failed";
      dispatch({ type: "LOGIN_ERROR", message: msg });
    }
  }

  if (state.phase === "login") {
    return <Login onLogin={handleLogin} error={state.error} />;
  }

  const { session } = state;
  const devices = state.phase === "ready" ? state.devices : [];
  const lastFetch = state.phase === "ready" ? state.lastFetch : null;

  return (
    <div className="app">
      <header className="topbar">
        <span className="topbar-logo">LGL Ingest</span>
        <div className="topbar-right">
          <span className="topbar-user">{session.user.display_name}</span>
          <button className="btn btn-ghost" onClick={() => dispatch({ type: "LOGOUT" })}>
            Sign out
          </button>
        </div>
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
