-- ===========================================================================
-- 315_board_packet_registry_sync.sql
-- ---------------------------------------------------------------------------
-- Record ownership: board_packet_section_templates is Bedrock configuration
-- (workpaper); board_packet_sections rows are `mixed` (delivered packet =
-- association_record, drafting state = workpaper) — unchanged by this migration.
--
-- WHY: the board-package section list lived in TWO places that had drifted:
--   1. lib/board_package/engine.js DEFAULT_SECTIONS — drives Paige's readiness
--      dashboard (which sections exist + how each is sourced).
--   2. board_packet_section_templates — SEEDS the per-packet board_packet_sections
--      rows and is the FK target for board_packet_sections.section_key.
-- Four keys the readiness profile scored had NO template row, so they could
-- never seed onto a packet, could never be filled, and (for the upload ones) the
-- section-list UI never showed them: prior_exec_minutes, management_report,
-- legal_matters, board_decisions. This is the same divergence class that hid the
-- five Financials sections (commit fec366f) — readiness scoring a section that
-- assemble can't seed/fill.
--
-- FIX: engine.js DEFAULT_SECTIONS is now the single canonical registry. This
-- migration adds the four missing template rows so the DB template key set
-- equals the registry key set. That equality is asserted live by
-- tests/test_board_package_registry.js (wired into `npm test`), so the two
-- lists can never silently drift again.
--
-- service_role is READ-ONLY on board_packet_section_templates, so this row
-- change goes through a numbered migration (per the 314 pattern). The existing
-- 17 template rows are intentionally left untouched — only the 4 gaps are filled.
-- ===========================================================================
BEGIN;

-- section_key is the PRIMARY KEY, so ON CONFLICT DO NOTHING is safe + idempotent.
-- default_order values slot each row into its group in the physical board book:
--   prior_exec_minutes → 35 (right after prior_minutes/30, exec material)
--   management_report  → 85 (Operations, after vendor_activity/80)
--   legal_matters      → 95 (Operations, privileged)
--   board_decisions    → 105 (Board Decisions, before appendix/110)
INSERT INTO board_packet_section_templates
  (section_key, display_name, description, default_order, required_default,
   supports_manual, supports_upload, supports_auto_trusted, supports_ai_generated,
   default_audience, data_schema_hint)
VALUES
  ('prior_exec_minutes', 'Prior Executive-Session Minutes',
   'Executive-session minutes from the previous meeting, for board approval. Board-only — never appears on the attendee/homeowner copy.',
   35, FALSE, TRUE, TRUE, FALSE, FALSE, 'board',
   '{"prior_meeting_date":null,"summary":"","motions":[]}'::jsonb),

  ('management_report', 'Management Report',
   'The manager''s written report for the meeting — operations narrative, open items, community updates. Provided by the manager (upload or manual).',
   85, TRUE, TRUE, TRUE, FALSE, FALSE, 'both',
   '{"text":"","highlights":[],"attachments":[]}'::jsonb),

  ('legal_matters', 'Legal Matters (privileged)',
   'Privileged legal-matter summary from counsel — active litigation, collections at legal, opinions. Board-only, attorney-client privileged.',
   95, FALSE, TRUE, TRUE, FALSE, FALSE, 'board',
   '{"matters":[{"caption":"","status":"","counsel":"","notes":""}]}'::jsonb),

  ('board_decisions', 'Items Requiring Board Approval',
   'The decision docket — items requiring a board vote this meeting, each with the recommendation and background. Curated by the manager; AI can draft from open action items.',
   105, TRUE, TRUE, FALSE, FALSE, TRUE, 'both',
   '{"items":[{"item":"","recommendation":"","background":"","source":""}]}'::jsonb)
ON CONFLICT (section_key) DO NOTHING;

-- Backfill the four sections into existing DRAFT packets so in-flight packages
-- pick them up without a rebuild. Only draft packets (never finalized/sent ones —
-- those are immutable per project_record_immutability). Status mirrors
-- seedSectionsForPacket: required_default TRUE → 'pending', FALSE → 'skipped';
-- input_mode mirrors the ai/manual/upload precedence. Idempotent via the
-- UNIQUE (packet_id, section_key) guard.
INSERT INTO board_packet_sections (packet_id, section_key, section_order, input_mode, status, audience)
SELECT p.id, t.section_key, t.default_order,
       CASE WHEN t.supports_ai_generated THEN 'ai_generated'
            WHEN t.supports_manual        THEN 'manual'
            WHEN t.supports_upload        THEN 'upload'
            ELSE 'manual' END,
       CASE WHEN t.required_default THEN 'pending' ELSE 'skipped' END,
       t.default_audience
FROM board_packets p
CROSS JOIN board_packet_section_templates t
WHERE p.status = 'draft'
  AND t.section_key IN ('prior_exec_minutes', 'management_report', 'legal_matters', 'board_decisions')
  AND NOT EXISTS (
    SELECT 1 FROM board_packet_sections s
    WHERE s.packet_id = p.id AND s.section_key = t.section_key
  )
ON CONFLICT (packet_id, section_key) DO NOTHING;

COMMIT;

-- ---------------------------------------------------------------------------
-- Verify (should return 21 = the engine.js DEFAULT_SECTIONS registry size):
--   SELECT COUNT(*) FROM board_packet_section_templates;
--   SELECT section_key FROM board_packet_section_templates ORDER BY default_order;
-- And that no registry key lacks a template row (expect 0 rows):
--   (run tests/test_board_package_registry.js — it does exactly this live)
-- ---------------------------------------------------------------------------
