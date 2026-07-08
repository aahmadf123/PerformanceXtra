-- Migration 0020: page revisions + autosave working copy.
--
-- page_revisions is an append-only history: every explicit "Save page" snapshots the
-- page's PREVIOUS state first, and the API prunes each page to its latest 20 rows so
-- the table stays small (and well within D1 free-tier write limits).
--
-- pages.draft_title/draft_blocks hold the autosaved working copy while a super admin
-- edits: autosave writes ONLY these columns, so a published page never changes publicly
-- until the editor explicitly saves/publishes (which clears the working copy).
--
-- Apply to the live DB (run AFTER 0019):
--   wrangler d1 execute performancextra --file db/migrations/0020_revisions.sql --remote
--
-- The ALTER TABLE statements fail harmlessly if re-run (duplicate column).

CREATE TABLE IF NOT EXISTS page_revisions (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id  TEXT NOT NULL,     -- pages.id (slug); rows are pruned, not FK-cascaded
  title    TEXT NOT NULL,
  blocks   TEXT NOT NULL,     -- JSON array snapshot
  status   TEXT,              -- lifecycle at snapshot time
  saved_at INTEGER NOT NULL,
  saved_by TEXT               -- editor's user id
);
CREATE INDEX IF NOT EXISTS idx_page_revisions_page ON page_revisions(page_id, id);

ALTER TABLE pages ADD COLUMN draft_title  TEXT;
ALTER TABLE pages ADD COLUMN draft_blocks TEXT;
