CREATE TABLE devices (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id          TEXT NOT NULL UNIQUE,
  hardware_id        TEXT NOT NULL DEFAULT '',
  hostname           TEXT NOT NULL DEFAULT '',
  nickname           TEXT,
  version            TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'offline',  -- online | offline
  last_state         TEXT NOT NULL DEFAULT '',
  last_seen_at       TIMESTAMPTZ,
  registered_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  enrollment_state   TEXT NOT NULL DEFAULT 'pending',  -- pending | enrolled | rejected
  enrollment_code    TEXT,
  enrolled_at        TIMESTAMPTZ,
  enrolled_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  archived           BOOLEAN NOT NULL DEFAULT false,
  verification_code  TEXT,
  verification_state TEXT NOT NULL DEFAULT 'unverified',  -- unverified | verified
  verified_at        TIMESTAMPTZ,
  verified_by        UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_devices_device_id ON devices(device_id);
CREATE INDEX idx_devices_status ON devices(status);
