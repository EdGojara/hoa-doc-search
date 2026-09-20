-- 436_partner_associations.sql
-- ----------------------------------------------------------------------------
-- Organization-to-organization relationships (Partner Associations) + fail-closed
-- member-scope entitlement, plus the first real relationship: Cinco Residential
-- Property Association is a Partner Association of Cinco Landscape Maintenance
-- Association (CLMA), evidenced by the 2009 Maintenance Agreement already indexed
-- for CLMA. (Ed 2026-09-20, CLMA two-sided portal.)
--
-- Business model: CLMA is a service organization; a Partner Association is its
-- organizational client. Portal entitlement belongs to the ORG-TO-ORG
-- relationship, not to an individual user. Terminology ('partner_association')
-- is CLMA's own; the Maintenance Agreement names the parties "Cinco Residential
-- Property Association, Inc." and "Cinco LMA" and does NOT contradict it, nor
-- does it establish an assessment obligation (so none is encoded here).
--
-- Design invariants (approved):
--   * communities stays the canonical entity (no organization_id refactor).
--   * organization_type describes what the org IS; capability describes what
--     Trusted DOES for it. They are separate.
--   * relationship must be status='active' to grant anything (live revocation).
--   * member scope is EXPLICIT and FAILS CLOSED: the default 'unclassified' is
--     invisible to members; only 'all_members' or 'selected_members' (with a
--     join row) are ever exposed. NULL is never used to mean "all".
--   * a selected-members list is an explicit FK-backed join (no polymorphic
--     object_id), read through one shared entitlement resolver.
--
-- Record ownership: community_relationships and document_member_scope are
-- `association_record` config for the relationship; the canonical org row is a
-- normal community. Additive + idempotent; existing records preserved.
BEGIN;

-- 1) organization_type: first-class, default residential_hoa, overridable.
ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS organization_type TEXT NOT NULL DEFAULT 'residential_hoa'
    CHECK (organization_type IN
      ('residential_hoa','landscape_association','commercial','social','nonprofit'));

-- CLMA is a landscape maintenance association, not a residential HOA.
UPDATE communities
   SET organization_type = 'landscape_association'
 WHERE id = 'c4a87380-81ae-43aa-94eb-a671e2d6401f'
   AND organization_type <> 'landscape_association';

-- 2) community_relationships: a directional, typed, status-bearing edge between
--    two canonical communities (parent service org -> member/partner org).
CREATE TABLE IF NOT EXISTS community_relationships (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_community_id  UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  member_community_id  UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  relationship_type    TEXT NOT NULL CHECK (relationship_type IN ('partner_association')),
  status               TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('pending','active','terminated')),
  started_at           TIMESTAMPTZ,
  ended_at             TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT community_relationships_distinct CHECK (parent_community_id <> member_community_id),
  UNIQUE (parent_community_id, member_community_id, relationship_type)
);
CREATE INDEX IF NOT EXISTS idx_comm_rel_member ON community_relationships (member_community_id, status);
CREATE INDEX IF NOT EXISTS idx_comm_rel_parent ON community_relationships (parent_community_id, status);
GRANT SELECT, INSERT, UPDATE, DELETE ON community_relationships TO service_role;
GRANT SELECT ON community_relationships TO authenticated;

-- keep updated_at fresh using the standard trigger function
DROP TRIGGER IF EXISTS trg_comm_rel_updated_at ON community_relationships;
CREATE TRIGGER trg_comm_rel_updated_at BEFORE UPDATE ON community_relationships
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- 3) member_scope: the EXPLICIT, FAIL-CLOSED authorization state of a document.
ALTER TABLE library_documents
  ADD COLUMN IF NOT EXISTS member_scope TEXT NOT NULL DEFAULT 'unclassified'
    CHECK (member_scope IN
      ('internal_only','all_members','selected_members','not_applicable','unclassified'));

-- 4) selected-members list: explicit, FK-backed (used only when member_scope='selected_members').
CREATE TABLE IF NOT EXISTS document_member_scope (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id          UUID NOT NULL REFERENCES library_documents(id) ON DELETE CASCADE,
  member_community_id  UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, member_community_id)
);
CREATE INDEX IF NOT EXISTS idx_doc_member_scope_member ON document_member_scope (member_community_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON document_member_scope TO service_role;
GRANT SELECT ON document_member_scope TO authenticated;

-- 5) The canonical Partner Association: Cinco Residential Property Association.
--    Named exactly as the Maintenance Agreement and CLMA's interface do. It is a
--    prospect (Bedrock does not manage it) that is a partner of prospect CLMA.
INSERT INTO communities (id, management_company_id, name, legal_name, slug,
                         management_status, organization_type, county, state, active)
SELECT 'c1c0f000-0000-4000-8000-000000000001',
       '00000000-0000-0000-0000-000000000001',
       'Cinco Residential Property Association',
       'Cinco Residential Property Association, Inc.',
       'cinco-residential-property-association',
       'prospect', 'residential_hoa', 'Fort Bend', 'TX', true
WHERE NOT EXISTS (SELECT 1 FROM communities WHERE id = 'c1c0f000-0000-4000-8000-000000000001');

-- 6) The evidenced relationship: CLMA (parent) <- Cinco Residential (partner), ACTIVE.
INSERT INTO community_relationships (parent_community_id, member_community_id, relationship_type, status, started_at)
SELECT 'c4a87380-81ae-43aa-94eb-a671e2d6401f',
       'c1c0f000-0000-4000-8000-000000000001',
       'partner_association', 'active', '2009-07-08'
ON CONFLICT (parent_community_id, member_community_id, relationship_type) DO NOTHING;

-- 7) Classify the Maintenance Agreement as selected_members -> Cinco Residential.
--    It IS specifically their agreement. Every other CLMA doc stays 'unclassified'
--    (invisible) until deliberately classified.
UPDATE library_documents
   SET member_scope = 'selected_members'
 WHERE id = '61da0561-f6ca-4b5e-9034-38783c2da172';

INSERT INTO document_member_scope (document_id, member_community_id)
SELECT '61da0561-f6ca-4b5e-9034-38783c2da172', 'c1c0f000-0000-4000-8000-000000000001'
WHERE EXISTS (SELECT 1 FROM library_documents WHERE id = '61da0561-f6ca-4b5e-9034-38783c2da172')
ON CONFLICT (document_id, member_community_id) DO NOTHING;

-- PostgREST must see the new columns/tables immediately (the "new column silently
-- EMPTY" scar). Same pattern as migration 435.
NOTIFY pgrst, 'reload schema';

COMMIT;
