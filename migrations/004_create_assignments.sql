-- Device <-> User assignments (many-to-many)
CREATE TABLE device_assignments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id   UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    assigned_by UUID REFERENCES users(id),
    UNIQUE(device_id, user_id)
);

CREATE INDEX idx_assignments_device ON device_assignments(device_id);
CREATE INDEX idx_assignments_user ON device_assignments(user_id);
