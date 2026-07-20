-- Migration 0024: security audit log for account-management actions.
--
-- Captures who performed sensitive user/passcode operations, from where, and when.
-- Used by API best-effort writes in functions/api/[[route]].js.

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id   TEXT,
  actor_role TEXT,
  action     TEXT NOT NULL,
  target_type TEXT,
  target_id  TEXT,
  ip         TEXT,
  user_agent TEXT,
  meta       TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_target ON audit_log(target_type, target_id, created_at DESC);
