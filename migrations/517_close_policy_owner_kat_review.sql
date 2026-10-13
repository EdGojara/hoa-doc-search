-- ============================================================================
-- 517_close_policy_owner_kat_review.sql  (Ed 2026-10-12: permanent accrual close policy)
-- ----------------------------------------------------------------------------
-- Ed: "No accounting month may be closed until Kat has completed a month-end
-- cutoff review and I have approved the close."
--
-- The existing close (migration 502) stays the one close workflow. This changes
-- ONE function, close_period:
--   1. only the owner closes a month (was: admin or owner);
--   2. the run closed on must be Kat's month-end cutoff review: recorded by Kat
--      (run_by begins "Kat") and carrying every cutoff control (CUT-01 expenses in
--      the period incurred, CUT-02 delinquent interest, CUT-03 prepaids, IF-01
--      interfund), which the checklist engine close-b.1 evaluates.
-- Everything else in close_period is unchanged (latest run, fingerprint, months in
-- order, owner overrides of BLOCKs, accepted warnings, the close record).
--
-- Nothing closes automatically and nothing is posted. No row changes: no period,
-- close record, journal entry or ledger row is touched. Reopen, overrides and
-- warning acceptance keep their 502 authority.
-- Record ownership: function only (period_close_* are workpapers, mig 502).
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION close_period(p_community uuid, p_period uuid, p_run uuid, p_actor text, p_actor_user_id uuid, p_actor_role text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE pc period_closes; run period_close_runs; per accounting_periods; now_fp text; unresolved jsonb; unaccepted jsonb; earlier jsonb;
        ovr jsonb; acc jsonb; lbl text; cyc timestamptz;
BEGIN
  IF p_actor_role IS DISTINCT FROM 'owner' THEN RAISE EXCEPTION 'close_refused: only the owner approves and closes a month (accrual close policy)'; END IF;
  IF coalesce(btrim(p_actor), '') = '' THEN RAISE EXCEPTION 'actor required'; END IF;
  SELECT * INTO per FROM accounting_periods WHERE id = p_period AND community_id = p_community FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no accounting period % for this community', p_period; END IF;
  IF per.status IN ('closed', 'locked') THEN RAISE EXCEPTION 'period_closed: already closed'; END IF;
  SELECT * INTO pc FROM period_closes WHERE period_id = p_period FOR UPDATE;
  IF NOT FOUND OR pc.latest_run_id IS NULL THEN RAISE EXCEPTION 'close_refused: run the checklist first'; END IF;
  IF pc.latest_run_id IS DISTINCT FROM p_run THEN RAISE EXCEPTION 'stale_run: a newer checklist run exists; close on the latest run'; END IF;
  SELECT * INTO run FROM period_close_runs WHERE id = p_run;
  -- Accrual close policy (mig 517): the run closed on must be Kat's month-end cutoff review,
  -- recorded by Kat (first word of run_by) with every cutoff control evaluated (lib/close/policy.js).
  IF split_part(lower(btrim(coalesce(run.run_by, ''))), ' ', 1) IS DISTINCT FROM 'kat' OR NOT (run.results @> '[{"code":"CUT-01"}]' AND run.results @> '[{"code":"CUT-02"}]'
       AND run.results @> '[{"code":"CUT-03"}]' AND run.results @> '[{"code":"IF-01"}]') THEN
    RAISE EXCEPTION 'close_refused: the month needs Kat''s month-end cutoff review first; run it, then close on that run';
  END IF;
  now_fp := close_ledger_facts(p_community, p_period)->>'fingerprint';
  IF now_fp IS DISTINCT FROM run.fingerprint THEN RAISE EXCEPTION 'books_changed: the books changed since the checklist ran; run it again before closing'; END IF;
  earlier := close_previous_open_periods(p_community, p_period);
  IF jsonb_array_length(earlier) > 0 THEN RAISE EXCEPTION 'close_refused: close the earlier months first (%)', earlier; END IF;
  unresolved := close_unresolved_blocks(p_run);
  IF jsonb_array_length(unresolved) > 0 THEN RAISE EXCEPTION 'close_refused: BLOCK controls not overridden by the owner: %', unresolved; END IF;
  cyc := close_cycle_start(p_period);
  SELECT coalesce(jsonb_agg(r->>'code' ORDER BY r->>'code'), '[]'::jsonb) INTO unaccepted
    FROM jsonb_array_elements(run.results) r
   WHERE r->>'status' = 'WARNING'
     AND NOT EXISTS (SELECT 1 FROM period_close_events e, jsonb_array_elements_text(e.detail->'control_codes') c
                      WHERE e.period_id = p_period AND e.run_id = p_run AND e.event = 'warnings_accepted' AND c = r->>'code');
  IF jsonb_array_length(unaccepted) > 0 THEN RAISE EXCEPTION 'close_refused: accept these warnings first: %', unaccepted; END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('control_code', e.control_code, 'reason', e.reason, 'actor', e.actor, 'at', e.created_at,
           'evidence_hash', e.evidence_hash, 'original_result', e.detail->'original_result') ORDER BY e.seq), '[]'::jsonb)
    INTO ovr FROM period_close_events e, jsonb_array_elements(run.results) r
   WHERE e.period_id = p_period AND e.event = 'block_overridden' AND e.created_at > cyc AND r->>'status' = 'BLOCK'
     AND e.control_code = r->>'code' AND e.evidence_hash = r->>'evidence_hash';
  SELECT coalesce(jsonb_agg(jsonb_build_object('control_code', c, 'accepted_by', e.actor, 'at', e.created_at, 'note', e.reason) ORDER BY e.seq), '[]'::jsonb)
    INTO acc FROM period_close_events e, jsonb_array_elements_text(e.detail->'control_codes') c
   WHERE e.period_id = p_period AND e.run_id = p_run AND e.event = 'warnings_accepted';
  lbl := CASE WHEN jsonb_array_length(ovr) > 0 THEN 'closed_with_override' ELSE 'closed' END;

  PERFORM set_config('trusted.close_txn', 'on', true);
  UPDATE accounting_periods SET status = 'closed', closed_at = now(), closed_by_user_id = p_actor_user_id WHERE id = p_period;
  UPDATE period_closes SET status = 'closed', close_label = lbl, close_run_id = p_run, fingerprint = run.fingerprint,
         closed_at = now(), closed_by = btrim(p_actor), closed_by_user_id = p_actor_user_id, closed_by_role = p_actor_role,
         accepted_warnings = acc, overrides = ovr
   WHERE id = pc.id;
  INSERT INTO period_close_events (community_id, period_id, run_id, event, actor, actor_user_id, actor_role, detail)
  VALUES (p_community, p_period, p_run, 'closed', btrim(p_actor), p_actor_user_id, p_actor_role,
          jsonb_build_object('label', lbl, 'fingerprint', run.fingerprint, 'overrides', ovr, 'accepted_warnings', acc));
  RETURN jsonb_build_object('status', 'closed', 'label', lbl, 'closed_through', per.period_end, 'fingerprint', run.fingerprint);
END;
$fn$;

REVOKE ALL ON FUNCTION close_period(uuid, uuid, uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION close_period(uuid, uuid, uuid, text, uuid, text) TO service_role;

COMMENT ON FUNCTION close_period(uuid, uuid, uuid, text, uuid, text) IS
  'Closes a month: OWNER only, on the latest checklist run, which must be Kat''s month-end cutoff review (CUT-01..03, IF-01); fingerprint unchanged; months in order; BLOCKs overridden by the owner; warnings accepted. (mig 502, policy mig 517)';

COMMIT;
