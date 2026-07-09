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
-- Strict tier ladder: coach < admin < super admin (each a superset of the one below):
--   super admin -> creates/manages admins, coaches AND other super admins + the global
--                  content library + site appearance (theme + page builder).
--   admin       -> everything a coach can do + the global content library + create/manage coaches.
--   coach       -> manages their own athletes (coach_id = the coach's id) + private content.
-- The two upper tiers are additive flag columns, NOT new role values: changing the
-- role CHECK would require dropping/rebuilding this FK-referenced table, which D1 can't
-- do cleanly. So role stays 'coach' for coach/admin/super admin rows, and login maps the
-- flags to the effective session role (effectiveRole in functions/api): is_superadmin=1
-- -> 'superadmin', else is_admin=1 -> 'admin', else role. is_admin added by 0006, the
-- super admin seeded by 0004 (change its password after first login).
-- The 'usr_global_library' row (seeded by 0006) owns the shared global content library;
-- it never logs in and is excluded from every roster listing in code.
CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,            -- uuid
  email          TEXT UNIQUE NOT NULL,
  name           TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('coach','athlete')),
  is_admin       INTEGER NOT NULL DEFAULT 0,  -- 1 = admin   (effective role 'admin' at login)      [migration 0006]
  is_superadmin  INTEGER NOT NULL DEFAULT 0,  -- 1 = super admin (effective role 'superadmin' at login)
  password_hash  TEXT,                        -- nullable until athlete sets password via invite
  coach_id       TEXT REFERENCES users(id),   -- set for athletes; null for coaches/admins/super admin
  invite_token   TEXT,                        -- one-time token for athlete first login
  invite_expires INTEGER,                     -- epoch seconds
  token_version  INTEGER NOT NULL DEFAULT 0,  -- bumped on password/passcode change to revoke old sessions [migration 0013]
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

-- Completions: which athlete finished which activity WITHIN which assignment
-- (mirrors reflections: assignment_id '' = no assignment context). Keyed per
-- assignment (migration 0015) so re-assigning the same activity later starts fresh.
-- No FK on assignment_id ('' has no parent row); deleting an assignment/athlete
-- removes its completions explicitly in code.
CREATE TABLE IF NOT EXISTS completions (
  athlete_id    TEXT NOT NULL REFERENCES users(id),
  activity_id   TEXT NOT NULL,
  assignment_id TEXT NOT NULL DEFAULT '',
  completed_at  INTEGER NOT NULL,
  PRIMARY KEY (athlete_id, activity_id, assignment_id)
);
CREATE INDEX IF NOT EXISTS idx_completions_assignment ON completions(assignment_id);

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

-- Login/invite brute-force throttling (migration 0012). One row per scope — an "ip:…",
-- "email:…", or "accept-ip:…" bucket — tracking failed attempts within a rolling window;
-- once the window limit is crossed the scope is locked until locked_until. Rows are cleared
-- on success and overwritten as windows roll, so the table stays tiny. The API fails OPEN
-- when this table is absent, so throttling is inert until the migration is applied.
CREATE TABLE IF NOT EXISTS login_attempts (
  scope        TEXT PRIMARY KEY,            -- 'ip:1.2.3.4' | 'email:foo@bar' | 'accept-ip:1.2.3.4'
  window_start INTEGER NOT NULL,            -- epoch seconds the current window opened
  count        INTEGER NOT NULL DEFAULT 0,  -- failures in the current window
  locked_until INTEGER                      -- epoch seconds the lockout ends (nullable)
);

-- Super-admin "Appearance" CMS (migration 0007). Both tables are global, edited only
-- by a super admin and applied site-wide; the GET endpoints are public so the
-- signed-out login page themes too.

-- Site configuration. value is a JSON blob keyed by `key`:
--   'theme'   -> design tokens (map 1:1 to CSS custom properties in styles.css :root)
--   'site'    -> brand config incl. logoUrl/faviconUrl
--   'menus'   -> explicit navigation menu ({items:[...]}, migration-free)
--   'checkin' -> athlete check-in dimensions/scales ({dimensions:[...]}, migration-free)
--   'access'  -> which CMS areas admins may edit ({pages,content,media booleans})
-- Applying theme/menus/checkin is a pure runtime override (no rebuild). All are super-admin
-- edited and read publicly via GET /api/site so the signed-out page themes/renders too.
CREATE TABLE IF NOT EXISTS site_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,                 -- JSON blob
  updated_at INTEGER NOT NULL
);

-- Builder pages. Blocks are an ordered JSON array on the row: [{id,type,props}, ...].
-- type is a server-enforced whitelist: hero|heading|text|image|cards|button|spacer.
-- status is the lifecycle ('draft'|'published'); the legacy `published` flag is kept
-- in sync by the API. nav_label/nav_order surface published pages as nav links.
CREATE TABLE IF NOT EXISTS pages (
  id          TEXT PRIMARY KEY,              -- slug, e.g. 'landing'
  title       TEXT NOT NULL,
  blocks      TEXT NOT NULL DEFAULT '[]',    -- JSON array of blocks
  published   INTEGER NOT NULL DEFAULT 0,    -- 1 = visible to the public GET (legacy mirror of status)
  updated_at  INTEGER NOT NULL,
  status      TEXT,                          -- 'draft' | 'published' (migration 0018)
  description TEXT,                          -- meta/SEO description
  nav_label   TEXT,                          -- when set, page appears as a nav link
  nav_order   INTEGER,                       -- sort order among nav links (NULL = not in nav)
  created_at  INTEGER,
  draft_title  TEXT,                         -- autosaved working copy (migration 0020);
  draft_blocks TEXT                          -- cleared on explicit save/publish
);

