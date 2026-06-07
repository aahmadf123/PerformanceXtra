-- PerformanceXtra — D1 schema
-- Live database: performancextra  (id: a1c23e94-460d-482d-8c2b-d1b93375d9ce, region ENAM)
-- Apply with: wrangler d1 execute performancextra --file db/schema.sql --remote
-- This schema is already applied to the live DB; kept here for version control / reproducibility.

PRAGMA foreign_keys = ON;

-- Users: both coaches and athletes; role is server-trusted (never from request body).
CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,            -- uuid
  email          TEXT UNIQUE NOT NULL,
  name           TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('coach','athlete')),
  password_hash  TEXT,                        -- nullable until athlete sets password via invite
  coach_id       TEXT REFERENCES users(id),   -- set for athletes; null for coaches
  invite_token   TEXT,                        -- one-time token for athlete first login
  invite_expires INTEGER,                     -- epoch seconds
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_coach ON users(coach_id);

-- Custom activities a coach adds (base 190 stay embedded in index.html).
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
  PRIMARY KEY (assignment_id, activity_id)
);

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
