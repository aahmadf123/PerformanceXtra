-- Migration 0007: super-admin "Appearance" CMS — site-wide theme tokens and a
-- block-based page builder. Both are global (not per-coach): one site_settings row
-- per key and one pages row per slug, edited only by a super admin and applied to
-- everyone (the GET endpoints are public so the signed-out login page themes too).
--
-- Apply to the live DB (run AFTER 0006):
--   wrangler d1 execute performancextra --file db/migrations/0007_site_builder.sql --remote
--
-- Idempotent: CREATE TABLE IF NOT EXISTS.

-- Theme tokens + brand/site config. value is a JSON blob keyed by `key`:
--   key 'theme' -> { accent, ember, bg, surface, ink, line, danger, warn,
--                    radius, space, fontBody, fontDisplay, fontScale }
--   key 'site'  -> { brandName, brandTag, ... }  (brand/nav copy)
-- Token keys map 1:1 to the CSS custom properties in styles.css :root, so applying
-- a saved theme is a pure CSS-variable override at runtime (no rebuild).
CREATE TABLE IF NOT EXISTS site_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,                 -- JSON blob
  updated_at INTEGER NOT NULL
);

-- Builder pages. Blocks are stored as an ordered JSON array on the row (D1-friendly:
-- one read, atomic write, ordering intrinsic to the array — no join/position table).
--   blocks JSON: [ { id, type, props }, ... ]  in render order
--   type is one of a server-enforced whitelist: hero|heading|text|image|cards|button|spacer
CREATE TABLE IF NOT EXISTS pages (
  id         TEXT PRIMARY KEY,              -- slug, e.g. 'landing'
  title      TEXT NOT NULL,
  blocks     TEXT NOT NULL DEFAULT '[]',    -- JSON array of blocks
  published  INTEGER NOT NULL DEFAULT 0,    -- 1 = visible to the public GET
  updated_at INTEGER NOT NULL
);
