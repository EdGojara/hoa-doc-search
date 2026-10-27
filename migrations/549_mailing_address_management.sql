-- 549_mailing_address_management.sql  (Ed 2026-10-27)
-- ----------------------------------------------------------------------------
-- Staff can change a homeowner's MAILING address from Homeowner 360, and every
-- module that mails a homeowner reads that one address. The property's physical
-- address (properties.street_address), the ownership history and the assessment
-- account are never touched: everything here writes only to contacts and to the
-- new record tables below.
--
-- 1. contacts gains mailing_unit, mailing_country and the provenance of the
--    current mailing address (mailing_address_source = 'staff' once an employee
--    entered it, with who and when). Columns are only ADDED; no existing address
--    is changed by this migration.
-- 2. contact_mailing_address_changes: permanent history of every staff change
--    (previous address, new address, reason, who, when) and of every import/sync
--    that was STOPPED from replacing a staff-entered address.
-- 3. mailing_address_letter_reviews: when the address changes, every unmailed
--    letter already generated for that recipient (violation letters: draft,
--    approved, or printed and not yet mailed; collections notices: draft,
--    approved, printed) is flagged. The letter itself is never re-addressed.
--    Violation letters also get a letter_mail_holds row (mig 544), so the Mail
--    Queue will not confirm them as mailed until a person verifies the envelope.
-- 4. contacts_mailing_address_guard (BEFORE INSERT/UPDATE on contacts):
--    a) an import, sync or any writer other than set_contact_mailing_address()
--       can never replace a staff-entered address (the staff address is kept and
--       the attempt is recorded in the history);
--    b) the legacy one-line contacts.mailing_address and the structured
--       mailing_* fields are kept in agreement on every write (whichever was
--       written last wins), so readers of either column see the same address.
-- 5. set_contact_mailing_address(): the ONE staff write path. Validates, writes
--    the contact, the history, the letter flags and the canonical audit event
--    (audit_events, mig 545) in one transaction.
--    resolve_mailing_address_letter_review(): staff record that they verified a
--    flagged letter's destination; releases that letter's address hold.
-- 6. v_current_property_owners: same columns in the same order (mig 457), plus
--    owner_mailing_unit / owner_mailing_country / owner_mailing_source /
--    owner_mailing_updated_at appended at the end.
--
-- Record ownership: association_record (the HOA's member roster and notice
-- history). Both new tables carry a community FK for termination export.
-- ----------------------------------------------------------------------------
BEGIN;

-- 1. contacts --------------------------------------------------------------
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS mailing_unit               TEXT,
  ADD COLUMN IF NOT EXISTS mailing_country            TEXT,
  ADD COLUMN IF NOT EXISTS mailing_address_source     TEXT,
  ADD COLUMN IF NOT EXISTS mailing_address_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS mailing_address_updated_by UUID REFERENCES user_profiles(id) ON DELETE RESTRICT;

DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_mailing_address_source_check') THEN
    ALTER TABLE contacts ADD CONSTRAINT contacts_mailing_address_source_check
      CHECK (mailing_address_source IS NULL OR mailing_address_source = 'staff');
  END IF;
END $c$;

COMMENT ON COLUMN contacts.mailing_unit IS 'Mailing unit / suite / apt (mig 549). Part of the canonical mailing address.';
COMMENT ON COLUMN contacts.mailing_country IS 'Mailing country, ISO-style code; NULL or US = United States (mig 549).';
COMMENT ON COLUMN contacts.mailing_address_source IS 'staff = an employee entered this mailing address through set_contact_mailing_address(); imports and syncs can no longer replace it. NULL = imported or legacy (mig 549).';
COMMENT ON COLUMN contacts.mailing_address_updated_at IS 'When an employee last set the mailing address (mig 549).';
COMMENT ON COLUMN contacts.mailing_address_updated_by IS 'Which employee last set the mailing address (mig 549).';

