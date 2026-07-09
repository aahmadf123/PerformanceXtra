-- Migration 0022: media library folders.
--
-- Adds an optional `folder` label to media rows so the library can be grouped/filtered.
-- NULL/empty = the default "All images" bucket. Search is client-side over the loaded list.
--
-- Apply to the live DB (run AFTER 0021):
--   wrangler d1 execute performancextra --file db/migrations/0022_media_folders.sql --remote
--
-- The ALTER TABLE fails harmlessly if re-run (duplicate column).

ALTER TABLE media ADD COLUMN folder TEXT;
