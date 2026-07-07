-- Migration 0004: seed the production super-admin account.
-- The super admin sits above coaches: it creates/manages coach accounts (coaches in
-- turn manage athletes). This replaces the old one-time "first coach" bootstrap.
--
-- SECURITY NOTE: an earlier version of this file committed a real password hash AND its
-- plaintext to version control. That credential is treated as permanently compromised:
-- its hash is pinned in COMPROMISED_HASHES ([[route]].js), and any account still using
-- it is forced to choose a new password at sign-in before a session is issued. Rotating
-- the password is what neutralises the leak — rewriting git history is not required.
--
-- To seed your own super admin: generate a hash with
--   node build/hash_password.mjs "<your-strong-password>"
-- and put it in the placeholder below before applying. NEVER commit the real hash or
-- the plaintext — keep the placeholder in version control.
--
-- Apply to the live DB (run AFTER 0003):
--   wrangler d1 execute performancextra --file db/migrations/0004_seed_superadmin.sql --remote
--
-- Idempotent: fixed id + UNIQUE email + INSERT OR IGNORE means re-running is a no-op.
-- (The production row already exists, so re-running with the placeholder is harmless.)
-- role stays 'coach' (satisfies the CHECK); is_superadmin=1 is what makes login grant
-- the effective 'superadmin' session role.
INSERT OR IGNORE INTO users (id,email,name,role,is_superadmin,password_hash,created_at)
VALUES (
  'usr_superadmin_0001',
  'firas.azfar@gmail.com',
  'Super Admin',
  'coach',
  1,
  '<REDACTED — generate with: node build/hash_password.mjs "your-password" — never commit the result>',
  strftime('%s','now')
);
