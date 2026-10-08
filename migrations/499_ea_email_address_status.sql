-- ===========================================================================
-- 499_ea_email_address_status.sql  (Ed 2026-10-07)
-- ---------------------------------------------------------------------------
-- Tessa learns which addresses work.
--
-- Nicole Hill: Tessa's address book held two rows for her, "Nicole Holtzhill"
-- <nicoleholtzhill@aol.com> (correct) and "Nicole Hill" <nicoleholtzhiII@aol.com>
-- (typed by hand, capital I's for l's). The first invite to the typo bounced
-- ("552 mailbox not found"), Tessa resent to the right address, and Nicole
-- replied from it. The next day "Confirmed: Phone Interview Tomorrow at 3:00 PM"
-- went to the bounced address again and bounced again. The resolver matched
-- "Nicole Hill" to the row with that exact name and had no idea either that the
-- address had bounced or that Nicole had since written from a different one.
--
-- This migration gives Tessa that memory:
--
--   ea_email_events            append-only evidence per address: a hard bounce
--                              (the NDR), an inbound message (the person wrote
--                              to us), a supersede (bounced address -> the
--                              verified one that replaced it), or a human
--                              restore. An address is BOUNCED while its latest
--                              bounce is newer than its latest restore. Nothing
--                              but a restore (a named human) ever un-bounces it.
--   ea_contact_email_history   every change Tessa makes to an address-book
--                              email, with the old address and the evidence.
--   ea_contacts.superseded_by_contact_id
--                              when the verified address already belongs to
--                              another row (Nicole's case), the bounced row
--                              points at it instead of duplicating the email
--                              (uq_ea_contacts_email allows one row per email).
--   ea_supersede_email(...)    one transaction: record the supersede, move the
--                              address-book row(s) off the bounced address,
--                              write history. Refuses unless the old address is
--                              bounced and the new one is not.
--
-- Record ownership: WORKPAPER (Bedrock's internal EA address book and its
-- delivery evidence). No community data.
--
-- No existing row changes. The Nicole data fix runs AFTER this is applied, via
-- scripts/tessa_address_backfill.js (dry run by default).
-- ===========================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS ea_email_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL,
  kind          TEXT NOT NULL,
  message_ref   TEXT NOT NULL,                 -- Graph message id (or restore:<uuid>)
  occurred_at   TIMESTAMPTZ NOT NULL,
  related_email TEXT,                          -- supersede: the verified replacement
  actor         TEXT NOT NULL DEFAULT 'system',
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ea_email_events_email_check CHECK (email = lower(btrim(email)) AND position('@' IN email) > 1),
  CONSTRAINT ea_email_events_kind_check CHECK (kind IN ('bounce', 'inbound', 'supersede', 'restore')),
  CONSTRAINT ea_email_events_supersede_check CHECK (kind <> 'supersede'
    OR (related_email IS NOT NULL AND related_email = lower(btrim(related_email)) AND related_email <> email)),
  -- A restore is the one thing that un-bounces an address, so it must name the
  -- human who did it.
  CONSTRAINT ea_email_events_restore_actor_check CHECK (kind <> 'restore' OR (actor <> 'system' AND btrim(actor) <> '')),
  -- The same NDR / message seen by the inbox poll and by a live lookup is ONE event.
  CONSTRAINT uq_ea_email_events UNIQUE (email, kind, message_ref)
);

CREATE INDEX IF NOT EXISTS idx_ea_email_events_email ON ea_email_events (email, occurred_at DESC);

-- Evidence is append-only.
CREATE OR REPLACE FUNCTION ea_email_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ea_email_events is append-only (record a restore instead of editing a bounce)';
END $$;
DROP TRIGGER IF EXISTS trg_ea_email_events_immutable ON ea_email_events;
CREATE TRIGGER trg_ea_email_events_immutable
  BEFORE UPDATE OR DELETE ON ea_email_events
  FOR EACH ROW EXECUTE FUNCTION ea_email_events_immutable();

ALTER TABLE ea_contacts ADD COLUMN IF NOT EXISTS superseded_by_contact_id UUID;
ALTER TABLE ea_contacts DROP CONSTRAINT IF EXISTS ea_contacts_superseded_by_fk;
ALTER TABLE ea_contacts ADD CONSTRAINT ea_contacts_superseded_by_fk
  FOREIGN KEY (superseded_by_contact_id) REFERENCES ea_contacts(id) ON DELETE SET NULL;
ALTER TABLE ea_contacts DROP CONSTRAINT IF EXISTS ea_contacts_superseded_by_check;
ALTER TABLE ea_contacts ADD CONSTRAINT ea_contacts_superseded_by_check
  CHECK (superseded_by_contact_id IS NULL OR superseded_by_contact_id <> id);

