-- Migration 0021: flexible check-in scores (editable dimensions & scales).
--
-- Adds a JSON `scores` column to checkins so the athlete daily check-in's dimensions and
-- their 1..N scales become super-admin editable (config in site_settings key 'checkin').
-- scores is an object keyed by dimension key, e.g. {"mood":4,"energy":3,"stress":2}.
--
-- The legacy mood/energy/stress columns are KEPT (nullable) and dual-written for the three
-- built-in dimensions, so an emergency rollback to the pre-0021 Worker still shows recent
-- check-ins (same "keep the legacy column in sync" idea as pages.published in 0018).
-- Removing/renaming a dimension never deletes its historical scores — old keys are simply
-- ignored by a config that no longer lists them.
--
-- Apply to the live DB (run AFTER 0020):
--   wrangler d1 execute performancextra --file db/migrations/0021_checkin_scores.sql --remote
--
-- The ALTER TABLE fails harmlessly if re-run (duplicate column); the backfill is idempotent.

ALTER TABLE checkins ADD COLUMN scores TEXT;

UPDATE checkins
   SET scores = json_object('mood', mood, 'energy', energy, 'stress', stress)
 WHERE scores IS NULL;
