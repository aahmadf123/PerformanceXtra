-- Migration 0016: fix the "Competitve Mindset" subtopic typo in stored activity data.
--
-- The misspelling came from one cell in the source spreadsheet (Master Repository
-- E182 → ACT-181) and rode into base_activities via the seed. The spreadsheet,
-- data.js and db/seed_activities.sql are fixed at source in the same change; this
-- migration repairs the payloads already sitting in the live database.
--
-- Idempotent: replace() is a no-op once the string is gone. Sweeps the override and
-- custom payloads too in case the typo was copied into an edit.
--
-- Apply to the live DB:
--   wrangler d1 execute performancextra --file db/migrations/0016_taxonomy_typo.sql --remote
UPDATE base_activities    SET payload = replace(payload, 'Competitve Mindset', 'Competitive Mindset') WHERE payload LIKE '%Competitve Mindset%';
UPDATE custom_activities  SET payload = replace(payload, 'Competitve Mindset', 'Competitive Mindset') WHERE payload LIKE '%Competitve Mindset%';
UPDATE activity_overrides SET payload = replace(payload, 'Competitve Mindset', 'Competitive Mindset') WHERE payload IS NOT NULL AND payload LIKE '%Competitve Mindset%';
-- Vocabulary rows: move-or-merge the misspelled value onto the correct one.
UPDATE OR IGNORE taxonomy SET value = 'Competitive Mindset' WHERE value = 'Competitve Mindset';
DELETE FROM taxonomy WHERE value = 'Competitve Mindset';