-- 2. history -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contact_mailing_address_changes (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id         UUID NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  community_id       UUID NULL REFERENCES communities(id) ON DELETE RESTRICT,
  kind               TEXT NOT NULL CHECK (kind IN ('staff_change', 'staff_confirmed', 'sync_blocked')),
  previous_address   JSONB NOT NULL,
  new_address        JSONB NOT NULL,
  reason             TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  changed_by_user_id UUID NULL REFERENCES user_profiles(id) ON DELETE RESTRICT,
  changed_by_name    TEXT NULL,
  writer             TEXT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (kind = 'sync_blocked' OR changed_by_user_id IS NOT NULL)
);
COMMENT ON TABLE contact_mailing_address_changes IS 'association_record: every staff change to a homeowner mailing address (previous, new, reason, who, when) and every import/sync stopped from replacing a staff-entered address. Append-only (mig 549).';
CREATE INDEX IF NOT EXISTS idx_contact_mailing_changes_contact ON contact_mailing_address_changes (contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_mailing_changes_community ON contact_mailing_address_changes (community_id, created_at DESC) WHERE community_id IS NOT NULL;

-- 3. letter reviews ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS mailing_address_letter_reviews (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  change_id             UUID NOT NULL REFERENCES contact_mailing_address_changes(id) ON DELETE RESTRICT,
  contact_id            UUID NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  community_id          UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  property_id           UUID NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  letter_kind           TEXT NOT NULL CHECK (letter_kind IN ('violation_letter', 'collection_notice')),
  interaction_id        UUID NULL REFERENCES interactions(id) ON DELETE RESTRICT,
  collection_notice_id  UUID NULL REFERENCES collection_notices(id) ON DELETE RESTRICT,
  letter_state          TEXT NOT NULL,
  mail_hold_id          UUID NULL REFERENCES letter_mail_holds(id) ON DELETE RESTRICT,
  previous_address      JSONB NOT NULL,
  new_address           JSONB NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at           TIMESTAMPTZ NULL,
  resolved_by_user_id   UUID NULL REFERENCES user_profiles(id) ON DELETE RESTRICT,
  resolution_reason     TEXT NULL,
  CHECK ((letter_kind = 'violation_letter' AND interaction_id IS NOT NULL AND collection_notice_id IS NULL)
      OR (letter_kind = 'collection_notice' AND collection_notice_id IS NOT NULL AND interaction_id IS NULL)),
  CHECK (resolved_at IS NULL OR (resolved_by_user_id IS NOT NULL AND length(btrim(coalesce(resolution_reason, ''))) > 0))
);
COMMENT ON TABLE mailing_address_letter_reviews IS 'association_record: an unmailed letter generated before its recipient''s mailing address changed. Staff verify the destination before it is mailed; the letter is never re-addressed. Only the resolution may be recorded, once (mig 549).';
CREATE UNIQUE INDEX IF NOT EXISTS uq_mailing_review_open_letter ON mailing_address_letter_reviews (interaction_id) WHERE resolved_at IS NULL AND interaction_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_mailing_review_open_notice ON mailing_address_letter_reviews (collection_notice_id) WHERE resolved_at IS NULL AND collection_notice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mailing_review_contact ON mailing_address_letter_reviews (contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mailing_review_open ON mailing_address_letter_reviews (community_id) WHERE resolved_at IS NULL;

CREATE OR REPLACE FUNCTION contact_mailing_address_changes_append_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'mailing address history is permanent (%); record a new change instead', OLD.id;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_contact_mailing_changes_append_only ON contact_mailing_address_changes;
CREATE TRIGGER trg_contact_mailing_changes_append_only BEFORE UPDATE OR DELETE ON contact_mailing_address_changes
  FOR EACH ROW EXECUTE FUNCTION contact_mailing_address_changes_append_only();

CREATE OR REPLACE FUNCTION mailing_address_letter_reviews_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'letter address reviews are permanent (%); resolve it instead', OLD.id;
  END IF;
  IF OLD.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'letter address review % was already resolved', OLD.id;
  END IF;
  IF (NEW.change_id, NEW.contact_id, NEW.community_id, NEW.property_id, NEW.letter_kind, NEW.interaction_id,
      NEW.collection_notice_id, NEW.letter_state, NEW.mail_hold_id, NEW.previous_address, NEW.new_address, NEW.created_at)
     IS DISTINCT FROM
     (OLD.change_id, OLD.contact_id, OLD.community_id, OLD.property_id, OLD.letter_kind, OLD.interaction_id,
      OLD.collection_notice_id, OLD.letter_state, OLD.mail_hold_id, OLD.previous_address, OLD.new_address, OLD.created_at) THEN
    RAISE EXCEPTION 'only the resolution of letter address review % can be recorded', OLD.id;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_mailing_address_letter_reviews_guard ON mailing_address_letter_reviews;
CREATE TRIGGER trg_mailing_address_letter_reviews_guard BEFORE UPDATE OR DELETE ON mailing_address_letter_reviews
  FOR EACH ROW EXECUTE FUNCTION mailing_address_letter_reviews_guard();

-- 4. address helpers + the contacts guard -------------------------------------
-- One-line form every legacy reader understands (lib/mail/address_block.js), the same
-- text lib/mail/mailing_address.js composes: US "STREET[ UNIT], CITY, ST ZIP" (unit on
-- the street line, USPS style); elsewhere one line per row ending in the country.
CREATE OR REPLACE FUNCTION mailing_address_compose(p_street TEXT, p_unit TEXT, p_city TEXT, p_state TEXT, p_zip TEXT, p_country TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
    WHEN nullif(btrim(coalesce(p_street, '')), '') IS NULL THEN NULL
    WHEN coalesce(nullif(upper(btrim(p_country)), ''), 'US') = 'US' THEN
      concat_ws(', ', concat_ws(' ', btrim(p_street), nullif(btrim(coalesce(p_unit, '')), '')), nullif(btrim(coalesce(p_city, '')), ''),
                nullif(btrim(concat_ws(' ', nullif(btrim(coalesce(p_state, '')), ''), nullif(btrim(coalesce(p_zip, '')), ''))), ''))
    ELSE concat_ws(E'\n', concat_ws(' ', btrim(p_street), nullif(btrim(coalesce(p_unit, '')), '')),
                   nullif(btrim(concat_ws(' ', nullif(btrim(coalesce(p_city, '')), ''), nullif(btrim(coalesce(p_state, '')), ''), nullif(btrim(coalesce(p_zip, '')), ''))), ''),
                   upper(btrim(p_country)))
  END
$fn$;

-- The address as a JSON object, for history rows and audit events.
CREATE OR REPLACE FUNCTION mailing_address_json(p_street TEXT, p_unit TEXT, p_city TEXT, p_state TEXT, p_zip TEXT, p_country TEXT, p_text TEXT)
RETURNS JSONB LANGUAGE sql IMMUTABLE AS $fn$
  SELECT jsonb_build_object('street', p_street, 'unit', p_unit, 'city', p_city, 'state', p_state, 'zip', p_zip,
                            'country', p_country, 'text', p_text)
$fn$;

CREATE OR REPLACE FUNCTION contacts_mailing_address_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_staff   BOOLEAN := coalesce(current_setting('trusted.mailing_address_writer', true), '') = 'staff';
  v_struct  BOOLEAN;
  v_text    BOOLEAN;
  v_parts   TEXT[];
  v_n       INT;
  v_last    TEXT;
  v_m       TEXT[];
  v_comm    UUID;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_struct := (NEW.mailing_street, NEW.mailing_unit, NEW.mailing_city, NEW.mailing_state, NEW.mailing_zip, NEW.mailing_country)
                IS DISTINCT FROM (OLD.mailing_street, OLD.mailing_unit, OLD.mailing_city, OLD.mailing_state, OLD.mailing_zip, OLD.mailing_country);
    v_text := NEW.mailing_address IS DISTINCT FROM OLD.mailing_address;
    IF NOT v_staff THEN
      -- Only set_contact_mailing_address() stamps who entered an address.
      NEW.mailing_address_source := OLD.mailing_address_source;
      NEW.mailing_address_updated_at := OLD.mailing_address_updated_at;
      NEW.mailing_address_updated_by := OLD.mailing_address_updated_by;
      IF OLD.mailing_address_source = 'staff' AND (v_struct OR v_text) THEN
        -- An import or sync may not replace what an employee entered: keep it, and record the attempt.
        SELECT p.community_id INTO v_comm FROM property_ownerships o JOIN properties p ON p.id = o.property_id
         WHERE o.contact_id = OLD.id AND o.end_date IS NULL ORDER BY o.is_primary DESC NULLS LAST, o.start_date NULLS LAST, o.id LIMIT 1;
        INSERT INTO contact_mailing_address_changes (contact_id, community_id, kind, previous_address, new_address, reason, writer)
        VALUES (OLD.id, v_comm, 'sync_blocked',
                mailing_address_json(OLD.mailing_street, OLD.mailing_unit, OLD.mailing_city, OLD.mailing_state, OLD.mailing_zip, OLD.mailing_country, OLD.mailing_address),
                mailing_address_json(CASE WHEN v_struct THEN NEW.mailing_street END, CASE WHEN v_struct THEN NEW.mailing_unit END,
                                     CASE WHEN v_struct THEN NEW.mailing_city END, CASE WHEN v_struct THEN NEW.mailing_state END,
                                     CASE WHEN v_struct THEN NEW.mailing_zip END, CASE WHEN v_struct THEN NEW.mailing_country END,
                                     CASE WHEN v_text THEN NEW.mailing_address END),
                'An import or sync tried to replace the mailing address an employee entered. The employee''s address was kept.',
                left(coalesce(nullif(current_setting('application_name', true), ''), session_user::text), 200));
        NEW.mailing_street := OLD.mailing_street; NEW.mailing_unit := OLD.mailing_unit; NEW.mailing_city := OLD.mailing_city;
        NEW.mailing_state := OLD.mailing_state; NEW.mailing_zip := OLD.mailing_zip; NEW.mailing_country := OLD.mailing_country;
        NEW.mailing_address := OLD.mailing_address;
        RETURN NEW;
      END IF;
    END IF;
  ELSE
    IF NOT v_staff THEN
      NEW.mailing_address_source := NULL; NEW.mailing_address_updated_at := NULL; NEW.mailing_address_updated_by := NULL;
    END IF;
    v_struct := nullif(btrim(coalesce(NEW.mailing_street, '')), '') IS NOT NULL;
    v_text := NOT v_struct AND NEW.mailing_address IS NOT NULL;
  END IF;

  IF v_staff THEN RETURN NEW; END IF; -- the staff function writes both forms itself

  -- Keep the one-line and structured forms in agreement: the last one written wins.
  IF v_struct THEN
    IF nullif(btrim(coalesce(NEW.mailing_street, '')), '') IS NOT NULL THEN
      NEW.mailing_address := mailing_address_compose(NEW.mailing_street, NEW.mailing_unit, NEW.mailing_city, NEW.mailing_state, NEW.mailing_zip, NEW.mailing_country);
    ELSIF NOT v_text THEN
      NEW.mailing_address := NULL;
    END IF;
  ELSIF v_text THEN
    NEW.mailing_street := NULL; NEW.mailing_unit := NULL; NEW.mailing_city := NULL; NEW.mailing_zip := NULL; NEW.mailing_country := NULL;
    IF nullif(btrim(coalesce(NEW.mailing_address, '')), '') IS NOT NULL THEN
      v_parts := ARRAY(SELECT btrim(x) FROM unnest(regexp_split_to_array(btrim(NEW.mailing_address), CASE WHEN position(E'\n' IN NEW.mailing_address) > 0 THEN E'\\s*\\n\\s*' ELSE ',' END)) x WHERE btrim(x) <> '');
      v_n := coalesce(array_length(v_parts, 1), 0);
      v_last := CASE WHEN v_n > 0 THEN v_parts[v_n] END;
      IF v_n >= 3 AND v_last ~* '^[a-z]{2}\s+\d{5}(-\d{4})?$' THEN
        v_m := regexp_match(v_last, '^([A-Za-z]{2})\s+(\d{5}(-\d{4})?)$');
        NEW.mailing_street := array_to_string(v_parts[1:v_n - 2], ', ');
        NEW.mailing_city := v_parts[v_n - 1];
        NEW.mailing_state := upper(v_m[1]); NEW.mailing_zip := v_m[2];
      ELSIF v_n >= 2 AND v_last ~* '^.+\s+[a-z]{2}\s+\d{5}(-\d{4})?$' THEN
        v_m := regexp_match(v_last, '^(.+?)\s+([A-Za-z]{2})\s+(\d{5}(-\d{4})?)$');
        NEW.mailing_street := array_to_string(v_parts[1:v_n - 1], ', ');
        NEW.mailing_city := v_m[1];
        NEW.mailing_state := upper(v_m[2]); NEW.mailing_zip := v_m[3];
      END IF;
      -- Anything that does not parse leaves the structured fields empty; readers use the one-line text.
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_contacts_mailing_address_guard ON contacts;
CREATE TRIGGER trg_contacts_mailing_address_guard BEFORE INSERT OR UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION contacts_mailing_address_guard();

-- 5. the staff write path -----------------------------------------------------
CREATE OR REPLACE FUNCTION set_contact_mailing_address(
  p_contact_id UUID, p_street TEXT, p_unit TEXT, p_city TEXT, p_state TEXT, p_zip TEXT, p_country TEXT,
  p_reason TEXT, p_actor UUID, p_route TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE
  v_actor    user_profiles%ROWTYPE;
  v_name     TEXT;
  v_c        contacts%ROWTYPE;
  v_street   TEXT := nullif(regexp_replace(btrim(coalesce(p_street, '')), '\s+', ' ', 'g'), '');
  v_unit     TEXT := nullif(regexp_replace(btrim(coalesce(p_unit, '')), '\s+', ' ', 'g'), '');
  v_city     TEXT := nullif(regexp_replace(btrim(coalesce(p_city, '')), '\s+', ' ', 'g'), '');
  v_state    TEXT := nullif(btrim(coalesce(p_state, '')), '');
  v_zip      TEXT := nullif(btrim(coalesce(p_zip, '')), '');
  v_country  TEXT := upper(nullif(btrim(coalesce(p_country, '')), ''));
  v_reason   TEXT := nullif(btrim(coalesce(p_reason, '')), '');
  v_text     TEXT;
  v_prev     JSONB;
  v_new      JSONB;
  v_kind     TEXT;
  v_change   UUID;
  v_comm     UUID;
  v_flagged  INT := 0;
  v_hold     UUID;
  v_hold_reason TEXT;
  r          RECORD;
BEGIN
  SELECT * INTO v_actor FROM user_profiles WHERE id = p_actor;
  IF NOT FOUND OR NOT v_actor.is_active OR v_actor.role NOT IN ('admin', 'staff') THEN
    RAISE EXCEPTION 'mailing_address: only an active employee can change a mailing address' USING ERRCODE = '42501';
  END IF;
  v_name := left(coalesce(nullif(btrim(v_actor.full_name), ''), v_actor.email, 'Staff'), 200);
  IF v_reason IS NULL THEN RAISE EXCEPTION 'mailing_address: a reason is required' USING ERRCODE = '22023'; END IF;

  IF v_country IS NULL OR v_country IN ('USA', 'UNITED STATES', 'UNITED STATES OF AMERICA', 'U.S.', 'U.S.A.') THEN v_country := 'US'; END IF;
  IF v_street IS NULL OR v_city IS NULL THEN RAISE EXCEPTION 'mailing_address: street and city are required' USING ERRCODE = '22023'; END IF;
  IF concat(p_street, p_unit, p_city, p_state, p_zip, p_country) ~ '[\r\n\t]' THEN
    RAISE EXCEPTION 'mailing_address: an address field cannot contain line breaks' USING ERRCODE = '22023';
  END IF;
  IF length(v_street) > 200 OR length(coalesce(v_unit, '')) > 60 OR length(v_city) > 100 OR length(coalesce(v_state, '')) > 60
     OR length(coalesce(v_zip, '')) > 20 OR length(v_country) > 60 THEN
    RAISE EXCEPTION 'mailing_address: a field is too long' USING ERRCODE = '22023';
  END IF;
  IF v_country = 'US' THEN
    v_state := upper(v_state);
    IF v_state IS NULL OR v_state !~ '^[A-Z]{2}$' THEN RAISE EXCEPTION 'mailing_address: state must be the 2-letter code' USING ERRCODE = '22023'; END IF;
    IF v_zip IS NULL OR v_zip !~ '^\d{5}(-\d{4})?$' THEN RAISE EXCEPTION 'mailing_address: ZIP must be 5 digits (or ZIP+4)' USING ERRCODE = '22023'; END IF;
  END IF;

  SELECT * INTO v_c FROM contacts WHERE id = p_contact_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'mailing_address: homeowner not found' USING ERRCODE = 'P0002'; END IF;

  v_text := mailing_address_compose(v_street, v_unit, v_city, v_state, v_zip, v_country);
  v_prev := mailing_address_json(v_c.mailing_street, v_c.mailing_unit, v_c.mailing_city, v_c.mailing_state, v_c.mailing_zip, v_c.mailing_country, v_c.mailing_address);
  v_new  := mailing_address_json(v_street, v_unit, v_city, v_state, v_zip, v_country, v_text);

  IF (v_c.mailing_street, v_c.mailing_unit, v_c.mailing_city, v_c.mailing_state, v_c.mailing_zip, coalesce(v_c.mailing_country, 'US'), v_c.mailing_address)
     IS NOT DISTINCT FROM (v_street, v_unit, v_city, v_state, v_zip, v_country, v_text) THEN
    IF v_c.mailing_address_source = 'staff' THEN
      RETURN jsonb_build_object('status', 'unchanged', 'contact_id', v_c.id, 'address', v_new);
    END IF;
    v_kind := 'staff_confirmed';   -- same address, now confirmed by an employee (and protected from syncs)
  ELSE
    v_kind := 'staff_change';
  END IF;

  SELECT p.community_id INTO v_comm FROM property_ownerships o JOIN properties p ON p.id = o.property_id
   WHERE o.contact_id = v_c.id AND o.end_date IS NULL ORDER BY o.is_primary DESC NULLS LAST, o.start_date NULLS LAST, o.id LIMIT 1;

  PERFORM set_config('trusted.mailing_address_writer', 'staff', true);
  UPDATE contacts SET mailing_street = v_street, mailing_unit = v_unit, mailing_city = v_city, mailing_state = v_state,
         mailing_zip = v_zip, mailing_country = v_country, mailing_address = v_text,
         mailing_address_source = 'staff', mailing_address_updated_at = now(), mailing_address_updated_by = v_actor.id
   WHERE id = v_c.id;
  PERFORM set_config('trusted.mailing_address_writer', '', true);

  INSERT INTO contact_mailing_address_changes (contact_id, community_id, kind, previous_address, new_address, reason, changed_by_user_id, changed_by_name, writer)
  VALUES (v_c.id, v_comm, v_kind, v_prev, v_new, v_reason, v_actor.id, v_name, left(coalesce(p_route, 'rpc set_contact_mailing_address'), 200))
  RETURNING id INTO v_change;

  IF v_kind = 'staff_change' THEN
    v_hold_reason := format('Mailing address changed on %s by %s after this letter was generated. Verify the envelope goes to the current mailing address before mailing.',
                            to_char(now() AT TIME ZONE 'America/Chicago', 'MM/DD/YYYY'), v_name);
    -- Violation / enforcement letters addressed to this person (the lot's current mail
    -- recipient, or the letter names the contact) that are generated and not yet mailed.
    FOR r IN
      SELECT i.id, i.community_id, i.property_id,
             CASE WHEN i.printed_at IS NOT NULL THEN 'printed_not_mailed' ELSE coalesce(i.status, 'draft') END AS state
        FROM interactions i
       WHERE (i.contact_id = v_c.id OR i.property_id IN (SELECT property_id FROM v_current_property_owners WHERE owner_contact_id = v_c.id))
         AND i.property_id IS NOT NULL AND i.community_id IS NOT NULL
         AND i.delivery_method IS NOT NULL AND i.delivery_method NOT IN ('email', 'sms', 'portal')
         AND i.mailed_at IS NULL
         AND coalesce(i.status, 'draft') NOT IN ('sent', 'rejected', 'failed', 'cancelled', 'error', 'superseded', 'voided')
         AND (i.printed_at IS NOT NULL OR coalesce(i.status, 'draft') IN ('draft', 'approved', 'pending_review'))
         AND NOT EXISTS (SELECT 1 FROM letter_mailing_evidence e WHERE e.interaction_id = i.id AND e.outcome = 'mailed')
         AND NOT EXISTS (SELECT 1 FROM mailing_address_letter_reviews x WHERE x.interaction_id = i.id AND x.resolved_at IS NULL)
       ORDER BY i.created_at, i.id
    LOOP
      v_hold := NULL;
      IF NOT EXISTS (SELECT 1 FROM letter_mail_holds h WHERE h.interaction_id = r.id AND h.released_at IS NULL) THEN
        INSERT INTO letter_mail_holds (interaction_id, community_id, reason, directed_by)
        VALUES (r.id, r.community_id, v_hold_reason, v_name) RETURNING id INTO v_hold;
      END IF;
      INSERT INTO mailing_address_letter_reviews (change_id, contact_id, community_id, property_id, letter_kind, interaction_id, letter_state, mail_hold_id, previous_address, new_address)
      VALUES (v_change, v_c.id, r.community_id, r.property_id, 'violation_letter', r.id, r.state, v_hold, v_prev, v_new);
      v_flagged := v_flagged + 1;
    END LOOP;
    -- Collections notices: the notice carries its own address snapshot, so it stays as printed;
    -- an open notice is flagged and cannot be recorded as mailed until a person verifies it.
    FOR r IN
      SELECT n.id, n.community_id, n.property_id, n.status
        FROM collection_notices n
       WHERE n.property_id IN (SELECT property_id FROM v_current_property_owners WHERE owner_contact_id = v_c.id)
         AND n.status IN ('draft', 'approved', 'printed')
         AND NOT EXISTS (SELECT 1 FROM mailing_address_letter_reviews x WHERE x.collection_notice_id = n.id AND x.resolved_at IS NULL)
       ORDER BY n.created_at, n.id
    LOOP
      INSERT INTO mailing_address_letter_reviews (change_id, contact_id, community_id, property_id, letter_kind, collection_notice_id, letter_state, previous_address, new_address)
      VALUES (v_change, v_c.id, r.community_id, r.property_id, 'collection_notice', r.id, r.status, v_prev, v_new);
      v_flagged := v_flagged + 1;
    END LOOP;
  END IF;

  INSERT INTO audit_events (community_id, actor_user_id, actor_name, entity_type, entity_id, action, field, previous_value, new_value, reason, route, record_ownership)
  VALUES (v_comm, v_actor.id, v_name, 'contact', v_c.id::text,
          CASE WHEN v_kind = 'staff_change' THEN 'mailing_address.changed' ELSE 'mailing_address.confirmed' END,
          'mailing_address', v_prev, v_new || jsonb_build_object('letters_flagged', v_flagged, 'change_id', v_change),
          v_reason, left(coalesce(p_route, 'rpc set_contact_mailing_address'), 300), 'association_record');

  -- The history row is append-only, so the flag count is reported here rather than stored back.
  RETURN jsonb_build_object('status', CASE WHEN v_kind = 'staff_change' THEN 'changed' ELSE 'confirmed' END,
                            'contact_id', v_c.id, 'change_id', v_change, 'previous', v_prev, 'address', v_new,
                            'letters_flagged', v_flagged);
END;
$fn$;

CREATE OR REPLACE FUNCTION resolve_mailing_address_letter_review(p_review_id UUID, p_reason TEXT, p_actor UUID, p_route TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE
  v_actor  user_profiles%ROWTYPE;
  v_name   TEXT;
  v_rv     mailing_address_letter_reviews%ROWTYPE;
  v_reason TEXT := nullif(btrim(coalesce(p_reason, '')), '');
  v_released BOOLEAN := false;
BEGIN
  SELECT * INTO v_actor FROM user_profiles WHERE id = p_actor;
  IF NOT FOUND OR NOT v_actor.is_active OR v_actor.role NOT IN ('admin', 'staff') THEN
    RAISE EXCEPTION 'mailing_address: only an active employee can verify a letter' USING ERRCODE = '42501';
  END IF;
  v_name := left(coalesce(nullif(btrim(v_actor.full_name), ''), v_actor.email, 'Staff'), 200);
  IF v_reason IS NULL OR length(v_reason) < 5 THEN RAISE EXCEPTION 'mailing_address: say how the destination was verified' USING ERRCODE = '22023'; END IF;

  SELECT * INTO v_rv FROM mailing_address_letter_reviews WHERE id = p_review_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'mailing_address: review not found' USING ERRCODE = 'P0002'; END IF;
  IF v_rv.resolved_at IS NOT NULL THEN RAISE EXCEPTION 'mailing_address: this letter was already verified' USING ERRCODE = '55000'; END IF;

  UPDATE mailing_address_letter_reviews SET resolved_at = now(), resolved_by_user_id = v_actor.id, resolution_reason = v_reason WHERE id = v_rv.id;
  -- Release only the hold this review placed; any other hold on the letter stays.
  IF v_rv.mail_hold_id IS NOT NULL THEN
    UPDATE letter_mail_holds SET released_at = now(), released_by_user_id = v_actor.id,
           release_reason = 'Destination verified after a mailing address change: ' || v_reason
     WHERE id = v_rv.mail_hold_id AND released_at IS NULL;
    v_released := FOUND;
  END IF;

  INSERT INTO audit_events (community_id, actor_user_id, actor_name, entity_type, entity_id, action, field, previous_value, new_value, reason, route, record_ownership)
  VALUES (v_rv.community_id, v_actor.id, v_name, 'mailing_address_letter_review', v_rv.id::text, 'mailing_address.letter_verified', 'resolved_at',
          jsonb_build_object('letter_kind', v_rv.letter_kind, 'interaction_id', v_rv.interaction_id, 'collection_notice_id', v_rv.collection_notice_id, 'letter_state', v_rv.letter_state),
          jsonb_build_object('hold_released', v_released, 'address_at_change', v_rv.new_address),
          v_reason, left(coalesce(p_route, 'rpc resolve_mailing_address_letter_review'), 300), 'association_record');

  RETURN jsonb_build_object('status', 'verified', 'review_id', v_rv.id, 'hold_released', v_released);
END;
$fn$;

REVOKE ALL ON FUNCTION set_contact_mailing_address(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION resolve_mailing_address_letter_review(UUID, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION set_contact_mailing_address(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION resolve_mailing_address_letter_review(UUID, TEXT, UUID, TEXT) TO service_role;

-- Records: the server reads and appends; only the functions above write them.
-- Supabase's default privileges grant new tables to anon/authenticated: take
-- that back and turn on row level security (no policies: no client access).
ALTER TABLE contact_mailing_address_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailing_address_letter_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON contact_mailing_address_changes, mailing_address_letter_reviews FROM PUBLIC, anon, authenticated;
REVOKE ALL ON contact_mailing_address_changes, mailing_address_letter_reviews FROM service_role;
REVOKE ALL ON FUNCTION mailing_address_compose(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION mailing_address_json(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mailing_address_compose(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION mailing_address_json(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT SELECT ON contact_mailing_address_changes TO service_role;
GRANT SELECT ON mailing_address_letter_reviews TO service_role;
GRANT INSERT ON contact_mailing_address_changes TO service_role;
GRANT INSERT, UPDATE ON mailing_address_letter_reviews TO service_role;

-- 6. the owner view: same columns, four appended --------------------------------
CREATE OR REPLACE VIEW v_current_property_owners AS
SELECT DISTINCT ON (p.id)
  p.id              AS property_id,
  p.community_id,
  p.street_address,
  p.unit,
  p.city,
  p.state,
  p.zip,
  p.property_type,
  p.lot_number,
  c.id              AS owner_contact_id,
  c.full_name       AS owner_name,
  c.primary_email   AS owner_email,
  c.primary_phone   AS owner_phone,
  c.mailing_address AS owner_mailing_address,
  o.start_date      AS owned_since,
  o.vesting,
  o.is_primary,
  p.latitude,
  p.longitude,
  p.boundary,
  p.vantaca_account_id,
  c.mailing_street  AS owner_mailing_street,
  c.mailing_city    AS owner_mailing_city,
  c.mailing_state   AS owner_mailing_state,
  c.mailing_zip     AS owner_mailing_zip,
  p.trusted_account_number,        -- mig 252 trustEd account # (stable, property-scoped)
  t.id              AS tenure_id,  -- mig 457: the lot's current ownership tenure
  c.mailing_unit    AS owner_mailing_unit,           -- mig 549
  c.mailing_country AS owner_mailing_country,        -- mig 549
  c.mailing_address_source AS owner_mailing_source,  -- mig 549
  c.mailing_address_updated_at AS owner_mailing_updated_at -- mig 549
FROM properties p
LEFT JOIN property_ownerships o ON o.property_id = p.id AND o.end_date IS NULL
LEFT JOIN contacts c           ON c.id = o.contact_id
LEFT JOIN ownership_tenures t  ON t.property_id = p.id AND t.kind = 'owner' AND t.end_date IS NULL
ORDER BY p.id, o.is_primary DESC NULLS LAST, o.start_date ASC NULLS LAST, o.created_at ASC NULLS LAST, o.id ASC;

COMMIT;
