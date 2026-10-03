-- ============================================================================
-- 487_community_data_canonical.sql  (Issue #15, Ed 2026-10-03)  -- PROPOSAL, NOT APPLIED
-- ----------------------------------------------------------------------------
-- Canonical community data (properties / parties / relationships) built around
-- EVIDENCE, with ONE transaction-atomic, idempotent write path for the AI
-- operator. It sits beside the legacy contacts / property_ownerships /
-- property_residencies tables (untouched; the paused legacy write paths are
-- contained by lib/identity_safety.js). No existing table or row changes.
--
-- Principles, enforced in the database (the service validates first as well):
--   * SOURCE IDENTITY. A party exists only through provider-scoped identities
--     (provider + kind + key + slot). A proposed party carries exactly ONE
--     identity; it is found only by that identity (never by name, email, phone or
--     address). Attaching a further identity (another slot, another provider) to
--     an existing party is a separate, evidence-backed identity_links item; two
--     identities of two existing parties are never joined. Identities are immutable.
--   * UNKNOWN IS A STATE. Dates are nullable with a basis ('unknown' exactly when
--     the start is null); observed_as_of (when the source said so) is separate
--     from effective dates and from the write time. No default dates, no default
--     state. An organization only from source evidence (a name pattern is a hint).
--   * OCCUPANCY IS SEPARATE FROM OWNERSHIP; several occupancies may be open; no
--     inferred basis exists; occupancies end only through occupancy_ends.
--   * LIFECYCLES. Ownerships, occupancies, addresses and contact methods are
--     current until ENDED ONCE by a change (with basis + evidence); history is kept.
--     One current primary owner per property (partial unique index: concurrency
--     safe) plus any co_owners; one current primary mailing address per party;
--     one current primary email / phone per party.
--   * PROVENANCE. Every material row has >= 1 evidence row (document + locator +
--     basis). A repeat observation APPENDS evidence to the existing row, so the
--     observation history is never lost.
--   * COMMUNITY CONSISTENCY. Every party / document / lease / property reference
--     in a canonical row is of the same community (composite foreign keys for the
--     cd_* references, a trigger for properties).
--   * ONE WRITE PATH. Tables are SELECT-only for service_role; cd_apply (SECURITY
--     DEFINER) validates the whole proposal and runs in one transaction: any
--     failure rolls back everything. Idempotent by (community, key) + hash.
-- Record ownership: association_record, community-scoped on every row.
-- Requires: communities, properties (with community_id).
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
  UNIQUE (community_id, idempotency_key),
  UNIQUE (id, community_id)
);

CREATE TABLE IF NOT EXISTS cd_source_documents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id      UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  provider          TEXT NOT NULL CHECK (length(btrim(provider)) > 0),
  kind              TEXT NOT NULL CHECK (length(btrim(kind)) > 0),
  filename          TEXT,
  sha256            TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  period_start      DATE,
  period_end        DATE,
  observed_as_of    DATE NOT NULL,
  change_id         UUID NOT NULL,
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (community_id, sha256),
  UNIQUE (id, community_id),
  FOREIGN KEY (change_id, community_id) REFERENCES cd_changes(id, community_id) ON DELETE RESTRICT,
  CHECK (period_start IS NULL OR period_end IS NULL OR period_start <= period_end)
);

CREATE TABLE IF NOT EXISTS cd_parties (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id      UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  kind              TEXT NOT NULL CHECK (kind IN ('person', 'organization', 'unknown')),
  kind_basis        TEXT NOT NULL CHECK (kind_basis IN ('source_field', 'unknown')),
  hints             JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(hints) = 'array'),   -- e.g. ["organization_name_pattern"]: never a fact
  display_name      TEXT NOT NULL CHECK (length(btrim(display_name)) > 0),
  given_name        TEXT,
  family_name       TEXT,
  change_id         UUID NOT NULL,
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, community_id),
  FOREIGN KEY (change_id, community_id) REFERENCES cd_changes(id, community_id) ON DELETE RESTRICT,
  CONSTRAINT cd_party_kind_needs_source CHECK ((kind = 'unknown') = (kind_basis = 'unknown'))
);

