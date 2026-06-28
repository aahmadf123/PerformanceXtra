-- 0008: Mental-performance check-ins + journaling.
-- A lightweight daily wellbeing check-in (mood / energy / stress, each 1-5, plus an
-- optional note) — one row per athlete per local day — and free-form journal entries.
-- Athletes write their own; their coach reads them in the Students -> Wellbeing panel.

CREATE TABLE IF NOT EXISTS checkins (
  athlete_id TEXT NOT NULL REFERENCES users(id),
  day        TEXT NOT NULL,                 -- 'YYYY-MM-DD' in the athlete's local time
  mood       INTEGER,                       -- 1..5 (nullable: a dimension may be left blank)
  energy     INTEGER,                       -- 1..5
  stress     INTEGER,                       -- 1..5 (higher = more stress)
  note       TEXT,
  updated_at INTEGER NOT NULL,
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
