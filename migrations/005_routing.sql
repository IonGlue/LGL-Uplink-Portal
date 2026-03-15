CREATE TABLE routing (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id  UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  dest_id    UUID NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  enabled    BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(source_id, dest_id)
);

CREATE INDEX idx_routing_source ON routing(source_id);
CREATE INDEX idx_routing_dest   ON routing(dest_id);
