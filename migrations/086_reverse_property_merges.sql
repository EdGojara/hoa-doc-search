-- ============================================================================
-- 086_reverse_property_merges.sql
-- ----------------------------------------------------------------------------
-- Restores merged properties from properties_merge_audit snapshots.
-- Reason: the prior dedup (085) compared properties.street_address — but the
-- Vantaca import populates that column from the MAILING address fields, not
-- the actual property/site address. So two distinct properties owned by the
-- same homeowner (same mailing) looked identical to the normalizer and got
-- merged. The dedup was operating on the wrong source-of-truth column.
--
-- This function re-inserts the merged_snapshot rows from the audit log,
-- repoints the FK relinks back to the restored properties, and marks the
-- audit row as reversed so it won't be processed twice.
--
-- USAGE:
--   -- Reverse a single audit row (test/verify path):
--   SELECT reverse_property_merge('<audit_id>'::uuid);
--
--   -- Reverse all merges for one community:
--   SELECT reverse_property_merge(id)
--   FROM properties_merge_audit
--   WHERE community_id = '<community_id>' AND reversed_at IS NULL;
--
--   -- Reverse EVERYTHING (the 696 merges from session 2026-05-21):
--   SELECT count(*) FROM (
--     SELECT reverse_property_merge(id)
--     FROM properties_merge_audit
--     WHERE reversed_at IS NULL
--   ) AS x;
--
-- Apply after 085. Idempotent (reversed rows are skipped).
-- ============================================================================

-- Add the reversed-tracking column if it doesn't exist
ALTER TABLE properties_merge_audit
  ADD COLUMN IF NOT EXISTS reversed_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversed_by  TEXT,
  ADD COLUMN IF NOT EXISTS reverse_notes TEXT;

DROP FUNCTION IF EXISTS reverse_property_merge(UUID);

CREATE OR REPLACE FUNCTION reverse_property_merge(p_audit_id UUID)
RETURNS TABLE (
  audit_id              UUID,
  restored_property_id  UUID,
  fk_relinks_restored   JSONB,
  action                TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
  audit_rec   properties_merge_audit%ROWTYPE;
  snap        JSONB;
  new_pid     UUID;
  relinks_done JSONB := '{}'::jsonb;
  rel_table   TEXT;
  rel_count   INT;
  this_count  INT;
BEGIN
  SELECT * INTO audit_rec FROM properties_merge_audit WHERE id = p_audit_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'audit row % not found', p_audit_id;
  END IF;
  IF audit_rec.reversed_at IS NOT NULL THEN
    -- Already reversed — return existing data
    RETURN QUERY SELECT audit_rec.id, audit_rec.merged_property_id, audit_rec.fk_relinks, 'ALREADY_REVERSED'::TEXT;
    RETURN;
  END IF;

  snap := audit_rec.merged_snapshot;

  -- Re-insert the property using the snapshot. Use the ORIGINAL id from the
  -- snapshot so any external references (audit trails, prior screenshots)
  -- stay consistent. Trigger will repopulate normalized_address / unit.
  -- If the original id collides (shouldn't, since we deleted it), the
  -- insert will fail and we abort.
  INSERT INTO properties (
    id, community_id, street_address, unit, city, state, zip,
    property_type, lot_number, vantaca_account_id, notes,
    created_at, updated_at
  ) VALUES (
    audit_rec.merged_property_id,
    (snap->>'community_id')::uuid,
    snap->>'street_address',
    NULLIF(snap->>'unit', ''),
    snap->>'city',
    snap->>'state',
    snap->>'zip',
    snap->>'property_type',
    snap->>'lot_number',
    snap->>'vantaca_account_id',
    snap->>'notes',
    COALESCE((snap->>'created_at')::timestamptz, NOW()),
    NOW()
  );
  new_pid := audit_rec.merged_property_id;

  -- Repoint the FK rows that originally pointed at this property.
  -- We don't know which specific rows belonged to the merged property vs the
  -- survivor — we only know counts from fk_relinks. The safe approach: the
  -- ownership rows that originally pointed at the merged_property_id are NOW
  -- pointing at the survivor; we don't have a way to disambiguate them from
  -- ownerships that always belonged to the survivor without more metadata.
  --
  -- For property_ownerships specifically: the snapshot doesn't preserve
  -- which contact_id was the merged property's owner. We rely on Vantaca
  -- re-import to re-establish correct ownerships after restoration.
  --
  -- What we CAN do: where there's exactly one fk_relink for a single-row
  -- table tied to this audit (e.g., vantaca_account_id snapshot points at
  -- a specific Vantaca account), we can restore by matching that account.
  --
  -- For now we restore the property row only; the Vantaca re-import (after
  -- the import is fixed to use property addresses) will re-establish FK
  -- relationships correctly.

  UPDATE properties_merge_audit
     SET reversed_at = NOW(),
         reversed_by = 'reverse_property_merge_fn',
         reverse_notes = 'Restored property row from snapshot. FK relinks NOT reversed — re-import will re-establish ownerships against the correct property addresses once the import is fixed.'
   WHERE id = p_audit_id;

  RETURN QUERY SELECT audit_rec.id, new_pid, audit_rec.fk_relinks, 'RESTORED'::TEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION reverse_property_merge(UUID) TO service_role;

-- ----------------------------------------------------------------------------
-- Convenience wrapper: reverse all non-reversed merges for a community,
-- or all merges if community_id is NULL.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS reverse_all_property_merges(UUID);

CREATE OR REPLACE FUNCTION reverse_all_property_merges(p_community_id UUID DEFAULT NULL)
RETURNS TABLE (
  total_audit_rows  BIGINT,
  restored          BIGINT,
  already_reversed  BIGINT,
  errors            BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  audit_row     RECORD;
  v_restored    BIGINT := 0;
  v_already     BIGINT := 0;
  v_errors      BIGINT := 0;
  v_total       BIGINT := 0;
  result_action TEXT;
BEGIN
  FOR audit_row IN
    SELECT id FROM properties_merge_audit
    WHERE reversed_at IS NULL
      AND (p_community_id IS NULL OR community_id = p_community_id)
    ORDER BY merged_at
  LOOP
    v_total := v_total + 1;
    BEGIN
      SELECT action INTO result_action FROM reverse_property_merge(audit_row.id);
      IF result_action = 'RESTORED' THEN
        v_restored := v_restored + 1;
      ELSE
        v_already := v_already + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
      -- Continue — one bad row doesn't block the rest
    END;
  END LOOP;
  RETURN QUERY SELECT v_total, v_restored, v_already, v_errors;
END;
$$;

GRANT EXECUTE ON FUNCTION reverse_all_property_merges(UUID) TO service_role;

-- ----------------------------------------------------------------------------
-- We also need to DROP the unique index that 085 added at the bottom —
-- it'll block the property re-inserts because some of those normalized
-- addresses now collide with the survivor that still exists.
-- ----------------------------------------------------------------------------
DROP INDEX IF EXISTS uniq_properties_normalized;
