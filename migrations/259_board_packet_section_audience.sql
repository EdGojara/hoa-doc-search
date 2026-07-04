-- ============================================================================
-- 259_board_packet_section_audience.sql
-- ----------------------------------------------------------------------------
-- Audience control per board-packet section (Ed 2026-07-02): a packet produces
-- a BOARD version (everything) and an ATTENDEES/homeowner version (only sections
-- cleared for sharing). This is a PRIVACY control — the homeowner copy must
-- never carry owner-level delinquency balances, violation detail, or legal
-- status. So the owner-PII sections default to board-only; staff adjust the
-- rest per meeting.
--
-- audience: 'both' (board + attendees), 'board' (board only), 'attendees'
-- (attendee handout only). Render rule: Board = audience in (both, board);
-- Attendees = audience in (both, attendees). Board-only is structurally
-- impossible to leak into the attendee PDF.
-- ============================================================================
BEGIN;

ALTER TABLE board_packet_sections
  ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'both'
    CHECK (audience IN ('both', 'board', 'attendees'));

ALTER TABLE board_packet_section_templates
  ADD COLUMN IF NOT EXISTS default_audience text NOT NULL DEFAULT 'both'
    CHECK (default_audience IN ('both', 'board', 'attendees'));

-- Owner-PII sections default to BOARD ONLY (delinquencies/AR aging with names,
-- deed-restriction violation detail). New packets inherit this; existing
-- packets get backfilled so a homeowner PDF is safe by default.
UPDATE board_packet_section_templates SET default_audience = 'board'
  WHERE section_key IN ('ar_aging', 'drv');
UPDATE board_packet_sections SET audience = 'board'
  WHERE section_key IN ('ar_aging', 'drv');

COMMIT;
