-- ============================================================================
-- 155_expand_verified_source.sql
-- ----------------------------------------------------------------------------
-- Expands the CHECK constraint on verified_source (properties + contacts)
-- to include the new sources added 2026-06-03 for the mailing-delta
-- workflow.
--
-- The original constraint from migration 149 only allowed:
--   'template_import' / 'manual_edit' / 'vantaca_initial'
--
-- The mailing-delta apply endpoint writes 'mailing_delta' and the
-- claim-transfer endpoint writes 'mailing_delta_transfer'. Every UPDATE
-- failed the constraint silently — Ed clicked Apply on 14 selected rows
-- and all 14 errored (the "values that don't exist in the constraint"
-- scar in CLAUDE.md, hit again).
--
-- This migration drops + re-adds the constraint with the expanded list.
-- All existing values stay valid; the new values become permitted.
-- ============================================================================

BEGIN;

ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_verified_source_check;
ALTER TABLE properties
  ADD CONSTRAINT properties_verified_source_check
  CHECK (
    verified_source IS NULL OR verified_source IN (
      'template_import',
      'manual_edit',
      'vantaca_initial',
      'mailing_delta',
      'mailing_delta_transfer'
    )
  );

ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_verified_source_check;
ALTER TABLE contacts
  ADD CONSTRAINT contacts_verified_source_check
  CHECK (
    verified_source IS NULL OR verified_source IN (
      'template_import',
      'manual_edit',
      'vantaca_initial',
      'mailing_delta',
      'mailing_delta_transfer'
    )
  );

NOTIFY pgrst, 'reload schema';

COMMIT;
