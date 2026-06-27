-- Migration 0005: student-level custom links.
-- Promotes the old per-assignment override (assignment_items.custom_url) to the
-- student level: a coach sets a link once per (student, activity) — e.g. a doc in
-- that student's private folder — and it applies to every assignment of that
-- activity for that student.
--
-- Apply to the live DB:
--   wrangler d1 execute performancextra --file db/migrations/0005_student_activity_links.sql --remote
CREATE TABLE IF NOT EXISTS student_activity_links (
  athlete_id  TEXT NOT NULL REFERENCES users(id),
  activity_id TEXT NOT NULL,                 -- base ACT-xxx or CUST-xxx
  url         TEXT NOT NULL,                 -- absolute https:// link
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (athlete_id, activity_id)
);
CREATE INDEX IF NOT EXISTS idx_student_links_athlete ON student_activity_links(athlete_id);

-- Backfill from the old per-assignment column; newest assignment wins per
-- (athlete, activity): ORDER BY created_at DESC inserts the most recent first, and
-- INSERT OR IGNORE then skips older duplicates that collide on the primary key.
INSERT OR IGNORE INTO student_activity_links (athlete_id, activity_id, url, updated_at)
SELECT a.athlete_id, ai.activity_id, ai.custom_url, a.created_at
FROM assignment_items ai
JOIN assignments a ON a.id = ai.assignment_id
WHERE ai.custom_url IS NOT NULL AND ai.custom_url <> ''
ORDER BY a.created_at DESC;
