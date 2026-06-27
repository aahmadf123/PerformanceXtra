-- 0009: In-app two-way communication.
-- A message thread between a coach and one of their athletes (sender is the trusted
-- session role, never the body), plus a single coach-private note per athlete that the
-- athlete never sees. Everything is in-app: no email/SMS is sent. A future developer can
-- wire notifications by reading unread rows (read_at IS NULL) — see README "Notifications".

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  athlete_id TEXT NOT NULL REFERENCES users(id),   -- the thread is keyed by the athlete
  coach_id   TEXT NOT NULL REFERENCES users(id),   -- the athlete's coach at send time
  sender     TEXT NOT NULL CHECK (sender IN ('coach','athlete')),
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at    INTEGER                                -- NULL until the other party has seen it
);
CREATE INDEX IF NOT EXISTS idx_messages_athlete ON messages(athlete_id);

-- One coach-private note per athlete (not visible to the athlete).
CREATE TABLE IF NOT EXISTS athlete_notes (
  athlete_id TEXT PRIMARY KEY REFERENCES users(id),
  note       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