CREATE TABLE IF NOT EXISTS cd_party_source_identities (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id      UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  party_id          UUID NOT NULL,
  provider          TEXT NOT NULL CHECK (length(btrim(provider)) > 0),
  identity_kind     TEXT NOT NULL CHECK (identity_kind IN ('homeowner_id', 'tenant_id', 'transfer_record', 'lease_party', 'statement_party')),
  identity_key      TEXT NOT NULL CHECK (length(btrim(identity_key)) > 0),
  slot              TEXT NOT NULL CHECK (length(btrim(slot)) > 0),
  linked_by_evidence BOOLEAN NOT NULL DEFAULT false,                         -- true when attached to an existing party by an identity_links item
  change_id         UUID NOT NULL,
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (community_id, provider, identity_kind, identity_key, slot),
  FOREIGN KEY (party_id, community_id) REFERENCES cd_parties(id, community_id) ON DELETE RESTRICT,
  FOREIGN KEY (change_id, community_id) REFERENCES cd_changes(id, community_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS cd_property_source_identities (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id      UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  property_id       UUID NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  provider          TEXT NOT NULL CHECK (length(btrim(provider)) > 0),
  identity_kind     TEXT NOT NULL CHECK (identity_kind IN ('account')),
  identity_key      TEXT NOT NULL CHECK (length(btrim(identity_key)) > 0),
  change_id         UUID NOT NULL,
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (community_id, provider, identity_kind, identity_key),
  FOREIGN KEY (change_id, community_id) REFERENCES cd_changes(id, community_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS cd_ownerships (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id         UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  property_id          UUID NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  party_id             UUID NOT NULL,
  role                 TEXT NOT NULL CHECK (role IN ('owner', 'co_owner')),
  effective_from       DATE,
  effective_from_basis TEXT NOT NULL CHECK (effective_from_basis IN ('unknown', 'transfer_settlement', 'deed_recorded', 'owner_statement')),
  effective_to         DATE,
  effective_to_basis   TEXT CHECK (effective_to_basis IN ('transfer_settlement', 'deed_recorded', 'owner_statement')),
  observed_as_of       DATE NOT NULL,
  change_id            UUID NOT NULL,
  ended_by_change_id   UUID,
  recorded_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (party_id, community_id) REFERENCES cd_parties(id, community_id) ON DELETE RESTRICT,
  FOREIGN KEY (change_id, community_id) REFERENCES cd_changes(id, community_id) ON DELETE RESTRICT,
  -- end provenance is community-scoped too: a row can only be ended by a change of its own community
  FOREIGN KEY (ended_by_change_id, community_id) REFERENCES cd_changes(id, community_id) ON DELETE RESTRICT,
  CONSTRAINT cd_ownership_unknown_start_is_real CHECK ((effective_from IS NULL) = (effective_from_basis = 'unknown')),
  CONSTRAINT cd_ownership_end_has_basis CHECK ((effective_to IS NULL) = (effective_to_basis IS NULL)),
  CONSTRAINT cd_ownership_dates_ordered CHECK (effective_from IS NULL OR effective_to IS NULL OR effective_from <= effective_to)
);
-- one current primary owner per property (concurrency-safe), and no duplicate open row for a party + role
CREATE UNIQUE INDEX IF NOT EXISTS cd_one_current_owner_per_property ON cd_ownerships (property_id) WHERE role = 'owner' AND effective_to IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cd_one_open_ownership_per_party_role ON cd_ownerships (property_id, party_id, role) WHERE effective_to IS NULL;

CREATE TABLE IF NOT EXISTS cd_leases (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id      UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  property_id       UUID NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  document_id       UUID NOT NULL,
  start_date        DATE,
  end_date          DATE,
  received_at       DATE,
  renewal_of        UUID,
  change_id         UUID NOT NULL,
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (community_id, document_id),
  UNIQUE (id, community_id),
  FOREIGN KEY (document_id, community_id) REFERENCES cd_source_documents(id, community_id) ON DELETE RESTRICT,
  FOREIGN KEY (renewal_of, community_id) REFERENCES cd_leases(id, community_id) ON DELETE RESTRICT,
  FOREIGN KEY (change_id, community_id) REFERENCES cd_changes(id, community_id) ON DELETE RESTRICT,
  CHECK (start_date IS NULL OR end_date IS NULL OR start_date <= end_date)
);

CREATE TABLE IF NOT EXISTS cd_occupancies (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id         UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  property_id          UUID NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  party_id             UUID,
  occupancy_kind       TEXT NOT NULL CHECK (occupancy_kind IN ('tenant', 'owner_occupant', 'family_member', 'vacant')),
  basis                TEXT NOT NULL CHECK (basis IN ('lease', 'owner_statement', 'tenant_source')),
  lease_id             UUID,
  effective_from       DATE,
  effective_to         DATE,
  effective_to_basis   TEXT CHECK (effective_to_basis IN ('lease_end', 'move_out_statement', 'owner_statement', 'tenant_source')),
  observed_as_of       DATE NOT NULL,
  change_id            UUID NOT NULL,
  ended_by_change_id   UUID,
  recorded_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (party_id, community_id) REFERENCES cd_parties(id, community_id) ON DELETE RESTRICT,
  FOREIGN KEY (lease_id, community_id) REFERENCES cd_leases(id, community_id) ON DELETE RESTRICT,
  FOREIGN KEY (change_id, community_id) REFERENCES cd_changes(id, community_id) ON DELETE RESTRICT,
  -- end provenance is community-scoped too: a row can only be ended by a change of its own community
  FOREIGN KEY (ended_by_change_id, community_id) REFERENCES cd_changes(id, community_id) ON DELETE RESTRICT,
  CONSTRAINT cd_occupancy_lease_basis CHECK ((basis = 'lease') = (lease_id IS NOT NULL)),
  CONSTRAINT cd_occupancy_tenant_needs_evidence_basis CHECK (occupancy_kind <> 'tenant' OR basis IN ('lease', 'tenant_source')),
  CONSTRAINT cd_occupancy_end_has_basis CHECK ((effective_to IS NULL) = (effective_to_basis IS NULL)),
  CHECK (effective_from IS NULL OR effective_to IS NULL OR effective_from <= effective_to)
);
CREATE UNIQUE INDEX IF NOT EXISTS cd_one_open_occupancy_per_party ON cd_occupancies (property_id, party_id, occupancy_kind) WHERE effective_to IS NULL AND party_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS cd_addresses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id      UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  party_id          UUID NOT NULL,
  purpose           TEXT NOT NULL CHECK (purpose IN ('mailing')),
  line1             TEXT NOT NULL CHECK (length(btrim(line1)) > 0),
  line2             TEXT,
  unit              TEXT,
  city              TEXT,
  state             TEXT,
  postal_code       TEXT,
  address_key       TEXT NOT NULL,                                           -- normalized identity of the address text (repeat observations)
  is_primary        BOOLEAN NOT NULL,
  is_property_address BOOLEAN NOT NULL,
  observed_as_of    DATE NOT NULL,
  effective_to      DATE,                                                    -- when it stopped being operative (null = current)
  effective_to_basis TEXT CHECK (effective_to_basis IN ('superseded_by_source', 'owner_statement', 'returned_mail', 'source_removed')),
  change_id         UUID NOT NULL,
  ended_by_change_id UUID,
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (party_id, community_id) REFERENCES cd_parties(id, community_id) ON DELETE RESTRICT,
  FOREIGN KEY (change_id, community_id) REFERENCES cd_changes(id, community_id) ON DELETE RESTRICT,
  -- end provenance is community-scoped too: a row can only be ended by a change of its own community
  FOREIGN KEY (ended_by_change_id, community_id) REFERENCES cd_changes(id, community_id) ON DELETE RESTRICT,
  CONSTRAINT cd_address_end_has_basis CHECK ((effective_to IS NULL) = (effective_to_basis IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS cd_one_current_address_per_text ON cd_addresses (party_id, purpose, address_key) WHERE effective_to IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cd_one_current_primary_address ON cd_addresses (party_id, purpose) WHERE is_primary AND effective_to IS NULL;

CREATE TABLE IF NOT EXISTS cd_contact_methods (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id      UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  party_id          UUID NOT NULL,
  method_type       TEXT NOT NULL CHECK (method_type IN ('email', 'phone')),
  value_normalized  TEXT NOT NULL CHECK (length(btrim(value_normalized)) > 0),
  attribution       TEXT NOT NULL CHECK (attribution IN ('party', 'owner_record', 'tenant')),
  is_primary        BOOLEAN NOT NULL,
  observed_as_of    DATE NOT NULL,
  effective_to      DATE,
  effective_to_basis TEXT CHECK (effective_to_basis IN ('superseded_by_source', 'owner_statement', 'bounced', 'source_removed')),
  change_id         UUID NOT NULL,
  ended_by_change_id UUID,
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (party_id, community_id) REFERENCES cd_parties(id, community_id) ON DELETE RESTRICT,
  FOREIGN KEY (change_id, community_id) REFERENCES cd_changes(id, community_id) ON DELETE RESTRICT,
  -- end provenance is community-scoped too: a row can only be ended by a change of its own community
  FOREIGN KEY (ended_by_change_id, community_id) REFERENCES cd_changes(id, community_id) ON DELETE RESTRICT,
  CONSTRAINT cd_contact_method_end_has_basis CHECK ((effective_to IS NULL) = (effective_to_basis IS NULL))
);
-- the SAME value on two parties is allowed (links nobody); per party one current row per value, one current primary per type
CREATE UNIQUE INDEX IF NOT EXISTS cd_one_current_method_per_value ON cd_contact_methods (party_id, method_type, value_normalized) WHERE effective_to IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cd_one_current_primary_method ON cd_contact_methods (party_id, method_type) WHERE is_primary AND effective_to IS NULL;

CREATE TABLE IF NOT EXISTS cd_evidence (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id      UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  subject_table     TEXT NOT NULL CHECK (subject_table IN ('cd_ownerships', 'cd_occupancies', 'cd_leases', 'cd_addresses', 'cd_contact_methods', 'cd_party_source_identities',
                                                          'cd_ownership_end', 'cd_occupancy_end', 'cd_address_end', 'cd_contact_method_end')),
  subject_id        UUID NOT NULL,
  observation       TEXT NOT NULL CHECK (observation IN ('created', 'reobserved', 'ended', 'linked')),
  document_id       UUID NOT NULL,
  locator           JSONB NOT NULL DEFAULT '{}'::jsonb,
  basis             TEXT NOT NULL CHECK (length(btrim(basis)) > 0),
  change_id         UUID NOT NULL,
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (document_id, community_id) REFERENCES cd_source_documents(id, community_id) ON DELETE RESTRICT,
  FOREIGN KEY (change_id, community_id) REFERENCES cd_changes(id, community_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_cd_evidence_subject ON cd_evidence (subject_table, subject_id);
CREATE INDEX IF NOT EXISTS idx_cd_party_identities_party ON cd_party_source_identities (party_id);

-- properties are legacy rows: a canonical row may only reference a property of its own community
CREATE OR REPLACE FUNCTION cd_property_same_community() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE pc UUID;
BEGIN
  SELECT community_id INTO pc FROM properties WHERE id = NEW.property_id;
  IF pc IS DISTINCT FROM NEW.community_id THEN RAISE EXCEPTION 'community data: property % is not in community %', NEW.property_id, NEW.community_id USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END;
$fn$;

-- immutability: append-only tables; lifecycle tables can only be ENDED once, by a change
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
CREATE OR REPLACE FUNCTION cd_changes_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' AND current_setting('cd.writing_result', true) = OLD.id::text AND OLD.result = '{}'::jsonb
     AND (to_jsonb(NEW) - 'result') = (to_jsonb(OLD) - 'result') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'community data: cd_changes is append-only' USING ERRCODE = 'check_violation';
END;
$fn$;
DO $do$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['cd_source_documents', 'cd_parties', 'cd_party_source_identities', 'cd_property_source_identities', 'cd_leases', 'cd_evidence'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_append_only ON %1$s; CREATE TRIGGER trg_%1$s_append_only BEFORE UPDATE OR DELETE ON %1$s FOR EACH ROW EXECUTE FUNCTION cd_append_only();', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['cd_ownerships', 'cd_occupancies', 'cd_addresses', 'cd_contact_methods'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_end_only ON %1$s; CREATE TRIGGER trg_%1$s_end_only BEFORE UPDATE OR DELETE ON %1$s FOR EACH ROW EXECUTE FUNCTION cd_end_only();', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['cd_property_source_identities', 'cd_ownerships', 'cd_leases', 'cd_occupancies'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_property_community ON %1$s; CREATE TRIGGER trg_%1$s_property_community BEFORE INSERT ON %1$s FOR EACH ROW EXECUTE FUNCTION cd_property_same_community();', t);
  END LOOP;
END $do$;
DROP TRIGGER IF EXISTS trg_cd_changes_guard ON cd_changes;
CREATE TRIGGER trg_cd_changes_guard BEFORE UPDATE OR DELETE ON cd_changes FOR EACH ROW EXECUTE FUNCTION cd_changes_guard();

-- ---------------------------------------------------------------------------
-- The single write path. p_change (all arrays optional):
--   documents:       [{ ref, provider, kind, filename, sha256, period_start, period_end, observed_as_of }]
--   identity_links:  [{ existing: {provider, identity_kind, identity_key, slot}, add: {...}, evidence: [...] }]
--   parties:         [{ ref, kind, kind_basis, hints, display_name, given_name, family_name, identities: [ exactly one ] }]
--   property_identities: [{ property_id, provider, identity_key }]
--   ownership_ends / occupancy_ends / address_ends / contact_method_ends:
--                    [{ <ownership|occupancy|address|contact_method>_id, effective_to, effective_to_basis, evidence: [...] }]
--   ownerships, leases, occupancies, addresses, contact_methods: material items, each with evidence: [...]
--   evidence item:   { document_ref | document_id, locator, basis }
-- Order: documents, identity links, parties, property identities, ENDS, then new
-- rows; a repeat observation of an existing current row appends its evidence.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cd_evidence_for(p_community UUID, p_change UUID, p_table TEXT, p_subject UUID, p_observation TEXT, p_items JSONB, p_doc_ids JSONB) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 THEN RAISE EXCEPTION 'community data: % needs evidence', p_table USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO cd_evidence (community_id, subject_table, subject_id, observation, document_id, locator, basis, change_id)
    SELECT p_community, p_table, p_subject, p_observation, coalesce(p_doc_ids->>(x->>'document_ref'), x->>'document_id')::uuid, coalesce(x->'locator', '{}'::jsonb), x->>'basis', p_change
      FROM jsonb_array_elements(p_items) x;
END;
$fn$;

CREATE OR REPLACE FUNCTION cd_apply_change(p_community UUID, p_idempotency_key TEXT, p_proposal_sha256 TEXT, p_change JSONB, p_actor_kind TEXT, p_actor_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  prior cd_changes%ROWTYPE; chg UUID; d JSONB; p JSONB; i JSONB; it JSONB; e JSONB; k TEXT;
  doc_ids JSONB := '{}'::jsonb; party_ids JSONB := '{}'::jsonb; lease_ids JSONB := '{}'::jsonb;
  hit UUID; hit2 UUID; new_id UUID; doc UUID; out JSONB; created JSONB := '[]'::jsonb; reobserved INT := 0;
BEGIN
  IF p_change IS NULL OR jsonb_typeof(p_change) <> 'object' THEN RAISE EXCEPTION 'community data: the change must be an object' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO prior FROM cd_changes WHERE community_id = p_community AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF prior.proposal_sha256 = p_proposal_sha256 THEN RETURN prior.result || jsonb_build_object('replayed', true); END IF;
    RAISE EXCEPTION 'community data: idempotency key % was already used for a different proposal', p_idempotency_key USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO cd_changes (community_id, idempotency_key, proposal_sha256, result, actor_kind, actor_id)
  VALUES (p_community, p_idempotency_key, p_proposal_sha256, '{}'::jsonb, p_actor_kind, p_actor_id) RETURNING id INTO chg;

  -- documents (re-used by hash within the community)
  FOR d IN SELECT * FROM jsonb_array_elements(coalesce(p_change->'documents', '[]'::jsonb)) LOOP
    hit := NULL;
    SELECT id INTO hit FROM cd_source_documents WHERE community_id = p_community AND sha256 = d->>'sha256';
    IF hit IS NULL THEN
      INSERT INTO cd_source_documents (community_id, provider, kind, filename, sha256, period_start, period_end, observed_as_of, change_id)
      VALUES (p_community, d->>'provider', d->>'kind', d->>'filename', d->>'sha256', (d->>'period_start')::date, (d->>'period_end')::date, (d->>'observed_as_of')::date, chg) RETURNING id INTO hit;
    END IF;
    doc_ids := doc_ids || jsonb_build_object(d->>'ref', hit);
  END LOOP;
  -- every evidence item of the whole proposal names a known document of this community, with a basis
  FOR e IN SELECT ev FROM jsonb_each(p_change) kv, jsonb_array_elements(CASE WHEN jsonb_typeof(kv.value) = 'array' THEN kv.value ELSE '[]'::jsonb END) item,
                 jsonb_array_elements(CASE WHEN jsonb_typeof(item->'evidence') = 'array' THEN item->'evidence' ELSE '[]'::jsonb END) ev LOOP
    IF coalesce(doc_ids->>(e->>'document_ref'), e->>'document_id') IS NULL OR NOT EXISTS (SELECT 1 FROM cd_source_documents WHERE id = coalesce(doc_ids->>(e->>'document_ref'), e->>'document_id')::uuid AND community_id = p_community) THEN
      RAISE EXCEPTION 'community data: evidence names an unknown document' USING ERRCODE = 'check_violation';
    END IF;
    IF length(btrim(coalesce(e->>'basis', ''))) = 0 THEN RAISE EXCEPTION 'community data: evidence needs a basis' USING ERRCODE = 'check_violation'; END IF;
  END LOOP;

  -- identity links: attach a NEW identity to the party of an EXISTING identity, with evidence; never join two existing parties
  FOR it IN SELECT * FROM jsonb_array_elements(coalesce(p_change->'identity_links', '[]'::jsonb)) LOOP
    hit := NULL; hit2 := NULL;
    SELECT party_id INTO hit FROM cd_party_source_identities WHERE community_id = p_community AND provider = it->'existing'->>'provider' AND identity_kind = it->'existing'->>'identity_kind' AND identity_key = it->'existing'->>'identity_key' AND slot = it->'existing'->>'slot';
    IF hit IS NULL THEN RAISE EXCEPTION 'community data: an identity link names an identity that is not recorded' USING ERRCODE = 'check_violation'; END IF;
    SELECT party_id INTO hit2 FROM cd_party_source_identities WHERE community_id = p_community AND provider = it->'add'->>'provider' AND identity_kind = it->'add'->>'identity_kind' AND identity_key = it->'add'->>'identity_key' AND slot = it->'add'->>'slot';
    IF hit2 IS NOT NULL AND hit2 <> hit THEN RAISE EXCEPTION 'community data: both identities already belong to different parties; identities are never merged' USING ERRCODE = 'check_violation'; END IF;
    IF hit2 IS NULL THEN
      INSERT INTO cd_party_source_identities (community_id, party_id, provider, identity_kind, identity_key, slot, linked_by_evidence, change_id)
      VALUES (p_community, hit, it->'add'->>'provider', it->'add'->>'identity_kind', it->'add'->>'identity_key', it->'add'->>'slot', true, chg) RETURNING id INTO new_id;
      PERFORM cd_evidence_for(p_community, chg, 'cd_party_source_identities', new_id, 'linked', it->'evidence', doc_ids);
    END IF;
  END LOOP;

  -- parties: exactly one identity each; found only by it
  FOR p IN SELECT * FROM jsonb_array_elements(coalesce(p_change->'parties', '[]'::jsonb)) LOOP
    IF jsonb_array_length(coalesce(p->'identities', '[]'::jsonb)) <> 1 THEN
      RAISE EXCEPTION 'community data: party % must carry exactly one source identity; further identities are attached by an evidence-backed identity link', p->>'ref' USING ERRCODE = 'check_violation';
    END IF;
    i := p->'identities'->0; hit := NULL;
    SELECT party_id INTO hit FROM cd_party_source_identities WHERE community_id = p_community AND provider = i->>'provider' AND identity_kind = i->>'identity_kind' AND identity_key = i->>'identity_key' AND slot = i->>'slot';
    IF hit IS NULL THEN
      INSERT INTO cd_parties (community_id, kind, kind_basis, hints, display_name, given_name, family_name, change_id)
      VALUES (p_community, p->>'kind', coalesce(p->>'kind_basis', 'unknown'), coalesce(p->'hints', '[]'::jsonb), p->>'display_name', nullif(p->>'given_name', ''), nullif(p->>'family_name', ''), chg) RETURNING id INTO hit;
      INSERT INTO cd_party_source_identities (community_id, party_id, provider, identity_kind, identity_key, slot, change_id)
      VALUES (p_community, hit, i->>'provider', i->>'identity_kind', i->>'identity_key', i->>'slot', chg);
      created := created || jsonb_build_array(p->>'ref');
    END IF;
    party_ids := party_ids || jsonb_build_object(p->>'ref', hit);
  END LOOP;

  FOR it IN SELECT * FROM jsonb_array_elements(coalesce(p_change->'property_identities', '[]'::jsonb)) LOOP
    hit := NULL;
    SELECT property_id INTO hit FROM cd_property_source_identities WHERE community_id = p_community AND provider = it->>'provider' AND identity_kind = 'account' AND identity_key = it->>'identity_key';
    IF hit IS NOT NULL AND hit <> (it->>'property_id')::uuid THEN RAISE EXCEPTION 'community data: account % already belongs to another property', it->>'identity_key' USING ERRCODE = 'check_violation'; END IF;
    IF hit IS NULL THEN INSERT INTO cd_property_source_identities (community_id, property_id, provider, identity_kind, identity_key, change_id) VALUES (p_community, (it->>'property_id')::uuid, it->>'provider', 'account', it->>'identity_key', chg); END IF;
  END LOOP;

  -- ENDS first (a transfer / move-out / superseded value), once, with a basis and evidence
  FOREACH k IN ARRAY ARRAY['ownership', 'occupancy', 'address', 'contact_method'] LOOP
    FOR it IN SELECT * FROM jsonb_array_elements(coalesce(p_change->(k || '_ends'), '[]'::jsonb)) LOOP
      hit := NULL;
      EXECUTE format('UPDATE %I SET effective_to = $1, effective_to_basis = $2, ended_by_change_id = $3 WHERE id = $4 AND community_id = $5 AND effective_to IS NULL RETURNING id',
                     CASE k WHEN 'ownership' THEN 'cd_ownerships' WHEN 'occupancy' THEN 'cd_occupancies' WHEN 'address' THEN 'cd_addresses' ELSE 'cd_contact_methods' END)
        INTO hit USING (it->>'effective_to')::date, it->>'effective_to_basis', chg, (it->>(k || '_id'))::uuid, p_community;
      IF hit IS NULL THEN RAISE EXCEPTION 'community data: % % is not a current % of this community', k, it->>(k || '_id'), k USING ERRCODE = 'check_violation'; END IF;
      PERFORM cd_evidence_for(p_community, chg, 'cd_' || k || '_end', hit, 'ended', it->'evidence', doc_ids);
    END LOOP;
  END LOOP;

  -- ownerships (a repeat observation of the same current ownership appends evidence)
  FOR it IN SELECT * FROM jsonb_array_elements(coalesce(p_change->'ownerships', '[]'::jsonb)) LOOP
    IF party_ids->>(it->>'party_ref') IS NULL THEN RAISE EXCEPTION 'community data: ownership names unknown party %', it->>'party_ref' USING ERRCODE = 'check_violation'; END IF;
    hit := NULL;
    IF it->>'effective_to' IS NULL THEN
      SELECT id INTO hit FROM cd_ownerships WHERE property_id = (it->>'property_id')::uuid AND party_id = (party_ids->>(it->>'party_ref'))::uuid AND role = it->>'role' AND effective_to IS NULL;
    END IF;
    IF hit IS NOT NULL THEN
      PERFORM cd_evidence_for(p_community, chg, 'cd_ownerships', hit, 'reobserved', it->'evidence', doc_ids); reobserved := reobserved + 1;
    ELSE
      IF it->>'role' = 'owner' AND it->>'effective_to' IS NULL AND EXISTS (SELECT 1 FROM cd_ownerships o WHERE o.property_id = (it->>'property_id')::uuid AND o.role = 'owner' AND o.effective_to IS NULL) THEN
        RAISE EXCEPTION 'community data: property % already has a current owner of another owner record; end that ownership with transfer evidence in the same change (no silent second owner)', it->>'property_id' USING ERRCODE = 'check_violation';
      END IF;
      INSERT INTO cd_ownerships (community_id, property_id, party_id, role, effective_from, effective_from_basis, effective_to, effective_to_basis, observed_as_of, change_id, ended_by_change_id)
      VALUES (p_community, (it->>'property_id')::uuid, (party_ids->>(it->>'party_ref'))::uuid, it->>'role', (it->>'effective_from')::date, it->>'effective_from_basis', (it->>'effective_to')::date, it->>'effective_to_basis', (it->>'observed_as_of')::date, chg,
              CASE WHEN it->>'effective_to' IS NOT NULL THEN chg END) RETURNING id INTO hit;
      PERFORM cd_evidence_for(p_community, chg, 'cd_ownerships', hit, 'created', it->'evidence', doc_ids);
    END IF;
  END LOOP;

  FOR it IN SELECT * FROM jsonb_array_elements(coalesce(p_change->'leases', '[]'::jsonb)) LOOP
    doc := coalesce(doc_ids->>(it->>'document_ref'), it->>'document_id')::uuid;
    IF doc IS NULL THEN RAISE EXCEPTION 'community data: a lease needs its document' USING ERRCODE = 'check_violation'; END IF;
    INSERT INTO cd_leases (community_id, property_id, document_id, start_date, end_date, received_at, renewal_of, change_id)
    VALUES (p_community, (it->>'property_id')::uuid, doc, (it->>'start_date')::date, (it->>'end_date')::date, (it->>'received_at')::date, (it->>'renewal_of_lease_id')::uuid, chg) RETURNING id INTO new_id;
    lease_ids := lease_ids || jsonb_build_object(it->>'ref', new_id);
    PERFORM cd_evidence_for(p_community, chg, 'cd_leases', new_id, 'created', it->'evidence', doc_ids);
  END LOOP;

  FOR it IN SELECT * FROM jsonb_array_elements(coalesce(p_change->'occupancies', '[]'::jsonb)) LOOP
    IF it->>'party_ref' IS NOT NULL AND party_ids->>(it->>'party_ref') IS NULL THEN RAISE EXCEPTION 'community data: occupancy names unknown party %', it->>'party_ref' USING ERRCODE = 'check_violation'; END IF;
    hit := NULL;
    IF it->>'party_ref' IS NOT NULL AND it->>'effective_to' IS NULL THEN
      SELECT id INTO hit FROM cd_occupancies WHERE property_id = (it->>'property_id')::uuid AND party_id = (party_ids->>(it->>'party_ref'))::uuid AND occupancy_kind = it->>'occupancy_kind' AND effective_to IS NULL;
    END IF;
    IF hit IS NOT NULL THEN
      PERFORM cd_evidence_for(p_community, chg, 'cd_occupancies', hit, 'reobserved', it->'evidence', doc_ids); reobserved := reobserved + 1;
    ELSE
      INSERT INTO cd_occupancies (community_id, property_id, party_id, occupancy_kind, basis, lease_id, effective_from, effective_to, effective_to_basis, observed_as_of, change_id, ended_by_change_id)
      VALUES (p_community, (it->>'property_id')::uuid, (party_ids->>(it->>'party_ref'))::uuid, it->>'occupancy_kind', it->>'basis', coalesce((lease_ids->>(it->>'lease_ref'))::uuid, (it->>'lease_id')::uuid),
              (it->>'effective_from')::date, (it->>'effective_to')::date, it->>'effective_to_basis', (it->>'observed_as_of')::date, chg, CASE WHEN it->>'effective_to' IS NOT NULL THEN chg END) RETURNING id INTO hit;
      PERFORM cd_evidence_for(p_community, chg, 'cd_occupancies', hit, 'created', it->'evidence', doc_ids);
    END IF;
  END LOOP;

  FOR it IN SELECT * FROM jsonb_array_elements(coalesce(p_change->'addresses', '[]'::jsonb)) LOOP
    IF party_ids->>(it->>'party_ref') IS NULL THEN RAISE EXCEPTION 'community data: address names unknown party %', it->>'party_ref' USING ERRCODE = 'check_violation'; END IF;
    k := upper(btrim(regexp_replace(concat_ws(' ', it->>'line1', it->>'line2', it->>'unit', it->>'postal_code'), '[^A-Za-z0-9]+', ' ', 'g')));
    hit := NULL;
    SELECT id INTO hit FROM cd_addresses WHERE party_id = (party_ids->>(it->>'party_ref'))::uuid AND purpose = coalesce(it->>'purpose', 'mailing') AND address_key = k AND effective_to IS NULL;
    IF hit IS NOT NULL THEN
      PERFORM cd_evidence_for(p_community, chg, 'cd_addresses', hit, 'reobserved', it->'evidence', doc_ids); reobserved := reobserved + 1;
    ELSE
      INSERT INTO cd_addresses (community_id, party_id, purpose, line1, line2, unit, city, state, postal_code, address_key, is_primary, is_property_address, observed_as_of, change_id)
      VALUES (p_community, (party_ids->>(it->>'party_ref'))::uuid, coalesce(it->>'purpose', 'mailing'), it->>'line1', nullif(it->>'line2', ''), nullif(it->>'unit', ''), nullif(it->>'city', ''), nullif(it->>'state', ''), nullif(it->>'postal_code', ''), k,
              coalesce((it->>'is_primary')::boolean, false), coalesce((it->>'is_property_address')::boolean, false), (it->>'observed_as_of')::date, chg) RETURNING id INTO hit;
      PERFORM cd_evidence_for(p_community, chg, 'cd_addresses', hit, 'created', it->'evidence', doc_ids);
    END IF;
  END LOOP;

  FOR it IN SELECT * FROM jsonb_array_elements(coalesce(p_change->'contact_methods', '[]'::jsonb)) LOOP
    IF party_ids->>(it->>'party_ref') IS NULL THEN RAISE EXCEPTION 'community data: contact method names unknown party %', it->>'party_ref' USING ERRCODE = 'check_violation'; END IF;
    IF it->>'attribution' <> 'tenant' AND EXISTS (SELECT 1 FROM jsonb_array_elements(it->'evidence') x JOIN cd_source_documents sd ON sd.id = coalesce(doc_ids->>(x->>'document_ref'), x->>'document_id')::uuid WHERE sd.kind IN ('lease', 'amenity_application')) THEN
      RAISE EXCEPTION 'community data: a lease / application document never supplies an owner''s contact method' USING ERRCODE = 'check_violation';
    END IF;
    IF it->>'attribution' = 'tenant' AND NOT EXISTS (SELECT 1 FROM cd_party_source_identities s WHERE s.party_id = (party_ids->>(it->>'party_ref'))::uuid AND s.identity_kind IN ('tenant_id', 'lease_party')) THEN
      RAISE EXCEPTION 'community data: tenant attribution on a party that is not a tenant' USING ERRCODE = 'check_violation';
    END IF;
    k := CASE WHEN it->>'method_type' = 'email' THEN lower(btrim(it->>'value')) ELSE regexp_replace(it->>'value', '\D', '', 'g') END;
    hit := NULL;
    SELECT id INTO hit FROM cd_contact_methods WHERE party_id = (party_ids->>(it->>'party_ref'))::uuid AND method_type = it->>'method_type' AND value_normalized = k AND effective_to IS NULL;
    IF hit IS NOT NULL THEN
      PERFORM cd_evidence_for(p_community, chg, 'cd_contact_methods', hit, 'reobserved', it->'evidence', doc_ids); reobserved := reobserved + 1;
    ELSE
      INSERT INTO cd_contact_methods (community_id, party_id, method_type, value_normalized, attribution, is_primary, observed_as_of, change_id)
      VALUES (p_community, (party_ids->>(it->>'party_ref'))::uuid, it->>'method_type', k, it->>'attribution', coalesce((it->>'is_primary')::boolean, false), (it->>'observed_as_of')::date, chg) RETURNING id INTO hit;
      PERFORM cd_evidence_for(p_community, chg, 'cd_contact_methods', hit, 'created', it->'evidence', doc_ids);
    END IF;
  END LOOP;

  out := jsonb_build_object('change_id', chg, 'documents', doc_ids, 'parties', party_ids, 'parties_created', created, 'leases', lease_ids, 'reobserved', reobserved, 'replayed', false);
  PERFORM set_config('cd.writing_result', chg::text, true);
  RETURN out;
END;
$fn$;

CREATE OR REPLACE FUNCTION cd_record_result(p_change UUID, p_result JSONB) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF current_setting('cd.writing_result', true) IS DISTINCT FROM p_change::text THEN RAISE EXCEPTION 'community data: results are recorded only by the apply that created them' USING ERRCODE = 'check_violation'; END IF;
  UPDATE cd_changes SET result = p_result WHERE id = p_change AND result = '{}'::jsonb;
  PERFORM set_config('cd.writing_result', '', true);
END;
$fn$;

CREATE OR REPLACE FUNCTION cd_apply(p_community UUID, p_idempotency_key TEXT, p_proposal_sha256 TEXT, p_change JSONB, p_actor_kind TEXT, p_actor_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE r JSONB;
BEGIN
  r := cd_apply_change(p_community, p_idempotency_key, p_proposal_sha256, p_change, p_actor_kind, p_actor_id);
  IF coalesce((r->>'replayed')::boolean, false) = false THEN PERFORM cd_record_result((r->>'change_id')::uuid, r); END IF;
  RETURN r;
END;
$fn$;

-- why does Trusted believe this row? every observation (created / reobserved / ended / linked), oldest first
CREATE OR REPLACE FUNCTION cd_why(p_subject_table TEXT, p_subject_id UUID) RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT coalesce(jsonb_agg(jsonb_build_object('observation', e.observation, 'document', jsonb_build_object('provider', d.provider, 'kind', d.kind, 'filename', d.filename, 'sha256', d.sha256, 'period_start', d.period_start, 'period_end', d.period_end, 'observed_as_of', d.observed_as_of),
           'locator', e.locator, 'basis', e.basis, 'change_id', e.change_id, 'recorded_at', e.recorded_at) ORDER BY e.recorded_at, e.id), '[]'::jsonb)
    FROM cd_evidence e JOIN cd_source_documents d ON d.id = e.document_id WHERE e.subject_table = p_subject_table AND e.subject_id = p_subject_id;
$fn$;

REVOKE ALL ON cd_changes, cd_source_documents, cd_parties, cd_party_source_identities, cd_property_source_identities, cd_ownerships, cd_leases, cd_occupancies, cd_addresses, cd_contact_methods, cd_evidence FROM PUBLIC;
GRANT SELECT ON cd_changes, cd_source_documents, cd_parties, cd_party_source_identities, cd_property_source_identities, cd_ownerships, cd_leases, cd_occupancies, cd_addresses, cd_contact_methods, cd_evidence TO service_role;
REVOKE ALL ON FUNCTION cd_apply_change(UUID, TEXT, TEXT, JSONB, TEXT, TEXT), cd_record_result(UUID, JSONB), cd_evidence_for(UUID, UUID, TEXT, UUID, TEXT, JSONB, JSONB), cd_apply(UUID, TEXT, TEXT, JSONB, TEXT, TEXT), cd_why(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cd_apply(UUID, TEXT, TEXT, JSONB, TEXT, TEXT), cd_why(TEXT, UUID) TO service_role;

COMMIT;
