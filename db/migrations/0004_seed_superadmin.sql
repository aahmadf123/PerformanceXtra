-- Migration 0004: seed the production super-admin account.
-- The super admin sits above coaches: it creates/manages coach accounts (coaches in
-- turn manage athletes). This replaces the old one-time "first coach" bootstrap.
--
-- The password_hash below was produced by:
--   node build/hash_password.mjs "PXtra-SuperAdmin-2026!"
-- so the initial login is:
--   email:    firas.azfar@gmail.com
--   password: PXtra-SuperAdmin-2026!
-- >>> CHANGE THIS PASSWORD immediately after first sign-in (Settings -> Update password).
-- To use different credentials, regenerate the hash with build/hash_password.mjs and
-- edit the email/name/hash below before applying.
--
-- Apply to the live DB (run AFTER 0003):
--   wrangler d1 execute performancextra --file db/migrations/0004_seed_superadmin.sql --remote
--
-- Idempotent: fixed id + UNIQUE email + INSERT OR IGNORE means re-running is a no-op.
-- role stays 'coach' (satisfies the CHECK); is_superadmin=1 is what makes login grant
-- the effective 'superadmin' session role.
INSERT OR IGNORE INTO users (id,email,name,role,is_superadmin,password_hash,created_at)
VALUES (
  'usr_superadmin_0001',
  'firas.azfar@gmail.com',
  'Super Admin',
  'coach',
  1,
  'pbkdf2$100000$FN_j-Namr6u_tSJ-exgQLQ$b5guofTADU4YNoywGA20xYmqoVJ75nvg9FTHriAF3Jk',
  strftime('%s','now')
);
