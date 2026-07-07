-- Migration 0015: completions become per-assignment.
--
-- The old PK (athlete_id, activity_id) meant an athlete could complete a given
-- activity exactly ONCE EVER — re-assigning the same drill next month showed it as
-- already done. The rebuilt table keys on (athlete_id, activity_id, assignment_id),
-- mirroring the reflections table: '' = completed with no assignment context.
--
-- The old FK on assignment_id (ON DELETE CASCADE) is intentionally dropped — '' has
-- no parent row, and deleting an assignment already removes its completions
-- explicitly in code (handleDeleteAssignment / handleDeleteAthlete).
--
-- Idempotent: re-running copies the (already-migrated) table into an identical new
-- one and swaps it — a no-op for the data.
--
-- Apply to the live DB:
--   wrangler d1 execute performancextra --file db/migrations/0015_completions_per_assignment.sql --remote
CREATE TABLE IF NOT EXISTS completions_new (
  athlete_id    TEXT NOT NULL REFERENCES users(id),
  activity_id   TEXT NOT NULL,
  assignment_id TEXT NOT NULL DEFAULT '',
  completed_at  INTEGER NOT NULL,
  PRIMARY KEY (athlete_id, activity_id, assignment_id)
);
INSERT OR IGNORE INTO completions_new (athlete_id, activity_id, assignment_id, completed_at)
  SELECT athlete_id, activity_id, COALESCE(assignment_id, ''), completed_at FROM completions;
DROP TABLE completions;
ALTER TABLE completions_new RENAME TO completions;
CREATE INDEX IF NOT EXISTS idx_completions_assignment ON completions(assignment_id);
