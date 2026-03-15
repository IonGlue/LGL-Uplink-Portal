import { useState, useEffect, useRef } from "react";
import { api, ApiError, Destination, DestinationInput, Device } from "../api";

interface Props {
  isAdmin: boolean;
  devices: Device[];
}

const EMPTY_FORM: DestinationInput = {
  name: "",
  srt_host: "",
  srt_port: 5000,
  srt_latency_ms: 200,
  srt_passphrase: "",
  description: "",
};

export default function DestinationsPage({ isAdmin, devices }: Props) {
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<DestinationInput>(EMPTY_FORM);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Deploy state
  const [deployingId, setDeployingId] = useState<string | null>(null);
  const [deployDeviceId, setDeployDeviceId] = useState<string>("");
  const [deployBusy, setDeployBusy] = useState(false);
  const [deployMsg, setDeployMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Delete state
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function fetchDestinations(q?: string) {
    try {
      const data = await api.destinations(q || undefined);
      setDestinations(data.destinations);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load destinations");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchDestinations();
  }, []);

  function handleSearchChange(value: string) {
    setSearch(value);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      fetchDestinations(value);
    }, 300);
  }

  function openCreateForm() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setFormError(null);
    setShowForm(true);
  }

  function openEditForm(dest: Destination) {
    setForm({
      name: dest.name,
      srt_host: dest.srt_host,
      srt_port: dest.srt_port,
      srt_latency_ms: dest.srt_latency_ms,
      srt_passphrase: "",
      description: dest.description,
    });
    setEditingId(dest.id);
    setFormError(null);
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditingId(null);
    setFormError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormBusy(true);
    setFormError(null);
    try {
      if (editingId) {
        const update: Partial<DestinationInput> = {
          name: form.name,
          srt_host: form.srt_host,
          srt_port: form.srt_port,
          srt_latency_ms: form.srt_latency_ms,
          description: form.description,
        };
        if (form.srt_passphrase) {
          update.srt_passphrase = form.srt_passphrase;
        }
        await api.updateDestination(editingId, update);
      } else {
        const input: DestinationInput = { ...form };
        if (!input.srt_passphrase) delete input.srt_passphrase;
        await api.createDestination(input);
      }
      closeForm();
      fetchDestinations(search || undefined);
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : "Failed to save");
    } finally {
      setFormBusy(false);
    }
  }

  async function handleDelete(id: string) {
    setDeleteBusy(true);
    try {
      await api.deleteDestination(id);
      setDeleteConfirmId(null);
      fetchDestinations(search || undefined);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to delete");
    } finally {
      setDeleteBusy(false);
    }
  }

  function openDeploy(destId: string) {
    setDeployingId(destId);
    setDeployDeviceId("");
    setDeployMsg(null);
  }

  async function handleDeploy() {
    if (!deployingId || !deployDeviceId) return;
    setDeployBusy(true);
    setDeployMsg(null);
    try {
      const result = await api.deployDestination(deployingId, deployDeviceId);
      setDeployMsg({ ok: true, text: `Deployed "${result.destination}" to encoder.` });
      setTimeout(() => {
        setDeployingId(null);
        setDeployMsg(null);
      }, 2000);
    } catch (e) {
      setDeployMsg({ ok: false, text: e instanceof ApiError ? e.message : "Deploy failed" });
    } finally {
      setDeployBusy(false);
    }
  }

  /** Parse an SRT URL and populate the form fields */
  function parseSrtUrl(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("srt://")) return;
    try {
      const u = new URL("https://" + trimmed.slice(6));
      const host = u.hostname;
      const port = u.port ? Number(u.port) : undefined;
      const passphrase = u.searchParams.get("passphrase");
      const latency = u.searchParams.get("latency");
      setForm((f) => ({
        ...f,
        ...(host ? { srt_host: host } : {}),
        ...(port ? { srt_port: port } : {}),
        ...(passphrase ? { srt_passphrase: passphrase } : {}),
        ...(latency ? { srt_latency_ms: Number(latency) } : {}),
      }));
    } catch {
      // ignore parse errors
    }
  }

  const onlineDevices = devices.filter(
    (d) => d.connection_status !== "offline" && !d.archived
  );

  return (
    <div>
      {/* Header */}
      <div className="page-header">
        <h1>Destinations</h1>
        {isAdmin && (
          <button className="btn btn-primary dest-add-btn" onClick={openCreateForm}>
            + New Destination
          </button>
        )}
      </div>

      {/* Search bar */}
      <div className="dest-search-bar">
        <input
          className="text-input dest-search-input"
          type="text"
          placeholder="Search destinations..."
          value={search}
          onChange={(e) => handleSearchChange(e.target.value)}
        />
      </div>

      {error && <p className="cmd-error" style={{ marginBottom: 16 }}>{error}</p>}

      {/* Destination list */}
      {loading ? (
        <p className="status-msg">Loading destinations...</p>
      ) : destinations.length === 0 ? (
        <div className="empty-state">
          <p>{search ? "No destinations match your search." : "No destinations yet."}</p>
          {!search && isAdmin && (
            <p className="empty-sub">Create your first destination to get started.</p>
          )}
        </div>
      ) : (
        <div className="dest-grid">
          {destinations.map((dest) => (
            <div key={dest.id} className="dest-card">
              <div className="dest-card-header">
                <h3 className="dest-card-name">{dest.name}</h3>
                {isAdmin && (
                  <div className="dest-card-actions">
                    <button className="btn-icon-ghost" title="Edit" onClick={() => openEditForm(dest)}>
                      Edit
                    </button>
                    {deleteConfirmId === dest.id ? (
                      <div className="delete-confirm-row">
                        <button
                          className="btn btn-danger"
                          style={{ padding: "4px 10px", fontSize: 12 }}
                          disabled={deleteBusy}
                          onClick={() => handleDelete(dest.id)}
                        >
                          {deleteBusy ? "..." : "Confirm"}
                        </button>
                        <button
                          className="btn btn-secondary"
                          style={{ padding: "4px 10px", fontSize: 12 }}
                          onClick={() => setDeleteConfirmId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        className="btn-icon-ghost"
                        style={{ color: "var(--red)" }}
                        title="Delete"
                        onClick={() => setDeleteConfirmId(dest.id)}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                )}
              </div>

              {dest.description && (
                <p className="dest-card-desc">{dest.description}</p>
              )}

              <dl className="card-meta">
                <div className="meta-row">
                  <dt>Host</dt>
                  <dd className="mono">{dest.srt_host}</dd>
                </div>
                <div className="meta-row">
                  <dt>Port</dt>
                  <dd className="mono">{dest.srt_port}</dd>
                </div>
                <div className="meta-row">
                  <dt>Latency</dt>
                  <dd className="mono">{dest.srt_latency_ms} ms</dd>
                </div>
                <div className="meta-row">
                  <dt>Passphrase</dt>
                  <dd>{dest.srt_passphrase_set ? <span style={{ color: "var(--green)" }}>Set</span> : <span className="text-muted">Not set</span>}</dd>
                </div>
              </dl>

              {/* Deploy section */}
              {isAdmin && (
                <div className="dest-deploy-section">
                  {deployingId === dest.id ? (
                    <div className="dest-deploy-form">
                      <select
                        className="select-input"
                        value={deployDeviceId}
                        onChange={(e) => setDeployDeviceId(e.target.value)}
                      >
                        <option value="">Select encoder...</option>
                        {onlineDevices.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.nickname?.trim() || d.hostname}
                            {d.connection_status === "streaming" ? " (streaming)" : ""}
                          </option>
                        ))}
                      </select>
                      <div className="dest-deploy-btns">
                        <button
                          className="btn btn-success"
                          style={{ padding: "6px 14px", fontSize: 12 }}
                          disabled={deployBusy || !deployDeviceId}
                          onClick={handleDeploy}
                        >
                          {deployBusy ? "Deploying..." : "Deploy"}
                        </button>
                        <button
                          className="btn btn-secondary"
                          style={{ padding: "6px 14px", fontSize: 12 }}
                          onClick={() => { setDeployingId(null); setDeployMsg(null); }}
                        >
                          Cancel
                        </button>
                      </div>
                      {deployMsg && (
                        <p className={deployMsg.ok ? "cmd-success" : "cmd-error"} style={{ marginTop: 8 }}>
                          {deployMsg.text}
                        </p>
                      )}
                    </div>
                  ) : (
                    <button
                      className="btn btn-primary dest-deploy-btn"
                      onClick={() => openDeploy(dest.id)}
                      disabled={onlineDevices.length === 0}
                      title={onlineDevices.length === 0 ? "No online encoders available" : "Deploy to an encoder"}
                    >
                      Deploy to Encoder
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Create / Edit modal */}
      {showForm && (
        <div className="modal-backdrop" onClick={closeForm}>
          <div className="modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">{editingId ? "Edit Destination" : "New Destination"}</h2>
              <button className="modal-close" onClick={closeForm}>x</button>
            </div>
            <div className="modal-body">
              <form className="settings-form" onSubmit={handleSubmit}>
                {/* SRT URL quick-paste */}
                <div className="field">
                  <label>Paste SRT URL</label>
                  <input
                    className="text-input"
                    type="text"
                    placeholder="srt://host:port?passphrase=secret&latency=200"
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
                    Paste an SRT URL to auto-fill host, port, and passphrase.
                  </span>
                </div>

                <div className="field">
                  <label>Name</label>
                  <input
                    className="text-input"
                    type="text"
                    placeholder="e.g. Studio A Ingest"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    required
                    autoFocus
                  />
                </div>

                <div className="settings-grid">
                  <div className="field">
                    <label>SRT Host</label>
                    <input
                      className="text-input"
                      type="text"
                      placeholder="ingest.example.com"
                      value={form.srt_host}
                      onChange={(e) => setForm({ ...form, srt_host: e.target.value })}
                      required
                    />
                  </div>
                  <div className="field">
                    <label>SRT Port</label>
                    <input
                      className="text-input"
                      type="number"
                      min={1}
                      max={65535}
                      placeholder="5000"
                      value={form.srt_port}
                      onChange={(e) => setForm({ ...form, srt_port: Number(e.target.value) })}
                      required
                    />
                  </div>
                  <div className="field">
                    <label>Latency (ms)</label>
                    <input
                      className="text-input"
                      type="number"
                      min={20}
                      max={8000}
                      placeholder="200"
                      value={form.srt_latency_ms ?? 200}
                      onChange={(e) => setForm({ ...form, srt_latency_ms: Number(e.target.value) })}
                    />
                  </div>
                  <div className="field">
                    <label>Passphrase</label>
                    <input
                      className="text-input"
                      type="password"
                      placeholder={editingId ? "Leave blank to keep current" : "Optional (10-79 chars)"}
                      value={form.srt_passphrase ?? ""}
                      onChange={(e) => setForm({ ...form, srt_passphrase: e.target.value })}
                      autoComplete="new-password"
                    />
                  </div>
                </div>

                <div className="field">
                  <label>Description</label>
                  <input
                    className="text-input"
                    type="text"
                    placeholder="Optional notes about this destination"
                    value={form.description ?? ""}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                  />
                </div>

                {formError && <p className="cmd-error">{formError}</p>}

                <div className="settings-actions">
                  <button type="button" className="btn btn-secondary" onClick={closeForm}>
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    style={{ width: "auto" }}
                    disabled={formBusy}
                  >
                    {formBusy ? "Saving..." : editingId ? "Save Changes" : "Create Destination"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
