-- Devices (registered uplink encoders)
CREATE TABLE devices (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id       TEXT NOT NULL UNIQUE,
    hardware_id     TEXT NOT NULL,
    hostname        TEXT NOT NULL DEFAULT 'uplink',
    version         TEXT NOT NULL DEFAULT '0.0.0',
    org_id          UUID REFERENCES organizations(id) ON DELETE SET NULL,
    status          TEXT NOT NULL DEFAULT 'offline',
    last_state      TEXT NOT NULL DEFAULT 'idle',
    last_seen_at    TIMESTAMPTZ,
    registered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_devices_device_id ON devices(device_id);
CREATE INDEX idx_devices_org ON devices(org_id);
CREATE INDEX idx_devices_hardware_id ON devices(hardware_id);
