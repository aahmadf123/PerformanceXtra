-- Migration 0018: multi-page management for the Appearance page builder.
-- Pages gain a draft/published lifecycle, SEO description, optional nav placement,
-- and a created_at stamp. The legacy `published` flag is kept in sync by the API
-- (status='published' <=> published=1) so an un-migrated client keeps working.
--
-- Apply to the live DB (run AFTER 0017):
--   wrangler d1 execute performancextra --file db/migrations/0018_pages_v2.sql --remote
--
-- Idempotent-ish: ALTER TABLE ADD COLUMN fails if the column already exists, so each
-- statement is safe to run exactly once; re-running the whole file is a no-op failure
-- you can ignore (D1 reports the duplicate column and changes nothing).

ALTER TABLE pages ADD COLUMN status      TEXT;     -- 'draft' | 'published' (NULL = derive from published flag)
ALTER TABLE pages ADD COLUMN description TEXT;     -- meta/SEO description shown in page lists
ALTER TABLE pages ADD COLUMN nav_label   TEXT;     -- when set, the page appears as a nav link with this label
ALTER TABLE pages ADD COLUMN nav_order   INTEGER;  -- sort order among nav links (NULL = not in nav)
ALTER TABLE pages ADD COLUMN created_at  INTEGER;

-- Backfill status from the legacy flag.
UPDATE pages SET status = CASE WHEN published = 1 THEN 'published' ELSE 'draft' END WHERE status IS NULL;
UPDATE pages SET created_at = updated_at WHERE created_at IS NULL;
