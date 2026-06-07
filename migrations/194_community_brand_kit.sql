-- ============================================================================
-- 194_community_brand_kit.sql
-- ----------------------------------------------------------------------------
-- Ed 2026-06-08 — Bedrock-as-invisible-plumbing principle applied to email
-- letterheads (and downstream: portals, PDFs, anything customer-facing).
--
-- Every community-facing artifact should read as the COMMUNITY's voice,
-- not Bedrock's. The homeowner's relationship is with their community, not
-- with their management company. Bedrock appears as a small "managed by"
-- attribution at the bottom — not as the dominant visual.
--
-- This migration adds brand fields to communities so each one can carry
-- its own color, logo, and signoff signature. Defaults are NEUTRAL (not
-- Bedrock branded) — a community with no brand kit set still doesn't look
-- like a Bedrock email; it looks like a clean unbranded community email.
--
-- COLUMNS:
--   brand_primary_color   — hex, used as the letterhead band background.
--                           Defaults to neutral '#0B1D34' (dark navy) —
--                           generic enough to feel like "a community" not
--                           specifically Bedrock. Communities should set
--                           their own.
--   brand_accent_color    — hex, used for eyebrows + dividers + buttons.
--                           Defaults to '#D4AF37' (warm gold) — also
--                           generic warm accent.
--   brand_text_on_primary — 'light' or 'dark' — text color on the
--                           letterhead band. Light text for dark
--                           backgrounds, dark text for light backgrounds.
--   logo_storage_path     — Supabase storage path to the community's logo
--                           (PNG/SVG, ideally on transparent bg).
--   logo_height_px        — display height in the letterhead. Default 36.
--   signoff_signature     — closing block text. Defaults to '[Community
--                           Name] Board' but staff can override (e.g.,
--                           "The Riverstone Property Management Committee").
-- ============================================================================

BEGIN;

ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS brand_primary_color   TEXT,
  ADD COLUMN IF NOT EXISTS brand_accent_color    TEXT,
  ADD COLUMN IF NOT EXISTS brand_text_on_primary TEXT
    CHECK (brand_text_on_primary IS NULL OR brand_text_on_primary IN ('light','dark')),
  ADD COLUMN IF NOT EXISTS logo_storage_path     TEXT,
  ADD COLUMN IF NOT EXISTS logo_height_px        INTEGER,
  ADD COLUMN IF NOT EXISTS signoff_signature     TEXT;

COMMENT ON COLUMN communities.brand_primary_color IS
  'Hex color used as the email letterhead band background. When set, replaces the default neutral palette. Each community should set their own — this is what makes emails read as community correspondence, not Bedrock correspondence.';

COMMENT ON COLUMN communities.brand_accent_color IS
  'Hex color used for eyebrow text + accent lines + buttons. Defaults to a warm neutral.';

COMMENT ON COLUMN communities.brand_text_on_primary IS
  'light = white text on dark band. dark = navy text on light band. Set to match contrast with brand_primary_color.';

COMMENT ON COLUMN communities.logo_storage_path IS
  'Supabase storage path to the community logo. Embedded in the email letterhead. PNG/SVG on transparent bg recommended.';

COMMENT ON COLUMN communities.signoff_signature IS
  'Closing block text on community emails (e.g., "The Drama Creek Board" or "Riverstone Property Management Committee"). When NULL, defaults to "[Community Name] Board".';

-- ----------------------------------------------------------------------------
-- Seed Drama Creek demo community with a distinctive brand kit so the
-- email blast UI's per-community preview shows real differentiation.
-- ----------------------------------------------------------------------------
UPDATE communities
SET brand_primary_color   = '#1B4D3E',                                -- forest green — sets demo community apart from any Bedrock branding
    brand_accent_color    = '#C9A96E',                                -- warm gold-bronze
    brand_text_on_primary = 'light',
    logo_height_px        = 40,
    signoff_signature     = 'The Drama Creek Board'
WHERE id = 'dc100000-0000-4000-a000-000000000000'
  AND brand_primary_color IS NULL;

COMMIT;
