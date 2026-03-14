-- Audit log
CREATE TABLE audit_log (
    id          BIGSERIAL PRIMARY KEY,
    actor_type  TEXT NOT NULL,
    actor_id    UUID,
    action      TEXT NOT NULL,
    target_type TEXT,
    target_id   UUID,
    details     JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_target ON audit_log(target_type, target_id, created_at DESC);
