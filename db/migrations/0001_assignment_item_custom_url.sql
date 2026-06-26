-- Migration 0001: per-student custom link override on assignment items.
-- A coach can override an activity's link for one athlete (e.g. a document in
-- that athlete's private folder) without changing the shared activity.
--
-- Apply to the live DB:
--   wrangler d1 execute performancextra --file db/migrations/0001_assignment_item_custom_url.sql --remote
--
-- Additive and idempotent-ish: re-running errors with "duplicate column" only if
-- already applied, which is safe to ignore.
ALTER TABLE assignment_items ADD COLUMN custom_url TEXT;
