-- ============================================================================
-- 018_matrix_form_separation.sql
-- ----------------------------------------------------------------------------
-- The Documents matrix is for AUDIT-grade per-community completeness — budgets,
-- insurance, reserves, governing docs. Resident-facing forms (ARC applications,
-- key fob requests) are a different operational category — they need their own
-- tab, not 20 columns of mostly-empty cells in the matrix.
--
-- This migration:
--   1) Adds show_in_matrix flag to document_categories
--   2) Sets it false for the form template categories
--   3) Updates the matrix view to filter accordingly
--
-- Apply AFTER 017. Idempotent.
-- ============================================================================

ALTER TABLE document_categories
  ADD COLUMN IF NOT EXISTS show_in_matrix BOOLEAN NOT NULL DEFAULT TRUE;

-- Forms and applications belong on the dedicated Forms tab, not in the matrix
UPDATE document_categories
   SET show_in_matrix = FALSE
 WHERE category IN ('arc_application', 'key_fob_form', 'forms_and_applications');

-- Rebuild the matrix view to respect the flag
CREATE OR REPLACE VIEW v_community_document_matrix AS
SELECT
  c.id                        AS community_id,
  c.name                      AS community_name,
  cat.category                AS category,
  cat.display_name            AS category_display,
  cat.required_for_resale     AS required_for_resale,
  cat.typical_frequency       AS typical_frequency,
  d.id                        AS current_document_id,
  d.title                     AS current_document_title,
  d.file_name_normalized      AS current_document_filename,
  d.period_label              AS current_period,
  d.effective_date            AS current_effective_date,
  d.expiration_date           AS current_expiration_date,
  d.status                    AS current_status,
  d.created_by_mgmt_company   AS created_by_mgmt_company,
  d.in_homewise_doctivity     AS in_homewise,
  d.in_vantaca_library        AS in_vantaca,
  CASE
    WHEN d.id IS NULL THEN 'missing'
    WHEN d.expiration_date IS NOT NULL AND d.expiration_date < CURRENT_DATE THEN 'expired'
    WHEN d.expiration_date IS NOT NULL AND d.expiration_date < CURRENT_DATE + INTERVAL '30 days' THEN 'expiring_soon'
    ELSE 'current'
  END                         AS matrix_status,
  CASE
    WHEN d.expiration_date IS NOT NULL THEN d.expiration_date - CURRENT_DATE
    ELSE NULL
  END                         AS days_to_expiration
FROM communities c
CROSS JOIN document_categories cat
LEFT JOIN library_documents d
  ON d.community_id = c.id
  AND d.category = cat.category
  AND d.status = 'current'
WHERE cat.show_in_matrix = TRUE        -- filter out form categories
ORDER BY c.name, cat.sort_order;

GRANT SELECT ON v_community_document_matrix TO service_role, authenticated;

-- Verify:
--   SELECT category, display_name, show_in_matrix FROM document_categories
--    WHERE category IN ('arc_application','key_fob_form','forms_and_applications')
--    ORDER BY sort_order;
--   -- expect 3 rows with show_in_matrix = false
--
--   SELECT COUNT(DISTINCT category) FROM v_community_document_matrix;
--   -- should match the count of audit categories (matrix shouldn't include forms)
