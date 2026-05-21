-- ============================================================================
-- 085_dedup_properties_function.sql
-- ----------------------------------------------------------------------------
-- Registers dedup_community_properties() — a controlled merge function for
-- the duplicate properties surfaced by v_property_duplicates (from migration
-- 084). Two-step pattern: dry_run=TRUE returns what WOULD merge without
-- touching data; dry_run=FALSE actually performs the merge.
--
-- The function repoints every known property_id FK across the schema, takes
-- non-null field values from dupes onto the survivor where the survivor's
-- value is missing, logs a full snapshot of both rows to properties_merge_audit,
-- then deletes the now-empty dupe.
--
-- Apply after 084. Idempotent (CREATE OR REPLACE).
--
-- USAGE (after migration is applied):
--
--   -- Preview what would merge across ALL communities:
--   SELECT * FROM dedup_community_properties(NULL, TRUE);
--
--   -- Preview just Eaglewood:
--   SELECT * FROM dedup_community_properties(
--     (SELECT id FROM communities WHERE name ILIKE '%eagle%wood%' LIMIT 1),
--     TRUE
--   );
--
--   -- Actually perform the merge for one community:
--   SELECT * FROM dedup_community_properties(
--     (SELECT id FROM communities WHERE name ILIKE '%eagle%wood%' LIMIT 1),
--     FALSE
--   );
--
--   -- After dedup completes, re-run migration 084 to add the unique index:
--   -- the index creation will succeed once duplicates are gone.
-- ============================================================================

-- Drop any prior signature first — Postgres won't let CREATE OR REPLACE change
-- a RETURNS TABLE column type even with identical (uuid, boolean) args.
DROP FUNCTION IF EXISTS dedup_community_properties(UUID, BOOLEAN);

