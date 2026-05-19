-- Board packet section templates — clarify the 'drv' (budget variance) label
-- and add a new 'violations_summary' section for actual deed restriction
-- violations.
-- ---------------------------------------------------------------------------
-- The 'drv' section_key in this codebase has always meant "Doctivity
-- Variance Report" (Vantaca's budget-vs-actual module). It has never meant
-- deed restriction violations. To stop the confusion, the display label
-- becomes "Budget vs. Actual (Doctivity)" — operators see what it actually
-- is on the card.
--
-- The actual DRV summary (open violations, certified §209 letters,
-- at-legal cases, pending hearings) gets its own section: 'violations_summary'.
-- Today it's populated from a Vantaca Violation Report Detail PDF upload;
-- when Bedrock's DRV stack fully replaces Vantaca, the same section will
-- auto-fill from trustEd's own violations table (supports_auto_trusted=true
-- is already set for that future path).

-- 1) Rename the existing budget-variance section for clarity
UPDATE board_packet_section_templates
SET display_name = 'Budget vs. Actual (Doctivity)',
    description  = 'Budget-to-actual variance analysis with AI-voiced commentary on material variances'
WHERE section_key = 'drv';

-- 2) Add the new violations summary section (between AR Aging and Vendor Activity)
INSERT INTO board_packet_section_templates
  (section_key, display_name, description, default_order, required_default,
   supports_manual, supports_upload, supports_auto_trusted, supports_ai_generated, data_schema_hint)
VALUES
  ('violations_summary',
   'Deed Restriction Violations',
   'Open violations summary — counts by stage (first notice / second notice / certified §209 / pending hearing / monthly fine), top categories, at-legal cases, top problem properties',
   75,
   FALSE,                               -- required_default — opt-in per packet
   FALSE,                               -- supports_manual — operator doesn''t type the whole report
   TRUE,                                -- supports_upload — Vantaca Violation Report PDF
   TRUE,                                -- supports_auto_trusted — future: auto-fill from trustEd violations table
   FALSE,                               -- supports_ai_generated
   '{"report_period":null,"total_violations":0,"by_stage":{"first_notice":0,"second_notice":0,"certified_letter_notice":0,"pending_hearing":0,"monthly_fine_assessed":0,"closed":0},"top_categories":[],"certified_cases":[],"fine_assessed_cases":[],"pending_hearing_cases":[],"watchouts":[],"narrative":""}'::jsonb)
ON CONFLICT (section_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  default_order = EXCLUDED.default_order,
  required_default = EXCLUDED.required_default,
  supports_manual = EXCLUDED.supports_manual,
  supports_upload = EXCLUDED.supports_upload,
  supports_auto_trusted = EXCLUDED.supports_auto_trusted,
  supports_ai_generated = EXCLUDED.supports_ai_generated,
  data_schema_hint = EXCLUDED.data_schema_hint;
