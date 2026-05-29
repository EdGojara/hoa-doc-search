-- ============================================================================
-- 129_matrix_requires_file_path.sql
-- ----------------------------------------------------------------------------
-- Fix: v_community_document_matrix marks rows as 'current' (green dot) even
-- when the library_documents row has NULL file_path — i.e., the metadata
-- says "we have a current Declaration" but there's no actual PDF stored.
--
-- Symptom Ed caught 2026-05-29: Quail Ridge Documents matrix showed
-- Declaration / CC&Rs as GREEN, but clicking the row showed no file. The
-- force-mow letter renderer then refused to render because we couldn't
-- read the recording info from a Declaration that didn't actually exist
-- locally.
--
-- Root cause: the LEFT JOIN matched on:
--    d.community_id = c.id
--    d.category = cat.category
--    d.status = 'current'
-- But did NOT require file_path to be non-null. A library_documents row
-- can be a metadata-only placeholder (e.g., "we verified this is in
-- HomeWise/Vantaca but didn't store a local copy"). Those rows shouldn't
-- count as having a downloadable document in this matrix.
--
-- Fix: add d.file_path IS NOT NULL AND d.file_path <> '' to the join
-- predicate. Metadata-only rows now correctly render as 'missing' so the
-- operator sees the truth.
--
-- Also surfaces 'in_homewise' and 'in_vantaca' visibility regardless of
-- the local-file presence (was previously gated behind current_document_id
-- — covered by the frontend patch 2026-05-29; left as-is here).
--
-- DROP + CREATE pattern (per CLAUDE.md scar — CREATE OR REPLACE fails
-- when a view's tablename.* expansion has shifted columns). Re-GRANT
-- afterward (per CLAUDE.md scar — DROP loses grants).
-- ============================================================================

BEGIN;

DROP VIEW IF EXISTS v_community_document_matrix CASCADE;

CREATE VIEW v_community_document_matrix AS
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
  AND d.file_path IS NOT NULL                  -- NEW: require actual file
  AND d.file_path <> ''                        -- NEW: defensive against empty-string stragglers
WHERE cat.show_in_matrix = TRUE
ORDER BY c.name, cat.sort_order;

-- Re-grant — DROP VIEW loses these (CLAUDE.md scar)
GRANT SELECT ON v_community_document_matrix TO anon, authenticated, service_role;

COMMIT;

-- ============================================================================
-- VERIFICATION (run in SQL editor)
-- ============================================================================
-- -- Find rows where status was previously 'current' on the false-positive
-- -- path (metadata exists but no file uploaded):
-- SELECT
--   c.name AS community,
--   cat.display_name AS category,
--   d.id AS document_id,
--   d.title,
--   d.file_path,
--   d.in_homewise_doctivity,
--   d.in_vantaca_library
-- FROM communities c
-- CROSS JOIN document_categories cat
-- LEFT JOIN library_documents d
--   ON d.community_id = c.id AND d.category = cat.category AND d.status = 'current'
-- WHERE d.id IS NOT NULL
--   AND (d.file_path IS NULL OR d.file_path = '')
--   AND cat.show_in_matrix = TRUE
-- ORDER BY c.name, cat.display_name;
--
-- -- Confirm matrix now matches reality for Quail Ridge:
-- SELECT category_display, matrix_status, current_document_id, current_status
-- FROM v_community_document_matrix
-- WHERE community_name = 'Quail Ridge'
-- ORDER BY category_display;
