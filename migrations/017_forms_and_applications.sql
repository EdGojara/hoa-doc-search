-- ============================================================================
-- 017_forms_and_applications.sql
-- ----------------------------------------------------------------------------
-- Add resident-facing form templates to the Documents Tracker taxonomy.
--
-- These are the BLANK FORM TEMPLATES residents fill out (ARC application,
-- key fob request, etc.) — NOT submitted instances (those live in the ACC
-- Review and other workflow modules). High-frequency requested docs that
-- need a home so they don't fall into 'other' and become unfindable.
--
-- Ed's stated drivers:
--   - ARC applications (every community has one)
--   - Key fob applications (frequently requested by new residents)
--   - Plus a catch-all bucket for less common forms
--
-- Apply AFTER 016. Idempotent.
-- ============================================================================

INSERT INTO document_categories (category, display_name, description, typical_frequency, typical_expiration_months, required_for_resale, sort_order) VALUES
  ('arc_application',         'ARC / ACC Application Form',
   'Architectural Review Application — blank template that owners complete to request a modification (additions, paint, fencing, etc.). This is the resident-facing FORM, not a submitted instance.',
   'event_driven', NULL, FALSE, 200),
  ('key_fob_form',            'Key Fob / Access Card Application',
   'Application form for residents requesting access fobs or key cards for amenities (pool, gym, gates).',
   'event_driven', NULL, FALSE, 210),
  ('forms_and_applications',  'Forms & Applications (Other)',
   'Catch-all for other resident-facing form templates — lease disclosures, violation notices, pool access, pet registration, modification requests not covered by ARC. Use the title to differentiate.',
   'event_driven', NULL, FALSE, 220)
ON CONFLICT (category) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  typical_frequency = EXCLUDED.typical_frequency,
  typical_expiration_months = EXCLUDED.typical_expiration_months,
  required_for_resale = EXCLUDED.required_for_resale,
  sort_order = EXCLUDED.sort_order;

-- Verify:
--   SELECT category, display_name, sort_order FROM document_categories
--    WHERE category IN ('arc_application','key_fob_form','forms_and_applications')
--    ORDER BY sort_order;
--   -- expect 3 rows
