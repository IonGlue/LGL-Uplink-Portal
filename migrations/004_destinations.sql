CREATE TABLE destinations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         VARCHAR(200) NOT NULL,
  dest_type    TEXT NOT NULL,  -- rtmp | srt_push | hls | recorder | lgl_ingest | placeholder
  config       JSONB NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'idle',  -- idle | active | error | placeholder
  process_pid  INTEGER,
  position_x   FLOAT NOT NULL DEFAULT 900,
  position_y   FLOAT NOT NULL DEFAULT 100,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_destinations_status ON destinations(status);
