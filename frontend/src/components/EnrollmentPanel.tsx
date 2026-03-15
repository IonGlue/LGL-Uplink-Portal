import { useState, useEffect } from "react";
import { api, ApiError, PendingDevice } from "../api";

interface Props {
  onEnrolled: () => void;
  onCountChange?: (count: number) => void;
}

export default function EnrollmentPanel({ onEnrolled, onCountChange }: Props) {
  const [devices, setDevices] = useState<PendingDevice[]>([]);
  const [selected, setSelected] = useState<PendingDevice | null>(null);
  const [codeInput, setCodeInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function load() {
    try {
      const data = await api.pendingDevices();
      setDevices(data.devices);
    } catch {
      // not admin / ignore
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    onCountChange?.(devices.length);
  }, [devices.length]);

  async function handleEnroll() {
    if (!selected || codeInput.length !== 10) return;
    setBusy(true);
    setError(null);
    try {
      await api.enrollDevice(selected.id, codeInput);
      // Also assign to org automatically
      await api.claimDeviceToOrg(selected.id).catch(() => {});
      // Remove the enrolled device from the list immediately so the panel updates
      setDevices((prev) => prev.filter((d) => d.id !== selected.id));
      setSelected(null);
      setCodeInput("");
      onEnrolled();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Enrollment failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleReject() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.rejectDevice(selected.id);
      setSelected(null);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Reject failed");
    } finally {
      setBusy(false);
    }
  }

  if (devices.length === 0) {
    return (
      <div className="enrollment-empty">
        <p className="enrollment-empty-msg">No new encoders waiting for approval.</p>
      </div>
    );
  }

  return (
    <div className="enrollment-banner">
      <div className="enrollment-header">
        <span className="enrollment-icon">*</span>
        <span className="enrollment-title">
          {devices.length} encoder{devices.length !== 1 ? "s" : ""} waiting for approval
        </span>
      </div>

      <div className="enrollment-list">
        {devices.map((d) => (
          <button
            key={d.id}
            className={`enrollment-device-btn ${selected?.id === d.id ? "selected" : ""}`}
            onClick={() => {
              setSelected(d);
              setCodeInput("");
              setError(null);
              setSuccess(null);
            }}
          >
            <span className="enroll-hostname">{d.hostname}</span>
            <span className="enroll-meta">{d.version} · {d.device_id.slice(0, 12)}…</span>
          </button>
        ))}
      </div>

      {success && <p className="enrollment-success">{success}</p>}

      {selected && (
        <div className="enrollment-verify">
          <p className="verify-instruction">
            Check the device's HDMI output or terminal and enter the 5-digit code shown:
          </p>
          <div className="code-displayed">
            <span className="code-label">Code on device</span>
            <span className="code-value">{selected.enrollment_code}</span>
          </div>
          <div className="verify-row">
            <input
              className="code-input"
              type="text"
              maxLength={10}
              pattern="[A-Z0-9]{10}"
              placeholder="Enter 10-char code"
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10))}
              autoFocus
            />
            <button
              className="btn btn-primary"
              style={{ width: "auto" }}
              onClick={handleEnroll}
              disabled={busy || codeInput.length !== 10}
            >
              Approve
            </button>
            <button
              className="btn btn-danger"
              onClick={handleReject}
              disabled={busy}
            >
              Reject
            </button>
          </div>
          {error && <p className="login-error" style={{ marginTop: 8 }}>{error}</p>}
        </div>
      )}
    </div>
  );
}
