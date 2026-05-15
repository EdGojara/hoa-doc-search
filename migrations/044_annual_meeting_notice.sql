-- ============================================================================
-- 044_annual_meeting_notice.sql
-- ----------------------------------------------------------------------------
-- Schema additions to back the Annual Meeting Notice + Proxy/Absentee Ballot
-- + Candidate Statements renderer (lib/nominations/annual_meeting_notice.js).
--
-- The renderer takes structured data per cycle + per candidate. This migration
-- adds the columns the UI will write into. All fields are nullable / have
-- defaults so existing cycles continue to render via the renderer's sensible
-- defaults (Canyon Gate-quality output) until a community is configured.
--
-- Apply AFTER 043. Idempotent.
-- ============================================================================

BEGIN;

-- 1) Cycle-level meeting-notice knobs ---------------------------------------
ALTER TABLE nomination_cycles
  -- Agenda: ordered array of strings. Empty/null = use the Bedrock default.
  ADD COLUMN IF NOT EXISTS agenda_items                  JSONB NULL,
  -- Voting methods + per-method deadlines. Structure:
  --   { online:    { enabled, close_date, close_time, instructions },
  --     mail:      { enabled, receive_by_date, receive_by_time, return_address },
  --     email:     { enabled, receive_by_date, receive_by_time, address },
  --     drop_off:  { enabled, receive_by_date, receive_by_time, location_name, location_address },
  --     in_person: { enabled } }
  ADD COLUMN IF NOT EXISTS voting_methods                JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Director term length in years. Bedrock default = 3.
  ADD COLUMN IF NOT EXISTS term_years                    INTEGER NULL DEFAULT 3 CHECK (term_years IS NULL OR (term_years > 0 AND term_years <= 10)),
  -- TX §209.00592 disclosure presentation. 'callout' = boxed (Canyon Gate
  -- style); 'embedded' = inline in proxy paragraph (Waterview 2024 style).
  -- 'omitted' is NOT supported — disclosure is statutorily required.
  ADD COLUMN IF NOT EXISTS tx_209_disclosure_style       TEXT NOT NULL DEFAULT 'callout'
    CHECK (tx_209_disclosure_style IN ('callout','embedded')),
  -- Optional "Registration commences at..." preamble for in-person voting.
  ADD COLUMN IF NOT EXISTS registration_time             TEXT NULL,
  -- Override rule wording — what happens when multiple votes are submitted.
  -- NULL = use the Bedrock default in the renderer.
  ADD COLUMN IF NOT EXISTS vote_override_rule            TEXT NULL,
  -- Label used on the proxy ballot Option 1. Default 'Quorum Only'.
  ADD COLUMN IF NOT EXISTS quorum_only_label             TEXT NULL DEFAULT 'Quorum Only',
  -- Allow write-in candidates on the directed ballot. Most communities yes.
  ADD COLUMN IF NOT EXISTS write_in_allowed              BOOLEAN NOT NULL DEFAULT TRUE,
  -- Notice generation tracking
  ADD COLUMN IF NOT EXISTS notice_pdf_storage_path       TEXT NULL,
  ADD COLUMN IF NOT EXISTS notice_generated_at           TIMESTAMPTZ NULL;

-- 2) Per-candidate additions for the candidate-statements page --------------
ALTER TABLE nominations
  -- Photo storage path (uploaded by the candidate or by staff after the
  -- nomination is submitted). The Bedrock storage bucket holds the file;
  -- this is just a pointer.
  ADD COLUMN IF NOT EXISTS photo_storage_path            TEXT NULL,
  -- Years in community — Waterview's template displays this prominently.
  -- Free-form ('10 years', '2005', etc.) so we don't fight the data.
  ADD COLUMN IF NOT EXISTS years_in_community            TEXT NULL,
  -- Flag — convenience for renderer; lets the slate label "(incumbent)" next
  -- to a candidate without joining to a roster table.
  ADD COLUMN IF NOT EXISTS is_incumbent                  BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;

-- Verify:
--   SELECT id, community_name, term_years, tx_209_disclosure_style,
--          jsonb_pretty(voting_methods) AS voting_methods,
--          jsonb_array_length(COALESCE(agenda_items, '[]'::jsonb)) AS agenda_count
--     FROM nomination_cycles ORDER BY created_at DESC LIMIT 3;
--   SELECT id, nominee_name, is_incumbent, years_in_community,
--          (photo_storage_path IS NOT NULL) AS has_photo
--     FROM nominations LIMIT 10;
