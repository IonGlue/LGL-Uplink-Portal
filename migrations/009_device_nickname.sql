-- Add optional human-readable nickname for devices
ALTER TABLE devices ADD COLUMN nickname VARCHAR(100);
