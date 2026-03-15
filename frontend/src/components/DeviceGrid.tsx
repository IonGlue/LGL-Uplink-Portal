import { Device } from "../api";
import DeviceCard from "./DeviceCard";

interface Props {
  devices: Device[];
  onSelect: (device: Device) => void;
}

export default function DeviceGrid({ devices, onSelect }: Props) {
  if (devices.length === 0) {
    return (
      <div className="empty-state">
        <p>No devices assigned to your organization yet.</p>
        <p className="empty-sub">
          Devices will appear here once they connect and an admin enrolls them.
        </p>
      </div>
    );
  }

  const streaming  = devices.filter((d) => d.connection_status === "streaming");
  const connecting = devices.filter((d) => d.connection_status === "connecting");
  const online     = devices.filter((d) => d.connection_status === "online");
  const offline    = devices.filter((d) => d.connection_status === "offline");

  const activeCount = streaming.length + connecting.length + online.length;
  const hasNoActiveConnections = activeCount === 0;

  return (
    <div className="device-grid-wrapper">
      {hasNoActiveConnections && (
        <div className="no-connections-screen">
          <p className="no-connections-title">No Connections</p>
          <div className="no-connections-stats">
            <div className="no-connections-stat">
              <span className="no-connections-stat-value">{devices.length}</span>
              <span className="no-connections-stat-label">Adapters</span>
            </div>
            <div className="no-connections-stat-divider" />
            <div className="no-connections-stat">
              <span className="no-connections-stat-value">{activeCount}</span>
              <span className="no-connections-stat-label">Active Connections</span>
            </div>
          </div>
        </div>
      )}

      {streaming.length > 0 && (
        <section>
          <h2 className="section-label section-streaming">
            Streaming <span className="count">{streaming.length}</span>
          </h2>
          <div className="device-grid">
            {streaming.map((d) => (
              <DeviceCard key={d.id} device={d} onClick={() => onSelect(d)} />
            ))}
          </div>
        </section>
      )}

      {connecting.length > 0 && (
        <section>
          <h2 className="section-label section-connecting">
            Connecting <span className="count">{connecting.length}</span>
          </h2>
          <div className="device-grid">
            {connecting.map((d) => (
              <DeviceCard key={d.id} device={d} onClick={() => onSelect(d)} />
            ))}
          </div>
        </section>
      )}

      {online.length > 0 && (
        <section>
          <h2 className="section-label section-online">
            Online <span className="count">{online.length}</span>
          </h2>
          <div className="device-grid">
            {online.map((d) => (
              <DeviceCard key={d.id} device={d} onClick={() => onSelect(d)} />
            ))}
          </div>
        </section>
      )}

      {offline.length > 0 && (
        <section>
          <h2 className="section-label muted">
            Offline <span className="count">{offline.length}</span>
          </h2>
          <div className="device-grid">
            {offline.map((d) => (
              <DeviceCard key={d.id} device={d} onClick={() => onSelect(d)} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
