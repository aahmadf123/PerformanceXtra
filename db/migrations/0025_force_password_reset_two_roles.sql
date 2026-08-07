-- Migration 0025: enforce first-login password reset for passcode-created accounts.
--
-- Adds users.must_reset_password used by /api/login FORCE_PASSWORD_CHANGE flow.
-- Accounts created/reset with one-time passcodes are flagged by API writes and must
-- choose a private password before receiving a session.

ALTER TABLE users ADD COLUMN must_reset_password INTEGER NOT NULL DEFAULT 0;
