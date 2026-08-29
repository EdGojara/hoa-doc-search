// ============================================================================
// tests/test_reconcile.js  (Ed 2026-08-29)
// ----------------------------------------------------------------------------
// The reconciliation loop must be cheap and safe: it may only spend a model call
// when there is genuinely something new to decide, it must be idempotent, it must
// never run away, and any uncertainty escalates to a human. These tests assert
// the COST + NO-LOOP guards by counting how often the (stubbed) judge is called.
// Deterministic: a thenable Supabase stub, no DB, no model.
// ============================================================================
const assert = require('assert');
const { reconcileObjective, MAX_DECISIONS } = require('../lib/team/reconcile');

let pass = 0, fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } }

// Configurable stub. decisions: rows for objective_decisions (newest first).
// hasNewEvidence: what _newEvidenceSince resolves to. captures inserts.
function stub({ decisions = [], hasNewEvidence = false, decisionCount = null, captured = [] } = {}) {
  const make = (table) => {
    const st = { table, op: 'select', eqs: {}, gt: false, count: false, single: false, payload: null };
    const b = {
      select(_s, opts) { if (opts && opts.count) { st.count = true; } return b; },
      insert(r) { st.op = 'insert'; st.payload = r; return b; },
      update(r) { st.op = 'update'; st.payload = r; return b; },
      eq(k, v) { st.eqs[k] = v; return b; },
      gt() { st.gt = true; return b; },
      in() { return b; }, order() { return b; }, limit() { return b; },
      single() { st.single = true; return b; },
      then(res, rej) {
        let out = { data: null, error: null, count: 0 };
        if (st.op === 'insert') { captured.push({ table, row: st.payload }); out = { data: { id: 'new', ...st.payload }, error: null }; }
        else if (st.op === 'update') { out = { data: { id: st.eqs.id || 'obj', ...st.payload }, error: null }; }
        else if (table === 'objective_decisions') {
          if (st.count) out = { count: decisionCount == null ? decisions.length : decisionCount, error: null };
          else if ('triggering_event_ref' in st.eqs) out = { data: decisions.filter((d) => d.triggering_event_ref === st.eqs.triggering_event_ref), error: null };
          else out = { data: decisions.slice(0, 1), error: null }; // last decision
        } else if (table === 'objective_events') {
          out = st.gt ? { data: hasNewEvidence ? [{ id: 'ev' }] : [], error: null } : { data: [], error: null };
        }
        return Promise.resolve(out).then(res, rej);
      },
    };
    return b;
  };
  return { from(t) { return make(t); } };
}

function countingJudge(verdict = 'PROPOSE_ACTION') {
  const fn = async () => { fn.calls++; return { verdict, confidence: 'medium', reason: 'stub', rules_consulted: [], proposed_capability: 'draft_reply', proposed_action_detail: 'draft a reply', authorization_boundary: false }; };
  fn.calls = 0;
  return fn;
}

const objOpen = { id: 'o1', community_id: 'c1', status: 'open', objective_type: 'homeowner_issue', title: 'x', owner_persona: 'claire' };
const nowIso = new Date().toISOString();
const oldIso = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago

(async () => {
  console.log('\nReconciliation loop — cost + no-loop guards\n');

  await (async () => {
    const j = countingJudge();
    const r = await reconcileObjective(stub({ decisions: [{ id: 'd', triggering_event_ref: 'msg-1', verdict: 'WAIT', created_at: oldIso }] }), objOpen, { triggeringEventRef: 'msg-1', judge: j });
    ok(r && r.skipped === 'already_decided', 'idempotent: same (objective,event) is not re-decided');
    ok(j.calls === 0, '  -> no model call on a duplicate event');
  })();

  await (async () => {
    const j = countingJudge();
    // last decision was recent, no new evidence -> dirty-check short-circuits
    const r = await reconcileObjective(stub({ decisions: [{ id: 'd', triggering_event_ref: 'drive_tick', verdict: 'WAIT', created_at: nowIso }], hasNewEvidence: false }), objOpen, { triggeringEventRef: 'drive_tick', judge: j });
    ok(r && r.skipped === 'no_change', 'dirty-check: no new evidence -> skip');
    ok(j.calls === 0, '  -> NO model call when nothing changed (the cost guard)');
  })();

  await (async () => {
    const j = countingJudge();
    const waiting = { ...objOpen, status: 'waiting_resident' };
    const r = await reconcileObjective(stub({ decisions: [{ id: 'd', triggering_event_ref: 'other', verdict: 'REQUEST_INFORMATION', created_at: oldIso }], hasNewEvidence: false }), waiting, { triggeringEventRef: 'msg-waitcheck', judge: j });
    ok(r && r.cheap && r.decision && r.decision.verdict === 'WAIT', 'cheap deterministic WAIT for "waiting, nothing new"');
    ok(j.calls === 0, '  -> resolved without a model call');
  })();

  await (async () => {
    const j = countingJudge();
    const cap = [];
    const r = await reconcileObjective(stub({ decisions: [{ id: 'd', triggering_event_ref: 'x', verdict: 'WAIT', created_at: oldIso }], decisionCount: MAX_DECISIONS, hasNewEvidence: true, captured: cap }), objOpen, { triggeringEventRef: 'msg-new', judge: j });
    ok(r && r.decision && r.decision.verdict === 'ESCALATE', `backstop: after ${MAX_DECISIONS} reconsiders -> ESCALATE to a human`);
    ok(j.calls === 0, '  -> no model call; it stops churning');
  })();

  await (async () => {
    const j = countingJudge('PROPOSE_ACTION');
    const cap = [];
    // dirty (new evidence) + past cooloff -> the one place a model call happens
    const r = await reconcileObjective(stub({ decisions: [{ id: 'd', triggering_event_ref: 'old', verdict: 'WAIT', created_at: oldIso }], hasNewEvidence: true, captured: cap }), objOpen, { triggeringEventRef: 'msg-new', judge: j });
    ok(j.calls === 1, 'model is called exactly once when there is genuinely new evidence');
    ok(r && r.decision && r.decision.verdict === 'PROPOSE_ACTION', '  -> records the judged verdict');
    ok(r.decision.executed === false, '  -> DARK: recorded, never executed');
  })();

  console.log(`\n${fail ? 'FAILED' : 'All'} reconcile cases ${fail ? '' : 'passed'} (${pass} passed, ${fail} failed).`);
  process.exit(fail ? 1 : 0);
})();
