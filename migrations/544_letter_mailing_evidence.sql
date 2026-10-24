-- 544_letter_mailing_evidence.sql  (Ed 2026-10-24)
-- ----------------------------------------------------------------------------
-- Mailing evidence: what staff confirmed actually happened to printed letters.
--
-- Printing a letter does not prove it was mailed, and a "confirm mailed" click
-- stamped the click time, not the real mailing date. Staff now confirm each print
-- run: which letters went out, on what date, and which were held or pulled. Those
-- answers are permanent records. Nothing here regenerates a letter, changes a cure
-- deadline, advances a case or creates a charge.
--
-- Record ownership: association_record (the HOA's notice history), all four
-- tables. Every table has a community FK for termination export.
--
--   mailing_batch_confirmations  one row per staff confirmation of a print run
--   letter_mailing_evidence      one row per letter per confirmation (append-only;
--                                 a newer row supersedes an older one)
--   letter_mail_holds            letters that must NOT be mailed until released
--   mailing_verification_scopes  print windows presumed NOT mailed until staff
--                                 confirm (Still Creek and Waterview recent runs)
--   enforcement_queue_owners     who is responsible for each work-queue bucket
-- ----------------------------------------------------------------------------
BEGIN;

CREATE TABLE IF NOT EXISTS mailing_batch_confirmations (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id         UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  delivery_method      TEXT NOT NULL,
  printed_at           TIMESTAMPTZ NOT NULL,
  mailed_on            DATE NULL,
  letter_count         INT NOT NULL CHECK (letter_count > 0),
  mailed_count         INT NOT NULL DEFAULT 0,
  not_mailed_count     INT NOT NULL DEFAULT 0,
  held_count           INT NOT NULL DEFAULT 0,
  excluded_count       INT NOT NULL DEFAULT 0,
  note                 TEXT NULL,
  confirmed_by_user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE RESTRICT,
  confirmed_by_name    TEXT NOT NULL,
  confirmed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (mailed_count = 0 OR mailed_on IS NOT NULL)
);
COMMENT ON TABLE mailing_batch_confirmations IS 'association_record: a staff member''s confirmation of what happened to one print run. Append-only.';
CREATE INDEX IF NOT EXISTS idx_mailing_batch_conf_community ON mailing_batch_confirmations (community_id, printed_at);

CREATE TABLE IF NOT EXISTS letter_mailing_evidence (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interaction_id        UUID NOT NULL REFERENCES interactions(id) ON DELETE RESTRICT,
  community_id          UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  violation_id          UUID NULL REFERENCES violations(id) ON DELETE RESTRICT,
  batch_confirmation_id UUID NULL REFERENCES mailing_batch_confirmations(id) ON DELETE RESTRICT,
  outcome               TEXT NOT NULL CHECK (outcome IN ('mailed', 'not_mailed', 'held', 'excluded')),
  mailed_on             DATE NULL,
  delivery_method       TEXT NULL,
  note                  TEXT NULL,
  recorded_by_user_id   UUID NOT NULL REFERENCES user_profiles(id) ON DELETE RESTRICT,
  recorded_by_name      TEXT NOT NULL,
  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (outcome <> 'mailed' OR mailed_on IS NOT NULL)
);
COMMENT ON TABLE letter_mailing_evidence IS 'association_record: staff-confirmed mailing outcome for one letter. Append-only; the newest row per letter is current.';
CREATE INDEX IF NOT EXISTS idx_letter_mailing_evidence_letter ON letter_mailing_evidence (interaction_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_letter_mailing_evidence_violation ON letter_mailing_evidence (violation_id) WHERE violation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS letter_mail_holds (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interaction_id       UUID NOT NULL REFERENCES interactions(id) ON DELETE RESTRICT,
  community_id         UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  reason               TEXT NOT NULL,
  directed_by          TEXT NOT NULL,
  directed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at          TIMESTAMPTZ NULL,
  released_by_user_id  UUID NULL REFERENCES user_profiles(id) ON DELETE RESTRICT,
  release_reason       TEXT NULL,
  CHECK (released_at IS NULL OR (released_by_user_id IS NOT NULL AND coalesce(release_reason, '') <> ''))
);
COMMENT ON TABLE letter_mail_holds IS 'association_record: a letter that must not be mailed, who directed it and why. Only the release fields may change, once.';
CREATE UNIQUE INDEX IF NOT EXISTS uq_letter_mail_holds_active ON letter_mail_holds (interaction_id) WHERE released_at IS NULL;

CREATE TABLE IF NOT EXISTS mailing_verification_scopes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id    UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  printed_from    DATE NOT NULL,
  printed_through DATE NOT NULL,
  reason          TEXT NOT NULL,
  directed_by     TEXT NOT NULL,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (printed_through >= printed_from)
);
COMMENT ON TABLE mailing_verification_scopes IS 'association_record: print windows whose letters are presumed NOT mailed until staff confirm a mailing date.';
CREATE UNIQUE INDEX IF NOT EXISTS uq_mailing_verification_scope ON mailing_verification_scopes (community_id, printed_from, printed_through);

CREATE TABLE IF NOT EXISTS enforcement_queue_owners (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id UUID NULL REFERENCES communities(id) ON DELETE RESTRICT,
  bucket       TEXT NOT NULL CHECK (bucket IN ('ready_to_mail', 'confirm_mailing', 'held_correction', 'missing_notice')),
  user_id      UUID NOT NULL REFERENCES user_profiles(id) ON DELETE RESTRICT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE enforcement_queue_owners IS 'workpaper: which employee owns each violations work-queue bucket (community_id NULL = the default for every community).';
CREATE UNIQUE INDEX IF NOT EXISTS uq_enforcement_queue_owner ON enforcement_queue_owners (coalesce(community_id, '00000000-0000-0000-0000-000000000000'::uuid), bucket);

-- Cure-deadline review holds (Ed 2026-10-24): when staff confirm a letter was
-- mailed LATER than the date its cure deadline was counted from, the case is
-- flagged and escalation waits until an admin resolves the deadline. The flag
-- keeps the deadline as it stood; a correction is recorded here, never silently.
CREATE TABLE IF NOT EXISTS enforcement_review_holds (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id                UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  violation_id                UUID NOT NULL REFERENCES violations(id) ON DELETE RESTRICT,
  interaction_id              UUID NULL REFERENCES interactions(id) ON DELETE RESTRICT,
  kind                        TEXT NOT NULL CHECK (kind IN ('cure_deadline_review')),
  reason                      TEXT NOT NULL,
  basis_date                  DATE NULL,
  confirmed_mailed_on         DATE NULL,
  cure_period_ends_at_flagged TIMESTAMPTZ NULL,
  flagged_by_user_id          UUID NULL REFERENCES user_profiles(id) ON DELETE RESTRICT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at                 TIMESTAMPTZ NULL,
  resolved_by_user_id         UUID NULL REFERENCES user_profiles(id) ON DELETE RESTRICT,
  resolution                  TEXT NULL CHECK (resolution IN ('keep_deadline', 'deadline_corrected')),
  resolution_reason           TEXT NULL,
  new_cure_period_ends_at     TIMESTAMPTZ NULL,
  CHECK (resolved_at IS NULL OR (resolved_by_user_id IS NOT NULL AND resolution IS NOT NULL AND coalesce(resolution_reason, '') <> '')),
  CHECK (resolution IS DISTINCT FROM 'deadline_corrected' OR new_cure_period_ends_at IS NOT NULL)
);
COMMENT ON TABLE enforcement_review_holds IS 'association_record: a case whose escalation waits for an admin to resolve its cure deadline, and how it was resolved. Only the resolution may be recorded, once.';
CREATE UNIQUE INDEX IF NOT EXISTS uq_enforcement_review_hold_open ON enforcement_review_holds (violation_id, kind) WHERE resolved_at IS NULL;

CREATE OR REPLACE FUNCTION enforcement_review_holds_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'review holds are permanent (hold %); resolve it instead', OLD.id;
  END IF;
  IF OLD.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'review hold % was already resolved', OLD.id;
  END IF;
  IF NEW.violation_id IS DISTINCT FROM OLD.violation_id OR NEW.interaction_id IS DISTINCT FROM OLD.interaction_id
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.basis_date IS DISTINCT FROM OLD.basis_date OR NEW.confirmed_mailed_on IS DISTINCT FROM OLD.confirmed_mailed_on
     OR NEW.cure_period_ends_at_flagged IS DISTINCT FROM OLD.cure_period_ends_at_flagged
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.community_id IS DISTINCT FROM OLD.community_id THEN
    RAISE EXCEPTION 'only the resolution of review hold % can be recorded', OLD.id;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_enforcement_review_holds_guard ON enforcement_review_holds;
CREATE TRIGGER trg_enforcement_review_holds_guard BEFORE UPDATE OR DELETE ON enforcement_review_holds
  FOR EACH ROW EXECUTE FUNCTION enforcement_review_holds_guard();

-- Permanent records: confirmations and evidence can never be edited or deleted.
CREATE OR REPLACE FUNCTION mailing_evidence_append_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'mailing records are permanent (% %); record a new confirmation instead', TG_TABLE_NAME, OLD.id;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_mailing_batch_conf_append_only ON mailing_batch_confirmations;
CREATE TRIGGER trg_mailing_batch_conf_append_only BEFORE UPDATE OR DELETE ON mailing_batch_confirmations
  FOR EACH ROW EXECUTE FUNCTION mailing_evidence_append_only();
DROP TRIGGER IF EXISTS trg_letter_mailing_evidence_append_only ON letter_mailing_evidence;
CREATE TRIGGER trg_letter_mailing_evidence_append_only BEFORE UPDATE OR DELETE ON letter_mailing_evidence
  FOR EACH ROW EXECUTE FUNCTION mailing_evidence_append_only();

-- A hold can only be released (once); nothing else about it changes, and it is never deleted.
CREATE OR REPLACE FUNCTION letter_mail_holds_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'mail holds are permanent (hold %); release it instead', OLD.id;
  END IF;
  IF OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'hold % was already released', OLD.id;
  END IF;
  IF NEW.interaction_id IS DISTINCT FROM OLD.interaction_id OR NEW.community_id IS DISTINCT FROM OLD.community_id
     OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.directed_by IS DISTINCT FROM OLD.directed_by
     OR NEW.directed_at IS DISTINCT FROM OLD.directed_at THEN
    RAISE EXCEPTION 'only the release of hold % can be recorded', OLD.id;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_letter_mail_holds_guard ON letter_mail_holds;
CREATE TRIGGER trg_letter_mail_holds_guard BEFORE UPDATE OR DELETE ON letter_mail_holds
  FOR EACH ROW EXECUTE FUNCTION letter_mail_holds_guard();

GRANT SELECT, INSERT ON mailing_batch_confirmations TO service_role;
GRANT SELECT, INSERT ON letter_mailing_evidence TO service_role;
GRANT SELECT, INSERT, UPDATE ON letter_mail_holds TO service_role;
GRANT SELECT, INSERT, UPDATE ON mailing_verification_scopes TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON enforcement_queue_owners TO service_role;
GRANT SELECT, INSERT, UPDATE ON enforcement_review_holds TO service_role;

-- Seed 1: the two Still Creek certified letters Ed held on 2026-10-23 (print run 10/23 3:26 PM).
INSERT INTO letter_mail_holds (interaction_id, community_id, reason, directed_by, directed_at)
SELECT i.id, i.community_id,
       'Held by Ed on 10/23/2026: this certified letter must not be mailed until Ed releases it.',
       'Ed Gojara', '2026-10-23T22:00:00Z'
FROM interactions i
WHERE i.id IN ('82d522d4-3fd4-4d98-ba8b-17cc5d003465', 'e7528e44-955b-46b2-ba6c-0b9afecdd5c2')
  AND NOT EXISTS (SELECT 1 FROM letter_mail_holds h WHERE h.interaction_id = i.id AND h.released_at IS NULL);

-- Seed 2: Ed's direction 2026-10-24: letters from the recent Still Creek and Waterview
-- inspections are presumed NOT mailed until staff confirm, even where a confirm click exists.
INSERT INTO mailing_verification_scopes (community_id, printed_from, printed_through, reason, directed_by)
SELECT c.id, v.f::date, v.t::date, v.r, 'Ed Gojara'
FROM (VALUES
  ('a0000000-0000-4000-8000-000000000006', '2026-10-23', '2026-10-24', 'Still Creek Ranch letters printed 10/23 from the recent inspection: presumed not mailed until staff confirm the date.'),
  ('a0000000-0000-4000-8000-000000000001', '2026-10-08', '2026-10-24', 'Waterview letters printed 10/8 to 10/23 from the recent inspections: presumed not mailed until staff confirm the date.')
) AS v(cid, f, t, r)
JOIN communities c ON c.id = v.cid::uuid
ON CONFLICT (community_id, printed_from, printed_through) DO NOTHING;

-- Seed 3: default owners. Martha confirms and mails; Ed owns holds and corrections.
INSERT INTO enforcement_queue_owners (community_id, bucket, user_id)
SELECT NULL, b.bucket, b.uid::uuid
FROM (VALUES
  ('confirm_mailing', '387f44df-a73f-40b3-be28-e73b2303b7cf'),
  ('ready_to_mail',   '387f44df-a73f-40b3-be28-e73b2303b7cf'),
  ('missing_notice',  '387f44df-a73f-40b3-be28-e73b2303b7cf'),
  ('held_correction', 'e108ca2f-bae3-48c1-b183-3d790c51a2af')
) AS b(bucket, uid)
WHERE EXISTS (SELECT 1 FROM user_profiles p WHERE p.id = b.uid::uuid)
  AND NOT EXISTS (SELECT 1 FROM enforcement_queue_owners o WHERE o.community_id IS NULL AND o.bucket = b.bucket);

COMMIT;
