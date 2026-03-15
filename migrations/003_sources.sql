CREATE TABLE sources (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           VARCHAR(200) NOT NULL,
  source_type    TEXT NOT NULL,  -- encoder | srt_listen | srt_pull | rtmp_pull | test_pattern | placeholder
  device_id      TEXT,           -- device_id string for encoder sources (links to devices.device_id)
  config         JSONB NOT NULL DEFAULT '{}',
  internal_port  INTEGER,        -- assigned by supervisor when active
  status         TEXT NOT NULL DEFAULT 'idle',  -- idle | waiting | active | error | placeholder
  process_pid    INTEGER,
  position_x     FLOAT NOT NULL DEFAULT 100,
  position_y     FLOAT NOT NULL DEFAULT 100,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sources_device_id ON sources(device_id);
CREATE INDEX idx_sources_status ON sources(status);
