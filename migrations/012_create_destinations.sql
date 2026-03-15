CREATE TABLE IF NOT EXISTS destinations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name          VARCHAR(200) NOT NULL,
  srt_host      VARCHAR(255) NOT NULL,
  srt_port      INTEGER NOT NULL,
  srt_latency_ms INTEGER NOT NULL DEFAULT 200,
  srt_passphrase TEXT,
  description   TEXT NOT NULL DEFAULT '',
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_destinations_org ON destinations(org_id);
