-- ============================================================================
-- 408_lunch_menu_cache.sql  (Ed 2026-09-05)
-- ----------------------------------------------------------------------------
-- The menu data Tessa answers "what's for lunch Wednesday" from. trustEd's
-- server can't read Lunchdrop (no API, login-walled), so a BROWSER capture (a
-- scheduled job on Ed's signed-in session, or an on-demand run) scrapes the
-- week's days/restaurants/menus and writes them here via
-- POST /api/tessa/lunch/menu-capture. Tessa then reads from this cache — the
-- browser is the eyes, Tessa reads what the eyes wrote down.
--
-- Record ownership: WORKPAPER (Bedrock-internal EA data, not an HOA record).
-- One row per (office, date, restaurant); re-capture overwrites (idempotent).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS lunch_menu_cache (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  office          text NOT NULL DEFAULT 'boxer',   -- Lunchdrop office/building key
  lunch_date      date NOT NULL,
  restaurant_name text,
  restaurant_slug text NOT NULL,                    -- Lunchdrop's per-restaurant id
  order_url       text,
  cutoff_text     text,                             -- e.g. "Order by 10:30am Wednesday"
  items           jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{name, price_cents, description}]
  captured_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (office, lunch_date, restaurant_slug)
);
CREATE INDEX IF NOT EXISTS idx_lunch_menu_date ON lunch_menu_cache (office, lunch_date);

GRANT SELECT, INSERT, UPDATE, DELETE ON lunch_menu_cache TO service_role;
GRANT SELECT ON lunch_menu_cache TO authenticated;

COMMIT;
