-- Add archived flag for hiding unused/disconnected encoders from the default view.
ALTER TABLE devices ADD COLUMN archived BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX idx_devices_archived ON devices(archived);
