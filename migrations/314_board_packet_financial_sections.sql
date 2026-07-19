-- ===========================================================================
-- 314_board_packet_financial_sections.sql
-- ---------------------------------------------------------------------------
-- Record ownership: board_packet_section_templates is Bedrock configuration
-- (workpaper); board_packet_sections rows are `mixed` (delivered packet =
-- association_record, drafting state = workpaper) — unchanged by this migration.
--
-- WHY: the board-package engine profile (lib/board_package/engine.js
-- DEFAULT_PROFILE) lists a full Financials group — bank-rec, AR aging,
-- delinquency, AP approval, reserve activity — and Paige's readiness dashboard
-- scores against it. But packets are SEEDED from board_packet_section_templates,
-- which only had ar_aging. So readiness would say "9 ready" while assemble could
-- only ever fill the sections that had a template row. Four Financials sections
-- (bank_rec, delinquency, ap_approval, reserve_activity) had no template, so
-- they never seeded and Paige silently skipped them.
--
-- This adds those four template rows (so every NEW packet seeds them) and
-- backfills them into existing DRAFT packets (so in-flight packets get them
-- too). All four now auto-fill natively from the trustEd GL / bank-rec /
-- reserve modules via api/board_packets.js autoFillSection.
-- ===========================================================================
BEGIN;

-- section_key is the PRIMARY KEY, so ON CONFLICT DO NOTHING is safe + idempotent.
INSERT INTO board_packet_section_templates
  (section_key, display_name, description, default_order, required_default,
   supports_manual, supports_upload, supports_auto_trusted, supports_ai_generated,
   default_audience, data_schema_hint)
VALUES
  ('bank_rec', 'Bank-reconciliation status',
   'Is each bank account reconciled through the reporting period, and does the bank balance tie to the GL. Pulled natively from the bank-reconciliation module.',
   60, TRUE, FALSE, TRUE, TRUE, FALSE, 'both',
   '{"accounts":[{"account":"Operating","period_end":"2026-06-30","status":"reconciled","difference":0}],"all_reconciled":true}'::jsonb),

  ('delinquency', 'Delinquency & collections',
   'Past-due homeowner accounts the board acts on — over-60 exposure, collection status, per-account list. Native from the GL AR subledger.',
   72, TRUE, TRUE, TRUE, TRUE, FALSE, 'board',
   '{"total_ar":0,"over_60":0,"delinquent_count":0,"accounts":[{"address":"","owner":"","balance":0,"oldest_days":0}]}'::jsonb),

  ('ap_approval', 'AP / invoice approval list',
   'Open vendor payables the board is approving to pay, aged and grouped by vendor. Native from the GL AP subledger.',
   73, TRUE, FALSE, TRUE, TRUE, FALSE, 'both',
   '{"total_ap":0,"vendor_count":0,"vendors":[{"name":"","category":"","balance":0,"open_count":0}]}'::jsonb),

  ('reserve_activity', 'Reserve activity & cash balances',
   'Reserve cash position, study funding targets, and components scheduled for replacement this year. Native from the GL + reserve study.',
   74, TRUE, FALSE, TRUE, TRUE, FALSE, 'both',
   '{"year":2026,"reserve_balance":0,"has_study":true,"recommended_contribution":0,"components_due":[{"name":"","cost":0}]}'::jsonb)
ON CONFLICT (section_key) DO NOTHING;

-- Backfill the four sections into existing DRAFT packets so in-flight packages
-- get them without a rebuild. Only draft packets (never finalized/sent ones —
-- those are immutable per project_record_immutability). Skipped for any packet
-- that already has the row (idempotent via the UNIQUE (packet_id, section_key)).
INSERT INTO board_packet_sections (packet_id, section_key, section_order, input_mode, status, audience)
SELECT p.id, t.section_key, t.default_order, 'auto_from_trusted', 'pending', t.default_audience
FROM board_packets p
CROSS JOIN board_packet_section_templates t
WHERE p.status = 'draft'
  AND t.section_key IN ('bank_rec', 'delinquency', 'ap_approval', 'reserve_activity')
  AND NOT EXISTS (
    SELECT 1 FROM board_packet_sections s
    WHERE s.packet_id = p.id AND s.section_key = t.section_key
  )
ON CONFLICT (packet_id, section_key) DO NOTHING;

COMMIT;
