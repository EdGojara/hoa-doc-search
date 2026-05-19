-- Split the single 'financials' section into separate 'balance_sheet' and
-- 'income_statement' sections so operators can upload each as its own PDF
-- without one wiping the other (the merge-after-extract approach in
-- api/board_packets.js was vulnerable to model hallucination filling in
-- the missing statement's shape and overwriting real prior data).
-- ---------------------------------------------------------------------------
-- Safe to run after 069. Idempotent.

-- 1) Add the two new section templates
INSERT INTO board_packet_section_templates
  (section_key, display_name, description, default_order, required_default,
   supports_manual, supports_upload, supports_auto_trusted, supports_ai_generated, data_schema_hint)
VALUES
  ('balance_sheet',
   'Balance Sheet',
   'Fund-balance position — Operating / Reserves / Savings / Total — with section subtotals and cash position headline',
   50,
   TRUE,
   FALSE,
   TRUE,
   TRUE,
   FALSE,
   '{"as_of_date":null,"assets":[],"asset_subtotals":[],"liabilities":[],"liability_subtotals":[],"equity":[],"equity_subtotals":[],"totals":{},"fund_cash_summary":{"operating":null,"reserves":null,"savings":null},"narrative":"","watchouts":[]}'::jsonb),

  ('income_statement',
   'Income Statement',
   'Statement of Revenues and Expenses — current period or 12-month trailing — with fund grouping and budget variance',
   55,
   TRUE,
   FALSE,
   TRUE,
   TRUE,
   FALSE,
   '{"period_label":null,"total_revenue":null,"total_expense":null,"net_income":null,"current_period":null,"by_fund":null,"trailing_months":[],"line_items":[],"narrative":"","watchouts":[]}'::jsonb)
ON CONFLICT (section_key) DO UPDATE SET
  display_name           = EXCLUDED.display_name,
  description            = EXCLUDED.description,
  default_order          = EXCLUDED.default_order,
  required_default       = EXCLUDED.required_default,
  supports_manual        = EXCLUDED.supports_manual,
  supports_upload        = EXCLUDED.supports_upload,
  supports_auto_trusted  = EXCLUDED.supports_auto_trusted,
  supports_ai_generated  = EXCLUDED.supports_ai_generated,
  data_schema_hint       = EXCLUDED.data_schema_hint;

-- 2) Retire the old combined 'financials' section template — keep the row
--    for any historic data already pinned to it, but flip its display name
--    so existing packets show it as legacy and supports_upload=FALSE so the
--    UI no longer offers the upload action that wipes data.
UPDATE board_packet_section_templates
SET    display_name      = 'Financial Statements (legacy combined)',
       description       = 'Superseded by separate Balance Sheet and Income Statement sections. Existing data preserved for reference.',
       required_default  = FALSE,
       supports_upload   = FALSE,
       supports_auto_trusted = FALSE
WHERE  section_key = 'financials';

-- 3) Backfill: every existing packet gets a balance_sheet + income_statement
--    section row (pending, upload mode). Skip packets that already have one.
INSERT INTO board_packet_sections (packet_id, section_key, section_order, input_mode, input_data, status)
SELECT bp.id, 'balance_sheet', 50, 'upload', '{}'::jsonb, 'pending'
FROM   board_packets bp
WHERE  NOT EXISTS (
  SELECT 1 FROM board_packet_sections bs
  WHERE  bs.packet_id = bp.id AND bs.section_key = 'balance_sheet'
);

INSERT INTO board_packet_sections (packet_id, section_key, section_order, input_mode, input_data, status)
SELECT bp.id, 'income_statement', 55, 'upload', '{}'::jsonb, 'pending'
FROM   board_packets bp
WHERE  NOT EXISTS (
  SELECT 1 FROM board_packet_sections bs
  WHERE  bs.packet_id = bp.id AND bs.section_key = 'income_statement'
);

-- 4) For existing 'financials' sections on existing packets, mark them
--    skipped so they don't appear in TOC. Their data stays intact for any
--    operator who wants to inspect it.
UPDATE board_packet_sections
SET    status = 'skipped'
WHERE  section_key = 'financials'
  AND  status NOT IN ('skipped');
