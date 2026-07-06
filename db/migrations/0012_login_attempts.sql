-- Migration 0012: login/invite brute-force throttling table.
-- Backs the rate limiting in functions/api ([[route]].js: handleLogin / handleAccept).
-- One row per scope (an "ip:…", "email:…", or "accept-ip:…" bucket). The API fails OPEN
-- when this table is absent, so applying this migration is what turns throttling on:
-- after LOGIN_MAX_FAILS failures within LOGIN_WINDOW for a scope, that scope is locked
-- for LOGIN_LOCK. Rows are cleared on success and reused across windows, so it stays tiny.
--
-- Apply to the live DB:
--   wrangler d1 execute performancextra --file db/migrations/0012_login_attempts.sql --remote
CREATE TABLE IF NOT EXISTS login_attempts (
  scope        TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER
);
