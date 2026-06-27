-- PerformanceXtra — D1 schema
-- Live database: performancextra  (id: a1c23e94-460d-482d-8c2b-d1b93375d9ce, region ENAM)
-- Worker: performance-xtra  (the database NAME is independent of the worker name)
--
-- Apply schema + base-activity seed to the live DB:
--   wrangler d1 execute performancextra --file db/schema.sql --remote
--   node build/generate_seed.mjs        # regenerates db/seed_activities.sql from data.js
--   wrangler d1 execute performancextra --file db/seed_activities.sql --remote
-- Kept here for version control / reproducibility.

PRAGMA foreign_keys = ON;

-- Users: coaches and athletes; role is server-trusted (never from request body).
-- Hierarchy: super admin -> creates/manages coaches; coach -> manages athletes
-- (coach_id = the coach's id). The super admin is a row with is_superadmin=1; login
-- maps that to the effective role 'superadmin' in the session (we keep role itself as
-- 'coach'/'athlete' so the CHECK and all FK references are unchanged — important because
-- D1 can't drop/rebuild this referenced table cleanly). The production super-admin
-- account is seeded by db/migrations/0004_seed_superadmin.sql (change its password
-- after first login).
CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,            -- uuid
  email          TEXT UNIQUE NOT NULL,
  name           TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('coach','athlete')),
  is_superadmin  INTEGER NOT NULL DEFAULT 0,  -- 1 = super admin (effective role 'superadmin' at login)
  password_hash  TEXT,                        -- nullable until athlete sets password via invite
  coach_id       TEXT REFERENCES users(id),   -- set for athletes; null for coaches/super admin
  invite_token   TEXT,                        -- one-time token for athlete first login
  invite_expires INTEGER,                     -- epoch seconds
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_coach ON users(coach_id);

-- Base activities: the 190 built-in mental-training activities (ACT-xxx).
-- Source of truth lives in data.js (generated from the Master Sheet); this table is the
-- authoritative server-side copy, seeded by db/seed_activities.sql and served via GET /api/activities.
-- The app reads these from D1 in SERVER mode and falls back to window.PX_DATA (data.js) when offline.
CREATE TABLE IF NOT EXISTS base_activities (
  id        TEXT PRIMARY KEY,              -- ACT-xxx
  payload   TEXT NOT NULL,                 -- JSON of the full activity object (matches data.js shape)
  position  INTEGER NOT NULL DEFAULT 0     -- preserves the original ordering from data.js
);

-- Custom activities a coach adds (base 190 live in base_activities + data.js).
CREATE TABLE IF NOT EXISTS custom_activities (
  id         TEXT PRIMARY KEY,
  coach_id   TEXT NOT NULL REFERENCES users(id),
  payload    TEXT NOT NULL,                  -- JSON: {name,topic,subtopics,type,progression,time,frequency,link,instructions,reflection}
  created_at INTEGER NOT NULL
);

-- Per-activity overrides / hide flags (mirrors current overrides/hidden).
CREATE TABLE IF NOT EXISTS activity_overrides (
  coach_id    TEXT NOT NULL REFERENCES users(id),
  activity_id TEXT NOT NULL,                 -- base ACT-xxx or CUST-xxx
  payload     TEXT,                          -- JSON of overridden fields (nullable)
  hidden      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (coach_id, activity_id)
);

-- Assignments: a titled set of activities a coach gives an athlete.
CREATE TABLE IF NOT EXISTS assignments (
  id         TEXT PRIMARY KEY,
  coach_id   TEXT NOT NULL REFERENCES users(id),
  athlete_id TEXT NOT NULL REFERENCES users(id),
  title      TEXT NOT NULL,
  note       TEXT,
  due_at     INTEGER,                        -- optional deadline
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assignments_athlete ON assignments(athlete_id);

CREATE TABLE IF NOT EXISTS assignment_items (
  assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  activity_id   TEXT NOT NULL,
  position      INTEGER NOT NULL,
  custom_url    TEXT,                          -- DEPRECATED: superseded by student_activity_links (kept for rollback)
  PRIMARY KEY (assignment_id, activity_id)
);

-- Student-level custom links: a coach overrides an activity's link for one athlete
-- (e.g. a doc in that athlete's private folder). Scoped to (athlete, activity), so it
-- applies to every assignment of that activity for that student. Replaces the older
-- per-assignment assignment_items.custom_url (migrated by 0005_student_activity_links.sql).
CREATE TABLE IF NOT EXISTS student_activity_links (
  athlete_id  TEXT NOT NULL REFERENCES users(id),
  activity_id TEXT NOT NULL,                  -- base ACT-xxx or CUST-xxx
  url         TEXT NOT NULL,                  -- absolute https:// link
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (athlete_id, activity_id)
);
CREATE INDEX IF NOT EXISTS idx_student_links_athlete ON student_activity_links(athlete_id);

-- Completions: which athlete finished which activity (optionally within an assignment).
-- assignment_id is intentionally excluded from the PRIMARY KEY because it is nullable
-- (SQLite PRIMARY KEY columns are implicitly NOT NULL). This means each athlete can
-- complete a given activity once globally, regardless of which assignment it belongs to.
CREATE TABLE IF NOT EXISTS completions (
  athlete_id    TEXT NOT NULL REFERENCES users(id),
  activity_id   TEXT NOT NULL,
  assignment_id TEXT REFERENCES assignments(id) ON DELETE CASCADE,
  completed_at  INTEGER NOT NULL,
  PRIMARY KEY (athlete_id, activity_id)
);

-- Reflections: athlete text responses to assignment reflection prompts.
-- assignment_id uses empty string when no assignment context exists.
CREATE TABLE IF NOT EXISTS reflections (
  athlete_id    TEXT NOT NULL REFERENCES users(id),
  assignment_id TEXT NOT NULL DEFAULT '',
  activity_id   TEXT NOT NULL,
  text          TEXT NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (athlete_id, assignment_id, activity_id)
);
CREATE INDEX IF NOT EXISTS idx_reflections_athlete ON reflections(athlete_id);

-- Coach-managed taxonomy: in-app overrides for the topic / subtopic / content-type
-- vocabularies. When a coach has rows here they drive the dropdowns; otherwise the
-- app falls back to the built-in vocabulary shipped in data.js (window.PX_TAXONOMY).
CREATE TABLE IF NOT EXISTS taxonomy (
  coach_id TEXT NOT NULL REFERENCES users(id),
  kind     TEXT NOT NULL CHECK (kind IN ('topic','subtopic','type')),
  value    TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (coach_id, kind, value)
);
CREATE INDEX IF NOT EXISTS idx_taxonomy_coach ON taxonomy(coach_id);

-- Internal key/value settings. Currently holds the auto-provisioned session
-- secret used to sign session cookies when SESSION_SECRET isn't set in the env.
-- Created automatically at runtime too; kept here for reproducibility.
CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
