-- Migration 0014: publish super-admin content stranded in a private scope (one-time
-- production repair, written idempotently — re-running is a no-op).
--
-- INCIDENT (2026-07): the super admin ("Super Admin Test", id below) edited activities
-- and taxonomy from the Repository tab, whose edits save to the editor's PRIVATE scope.
-- 84 taxonomy rows, 17 activity overrides and 1 custom activity accumulated under their
-- own coach_id while the shared global-library owner (usr_global_library) had ZERO rows
-- — so no coach ever saw any of those changes ("changes not reflected for Coach1").
-- The companion code change makes super-admin edits save to the global library by
-- default; this migration rescues the rows that were already stranded.
--
-- Move-or-merge pattern: taxonomy and activity_overrides have composite PKs that
-- include coach_id, so UPDATE OR IGNORE moves each row unless an identical global row
-- already exists, and the DELETE clears whatever the move skipped. custom_activities
-- is keyed by id alone, so a plain UPDATE is already idempotent.
--
-- Also re-points any assignment created BY an admin/super admin at an athlete they
-- don't directly coach to that athlete's real coach, matching the new ownership rule
-- (assignments are always recorded under the athlete's own coach).
--
-- Apply to the live DB:
--   wrangler d1 execute performancextra --file db/migrations/0014_promote_global_content.sql --remote

UPDATE OR IGNORE taxonomy SET coach_id = 'usr_global_library'
  WHERE coach_id = '21a030d6-e4ef-4b3c-a51e-4ca45cc322bf';
DELETE FROM taxonomy WHERE coach_id = '21a030d6-e4ef-4b3c-a51e-4ca45cc322bf';

UPDATE OR IGNORE activity_overrides SET coach_id = 'usr_global_library'
  WHERE coach_id = '21a030d6-e4ef-4b3c-a51e-4ca45cc322bf';
DELETE FROM activity_overrides WHERE coach_id = '21a030d6-e4ef-4b3c-a51e-4ca45cc322bf';

UPDATE custom_activities SET coach_id = 'usr_global_library'
  WHERE coach_id = '21a030d6-e4ef-4b3c-a51e-4ca45cc322bf';

-- Re-point admin/super-admin-created assignments to the athlete's real coach (only
-- when the athlete HAS a coach and it differs from the recorded creator).
UPDATE assignments
SET coach_id = (SELECT u.coach_id FROM users u WHERE u.id = assignments.athlete_id)
WHERE coach_id IN (SELECT id FROM users WHERE is_admin = 1 OR is_superadmin = 1)
  AND (SELECT u.coach_id FROM users u WHERE u.id = assignments.athlete_id) IS NOT NULL
  AND coach_id != (SELECT u.coach_id FROM users u WHERE u.id = assignments.athlete_id);
