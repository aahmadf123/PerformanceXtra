-- Migration 0006: add an Admin tier between coaches and the super admin, and a
-- sentinel owner row for the shared global content library.
--
-- Like 0003 (is_superadmin), the Admin tier is an additive flag column, NOT a new
-- role value: changing the users.role CHECK constraint would require dropping and
-- rebuilding the FK-referenced users table, which D1 cannot do cleanly. ADD COLUMN
-- is FK-safe. An admin is a users row with is_admin=1; role stays 'coach'. Login maps
-- the flags to an effective session role (see effectiveRole in functions/api):
--     is_superadmin=1 -> 'superadmin'   (top tier)
--     is_admin=1      -> 'admin'         (middle tier)
--     otherwise       -> role            ('coach' | 'athlete')
-- The ladder is strict: coach < admin < super admin, each a superset of the one below.
--
-- The 'usr_global_library' row owns the shared global content library (custom
-- activities, overrides, taxonomy) that every coach/athlete sees merged under their
-- own private content. It never logs in (no password_hash); it exists only so the
-- custom_activities.coach_id / activity_overrides.coach_id / taxonomy.coach_id foreign
-- keys are satisfied. role='coach', is_admin=0, is_superadmin=0 — it is excluded from
-- every coach/admin roster listing in code.
--
-- Apply to the live DB (run AFTER 0005):
--   wrangler d1 execute performancextra --file db/migrations/0006_admin_role.sql --remote
--
-- Additive and idempotent: ADD COLUMN errors with "duplicate column" only if already
-- applied (safe to ignore); the seed uses a fixed id + INSERT OR IGNORE.
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO users (id,email,name,role,is_admin,is_superadmin,created_at)
VALUES (
  'usr_global_library',
  'global-library@performancextra.internal',
  'Global Library',
  'coach',
  0,
  0,
  strftime('%s','now')
);
