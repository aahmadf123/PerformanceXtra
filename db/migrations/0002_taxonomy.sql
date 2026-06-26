-- Migration 0002: coach-managed taxonomy (topics / subtopics / content types).
-- Lets a non-technical admin add / rename / merge / remove the dropdown
-- vocabularies in-app, persisted server-side so it survives redeploys. When a
-- coach has no rows here the app falls back to the built-in vocabulary shipped
-- in data.js (window.PX_TAXONOMY).
--
-- Apply to the live DB:
--   wrangler d1 execute performancextra --file db/migrations/0002_taxonomy.sql --remote
CREATE TABLE IF NOT EXISTS taxonomy (
  coach_id TEXT NOT NULL REFERENCES users(id),
  kind     TEXT NOT NULL CHECK (kind IN ('topic','subtopic','type')),
  value    TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (coach_id, kind, value)
);
CREATE INDEX IF NOT EXISTS idx_taxonomy_coach ON taxonomy(coach_id);
