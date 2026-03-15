CREATE TABLE telemetry (
  id        BIGSERIAL PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
  state     TEXT NOT NULL DEFAULT '',
  payload   JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_telemetry_device_ts ON telemetry(device_id, ts DESC);
