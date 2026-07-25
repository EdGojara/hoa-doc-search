-- 332_identity_verifications.sql
-- ---------------------------------------------------------------------------
-- Staff verification that two same-name CONTACTS are the SAME person or DIFFERENT
-- people. Guards against the same-name-different-owner collapse — staff hit a
-- case where two owners shared a name but had different email/phone, and the
-- platform must not silently treat them as one (Ed 2026-07-25).
--
-- Adapted to our model: contact_id pairs (not "account_id"), verified_by ->
-- user_profiles. This is a STAFF-ONLY admin table — the homeowner portal is a
-- separate app that never queries it — so access is service-role write +
-- authenticated read + endpoint staff-gating, our standard (no client RLS).
--
-- Record ownership: workpaper (internal identity-resolution decision).
-- ---------------------------------------------------------------------------
BEGIN;

CREATE TABLE IF NOT EXISTS identity_verifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id_1  uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  contact_id_2  uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  result        text NOT NULL CHECK (result IN ('same_person','different_people')),
  verified_by   uuid REFERENCES user_profiles(id),
  verified_at   timestamptz NOT NULL DEFAULT now(),
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_verifications_distinct_pair CHECK (contact_id_1 <> contact_id_2)
);

-- One verification per UNORDERED pair — (A,B) and (B,A) are the same decision.
CREATE UNIQUE INDEX IF NOT EXISTS uq_identity_verifications_pair
  ON identity_verifications (LEAST(contact_id_1, contact_id_2), GREATEST(contact_id_1, contact_id_2));

GRANT SELECT, INSERT, UPDATE, DELETE ON identity_verifications TO service_role;
GRANT SELECT ON identity_verifications TO authenticated;

COMMIT;
