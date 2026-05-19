-- Repurpose section_key='drv' to be what its name literally means: Deed
-- Restriction Violations. The prior "Doctivity Variance Report" label was
-- a mislabel (Doctivity is Vantaca's compliance module, not budget variance).
-- Drops the redundant 'violations_summary' template added in migration 068.
-- ---------------------------------------------------------------------------
-- Safe to run after 068. Idempotent.

-- 1) Repoint 'drv' to actually mean Deed Restriction Violations
UPDATE board_packet_section_templates
SET display_name        = 'Deed Restriction Violations',
    description         = 'Open violations summary — counts by stage (first notice / second notice / certified §209 / pending hearing / monthly fine), top categories, at-legal cases, top problem properties',
    default_order       = 75,
    required_default    = FALSE,
    supports_manual     = FALSE,
    supports_upload     = TRUE,
    supports_auto_trusted = TRUE,
    supports_ai_generated = FALSE,
    data_schema_hint    = '{"report_period":null,"total_violations":0,"by_stage":{"first_notice":0,"second_notice":0,"certified_letter_notice":0,"pending_hearing":0,"monthly_fine_assessed":0,"closed":0},"top_categories":[],"certified_cases":[],"fine_assessed_cases":[],"pending_hearing_cases":[],"watchouts":[],"narrative":""}'::jsonb
WHERE section_key = 'drv';

-- 2) Drop the redundant 'violations_summary' template introduced in 068.
--    Any packets that auto-seeded this section get the rows removed too —
--    safe because migration 068 just shipped and these sections will have
--    been empty placeholders.
DELETE FROM board_packet_sections
 WHERE section_key = 'violations_summary';
DELETE FROM board_packet_section_templates
 WHERE section_key = 'violations_summary';

-- 3) Existing 'drv' sections (created under the old budget-variance label)
--    likely have either empty input_data or stale variance JSON. Reset
--    them back to 'pending' status so operators can re-upload the right
--    PDF for the new shape; preserves the row + audit trail.
UPDATE board_packet_sections
SET    input_data = '{}'::jsonb,
       status     = 'pending',
       input_mode = 'upload'
WHERE  section_key = 'drv'
  AND  status NOT IN ('skipped');