CREATE TABLE IF NOT EXISTS ea_contact_email_history (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id             UUID,
  contact_name           TEXT NOT NULL,
  old_email              TEXT,
  new_email              TEXT,
  merged_into_contact_id UUID,
  reason                 TEXT NOT NULL,
  evidence               JSONB NOT NULL DEFAULT '{}'::jsonb,
  changed_by             TEXT NOT NULL,
  changed_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ea_contact_email_history_contact_fk FOREIGN KEY (contact_id) REFERENCES ea_contacts(id) ON DELETE SET NULL,
  CONSTRAINT ea_contact_email_history_merged_fk FOREIGN KEY (merged_into_contact_id) REFERENCES ea_contacts(id) ON DELETE SET NULL,
  CONSTRAINT ea_contact_email_history_reason_check CHECK (reason IN ('bounced_superseded'))
);

CREATE INDEX IF NOT EXISTS idx_ea_contact_email_history_contact ON ea_contact_email_history (contact_id, changed_at DESC);

-- Supersede a bounced address with a verified one, atomically.
CREATE OR REPLACE FUNCTION ea_supersede_email(
  p_bad TEXT, p_good TEXT, p_message_ref TEXT, p_occurred_at TIMESTAMPTZ,
  p_evidence JSONB, p_actor TEXT
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_bad  TEXT := lower(btrim(p_bad));
  v_good TEXT := lower(btrim(p_good));
  v_holder UUID;
  v_row RECORD;
  v_changed JSONB := '[]'::jsonb;
  v_bounced BOOLEAN;
BEGIN
  IF v_bad IS NULL OR v_good IS NULL OR v_bad = v_good THEN
    RAISE EXCEPTION 'ea_supersede_email: two different addresses are required';
  END IF;
  -- 499: the old address must be bounced (latest bounce newer than latest restore).
  SELECT EXISTS (
    SELECT 1 FROM ea_email_events b WHERE b.email = v_bad AND b.kind = 'bounce'
      AND b.occurred_at > coalesce((SELECT max(r.occurred_at) FROM ea_email_events r WHERE r.email = v_bad AND r.kind = 'restore'), '-infinity'::timestamptz)
  ) INTO v_bounced;
  IF NOT v_bounced THEN
    RAISE EXCEPTION 'ea_supersede_email: % has no unrestored bounce on file', v_bad;
  END IF;
  -- ...and the replacement must not be.
  IF EXISTS (
    SELECT 1 FROM ea_email_events b WHERE b.email = v_good AND b.kind = 'bounce'
      AND b.occurred_at > coalesce((SELECT max(r.occurred_at) FROM ea_email_events r WHERE r.email = v_good AND r.kind = 'restore'), '-infinity'::timestamptz)
  ) THEN
    RAISE EXCEPTION 'ea_supersede_email: the replacement % has bounced too', v_good;
  END IF;

  INSERT INTO ea_email_events (email, kind, message_ref, occurred_at, related_email, actor, detail)
  VALUES (v_bad, 'supersede', p_message_ref, p_occurred_at, v_good, coalesce(nullif(btrim(p_actor), ''), 'system'), coalesce(p_evidence, '{}'::jsonb))
  ON CONFLICT ON CONSTRAINT uq_ea_email_events DO NOTHING;

  SELECT id INTO v_holder FROM ea_contacts WHERE lower(email) = v_good LIMIT 1;

  FOR v_row IN SELECT id, name, email FROM ea_contacts WHERE lower(email) = v_bad FOR UPDATE LOOP
    IF v_holder IS NULL THEN
      UPDATE ea_contacts SET email = v_good WHERE id = v_row.id;
      v_holder := v_row.id;
      INSERT INTO ea_contact_email_history (contact_id, contact_name, old_email, new_email, reason, evidence, changed_by)
      VALUES (v_row.id, v_row.name, v_row.email, v_good, 'bounced_superseded', coalesce(p_evidence, '{}'::jsonb), coalesce(nullif(btrim(p_actor), ''), 'system'));
      v_changed := v_changed || jsonb_build_object('contact_id', v_row.id, 'name', v_row.name, 'email', v_good);
    ELSE
      UPDATE ea_contacts SET email = NULL, superseded_by_contact_id = v_holder WHERE id = v_row.id;
      INSERT INTO ea_contact_email_history (contact_id, contact_name, old_email, new_email, merged_into_contact_id, reason, evidence, changed_by)
      VALUES (v_row.id, v_row.name, v_row.email, v_good, v_holder, 'bounced_superseded', coalesce(p_evidence, '{}'::jsonb), coalesce(nullif(btrim(p_actor), ''), 'system'));
      v_changed := v_changed || jsonb_build_object('contact_id', v_row.id, 'name', v_row.name, 'merged_into', v_holder);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('bad', v_bad, 'good', v_good, 'contacts', v_changed);
END $$;

GRANT SELECT, INSERT ON ea_email_events TO service_role;
GRANT SELECT, INSERT ON ea_contact_email_history TO service_role;
REVOKE ALL ON FUNCTION ea_supersede_email(TEXT, TEXT, TEXT, TIMESTAMPTZ, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION ea_supersede_email(TEXT, TEXT, TEXT, TIMESTAMPTZ, JSONB, TEXT) TO service_role;

COMMIT;
