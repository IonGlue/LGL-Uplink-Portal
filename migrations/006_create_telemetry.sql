-- Telemetry snapshots (recent history, pruned by TTL)
CREATE TABLE telemetry (
    id          BIGSERIAL PRIMARY KEY,
    device_id   UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    ts          TIMESTAMPTZ NOT NULL,
    state       TEXT NOT NULL,
    payload     JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_telemetry_device_ts ON telemetry(device_id, ts DESC);
