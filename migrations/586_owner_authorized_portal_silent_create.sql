-- ============================================================================
-- 586_owner_authorized_portal_silent_create.sql  (Ed 2026-11-27)
-- ----------------------------------------------------------------------------
-- Extends the Owner Authorization Service (migs 554-556, 566, 577, 582-585) to
-- silent homeowner portal account creation. Until now the only way to create
-- accounts for every eligible owner of an association (the broader launch)
-- was the signed-in owner's POST /api/portal-admin/community/:id/bulk-invite
-- with mode create_only and broader_launch_approved. With this migration Tessa
-- emails the owner ONE request listing, per association, the accounts to
-- create, multi-lot accounts, skipped counts by reason and the roster hash; the
-- owner replies "approved" (or "approved except <association>"); Amanda creates
-- the accounts through the SAME create path (lib/portal/silent_create), only if
-- the recomputed roster still has that hash and its lot cross-check passes.
-- No invitation or magic link is created, and communities.portal_active,
-- balances and payments are never touched.
--
--   scope 'portal_silent_creates'   one request of associations, one item each,
--                                   fingerprint = the roster hash
--                                   (lib/portal/invite_roster rosterHash).
--
-- The roster hash is computed by the application from v_current_property_owners
-- and portal_users, exactly as the endpoint computes it; this function checks
-- its shape, that each association exists and is not a demo, that the request
-- states the association's portal state truly (on or off; execution refuses if
-- it changes), and stores the items with the association's name.
--
-- Sensitivity tier 1 (lib/authorization/policy.js): homeowner accounts for
-- owners of record, each limited to the owner's own lots; nobody is told. Where
-- the portal is off nothing is visible until it is switched on; where it is on
-- (stated in the request) an owner could sign in, with balances and payments off. Executor ai-team:amanda.
--
-- Record ownership: no new table. owner_authorizations rows stay workpaper +
-- association evidence exactly as before. No existing rows are added, removed or
-- changed.
-- ============================================================================
BEGIN;

ALTER TABLE owner_authorizations DROP CONSTRAINT IF EXISTS owner_authorizations_scope_check;
ALTER TABLE owner_authorizations ADD CONSTRAINT owner_authorizations_scope_check
  CHECK (scope IN ('conversion_objects', 'accounting_runs', 'arc_acc_decisions', 'closing_packages', 'check_receipt_allocations', 'legal_posting_reversals', 'portal_silent_creates'));

-- p_associations = [{ community_id, roster_hash, membership_hash, accounts_to_create, multi_lot_accounts,
--                     existing_silent_accounts, lots, skipped: { reason: count } }, ...]
CREATE OR REPLACE FUNCTION owner_authorization_request_portal_silent_creates(p_subject text, p_summary text, p_associations jsonb, p_owner_email text, p_requested_by text, p_hours integer DEFAULT 72)
RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE x jsonb; c communities%ROWTYPE; items jsonb := '[]'::jsonb; n int := 0; new_id uuid; creates int; existing int;
BEGIN
  IF p_hours IS NULL OR p_hours < 1 OR p_hours > 168 THEN RAISE EXCEPTION 'an authorization request expires within 1 to 168 hours' USING ERRCODE = 'check_violation'; END IF;
  IF length(btrim(coalesce(p_owner_email, ''))) < 3 THEN RAISE EXCEPTION 'the owner email is required' USING ERRCODE = 'check_violation'; END IF;
  IF p_associations IS NULL OR jsonb_typeof(p_associations) <> 'array' OR jsonb_array_length(p_associations) = 0 OR jsonb_array_length(p_associations) > 25 THEN
    RAISE EXCEPTION 'list 1 to 25 associations' USING ERRCODE = 'check_violation'; END IF;
  FOR x IN SELECT * FROM jsonb_array_elements(p_associations) LOOP
    n := n + 1;
    IF jsonb_typeof(x) <> 'object' OR coalesce(x->>'community_id', '') !~ '^[0-9a-fA-F-]{36}$' THEN RAISE EXCEPTION 'association %: community_id is required', n USING ERRCODE = 'check_violation'; END IF;
    SELECT * INTO c FROM communities WHERE id = (x->>'community_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'association %: not an association', n USING ERRCODE = 'check_violation'; END IF;
    IF c.is_demo IS TRUE THEN RAISE EXCEPTION 'association %: % is a demo association', n, c.name USING ERRCODE = 'check_violation'; END IF;
    -- The request states whether each portal is on; it must be what the database says.
    IF jsonb_typeof(x->'portal_active') <> 'boolean' OR (x->>'portal_active')::boolean IS DISTINCT FROM (c.portal_active IS TRUE) THEN
      RAISE EXCEPTION 'association %: the request must state whether the % portal is on (it is %)', n, c.name, CASE WHEN c.portal_active IS TRUE THEN 'on' ELSE 'off' END USING ERRCODE = 'check_violation'; END IF;
    IF coalesce(x->>'roster_hash', '') !~ '^[0-9a-f]{24}$' OR coalesce(x->>'membership_hash', '') !~ '^[0-9a-f]{24}$' THEN
      RAISE EXCEPTION 'association %: roster_hash and membership_hash are required', n USING ERRCODE = 'check_violation'; END IF;
    IF coalesce(x->>'accounts_to_create', '') !~ '^\d{1,6}$' OR coalesce(x->>'existing_silent_accounts', '0') !~ '^\d{1,6}$' THEN
      RAISE EXCEPTION 'association %: account counts must be whole numbers', n USING ERRCODE = 'check_violation'; END IF;
    creates := (x->>'accounts_to_create')::int; existing := coalesce(x->>'existing_silent_accounts', '0')::int;
    IF creates + existing = 0 THEN RAISE EXCEPTION 'association %: % has no accounts to create', n, c.name USING ERRCODE = 'check_violation'; END IF;
    items := items || jsonb_build_array(jsonb_build_object('n', n, 'object_type', 'portal_silent_create', 'community_id', c.id::text, 'name', c.name, 'slug', c.slug,
      'accounts_to_create', creates, 'multi_lot_accounts', coalesce(x->>'multi_lot_accounts', '0')::int, 'existing_silent_accounts', existing,
      'lots', coalesce(x->>'lots', '0')::int, 'portal_active', c.portal_active IS TRUE, 'skipped', coalesce(x->'skipped', '{}'::jsonb),
      'fingerprint', x->>'roster_hash', 'membership_hash', x->>'membership_hash'));
  END LOOP;
  IF (SELECT count(DISTINCT y->>'community_id') FROM jsonb_array_elements(items) y) <> n THEN RAISE EXCEPTION 'an association is listed twice' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO owner_authorizations (scope, subject, summary, items, items_sha256, owner_email, requested_by, expires_at, coordinator, executor, sensitivity_tier)
  VALUES ('portal_silent_creates', btrim(p_subject), p_summary, items, conversion_sha256_jsonb(items), lower(btrim(p_owner_email)), p_requested_by,
    now() + make_interval(hours => p_hours), 'ai-team:amanda', 'ai-team:amanda', 1)
  RETURNING id INTO new_id;
  RETURN jsonb_build_object('id', new_id, 'items', items, 'items_sha256', conversion_sha256_jsonb(items));
END $fn$;

REVOKE ALL ON FUNCTION owner_authorization_request_portal_silent_creates(text, text, jsonb, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION owner_authorization_request_portal_silent_creates(text, text, jsonb, text, text, integer) TO service_role;

COMMIT;
