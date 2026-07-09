
-- Migration 0023: reusable page sections (saved block groups).
--
-- A super admin can save a group of page-builder blocks as a named "section" and insert it
-- into any page. blocks is the same sanitized JSON-array shape as pages.blocks; inserting a
-- section splices its blocks into the page draft (they are re-sanitized on the page's save).
--
-- Apply to the live DB (run AFTER 0022):
--   wrangler d1 execute performancextra --file db/migrations/0023_page_sections.sql --remote

CREATE TABLE IF NOT EXISTS page_sections (
  id         TEXT PRIMARY KEY,              -- random id
  name       TEXT NOT NULL,                 -- display name
  blocks     TEXT NOT NULL DEFAULT '[]',    -- JSON array of blocks (same shape as pages.blocks)
  updated_at INTEGER NOT NULL
);
