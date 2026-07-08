-- Migration 0019: CMS media library metadata. The image bytes live in the R2 bucket
-- bound as MEDIA (key = 'media/<id>.<ext>'); this table is the browsable index the
-- Appearance -> Media panel lists and the image picker searches. Deleting a media row
-- also deletes the R2 object (handled in the API).
--
-- Apply to the live DB (run AFTER 0018):
--   wrangler d1 execute performancextra --file db/migrations/0019_media.sql --remote
--
-- Idempotent: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS media (
  id         TEXT PRIMARY KEY,   -- random id; also the R2 key stem
  key        TEXT NOT NULL,      -- full R2 object key, e.g. 'media/abc123.webp'
  filename   TEXT NOT NULL,      -- original filename, for display
  mime       TEXT NOT NULL,      -- image/jpeg | image/png | image/webp | image/gif
  size       INTEGER NOT NULL,   -- bytes as stored
  alt        TEXT,               -- default alt text
  created_at INTEGER NOT NULL,
  created_by TEXT                -- uploader's user id
);
