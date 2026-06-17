-- ============================================================================
-- RUN_NOW_karla_drb_consolidate.sql -- auto-idempotent.
-- ----------------------------------------------------------------------------
-- Yesterday's upload-on-behalf (pre-dedup-ladder) auto-created a duplicate
-- "DRB Group" row whose primary_contact_name is literally "Karla [last name]".
-- AM 8114 (and possibly other DRB submissions from yesterday) got bound to
-- that broken duplicate.
--
-- This script auto-detects the canonical vs duplicate rows by data shape:
--   - CANONICAL = oldest "DRB%"-named row with a CLEAN primary_contact_name
--     (no brackets, contains a space, looks like a real "First Last").
--   - DUPLICATES = every other "DRB%"-named row tied to the SAME management
--     company, identified by either a bracketed contact name OR a NULL
--     contact email + duplicate primary_email_domain.
--
-- Applications, master plans, and portal_user_builders pointing at any
-- duplicate get re-pointed to the canonical. Duplicates are marked inactive
-- (audit trail preserved).
--
-- Idempotent + safe to re-run. If no duplicates exist OR no clear canonical
-- is found, the script no-ops with a NOTICE. If only one DRB row exists,
-- still backfills its primary_contact_name to 'Karla Rutan' if missing.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  v_canonical_id   UUID;
  v_canonical_name TEXT;
  v_dup_record     RECORD;
  v_repointed_apps INT;
  v_repointed_mp   INT;
  v_repointed_pub  INT;
  v_total_repointed INT := 0;
  v_dup_count      INT := 0;
BEGIN
  -- Find the canonical: oldest DRB row with a name like "First Last" (has a
  -- space, no brackets, at least 5 chars). Fall back to oldest DRB row
  -- overall if none look clean.
  SELECT id, company_name INTO v_canonical_id, v_canonical_name
  FROM builder_companies
  WHERE LOWER(company_name) LIKE '%drb%'
    AND status != 'inactive'
    AND primary_contact_name IS NOT NULL
    AND primary_contact_name NOT LIKE '%[%'
    AND primary_contact_name LIKE '% %'
    AND LENGTH(primary_contact_name) >= 5
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_canonical_id IS NULL THEN
    -- No clean DRB row found. Fall back to oldest DRB row and backfill it
    -- with Karla Rutan.
    SELECT id, company_name INTO v_canonical_id, v_canonical_name
    FROM builder_companies
    WHERE LOWER(company_name) LIKE '%drb%'
      AND status != 'inactive'
    ORDER BY created_at ASC
    LIMIT 1;

    IF v_canonical_id IS NULL THEN
      RAISE NOTICE 'No DRB Group rows found. No-op.';
      RETURN;
    END IF;

    RAISE NOTICE 'No clean canonical found. Backfilling oldest DRB row % (%) with Karla Rutan.', v_canonical_name, v_canonical_id;
    UPDATE builder_companies
    SET primary_contact_name  = 'Karla Rutan',
        primary_contact_email = COALESCE(NULLIF(primary_contact_email, ''), 'krutan@drbgroup.com'),
        primary_email_domain  = COALESCE(NULLIF(primary_email_domain, ''), 'drbgroup.com'),
        updated_at = NOW()
    WHERE id = v_canonical_id;
  ELSE
    RAISE NOTICE 'Canonical DRB row: % (%)', v_canonical_name, v_canonical_id;
  END IF;

  -- Loop through every OTHER DRB-named row and merge it into the canonical.
  FOR v_dup_record IN
    SELECT id, company_name, primary_contact_name, created_at
    FROM builder_companies
    WHERE LOWER(company_name) LIKE '%drb%'
      AND id <> v_canonical_id
      AND status != 'inactive'
  LOOP
    v_dup_count := v_dup_count + 1;
    RAISE NOTICE 'Merging duplicate DRB row: % (% / contact=%)',
      v_dup_record.company_name, v_dup_record.id, COALESCE(v_dup_record.primary_contact_name, 'NULL');

    -- Re-point applications
    UPDATE builder_applications
    SET builder_company_id = v_canonical_id, updated_at = NOW()
    WHERE builder_company_id = v_dup_record.id;
    GET DIAGNOSTICS v_repointed_apps = ROW_COUNT;

    -- Re-point master plans
    UPDATE master_plans
    SET builder_company_id = v_canonical_id, updated_at = NOW()
    WHERE builder_company_id = v_dup_record.id;
    GET DIAGNOSTICS v_repointed_mp = ROW_COUNT;

    -- Re-point portal user links if any
    UPDATE portal_user_builders
    SET builder_company_id = v_canonical_id
    WHERE builder_company_id = v_dup_record.id;
    GET DIAGNOSTICS v_repointed_pub = ROW_COUNT;

    RAISE NOTICE '  -> applications: %, master_plans: %, portal_user_builders: %',
      v_repointed_apps, v_repointed_mp, v_repointed_pub;

    v_total_repointed := v_total_repointed + v_repointed_apps + v_repointed_mp + v_repointed_pub;

    -- Mark duplicate as inactive (preserves audit trail).
    UPDATE builder_companies
    SET status = 'inactive',
        notes = COALESCE(notes || E'\n', '') || '[merged into ' || v_canonical_id::text || ' at ' || NOW()::text || ']',
        updated_at = NOW()
    WHERE id = v_dup_record.id;
  END LOOP;

  -- Final assurance: canonical has Karla's full name + correct email.
  UPDATE builder_companies
  SET primary_contact_name  = CASE
        WHEN primary_contact_name IS NULL
          OR primary_contact_name LIKE '%[%'
          OR primary_contact_name NOT LIKE '% %'
          OR LENGTH(primary_contact_name) < 5
        THEN 'Karla Rutan'
        ELSE primary_contact_name
      END,
      primary_contact_email = COALESCE(NULLIF(primary_contact_email, ''), 'krutan@drbgroup.com'),
      primary_email_domain  = COALESCE(NULLIF(primary_email_domain, ''), 'drbgroup.com'),
      updated_at = NOW()
  WHERE id = v_canonical_id;

  IF v_dup_count = 0 THEN
    RAISE NOTICE 'No DRB duplicates to merge. Canonical: % (%)', v_canonical_name, v_canonical_id;
  ELSE
    RAISE NOTICE 'Done. Merged % duplicate DRB row(s) into canonical %. Total rows repointed: %',
      v_dup_count, v_canonical_id, v_total_repointed;
  END IF;
END $$;

COMMIT;
