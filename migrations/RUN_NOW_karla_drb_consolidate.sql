-- ============================================================================
-- PASTE INTO SUPABASE SQL EDITOR. Read each STEP comment before running.
-- ----------------------------------------------------------------------------
-- Karla's name + DRB Group duplicate cleanup.
--
-- Yesterday's upload-on-behalf code didn't have the dedup ladder yet, so it
-- created a duplicate DRB Group row in builder_companies. AM 8114 (and
-- possibly other DRB submissions from yesterday) got bound to that broken
-- duplicate whose primary_contact_name is literally "Karla [last name]".
--
-- This script:
--   1. Shows you what duplicates exist BEFORE changing anything
--   2. Identifies the canonical DRB Group row (the one with Karla Rutan)
--   3. Re-points every application from any duplicate -> canonical
--   4. Marks the duplicate rows as merged
--   5. Fixes any letter rendering data on responses
--
-- Run STEP 1 alone first, look at the output, then if it looks right,
-- run STEP 2-5 together. If you see something surprising in STEP 1,
-- stop and screenshot it before continuing.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- STEP 1: SHOW what we have. Run this FIRST and look at the result.
-- ----------------------------------------------------------------------------
-- Find every builder_companies row whose name fuzzy-matches "DRB":
SELECT
  id,
  company_name,
  primary_contact_name,
  primary_contact_email,
  primary_email_domain,
  status,
  created_at,
  (SELECT COUNT(*) FROM builder_applications WHERE builder_company_id = bc.id) AS application_count
FROM builder_companies bc
WHERE LOWER(company_name) LIKE '%drb%'
ORDER BY created_at;

-- Expected pattern: 2+ rows. The CANONICAL row should have:
--   - primary_contact_name = 'Karla Rutan'
--   - primary_contact_email = 'krutan@drbgroup.com'
--   - older created_at (it's been on file longer)
-- The DUPLICATE row(s) will have:
--   - primary_contact_name = 'Karla [last name]' OR NULL
--   - newer created_at (yesterday's intake)


-- ----------------------------------------------------------------------------
-- STEP 2-5: After verifying STEP 1, fill in the two UUIDs below and run.
-- Replace the placeholder UUIDs with what STEP 1 returned.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_canonical_id UUID := '00000000-0000-0000-0000-000000000000';  -- REPLACE: the GOOD DRB row id
  v_duplicate_id UUID := '00000000-0000-0000-0000-000000000000';  -- REPLACE: the BAD DRB row id
  v_repointed INT;
BEGIN
  IF v_canonical_id = '00000000-0000-0000-0000-000000000000'
     OR v_duplicate_id = '00000000-0000-0000-0000-000000000000' THEN
    RAISE EXCEPTION 'Replace the two placeholder UUIDs with the real IDs from STEP 1 before running.';
  END IF;
  IF v_canonical_id = v_duplicate_id THEN
    RAISE EXCEPTION 'Canonical and duplicate must be different UUIDs.';
  END IF;

  -- 2. Re-point every application from the duplicate to the canonical
  UPDATE builder_applications
  SET builder_company_id = v_canonical_id,
      updated_at = NOW()
  WHERE builder_company_id = v_duplicate_id;
  GET DIAGNOSTICS v_repointed = ROW_COUNT;
  RAISE NOTICE 'Re-pointed % applications from duplicate to canonical', v_repointed;

  -- 3. Re-point any master plans tied to the duplicate
  UPDATE master_plans
  SET builder_company_id = v_canonical_id,
      updated_at = NOW()
  WHERE builder_company_id = v_duplicate_id;

  -- 4. Re-point portal_user_builders if any link to the duplicate
  UPDATE portal_user_builders
  SET builder_company_id = v_canonical_id
  WHERE builder_company_id = v_duplicate_id;

  -- 5. Mark the duplicate as merged (don't DELETE -- keep the audit trail).
  -- 'merged' isn't a valid status enum value, so use 'inactive' and note it.
  UPDATE builder_companies
  SET status = 'inactive',
      notes = COALESCE(notes, '') || E'\n[merged into ' || v_canonical_id::text || ' on ' || NOW()::text || ']'
  WHERE id = v_duplicate_id;

  -- 6. Ensure the canonical row has Karla's full name, even if it was somehow
  -- already overwritten with a bad value.
  UPDATE builder_companies
  SET primary_contact_name = 'Karla Rutan',
      primary_contact_email = COALESCE(NULLIF(primary_contact_email, ''), 'krutan@drbgroup.com'),
      primary_email_domain  = COALESCE(NULLIF(primary_email_domain, ''), 'drbgroup.com'),
      updated_at = NOW()
  WHERE id = v_canonical_id
    AND (primary_contact_name IS NULL
         OR primary_contact_name LIKE '%[%'
         OR primary_contact_name = '');

  RAISE NOTICE 'Done. Re-render AM 8114 (or any DRB application) to pick up the cleaned contact info.';
END $$;


-- ----------------------------------------------------------------------------
-- STEP 6 (optional): clear stale rendered letters so the next "Render letter"
-- click regenerates with Karla Rutan.
-- ----------------------------------------------------------------------------
-- This DOES NOT delete the storage files, just nulls the pointer so the
-- handler regenerates. Replace the WHERE clause to scope to whichever
-- applications you want regenerated.
--
-- Example: regenerate all DRB letters since 2026-06-15:
--
-- UPDATE builder_application_responses r
-- SET letter_pdf_path = NULL, email_sent_at = NULL
-- FROM builder_applications a
-- WHERE r.application_id = a.id
--   AND a.builder_company_id = '<CANONICAL_DRB_UUID>'
--   AND a.created_at >= '2026-06-15';