CREATE OR REPLACE FUNCTION dedup_community_properties(
  p_community_id UUID DEFAULT NULL,
  p_dry_run      BOOLEAN DEFAULT TRUE
)
RETURNS TABLE (
  community_name        TEXT,
  normalized_address    TEXT,
  survivor_id           UUID,
  merged_ids            UUID[],
  group_size            BIGINT,
  fk_relinks_summary    JSONB,
  action                TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
  grp                RECORD;
  surv_id            UUID;
  dupe_id            UUID;
  surv_row           properties%ROWTYPE;
  dupe_row           properties%ROWTYPE;
  total_relinks      INT;
  fk_counts          JSONB;
  this_count         INT;
  audit_id           UUID;
BEGIN
  FOR grp IN
    SELECT * FROM v_property_duplicates
    WHERE (p_community_id IS NULL OR community_id = p_community_id)
    ORDER BY community_name, normalized_address
  LOOP
    surv_id := grp.property_ids[1];  -- oldest by created_at — natural survivor

    -- Load survivor row for audit + best-field merge
    SELECT * INTO surv_row FROM properties WHERE id = surv_id;

    FOREACH dupe_id IN ARRAY grp.property_ids[2:array_length(grp.property_ids, 1)]
    LOOP
      SELECT * INTO dupe_row FROM properties WHERE id = dupe_id;
      fk_counts := '{}'::jsonb;
      total_relinks := 0;

      IF NOT p_dry_run THEN

        -- ----- Repoint every known property_id FK -----
        -- property_ownerships (ON DELETE RESTRICT)
        UPDATE property_ownerships SET property_id = surv_id, updated_at = NOW() WHERE property_id = dupe_id;
        GET DIAGNOSTICS this_count = ROW_COUNT;
        IF this_count > 0 THEN fk_counts := fk_counts || jsonb_build_object('property_ownerships', this_count); total_relinks := total_relinks + this_count; END IF;

        -- property_residencies (best-effort; table may not exist on every install)
        BEGIN
          UPDATE property_residencies SET property_id = surv_id WHERE property_id = dupe_id;
          GET DIAGNOSTICS this_count = ROW_COUNT;
          IF this_count > 0 THEN fk_counts := fk_counts || jsonb_build_object('property_residencies', this_count); total_relinks := total_relinks + this_count; END IF;
        EXCEPTION WHEN undefined_table THEN NULL; WHEN undefined_column THEN NULL; END;

        -- DRV / enforcement
        BEGIN
          UPDATE violations SET property_id = surv_id WHERE property_id = dupe_id;
          GET DIAGNOSTICS this_count = ROW_COUNT;
          IF this_count > 0 THEN fk_counts := fk_counts || jsonb_build_object('violations', this_count); total_relinks := total_relinks + this_count; END IF;
        EXCEPTION WHEN undefined_table THEN NULL; WHEN undefined_column THEN NULL; END;

        BEGIN
          UPDATE property_observations SET property_id = surv_id WHERE property_id = dupe_id;
          GET DIAGNOSTICS this_count = ROW_COUNT;
          IF this_count > 0 THEN fk_counts := fk_counts || jsonb_build_object('property_observations', this_count); total_relinks := total_relinks + this_count; END IF;
        EXCEPTION WHEN undefined_table THEN NULL; WHEN undefined_column THEN NULL; END;

        BEGIN
          UPDATE inspections SET property_id = surv_id WHERE property_id = dupe_id;
          GET DIAGNOSTICS this_count = ROW_COUNT;
          IF this_count > 0 THEN fk_counts := fk_counts || jsonb_build_object('inspections', this_count); total_relinks := total_relinks + this_count; END IF;
        EXCEPTION WHEN undefined_table THEN NULL; WHEN undefined_column THEN NULL; END;

        BEGIN
          UPDATE inspection_photos SET property_id = surv_id WHERE property_id = dupe_id;
          GET DIAGNOSTICS this_count = ROW_COUNT;
          IF this_count > 0 THEN fk_counts := fk_counts || jsonb_build_object('inspection_photos', this_count); total_relinks := total_relinks + this_count; END IF;
        EXCEPTION WHEN undefined_table THEN NULL; WHEN undefined_column THEN NULL; END;

        -- Amenities (clubhouse rentals)
        BEGIN
          UPDATE amenity_rentals SET property_id = surv_id WHERE property_id = dupe_id;
          GET DIAGNOSTICS this_count = ROW_COUNT;
          IF this_count > 0 THEN fk_counts := fk_counts || jsonb_build_object('amenity_rentals', this_count); total_relinks := total_relinks + this_count; END IF;
        EXCEPTION WHEN undefined_table THEN NULL; WHEN undefined_column THEN NULL; END;

        -- ARC (resident + builder)
        BEGIN
          UPDATE arc_historical_decisions SET property_id = surv_id WHERE property_id = dupe_id;
          GET DIAGNOSTICS this_count = ROW_COUNT;
          IF this_count > 0 THEN fk_counts := fk_counts || jsonb_build_object('arc_historical_decisions', this_count); total_relinks := total_relinks + this_count; END IF;
        EXCEPTION WHEN undefined_table THEN NULL; WHEN undefined_column THEN NULL; END;

        BEGIN
          UPDATE builder_applications SET property_id = surv_id WHERE property_id = dupe_id;
          GET DIAGNOSTICS this_count = ROW_COUNT;
          IF this_count > 0 THEN fk_counts := fk_counts || jsonb_build_object('builder_applications', this_count); total_relinks := total_relinks + this_count; END IF;
        EXCEPTION WHEN undefined_table THEN NULL; WHEN undefined_column THEN NULL; END;

        BEGIN
          UPDATE builder_precedents SET property_id = surv_id WHERE property_id = dupe_id;
          GET DIAGNOSTICS this_count = ROW_COUNT;
          IF this_count > 0 THEN fk_counts := fk_counts || jsonb_build_object('builder_precedents', this_count); total_relinks := total_relinks + this_count; END IF;
        EXCEPTION WHEN undefined_table THEN NULL; WHEN undefined_column THEN NULL; END;

        -- Knowledge substrate + email intake
        BEGIN
          UPDATE knowledge_documents SET property_id = surv_id WHERE property_id = dupe_id;
          GET DIAGNOSTICS this_count = ROW_COUNT;
          IF this_count > 0 THEN fk_counts := fk_counts || jsonb_build_object('knowledge_documents', this_count); total_relinks := total_relinks + this_count; END IF;
        EXCEPTION WHEN undefined_table THEN NULL; WHEN undefined_column THEN NULL; END;

        BEGIN
          UPDATE email_intake SET property_id = surv_id WHERE property_id = dupe_id;
          GET DIAGNOSTICS this_count = ROW_COUNT;
          IF this_count > 0 THEN fk_counts := fk_counts || jsonb_build_object('email_intake', this_count); total_relinks := total_relinks + this_count; END IF;
        EXCEPTION WHEN undefined_table THEN NULL; WHEN undefined_column THEN NULL; END;

        -- Owner AR + payments
        BEGIN
          UPDATE owner_ar_snapshots SET property_id = surv_id WHERE property_id = dupe_id;
          GET DIAGNOSTICS this_count = ROW_COUNT;
          IF this_count > 0 THEN fk_counts := fk_counts || jsonb_build_object('owner_ar_snapshots', this_count); total_relinks := total_relinks + this_count; END IF;
        EXCEPTION WHEN undefined_table THEN NULL; WHEN undefined_column THEN NULL; END;

        -- Portal
        BEGIN
          UPDATE portal_user_properties SET property_id = surv_id WHERE property_id = dupe_id;
          GET DIAGNOSTICS this_count = ROW_COUNT;
          IF this_count > 0 THEN fk_counts := fk_counts || jsonb_build_object('portal_user_properties', this_count); total_relinks := total_relinks + this_count; END IF;
        EXCEPTION WHEN undefined_table THEN NULL; WHEN undefined_column THEN NULL; END;

        -- ----- Best-field merge: take non-null from dupe if survivor is missing -----
        UPDATE properties SET
          unit          = COALESCE(NULLIF(TRIM(properties.unit), ''), NULLIF(TRIM(dupe_row.unit), '')),
          city          = COALESCE(properties.city, dupe_row.city),
          state         = COALESCE(properties.state, dupe_row.state),
          zip           = COALESCE(properties.zip, dupe_row.zip),
          property_type = COALESCE(properties.property_type, dupe_row.property_type),
          lot_number    = COALESCE(properties.lot_number, dupe_row.lot_number),
          vantaca_account_id = COALESCE(properties.vantaca_account_id, dupe_row.vantaca_account_id),
          notes         = COALESCE(properties.notes, dupe_row.notes),
          updated_at    = NOW()
        WHERE id = surv_id;

        -- ----- Audit log -----
        INSERT INTO properties_merge_audit (
          merged_by, community_id, survivor_property_id, merged_property_id,
          normalized_address, reason, survivor_snapshot, merged_snapshot, fk_relinks
        ) VALUES (
          'auto_dedup_function',
          grp.community_id, surv_id, dupe_id,
          grp.normalized_address,
          'normalize_match',
          to_jsonb(surv_row),
          to_jsonb(dupe_row),
          fk_counts
        ) RETURNING id INTO audit_id;

        -- ----- Delete the dupe -----
        DELETE FROM properties WHERE id = dupe_id;

      ELSE
        -- Dry run: count FK rows without modifying
        BEGIN SELECT COUNT(*) INTO this_count FROM property_ownerships WHERE property_id = dupe_id;
              IF this_count > 0 THEN fk_counts := fk_counts || jsonb_build_object('property_ownerships', this_count); total_relinks := total_relinks + this_count; END IF;
        EXCEPTION WHEN OTHERS THEN NULL; END;
        BEGIN SELECT COUNT(*) INTO this_count FROM property_residencies WHERE property_id = dupe_id;
              IF this_count > 0 THEN fk_counts := fk_counts || jsonb_build_object('property_residencies', this_count); total_relinks := total_relinks + this_count; END IF;
        EXCEPTION WHEN OTHERS THEN NULL; END;
        BEGIN SELECT COUNT(*) INTO this_count FROM violations WHERE property_id = dupe_id;
              IF this_count > 0 THEN fk_counts := fk_counts || jsonb_build_object('violations', this_count); total_relinks := total_relinks + this_count; END IF;
        EXCEPTION WHEN OTHERS THEN NULL; END;
        BEGIN SELECT COUNT(*) INTO this_count FROM amenity_rentals WHERE property_id = dupe_id;
              IF this_count > 0 THEN fk_counts := fk_counts || jsonb_build_object('amenity_rentals', this_count); total_relinks := total_relinks + this_count; END IF;
        EXCEPTION WHEN OTHERS THEN NULL; END;
        BEGIN SELECT COUNT(*) INTO this_count FROM owner_ar_snapshots WHERE property_id = dupe_id;
              IF this_count > 0 THEN fk_counts := fk_counts || jsonb_build_object('owner_ar_snapshots', this_count); total_relinks := total_relinks + this_count; END IF;
        EXCEPTION WHEN OTHERS THEN NULL; END;
      END IF;
    END LOOP;

    RETURN QUERY SELECT
      grp.community_name,
      grp.normalized_address,
      surv_id,
      grp.property_ids[2:array_length(grp.property_ids, 1)] AS merged_ids,
      grp.dupe_count,
      fk_counts,
      CASE WHEN p_dry_run THEN 'WOULD_MERGE' ELSE 'MERGED' END;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION dedup_community_properties(UUID, BOOLEAN) TO service_role;

-- ----------------------------------------------------------------------------
-- After dedup runs successfully, the unique index from migration 084 can be
-- added/validated. This block tries to create it; if it succeeds, all future
-- inserts are protected from duplicates. If duplicates remain, it raises a
-- NOTICE.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_properties_normalized
      ON properties (community_id, normalized_address, normalized_unit);
    RAISE NOTICE 'uniq_properties_normalized index is in place — duplicates blocked at the DB level.';
  EXCEPTION
    WHEN unique_violation THEN
      RAISE NOTICE 'Cannot add uniq_properties_normalized — duplicates still exist. Run dedup_community_properties(NULL, FALSE) and try again.';
  END;
END $$;
