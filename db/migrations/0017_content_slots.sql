-- Migration 0017: editable site copy ("content slots"). Every piece of previously
-- hardcoded user-facing text (header brand, signed-out hero, section intros, footer)
-- gets a stable slot key. This table stores only OVERRIDES — the original copy stays
-- in the client as the default for each key (same pattern as DEFAULT_THEME in
-- site_settings: defaults in code, DB rows override). An empty table therefore
-- renders the site exactly as before, and "Reset to default" simply deletes the row.
--
-- Keys are validated server-side against a whitelist (CONTENT_SLOTS in the API), so
-- a malformed save can't inject arbitrary keys or oversized blobs. Reads are public
-- (the signed-out landing page shows slot copy); writes are super-admin only.
--
-- Apply to the live DB (run AFTER 0016):
--   wrangler d1 execute performancextra --file db/migrations/0017_content_slots.sql --remote
--
-- Idempotent: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS content_slots (
  key        TEXT PRIMARY KEY,   -- e.g. 'hero.title', 'repo.intro', 'footer.text'
  value      TEXT NOT NULL,      -- plain text override for this slot
  updated_at INTEGER NOT NULL
);
