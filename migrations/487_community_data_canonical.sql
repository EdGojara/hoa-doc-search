-- ============================================================================
-- 487_community_data_canonical.sql  (Issue #15, Ed 2026-10-03)  -- PROPOSAL, NOT APPLIED
-- ----------------------------------------------------------------------------
-- Canonical community data (properties / parties / relationships) built around
-- EVIDENCE, with ONE transaction-atomic, idempotent write path for the AI
-- operator. It sits beside the legacy contacts / property_ownerships /
-- property_residencies tables (which stay as they are; the paused legacy write
-- paths are contained by lib/identity_safety.js). Nothing here touches them.
--
-- Principles enforced by the schema and by cd_apply_change:
--   * Durable, provider-scoped SOURCE IDENTITY. A party exists only through one
--     or more identities (provider + kind + key + slot, e.g. vantaca /
--     homeowner_id / H15 / owner). Identities are immutable and unique; a
--     proposal can never merge two existing identities into one party, and no
--     name, email, phone or address is ever used to find a party.
--   * UNKNOWN IS A STATE. Start / end dates are nullable and carry a basis
--     ('unknown' exactly when the date is null); observed_as_of (when the source
--     said so) is separate from any effective date and from the write time.
--   * OCCUPANCY IS SEPARATE FROM OWNERSHIP. Several occupancies may be open at
--     once (co-tenants); occupancy has an evidence basis and can never be
--     inferred (no 'inferred' basis exists).
--   * PROVENANCE IS FIRST-CLASS. Every material row (ownership, occupancy,
--     lease, address, contact method) has >= 1 evidence row pointing at a
--     source document (hash, period, observation time) and a locator
--     (sheet / row / line). The apply function refuses a material item
--     without evidence.
--   * ONE WRITE PATH. Tables are SELECT-only for service_role; every write
--     goes through cd_apply_change (SECURITY DEFINER), which validates the whole
--     proposal and runs in one transaction: any failure rolls back everything
--     (no partially-created party). Idempotent by (community, idempotency_key):
--     a replay with the same proposal returns the original result; the same key
--     with a different proposal is refused.
--   * No default state ('TX'), no default dates, no editable source ids.
-- Record ownership: association_record (the association's people / property
-- relationships), community-scoped on every row. Requires: communities,
-- properties (with community_id). No existing row changes.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS cd_changes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id      UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  idempotency_key   TEXT NOT NULL CHECK (length(btrim(idempotency_key)) > 0),
  proposal_sha256   TEXT NOT NULL CHECK (proposal_sha256 ~ '^[0-9a-f]{64}$'),
  result            JSONB NOT NULL,
  actor_kind        TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent', 'system')),
  actor_id          TEXT NOT NULL CHECK (length(btrim(actor_id)) > 0),
  applied_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (community_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS cd_source_documents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id      UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  provider          TEXT NOT NULL CHECK (length(btrim(provider)) > 0),
  kind              TEXT NOT NULL CHECK (length(btrim(kind)) > 0),           -- e.g. all_addresses_export, homeowner_contact_information, ownership_transfer_report, lease
  filename          TEXT,
  sha256            TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  period_start      DATE,
  period_end        DATE,
  observed_as_of    DATE NOT NULL,                                            -- the date the source speaks for (export / report date)
  change_id         UUID NOT NULL REFERENCES cd_changes(id) ON DELETE RESTRICT,
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (community_id, sha256),
  CHECK (period_start IS NULL OR period_end IS NULL OR period_start <= period_end)
);

CREATE TABLE IF NOT EXISTS cd_parties (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id      UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  kind              TEXT NOT NULL CHECK (kind IN ('person', 'organization', 'unknown')),
  kind_basis        TEXT NOT NULL CHECK (kind_basis IN ('source_field', 'name_pattern_flag', 'unknown')),
  display_name      TEXT NOT NULL CHECK (length(btrim(display_name)) > 0),
  given_name        TEXT,
  family_name       TEXT,                                                     -- null when the source does not give it (never copied from another party)
  change_id         UUID NOT NULL REFERENCES cd_changes(id) ON DELETE RESTRICT,
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cd_party_source_identities (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id      UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  party_id          UUID NOT NULL REFERENCES cd_parties(id) ON DELETE RESTRICT,
  provider          TEXT NOT NULL CHECK (length(btrim(provider)) > 0),
  identity_kind     TEXT NOT NULL CHECK (identity_kind IN ('homeowner_id', 'tenant_id', 'transfer_record', 'lease_party', 'statement_party')),
  identity_key      TEXT NOT NULL CHECK (length(btrim(identity_key)) > 0),
  slot              TEXT NOT NULL CHECK (length(btrim(slot)) > 0),            -- owner / spouse / previous_owner / tenant:0 ...
  change_id         UUID NOT NULL REFERENCES cd_changes(id) ON DELETE RESTRICT,
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (community_id, provider, identity_kind, identity_key, slot)
);

CREATE TABLE IF NOT EXISTS cd_property_source_identities (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id      UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  property_id       UUID NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  provider          TEXT NOT NULL CHECK (length(btrim(provider)) > 0),
  identity_kind     TEXT NOT NULL CHECK (identity_kind IN ('account')),
  identity_key      TEXT NOT NULL CHECK (length(btrim(identity_key)) > 0),
  change_id         UUID NOT NULL REFERENCES cd_changes(id) ON DELETE RESTRICT,
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (community_id, provider, identity_kind, identity_key)
);

CREATE TABLE IF NOT EXISTS cd_ownerships (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id         UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  property_id          UUID NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  party_id             UUID NOT NULL REFERENCES cd_parties(id) ON DELETE RESTRICT,
  role                 TEXT NOT NULL CHECK (role IN ('owner', 'co_owner')),
  effective_from       DATE,
  effective_from_basis TEXT NOT NULL CHECK (effective_from_basis IN ('unknown', 'transfer_settlement', 'deed_recorded', 'owner_statement')),
  effective_to         DATE,
  effective_to_basis   TEXT CHECK (effective_to_basis IN ('transfer_settlement', 'deed_recorded', 'owner_statement')),
  observed_as_of       DATE NOT NULL,
  change_id            UUID NOT NULL REFERENCES cd_changes(id) ON DELETE RESTRICT,
  ended_by_change_id   UUID REFERENCES cd_changes(id) ON DELETE RESTRICT,
  recorded_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT cd_ownership_unknown_start_is_real CHECK ((effective_from IS NULL) = (effective_from_basis = 'unknown')),
  CONSTRAINT cd_ownership_end_has_basis CHECK ((effective_to IS NULL) = (effective_to_basis IS NULL)),
  CONSTRAINT cd_ownership_dates_ordered CHECK (effective_from IS NULL OR effective_to IS NULL OR effective_from <= effective_to)
);

CREATE TABLE IF NOT EXISTS cd_leases (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id      UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  property_id       UUID NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  document_id       UUID NOT NULL REFERENCES cd_source_documents(id) ON DELETE RESTRICT,
  start_date        DATE,                                                   -- as stated; null = not stated
  end_date          DATE,
  received_at       DATE,
  renewal_of        UUID REFERENCES cd_leases(id) ON DELETE RESTRICT,       -- only when the lease says so
  change_id         UUID NOT NULL REFERENCES cd_changes(id) ON DELETE RESTRICT,
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (community_id, document_id),
  CHECK (start_date IS NULL OR end_date IS NULL OR start_date <= end_date)
);

CREATE TABLE IF NOT EXISTS cd_occupancies (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id         UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  property_id          UUID NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  party_id             UUID REFERENCES cd_parties(id) ON DELETE RESTRICT,   -- null: occupied by someone not identified
  occupancy_kind       TEXT NOT NULL CHECK (occupancy_kind IN ('tenant', 'owner_occupant', 'family_member', 'vacant')),
  basis                TEXT NOT NULL CHECK (basis IN ('lease', 'owner_statement', 'tenant_source')),   -- there is no inferred basis
  lease_id             UUID REFERENCES cd_leases(id) ON DELETE RESTRICT,
  effective_from       DATE,
  effective_to         DATE,
  observed_as_of       DATE NOT NULL,
  change_id            UUID NOT NULL REFERENCES cd_changes(id) ON DELETE RESTRICT,
  ended_by_change_id   UUID REFERENCES cd_changes(id) ON DELETE RESTRICT,
  recorded_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT cd_occupancy_lease_basis CHECK ((basis = 'lease') = (lease_id IS NOT NULL)),
  CONSTRAINT cd_occupancy_tenant_needs_evidence_basis CHECK (occupancy_kind <> 'tenant' OR basis IN ('lease', 'tenant_source')),
  CHECK (effective_from IS NULL OR effective_to IS NULL OR effective_from <= effective_to)
);

CREATE TABLE IF NOT EXISTS cd_addresses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id      UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  party_id          UUID NOT NULL REFERENCES cd_parties(id) ON DELETE RESTRICT,
  purpose           TEXT NOT NULL CHECK (purpose IN ('mailing')),
  line1             TEXT NOT NULL CHECK (length(btrim(line1)) > 0),
  line2             TEXT,
  unit              TEXT,
  city              TEXT,
  state             TEXT,                                                    -- no default; null when not given
  postal_code       TEXT,
  is_primary        BOOLEAN NOT NULL,
  is_property_address BOOLEAN NOT NULL,                                      -- true only when the source says mail goes to the property
  observed_as_of    DATE NOT NULL,
  change_id         UUID NOT NULL REFERENCES cd_changes(id) ON DELETE RESTRICT,
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cd_contact_methods (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id      UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  party_id          UUID NOT NULL REFERENCES cd_parties(id) ON DELETE RESTRICT,
  method_type       TEXT NOT NULL CHECK (method_type IN ('email', 'phone')),
  value_normalized  TEXT NOT NULL CHECK (length(btrim(value_normalized)) > 0),
  attribution       TEXT NOT NULL CHECK (attribution IN ('party', 'owner_record', 'tenant')),   -- owner_record: keyed by account in the source, not by person
  is_primary        BOOLEAN NOT NULL,
  observed_as_of    DATE NOT NULL,
  change_id         UUID NOT NULL REFERENCES cd_changes(id) ON DELETE RESTRICT,
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (party_id, method_type, value_normalized)                          -- the SAME value on two parties is allowed: it links nobody
);

CREATE TABLE IF NOT EXISTS cd_evidence (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id      UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  subject_table     TEXT NOT NULL CHECK (subject_table IN ('cd_ownerships', 'cd_occupancies', 'cd_leases', 'cd_addresses', 'cd_contact_methods', 'cd_parties', 'cd_ownership_end')),
  subject_id        UUID NOT NULL,
  document_id       UUID NOT NULL REFERENCES cd_source_documents(id) ON DELETE RESTRICT,
  locator           JSONB NOT NULL DEFAULT '{}'::jsonb,                     -- { sheet, row } / { line } / { page }
  basis             TEXT NOT NULL CHECK (length(btrim(basis)) > 0),          -- why this document supports the subject
  change_id         UUID NOT NULL REFERENCES cd_changes(id) ON DELETE RESTRICT,
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cd_evidence_subject ON cd_evidence (subject_table, subject_id);
CREATE INDEX IF NOT EXISTS idx_cd_ownerships_property ON cd_ownerships (property_id) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_cd_occupancies_property ON cd_occupancies (property_id) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_cd_party_identities_party ON cd_party_source_identities (party_id);

-- Immutability: identities, documents, evidence and changes are append-only; the
-- relationship tables allow only the end of a period (set once, by a change).
CREATE OR REPLACE FUNCTION cd_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN RAISE EXCEPTION 'community data: % is append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation'; END;
$fn$;
CREATE OR REPLACE FUNCTION cd_end_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'community data: % rows are never deleted', TG_TABLE_NAME USING ERRCODE = 'check_violation'; END IF;
  IF OLD.effective_to IS NOT NULL OR NEW.effective_to IS NULL OR NEW.ended_by_change_id IS NULL
     OR (to_jsonb(NEW) - ARRAY['effective_to', 'effective_to_basis', 'ended_by_change_id']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['effective_to', 'effective_to_basis', 'ended_by_change_id']) THEN
    RAISE EXCEPTION 'community data: a % row can only be ended once, by a change; nothing else changes', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;
DO $do$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['cd_source_documents', 'cd_parties', 'cd_party_source_identities', 'cd_property_source_identities', 'cd_leases', 'cd_addresses', 'cd_contact_methods', 'cd_evidence'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_append_only ON %1$s; CREATE TRIGGER trg_%1$s_append_only BEFORE UPDATE OR DELETE ON %1$s FOR EACH ROW EXECUTE FUNCTION cd_append_only();', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['cd_ownerships', 'cd_occupancies'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_end_only ON %1$s; CREATE TRIGGER trg_%1$s_end_only BEFORE UPDATE OR DELETE ON %1$s FOR EACH ROW EXECUTE FUNCTION cd_end_only();', t);
  END LOOP;
END $do$;

-- cd_changes: append-only, except that the apply which created a row writes its result once.
CREATE OR REPLACE FUNCTION cd_changes_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' AND current_setting('cd.writing_result', true) = OLD.id::text AND OLD.result = '{}'::jsonb
     AND (to_jsonb(NEW) - 'result') = (to_jsonb(OLD) - 'result') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'community data: cd_changes is append-only' USING ERRCODE = 'check_violation';
END;
$fn$;
DROP TRIGGER IF EXISTS trg_cd_changes_guard ON cd_changes;
CREATE TRIGGER trg_cd_changes_guard BEFORE UPDATE OR DELETE ON cd_changes FOR EACH ROW EXECUTE FUNCTION cd_changes_guard();

-- ---------------------------------------------------------------------------
-- The single write path. p_change (all arrays optional):
--   documents:  [{ ref, provider, kind, filename, sha256, period_start, period_end, observed_as_of }]
--   parties:    [{ ref, kind, kind_basis, display_name, given_name, family_name,
--                  identities: [{ provider, identity_kind, identity_key, slot }] }]   (>= 1 identity each)
--   property_identities: [{ property_id, provider, identity_key }]
--   ownerships: [{ property_id, party_ref, role, effective_from, effective_from_basis, effective_to, effective_to_basis, observed_as_of, evidence: [...] }]
--   ownership_ends: [{ ownership_id, effective_to, effective_to_basis, evidence: [...] }]
--   leases:     [{ ref, property_id, document_ref, start_date, end_date, received_at, renewal_of_lease_id, tenant_party_refs: [...], evidence: [...] }]
--   occupancies:[{ property_id, party_ref (or null), occupancy_kind, basis, lease_ref, effective_from, effective_to, observed_as_of, evidence: [...] }]
--   addresses:  [{ party_ref, purpose, line1, line2, unit, city, state, postal_code, is_primary, is_property_address, observed_as_of, evidence: [...] }]
--   contact_methods: [{ party_ref, method_type, value, attribution, is_primary, observed_as_of, evidence: [...] }]
--   evidence item: { document_ref | document_id, locator, basis }
-- A party_ref names a party of this proposal; a party is FOUND only by one of its
-- source identities (never by name / email / phone / address). Returns the ids.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cd_apply_change(p_community UUID, p_idempotency_key TEXT, p_proposal_sha256 TEXT, p_change JSONB, p_actor_kind TEXT, p_actor_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  prior cd_changes%ROWTYPE; chg UUID; d JSONB; p JSONB; i JSONB; it JSONB; e JSONB;
  doc_ids JSONB := '{}'::jsonb; party_ids JSONB := '{}'::jsonb; lease_ids JSONB := '{}'::jsonb;
  hit UUID; hit_set UUID[]; new_id UUID; doc UUID; prop_comm UUID; out JSONB := '{}'::jsonb; created JSONB := '[]'::jsonb;
BEGIN
  IF p_change IS NULL OR jsonb_typeof(p_change) <> 'object' THEN RAISE EXCEPTION 'community data: the change must be an object' USING ERRCODE = 'check_violation'; END IF;
  -- idempotency: same key + same proposal -> the original result; same key + other proposal -> refused
  SELECT * INTO prior FROM cd_changes WHERE community_id = p_community AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF prior.proposal_sha256 = p_proposal_sha256 THEN RETURN prior.result || jsonb_build_object('replayed', true); END IF;
    RAISE EXCEPTION 'community data: idempotency key % was already used for a different proposal', p_idempotency_key USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO cd_changes (community_id, idempotency_key, proposal_sha256, result, actor_kind, actor_id)
  VALUES (p_community, p_idempotency_key, p_proposal_sha256, '{}'::jsonb, p_actor_kind, p_actor_id) RETURNING id INTO chg;

  -- documents (re-used by hash when already recorded for this community)
  FOR d IN SELECT * FROM jsonb_array_elements(coalesce(p_change->'documents', '[]'::jsonb)) LOOP
    SELECT id INTO hit FROM cd_source_documents WHERE community_id = p_community AND sha256 = d->>'sha256';
    IF hit IS NULL THEN
      INSERT INTO cd_source_documents (community_id, provider, kind, filename, sha256, period_start, period_end, observed_as_of, change_id)
      VALUES (p_community, d->>'provider', d->>'kind', d->>'filename', d->>'sha256', (d->>'period_start')::date, (d->>'period_end')::date, (d->>'observed_as_of')::date, chg) RETURNING id INTO hit;
    END IF;
    doc_ids := doc_ids || jsonb_build_object(d->>'ref', hit);
    hit := NULL;
  END LOOP;

  -- parties: found ONLY by source identity; identities of one party may not point at two existing parties
  FOR p IN SELECT * FROM jsonb_array_elements(coalesce(p_change->'parties', '[]'::jsonb)) LOOP
    IF jsonb_array_length(coalesce(p->'identities', '[]'::jsonb)) = 0 THEN RAISE EXCEPTION 'community data: party % has no source identity', p->>'ref' USING ERRCODE = 'check_violation'; END IF;
    SELECT array_agg(DISTINCT s.party_id) INTO hit_set FROM jsonb_array_elements(p->'identities') x
      JOIN cd_party_source_identities s ON s.community_id = p_community AND s.provider = x->>'provider' AND s.identity_kind = x->>'identity_kind' AND s.identity_key = x->>'identity_key' AND s.slot = x->>'slot';
    IF coalesce(array_length(hit_set, 1), 0) > 1 THEN RAISE EXCEPTION 'community data: party % names identities of % different existing parties; identities are never merged', p->>'ref', array_length(hit_set, 1) USING ERRCODE = 'check_violation'; END IF;
    IF coalesce(array_length(hit_set, 1), 0) = 1 THEN new_id := hit_set[1];
    ELSE
      INSERT INTO cd_parties (community_id, kind, kind_basis, display_name, given_name, family_name, change_id)
      VALUES (p_community, p->>'kind', coalesce(p->>'kind_basis', 'unknown'), p->>'display_name', nullif(p->>'given_name', ''), nullif(p->>'family_name', ''), chg) RETURNING id INTO new_id;
      created := created || jsonb_build_array(p->>'ref');
    END IF;
    FOR i IN SELECT * FROM jsonb_array_elements(p->'identities') LOOP
      IF NOT EXISTS (SELECT 1 FROM cd_party_source_identities s WHERE s.community_id = p_community AND s.provider = i->>'provider' AND s.identity_kind = i->>'identity_kind' AND s.identity_key = i->>'identity_key' AND s.slot = i->>'slot') THEN
        INSERT INTO cd_party_source_identities (community_id, party_id, provider, identity_kind, identity_key, slot, change_id)
        VALUES (p_community, new_id, i->>'provider', i->>'identity_kind', i->>'identity_key', i->>'slot', chg);
      END IF;
    END LOOP;
    party_ids := party_ids || jsonb_build_object(p->>'ref', new_id);
  END LOOP;

  FOR it IN SELECT * FROM jsonb_array_elements(coalesce(p_change->'property_identities', '[]'::jsonb)) LOOP
    SELECT community_id INTO prop_comm FROM properties WHERE id = (it->>'property_id')::uuid;
    IF prop_comm IS DISTINCT FROM p_community THEN RAISE EXCEPTION 'community data: property % is not in this community', it->>'property_id' USING ERRCODE = 'check_violation'; END IF;
    SELECT property_id INTO hit FROM cd_property_source_identities WHERE community_id = p_community AND provider = it->>'provider' AND identity_kind = 'account' AND identity_key = it->>'identity_key';
    IF hit IS NOT NULL AND hit <> (it->>'property_id')::uuid THEN RAISE EXCEPTION 'community data: account % already belongs to another property', it->>'identity_key' USING ERRCODE = 'check_violation'; END IF;
    IF hit IS NULL THEN INSERT INTO cd_property_source_identities (community_id, property_id, provider, identity_kind, identity_key, change_id) VALUES (p_community, (it->>'property_id')::uuid, it->>'provider', 'account', it->>'identity_key', chg); END IF;
    hit := NULL;
  END LOOP;

  -- every material item: property in this community, known party, >= 1 evidence on a known document
  FOR it IN SELECT x FROM jsonb_array_elements(coalesce(p_change->'ownerships', '[]'::jsonb)) x UNION ALL SELECT x FROM jsonb_array_elements(coalesce(p_change->'occupancies', '[]'::jsonb)) x
            UNION ALL SELECT x FROM jsonb_array_elements(coalesce(p_change->'leases', '[]'::jsonb)) x LOOP
    SELECT community_id INTO prop_comm FROM properties WHERE id = (it->>'property_id')::uuid;
    IF prop_comm IS DISTINCT FROM p_community THEN RAISE EXCEPTION 'community data: property % is not in this community', it->>'property_id' USING ERRCODE = 'check_violation'; END IF;
  END LOOP;
  FOR it IN SELECT x FROM jsonb_array_elements(coalesce(p_change->'ownerships', '[]'::jsonb)) x UNION ALL SELECT x FROM jsonb_array_elements(coalesce(p_change->'ownership_ends', '[]'::jsonb)) x
            UNION ALL SELECT x FROM jsonb_array_elements(coalesce(p_change->'leases', '[]'::jsonb)) x UNION ALL SELECT x FROM jsonb_array_elements(coalesce(p_change->'occupancies', '[]'::jsonb)) x
            UNION ALL SELECT x FROM jsonb_array_elements(coalesce(p_change->'addresses', '[]'::jsonb)) x UNION ALL SELECT x FROM jsonb_array_elements(coalesce(p_change->'contact_methods', '[]'::jsonb)) x LOOP
    IF jsonb_array_length(coalesce(it->'evidence', '[]'::jsonb)) = 0 THEN RAISE EXCEPTION 'community data: an item has no evidence: %', left(it::text, 200) USING ERRCODE = 'check_violation'; END IF;
    FOR e IN SELECT * FROM jsonb_array_elements(it->'evidence') LOOP
      IF coalesce(doc_ids->>(e->>'document_ref'), e->>'document_id') IS NULL OR NOT EXISTS (SELECT 1 FROM cd_source_documents WHERE id = coalesce(doc_ids->>(e->>'document_ref'), e->>'document_id')::uuid AND community_id = p_community) THEN
        RAISE EXCEPTION 'community data: evidence names an unknown document' USING ERRCODE = 'check_violation';
      END IF;
      IF length(btrim(coalesce(e->>'basis', ''))) = 0 THEN RAISE EXCEPTION 'community data: evidence needs a basis' USING ERRCODE = 'check_violation'; END IF;
    END LOOP;
  END LOOP;

  -- ending an existing ownership (a transfer): once, with a basis, with evidence (BEFORE new ownerships, so a transfer can replace the owner)
  FOR it IN SELECT * FROM jsonb_array_elements(coalesce(p_change->'ownership_ends', '[]'::jsonb)) LOOP
    UPDATE cd_ownerships SET effective_to = (it->>'effective_to')::date, effective_to_basis = it->>'effective_to_basis', ended_by_change_id = chg
     WHERE id = (it->>'ownership_id')::uuid AND community_id = p_community AND effective_to IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'community data: ownership % is not an open ownership of this community', it->>'ownership_id' USING ERRCODE = 'check_violation'; END IF;
    INSERT INTO cd_evidence (community_id, subject_table, subject_id, document_id, locator, basis, change_id)
      SELECT p_community, 'cd_ownership_end', (it->>'ownership_id')::uuid, coalesce(doc_ids->>(x->>'document_ref'), x->>'document_id')::uuid, coalesce(x->'locator', '{}'::jsonb), x->>'basis', chg FROM jsonb_array_elements(it->'evidence') x;
  END LOOP;
  -- ownerships
  FOR it IN SELECT * FROM jsonb_array_elements(coalesce(p_change->'ownerships', '[]'::jsonb)) LOOP
    IF party_ids->>(it->>'party_ref') IS NULL THEN RAISE EXCEPTION 'community data: ownership names unknown party %', it->>'party_ref' USING ERRCODE = 'check_violation'; END IF;
    IF it->>'role' = 'owner' AND it->>'effective_to' IS NULL AND EXISTS (SELECT 1 FROM cd_ownerships o WHERE o.property_id = (it->>'property_id')::uuid AND o.role = 'owner' AND o.effective_to IS NULL AND o.party_id <> (party_ids->>(it->>'party_ref'))::uuid) THEN
      RAISE EXCEPTION 'community data: property % already has a current owner of another owner record; end that ownership with transfer evidence in the same change (no silent second owner)', it->>'property_id' USING ERRCODE = 'check_violation';
    END IF;
    IF it->>'effective_to' IS NULL AND EXISTS (SELECT 1 FROM cd_ownerships o WHERE o.property_id = (it->>'property_id')::uuid AND o.party_id = (party_ids->>(it->>'party_ref'))::uuid AND o.role = it->>'role' AND o.effective_to IS NULL) THEN
      CONTINUE;   -- the same open ownership is already recorded (a later observation of it adds nothing)
    END IF;
    INSERT INTO cd_ownerships (community_id, property_id, party_id, role, effective_from, effective_from_basis, effective_to, effective_to_basis, observed_as_of, change_id, ended_by_change_id)
    VALUES (p_community, (it->>'property_id')::uuid, (party_ids->>(it->>'party_ref'))::uuid, it->>'role', (it->>'effective_from')::date, it->>'effective_from_basis', (it->>'effective_to')::date, it->>'effective_to_basis', (it->>'observed_as_of')::date, chg,
            CASE WHEN it->>'effective_to' IS NOT NULL THEN chg END) RETURNING id INTO new_id;
    INSERT INTO cd_evidence (community_id, subject_table, subject_id, document_id, locator, basis, change_id)
      SELECT p_community, 'cd_ownerships', new_id, coalesce(doc_ids->>(x->>'document_ref'), x->>'document_id')::uuid, coalesce(x->'locator', '{}'::jsonb), x->>'basis', chg FROM jsonb_array_elements(it->'evidence') x;
  END LOOP;
  -- leases (+ their tenant parties are named by ref; tenancy is recorded as occupancies)
  FOR it IN SELECT * FROM jsonb_array_elements(coalesce(p_change->'leases', '[]'::jsonb)) LOOP
    doc := coalesce(doc_ids->>(it->>'document_ref'), it->>'document_id')::uuid;
    IF doc IS NULL THEN RAISE EXCEPTION 'community data: a lease needs its document' USING ERRCODE = 'check_violation'; END IF;
    INSERT INTO cd_leases (community_id, property_id, document_id, start_date, end_date, received_at, renewal_of, change_id)
    VALUES (p_community, (it->>'property_id')::uuid, doc, (it->>'start_date')::date, (it->>'end_date')::date, (it->>'received_at')::date, (it->>'renewal_of_lease_id')::uuid, chg) RETURNING id INTO new_id;
    lease_ids := lease_ids || jsonb_build_object(it->>'ref', new_id);
    INSERT INTO cd_evidence (community_id, subject_table, subject_id, document_id, locator, basis, change_id)
      SELECT p_community, 'cd_leases', new_id, coalesce(doc_ids->>(x->>'document_ref'), x->>'document_id')::uuid, coalesce(x->'locator', '{}'::jsonb), x->>'basis', chg FROM jsonb_array_elements(it->'evidence') x;
  END LOOP;
  -- occupancies: several may be open at once; nothing here ends another occupancy
  FOR it IN SELECT * FROM jsonb_array_elements(coalesce(p_change->'occupancies', '[]'::jsonb)) LOOP
    IF it->>'party_ref' IS NOT NULL AND party_ids->>(it->>'party_ref') IS NULL THEN RAISE EXCEPTION 'community data: occupancy names unknown party %', it->>'party_ref' USING ERRCODE = 'check_violation'; END IF;
    INSERT INTO cd_occupancies (community_id, property_id, party_id, occupancy_kind, basis, lease_id, effective_from, effective_to, observed_as_of, change_id)
    VALUES (p_community, (it->>'property_id')::uuid, (party_ids->>(it->>'party_ref'))::uuid, it->>'occupancy_kind', it->>'basis', (lease_ids->>(it->>'lease_ref'))::uuid, (it->>'effective_from')::date, (it->>'effective_to')::date, (it->>'observed_as_of')::date, chg) RETURNING id INTO new_id;
    INSERT INTO cd_evidence (community_id, subject_table, subject_id, document_id, locator, basis, change_id)
      SELECT p_community, 'cd_occupancies', new_id, coalesce(doc_ids->>(x->>'document_ref'), x->>'document_id')::uuid, coalesce(x->'locator', '{}'::jsonb), x->>'basis', chg FROM jsonb_array_elements(it->'evidence') x;
  END LOOP;
  -- addresses and contact methods: attached to a party, with attribution; a lease document never feeds an owner record
  FOR it IN SELECT * FROM jsonb_array_elements(coalesce(p_change->'addresses', '[]'::jsonb)) LOOP
    IF party_ids->>(it->>'party_ref') IS NULL THEN RAISE EXCEPTION 'community data: address names unknown party %', it->>'party_ref' USING ERRCODE = 'check_violation'; END IF;
    INSERT INTO cd_addresses (community_id, party_id, purpose, line1, line2, unit, city, state, postal_code, is_primary, is_property_address, observed_as_of, change_id)
    VALUES (p_community, (party_ids->>(it->>'party_ref'))::uuid, coalesce(it->>'purpose', 'mailing'), it->>'line1', nullif(it->>'line2', ''), nullif(it->>'unit', ''), nullif(it->>'city', ''), nullif(it->>'state', ''), nullif(it->>'postal_code', ''),
            coalesce((it->>'is_primary')::boolean, false), coalesce((it->>'is_property_address')::boolean, false), (it->>'observed_as_of')::date, chg) RETURNING id INTO new_id;
    INSERT INTO cd_evidence (community_id, subject_table, subject_id, document_id, locator, basis, change_id)
      SELECT p_community, 'cd_addresses', new_id, coalesce(doc_ids->>(x->>'document_ref'), x->>'document_id')::uuid, coalesce(x->'locator', '{}'::jsonb), x->>'basis', chg FROM jsonb_array_elements(it->'evidence') x;
  END LOOP;
  FOR it IN SELECT * FROM jsonb_array_elements(coalesce(p_change->'contact_methods', '[]'::jsonb)) LOOP
    IF party_ids->>(it->>'party_ref') IS NULL THEN RAISE EXCEPTION 'community data: contact method names unknown party %', it->>'party_ref' USING ERRCODE = 'check_violation'; END IF;
    IF it->>'attribution' <> 'tenant' AND EXISTS (SELECT 1 FROM jsonb_array_elements(it->'evidence') x JOIN cd_source_documents sd ON sd.id = coalesce(doc_ids->>(x->>'document_ref'), x->>'document_id')::uuid WHERE sd.kind IN ('lease', 'amenity_application')) THEN
      RAISE EXCEPTION 'community data: a lease / application document never supplies an owner''s contact method' USING ERRCODE = 'check_violation';
    END IF;
    IF it->>'attribution' = 'tenant' AND NOT EXISTS (SELECT 1 FROM cd_party_source_identities s WHERE s.party_id = (party_ids->>(it->>'party_ref'))::uuid AND s.identity_kind IN ('tenant_id', 'lease_party')) THEN
      RAISE EXCEPTION 'community data: tenant attribution on a party that is not a tenant' USING ERRCODE = 'check_violation';
    END IF;
    new_id := NULL;
    INSERT INTO cd_contact_methods (community_id, party_id, method_type, value_normalized, attribution, is_primary, observed_as_of, change_id)
    VALUES (p_community, (party_ids->>(it->>'party_ref'))::uuid, it->>'method_type', CASE WHEN it->>'method_type' = 'email' THEN lower(btrim(it->>'value')) ELSE regexp_replace(it->>'value', '\D', '', 'g') END,
            it->>'attribution', coalesce((it->>'is_primary')::boolean, false), (it->>'observed_as_of')::date, chg)
    ON CONFLICT (party_id, method_type, value_normalized) DO NOTHING RETURNING id INTO new_id;
    IF new_id IS NOT NULL THEN
      INSERT INTO cd_evidence (community_id, subject_table, subject_id, document_id, locator, basis, change_id)
        SELECT p_community, 'cd_contact_methods', new_id, coalesce(doc_ids->>(x->>'document_ref'), x->>'document_id')::uuid, coalesce(x->'locator', '{}'::jsonb), x->>'basis', chg FROM jsonb_array_elements(it->'evidence') x;
    END IF;
    new_id := NULL;
  END LOOP;

  out := jsonb_build_object('change_id', chg, 'documents', doc_ids, 'parties', party_ids, 'parties_created', created, 'leases', lease_ids, 'replayed', false);
  -- the result row is written once by cd_record_result in this same transaction (cd_changes_guard)
  PERFORM set_config('cd.writing_result', chg::text, true);
  RETURN out;
END;
$fn$;

-- the change row stores its result: written once, inside the same transaction
CREATE OR REPLACE FUNCTION cd_record_result(p_change UUID, p_result JSONB) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF current_setting('cd.writing_result', true) IS DISTINCT FROM p_change::text THEN RAISE EXCEPTION 'community data: results are recorded only by the apply that created them' USING ERRCODE = 'check_violation'; END IF;
  UPDATE cd_changes SET result = p_result WHERE id = p_change AND result = '{}'::jsonb;
  PERFORM set_config('cd.writing_result', '', true);
END;
$fn$;

-- one call for the service: apply + record the result atomically
CREATE OR REPLACE FUNCTION cd_apply(p_community UUID, p_idempotency_key TEXT, p_proposal_sha256 TEXT, p_change JSONB, p_actor_kind TEXT, p_actor_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE r JSONB;
BEGIN
  r := cd_apply_change(p_community, p_idempotency_key, p_proposal_sha256, p_change, p_actor_kind, p_actor_id);
  IF coalesce((r->>'replayed')::boolean, false) = false THEN PERFORM cd_record_result((r->>'change_id')::uuid, r); END IF;
  RETURN r;
END;
$fn$;

-- why does Trusted believe this row? (documents, hashes, locators, bases)
CREATE OR REPLACE FUNCTION cd_why(p_subject_table TEXT, p_subject_id UUID) RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT coalesce(jsonb_agg(jsonb_build_object('document', jsonb_build_object('provider', d.provider, 'kind', d.kind, 'filename', d.filename, 'sha256', d.sha256, 'period_start', d.period_start, 'period_end', d.period_end, 'observed_as_of', d.observed_as_of),
           'locator', e.locator, 'basis', e.basis, 'change_id', e.change_id, 'recorded_at', e.recorded_at) ORDER BY e.recorded_at), '[]'::jsonb)
    FROM cd_evidence e JOIN cd_source_documents d ON d.id = e.document_id WHERE e.subject_table = p_subject_table AND e.subject_id = p_subject_id;
$fn$;

REVOKE ALL ON cd_changes, cd_source_documents, cd_parties, cd_party_source_identities, cd_property_source_identities, cd_ownerships, cd_leases, cd_occupancies, cd_addresses, cd_contact_methods, cd_evidence FROM PUBLIC;
GRANT SELECT ON cd_changes, cd_source_documents, cd_parties, cd_party_source_identities, cd_property_source_identities, cd_ownerships, cd_leases, cd_occupancies, cd_addresses, cd_contact_methods, cd_evidence TO service_role;
REVOKE ALL ON FUNCTION cd_apply_change(UUID, TEXT, TEXT, JSONB, TEXT, TEXT), cd_record_result(UUID, JSONB), cd_apply(UUID, TEXT, TEXT, JSONB, TEXT, TEXT), cd_why(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cd_apply(UUID, TEXT, TEXT, JSONB, TEXT, TEXT), cd_why(TEXT, UUID) TO service_role;

COMMIT;
