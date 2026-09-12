-- ============================================================================
-- 415_community_ein.sql  (Ed 2026-09-12)
-- ----------------------------------------------------------------------------
-- Each community IS a legal entity (the HOA) with its own EIN. Storing it (with
-- the legal name + address already on communities: hoa_legal_name, hoa_address)
-- lets trustEd generate that association's tax forms, starting with the W-9 it
-- hands to banks and vendors. Bedrock's own EIN lives on management_companies.ein.
--
-- EINs are populated from each HOA's IRS EIN-assignment letter (CP 575),
-- verified per entity, never guessed. tax_classification (W-9 line 3, e.g. how
-- the HOA files: C corp / other / 1120-H) is left for the CPA to set per entity.
--
-- Record ownership: association_record — an HOA's EIN is the association's own.
-- ============================================================================
BEGIN;

ALTER TABLE communities ADD COLUMN IF NOT EXISTS ein text;
ALTER TABLE communities ADD COLUMN IF NOT EXISTS tax_classification text;

COMMENT ON COLUMN communities.ein IS 'HOA employer identification number (from the IRS CP 575 letter). For W-9 / tax-form generation.';
COMMENT ON COLUMN communities.tax_classification IS 'W-9 line 3 federal tax classification for this HOA (set by CPA; e.g. C corporation / other / 1120-H filer).';

COMMIT;