-- Page edit history (migration 0020): every explicit save snapshots the previous state;
-- the API prunes each page to its latest 20 revisions.
CREATE TABLE IF NOT EXISTS page_revisions (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id  TEXT NOT NULL,
  title    TEXT NOT NULL,
  blocks   TEXT NOT NULL,     -- JSON array snapshot
  status   TEXT,
  saved_at INTEGER NOT NULL,
  saved_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_page_revisions_page ON page_revisions(page_id, id);

-- Reusable page sections (migration 0023): a super admin saves a named group of builder
-- blocks and inserts it into any page. blocks is the same sanitized JSON shape as pages.blocks.
CREATE TABLE IF NOT EXISTS page_sections (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  blocks     TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);

-- Editable site copy overrides (migration 0017). Each previously hardcoded piece of
-- user-facing text has a stable slot key; the original copy stays in the client as the
-- default, so this table stores only overrides (empty table = original site).
CREATE TABLE IF NOT EXISTS content_slots (
  key        TEXT PRIMARY KEY,   -- e.g. 'hero.title', 'repo.intro', 'footer.text'
  value      TEXT NOT NULL,      -- plain text override for this slot
  updated_at INTEGER NOT NULL
);

-- CMS media library metadata (migration 0019). Image bytes live in the R2 bucket bound
-- as MEDIA (key 'media/<id>.<ext>'); this table is the browsable index for the
-- Appearance -> Media panel and image picker.
CREATE TABLE IF NOT EXISTS media (
  id         TEXT PRIMARY KEY,   -- random id; also the R2 key stem
  key        TEXT NOT NULL,      -- full R2 object key, e.g. 'media/abc123.webp'
  filename   TEXT NOT NULL,      -- original filename, for display
  mime       TEXT NOT NULL,      -- image/jpeg | image/png | image/webp | image/gif
  size       INTEGER NOT NULL,   -- bytes as stored
  alt        TEXT,               -- default alt text
  created_at INTEGER NOT NULL,
  created_by TEXT,               -- uploader's user id
  folder     TEXT                -- optional folder label for grouping/filtering (migration 0022)
);

-- Mental-performance check-ins + journaling (migration 0008). Athletes self-report a
-- daily mood/energy/stress (each 1-5) + optional note (one row per athlete per local
-- day), and free-form journal entries; their coach reads both read-only.
-- The check-in dimensions/scales are super-admin configurable (site_settings key 'checkin').
-- `scores` (migration 0021) is a JSON object keyed by dimension key, e.g.
-- {"mood":4,"energy":3,"stress":2}. The mood/energy/stress columns are kept and dual-written
-- for the three built-in dimensions so a rollback to a pre-0021 Worker still shows data.
CREATE TABLE IF NOT EXISTS checkins (
  athlete_id TEXT NOT NULL REFERENCES users(id),
  day        TEXT NOT NULL,                 -- 'YYYY-MM-DD' in the athlete's local time
  mood       INTEGER,                       -- 1..5 (nullable) — legacy mirror of scores.mood
  energy     INTEGER,                       -- 1..5           — legacy mirror of scores.energy
  stress     INTEGER,                       -- 1..5           — legacy mirror of scores.stress
  note       TEXT,
  updated_at INTEGER NOT NULL,
  scores     TEXT,                          -- JSON {dimKey: value, ...} (migration 0021)
  PRIMARY KEY (athlete_id, day)
);
CREATE INDEX IF NOT EXISTS idx_checkins_athlete ON checkins(athlete_id);

CREATE TABLE IF NOT EXISTS journal_entries (
  id         TEXT PRIMARY KEY,
  athlete_id TEXT NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_journal_athlete ON journal_entries(athlete_id);

-- In-app two-way messaging (migration 0009): a coach<->athlete thread keyed by athlete,
-- plus a single coach-private note per athlete (never shown to the athlete). All in-app;
-- no email is sent. sender is server-trusted (the session role), never the request body.
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  athlete_id TEXT NOT NULL REFERENCES users(id),
  coach_id   TEXT NOT NULL REFERENCES users(id),
  sender     TEXT NOT NULL CHECK (sender IN ('coach','athlete')),
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_athlete ON messages(athlete_id);

CREATE TABLE IF NOT EXISTS athlete_notes (
  athlete_id TEXT PRIMARY KEY REFERENCES users(id),
  note       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Reusable assignment templates (migration 0010): a coach saves a titled set of
-- activities once and reuses it to start an assignment or bulk-assign to many athletes.
CREATE TABLE IF NOT EXISTS assignment_templates (
  id         TEXT PRIMARY KEY,
  coach_id   TEXT NOT NULL REFERENCES users(id),
  title      TEXT NOT NULL,
  note       TEXT,
  items      TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_templates_coach ON assignment_templates(coach_id);

-- Seed the non-login sentinel row that owns the shared global content library
-- (mirrors migration 0006; INSERT OR IGNORE so re-running is a no-op). Without this
-- row every /global/* write fails its coach_id foreign key on a fresh database.
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
