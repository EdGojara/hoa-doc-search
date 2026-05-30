-- ============================================================================
-- 138_august_meadows_arc_standards_seed.sql
-- ----------------------------------------------------------------------------
-- Populates communities.builder_arc_standards for August Meadows with the
-- structured rubric encoded inline in the submission form (
-- public/august-meadows-submission-form.html line 389) so the AI review
-- pipeline can read the standards programmatically instead of re-discovering
-- them from the Design Guidelines PDF on every submission.
--
-- Source documents:
--   • /public/august-meadows-submission-form.html — Ed's distillation of the
--     standards into the form copy reviewed by builders
--   • "Residential Design Guidelines (Jones Creek Reserve) 2.5.2024.pdf"
--     in OneDrive\BEDROCK\Client - August Meadows\ — the underlying DG.
--     "Jones Creek Reserve" was the working name before the community was
--     recorded as August Meadows; both refer to the same governing doc.
--   • Filed April 22, 2026, Fort Bend County (per the form copy).
--   • Jurisdiction for permits: City of Needville.
--
-- What's seeded here is the SUBSET we can fill confidently from those two
-- sources. Empty slots (min_square_footage, single_material_max_pct,
-- approved_paint_palette, etc.) require reading the recorded DG PDF page by
-- page; flagged with TODO so a follow-up migration can fill them in.
--
-- Same migration also sets the design guidelines URL placeholder + records
-- the recorded-doc reference in the standards JSONB so downstream renderers
-- can cite "August Meadows Residential Design Guidelines (recorded
-- April 22, 2026, Fort Bend County)" in approval letters without operator
-- having to retype it.
--
-- Apply after 137. Idempotent — uses jsonb_build_object so re-running this
-- writes the same values without growing the document.
-- ============================================================================

BEGIN;

UPDATE communities
SET builder_arc_standards = jsonb_build_object(
      -- Masonry requirements
      'masonry_front_elevation_min_pct', 35,
      'masonry_wrap_distance_feet',      2,
      -- Roof pitch minimums (text format because builder spec uses "8:12")
      'roof_pitch_sides_min',            '8:12',
      'roof_pitch_porches_min',          '6:12',
      -- Brick spec
      'brick_spec',                      'ASTM C216-87',
      'brick_allowed_types',             jsonb_build_array('king', 'queen'),
      'brick_prohibited_types',          jsonb_build_array('jumbo', 'stucco_brick'),
      'brick_color_palette',             'earth tones',
      'mortar_joint_style',              'tooled (no slump)',
      -- Hard prohibitions
      'prohibited_materials',            jsonb_build_array('Dryvit', 'EIFS'),
      -- Reference metadata so letter renderers can cite the doc accurately
      'design_guidelines_recorded_date', '2026-04-22',
      'design_guidelines_county',        'Fort Bend County',
      'city_jurisdiction',               'City of Needville',
      -- Free-form notes — gap inventory + DG file pointer
      'notes',                           'Standards seeded 2026-05-30 from public/august-meadows-submission-form.html copy. Underlying source: "Residential Design Guidelines (Jones Creek Reserve) 2.5.2024.pdf" in OneDrive (Jones Creek Reserve was the pre-recording working name). TODO: read the recorded DG to populate min_square_footage, max_square_footage, single_material_max_pct, approved_paint_palette, and any adjacency/lot-type-specific modifiers. Builder is responsible for City of Needville permits and inspections independently.'
    ),
    -- Also stamp the design guidelines URL placeholder — the real URL goes
    -- live once Ed confirms the canonical hosting location (DRB portal or
    -- Bedrock-hosted copy). For now point to the library_documents path
    -- pattern the Documents tab uses.
    builder_arc_design_guidelines_url = COALESCE(
      builder_arc_design_guidelines_url,
      '/documents?community=august-meadows&category=design_document'
    )
WHERE management_company_id = '00000000-0000-0000-0000-000000000001'
  AND name ILIKE 'August Meadows%';

COMMIT;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
-- SELECT name, jsonb_pretty(builder_arc_standards) AS standards,
--        builder_arc_design_guidelines_url
-- FROM communities
-- WHERE management_company_id = '00000000-0000-0000-0000-000000000001'
--   AND name ILIKE 'August Meadows%';
