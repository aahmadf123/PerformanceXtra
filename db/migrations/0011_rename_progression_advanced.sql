-- Migration 0011: rename the progression bucket "Extra Activities" to "Advanced".
-- Progression is stored inside each activity's JSON payload (base_activities,
-- custom_activities) and inside per-coach override payloads (activity_overrides),
-- not as its own column — so this rewrites the value in place with REPLACE(). The
-- payloads are minified JSON (no space after the colon), matching how the API's
-- JSON.stringify and db/seed_activities.sql write them. The client's ordered
-- progression list (window.PX_TAXONOMY in data.js) is updated in the same change.
--
-- Apply to the live DB (idempotent — re-running is a no-op once no old value remains):
--   wrangler d1 execute performancextra --file db/migrations/0011_rename_progression_advanced.sql --remote
--
-- If you instead re-run the regenerated db/seed_activities.sql, base_activities already
-- come back as "Advanced"; the custom_activities / activity_overrides updates below are
-- still needed for any coach-created or overridden activities.

UPDATE base_activities
   SET payload = REPLACE(payload, '"progression":"Extra Activities"', '"progression":"Advanced"')
 WHERE payload LIKE '%"progression":"Extra Activities"%';

UPDATE custom_activities
   SET payload = REPLACE(payload, '"progression":"Extra Activities"', '"progression":"Advanced"')
 WHERE payload LIKE '%"progression":"Extra Activities"%';

UPDATE activity_overrides
   SET payload = REPLACE(payload, '"progression":"Extra Activities"', '"progression":"Advanced"')
 WHERE payload IS NOT NULL AND payload LIKE '%"progression":"Extra Activities"%';
