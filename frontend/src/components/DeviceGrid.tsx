import { Device } from "../api";
import DeviceCard from "./DeviceCard";

interface Props {
  devices: Device[];
}

export default function DeviceGrid({ devices }: Props) {
  if (devices.length === 0) {
    return (
      <div className="empty-state">
        <p>No devices assigned to your organization yet.</p>
        <p className="empty-sub">
          Devices will appear here once they connect and an admin assigns them.
        </p>
      </div>
    );
  }

  const online = devices.filter((d) => d.status === "online");
  const offline = devices.filter((d) => d.status === "offline");

  return (
    <div className="device-grid-wrapper">
      {online.length > 0 && (
        <section>
          <h2 className="section-label">
            Online <span className="count">{online.length}</span>
          </h2>
          <div className="device-grid">
            {online.map((d) => (
              <DeviceCard key={d.id} device={d} />
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
              <DeviceCard key={d.id} device={d} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
