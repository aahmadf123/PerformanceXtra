-- 0010: Reusable assignment templates (coach efficiency).
-- A coach saves a titled set of activities once and reuses it — to start a new
-- assignment or to bulk-assign the same workout to several athletes in one action.
-- `items` is a JSON array of activity ids (same shape as an assignment's items).

CREATE TABLE IF NOT EXISTS assignment_templates (
  id         TEXT PRIMARY KEY,
  coach_id   TEXT NOT NULL REFERENCES users(id),
  title      TEXT NOT NULL,
  note       TEXT,
  items      TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_templates_coach ON assignment_templates(coach_id);
