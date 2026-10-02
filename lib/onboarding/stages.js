// ============================================================================
// lib/onboarding/stages.js  (Issue #15) — staged state machine + hard gates
// ----------------------------------------------------------------------------
// Legacy source -> immutable intake -> normalized staging -> source controls ->
// conversion snapshot -> activity bridge -> preflight approval -> atomic
// execution -> post-conversion proof.
//
// Guardrail (Issue #15): for financial onboarding an AI agent works ONE
// bounded stage at a time and may NOT infer or begin the next stage.
//   - An agent is assigned exactly one stage. It may only perform that stage's
//     permitted actions, and only while the batch is IN that stage.
//   - Completing a stage records its result; it never moves the batch.
//   - Every stage transition is made by a human, one step at a time, never
//     skipping a stage, and only on the stage's LATEST result: PASS, or every
//     open control waived by a human for THAT result (waivers and approvals are
//     bound to a result id, so re-running a stage makes them stale).
//   - A waiver is a disposition next to the control; the control stays
//     FAIL / BLOCKED (controls.applyWaivers / summarize).
//   - Entering EXECUTE additionally needs a human approval bound to the exact
//     preflight report hash, with every control PASS (or explicitly waived by a
//     human with a reason).
//   - The write lock is open only in EXECUTE with that approval.
// The database enforces the same rules (migration 481 guard trigger); this
// module is the application-side copy so a script cannot even ask.
// ============================================================================

const crypto = require('crypto');

const STAGES = Object.freeze(['intake', 'normalize', 'source_controls', 'snapshot', 'activity_bridge', 'preflight', 'execute', 'post_proof', 'complete']);

// What may be done in each stage. Nothing outside 'execute' may write production.
const PERMITTED = Object.freeze({
  intake:          ['register_artifact', 'verify_artifact', 'complete_stage'],
  normalize:       ['run_adapter', 'record_extraction_defect', 'complete_stage'],
  source_controls: ['run_source_controls', 'complete_stage'],
  snapshot:        ['build_snapshot', 'complete_stage'],
  activity_bridge: ['compare_activity', 'classify_activity', 'complete_stage'],
  preflight:       ['build_preflight', 'complete_stage'],
  execute:         ['execute_batch', 'complete_stage'],
  post_proof:      ['run_post_proof', 'complete_stage'],
  complete:        [],
});

class GateError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function newBatchState({ batch_code, community_id, source_system }) {
  if (!batch_code || !community_id || !source_system) throw new GateError('BATCH_FIELDS_REQUIRED');
  return Object.freeze({ batch_code, community_id, source_system, stage: 'intake', stage_results: Object.freeze({}), completions: Object.freeze([]), waivers: Object.freeze([]), events: Object.freeze([]), approval: null, write_lock: true });
}

const isHuman = (actor) => actor && actor.kind === 'human' && actor.id;
const isAgent = (actor) => actor && actor.kind === 'agent';
const now = () => new Date().toISOString();
const NON_PASS = new Set(['FAIL', 'BLOCKED']);

// May this actor perform `action` on the batch right now?
function assertPermitted(state, actor, action) {
  if (!actor || !actor.kind) throw new GateError('ACTOR_REQUIRED');
  const allowed = PERMITTED[state.stage] || [];
  if (!allowed.includes(action)) throw new GateError('ACTION_NOT_PERMITTED_IN_STAGE', `${action} is not permitted in stage ${state.stage}`);
  if (isAgent(actor)) {
    if (!actor.assigned_stage) throw new GateError('AGENT_NEEDS_ASSIGNED_STAGE');
    if (actor.assigned_stage !== state.stage) throw new GateError('AGENT_OUTSIDE_ASSIGNED_STAGE', `agent assigned to ${actor.assigned_stage} cannot act in ${state.stage}`);
    if (action === 'execute_batch') throw new GateError('AGENT_CANNOT_EXECUTE');
  }
  return true;
}

function permittedActions(state, actor) {
  return (PERMITTED[state.stage] || []).filter((a) => { try { return assertPermitted(state, actor, a); } catch (_) { return false; } });
}

// The completion that governs a stage is always the LATEST one recorded for it.
// Waivers and approvals are bound to a specific completion id, so recording a
// new result for the stage (a re-run) makes every earlier waiver / approval
// stale: an old waiver can never authorize a later, different result.
const latestCompletion = (state, stage) => state.stage_results[stage] || null;
const waiversFor = (state, completion) => (completion ? state.waivers.filter((w) => w.completion_id === completion.id) : []);

// Record a stage's result. Never changes the stage. A FAIL / BLOCKED result must
// name its open controls (the codes a human would have to waive); PASS has none.
function completeStage(state, actor, result) {
  assertPermitted(state, actor, 'complete_stage');
  if (!result || !['PASS', 'FAIL', 'BLOCKED'].includes(result.status)) throw new GateError('STAGE_RESULT_REQUIRED');
  const open = result.open_controls || [];
  if (result.status === 'PASS' && open.length) throw new GateError('STAGE_RESULT_INCONSISTENT', 'a PASS result cannot have open controls');
  if (NON_PASS.has(result.status) && !open.length) throw new GateError('STAGE_RESULT_OPEN_CONTROLS_REQUIRED', 'a FAIL/BLOCKED result must list its open controls');
  const completion = Object.freeze({ ...result, open_controls: Object.freeze([...open]), id: crypto.randomUUID(), stage: state.stage, by: actor.id || actor.kind, at: now() });
  return Object.freeze({
    ...state,
    stage_results: Object.freeze({ ...state.stage_results, [state.stage]: completion }),
    completions: Object.freeze([...state.completions, completion]),
    events: Object.freeze([...state.events, { type: 'stage_completed', stage: state.stage, completion_id: completion.id, by: completion.by, status: result.status }]),
  });
}

// Human-only waiver of ONE open control of the CURRENT stage's latest result, with
// a reason. The control itself stays FAIL / BLOCKED; the waiver is a separate disposition.
function waiveControl(state, actor, code, reason) {
  if (!isHuman(actor)) throw new GateError('WAIVER_REQUIRES_HUMAN');
  if (!reason || String(reason).trim().length < 10) throw new GateError('WAIVER_REASON_REQUIRED');
  const done = latestCompletion(state, state.stage);
  if (!done) throw new GateError('WAIVER_NEEDS_COMPLETED_STAGE');
  if (!done.open_controls.includes(code)) throw new GateError('WAIVER_NOT_AN_OPEN_CONTROL', `${code} is not an open control of the current ${state.stage} result`);
  if (waiversFor(state, done).some((w) => w.code === code)) throw new GateError('WAIVER_ALREADY_RECORDED');
  const waiver = Object.freeze({ id: crypto.randomUUID(), completion_id: done.id, stage: state.stage, code, by: actor.id, reason: String(reason).trim(), at: now() });
  return Object.freeze({ ...state, waivers: Object.freeze([...state.waivers, waiver]), events: Object.freeze([...state.events, { type: 'control_waived', stage: state.stage, completion_id: done.id, code, by: actor.id }]) });
}

// Is the current stage's latest result passing, or is every open control waived (for that result)?
function stageGate(state) {
  const done = latestCompletion(state, state.stage);
  if (!done) return { ok: false, code: 'CURRENT_STAGE_NOT_COMPLETE' };
  if (done.status === 'PASS') return { ok: true, completion: done, eligibility: 'eligible' };
  const waived = new Set(waiversFor(state, done).map((w) => w.code));
  const open = done.open_controls.filter((c) => !waived.has(c));
  if (open.length) return { ok: false, code: 'CURRENT_STAGE_NOT_PASSING', open, completion: done };
  return { ok: true, completion: done, eligibility: 'eligible_with_waiver' };
}

// Human-only approval of an exact preflight report. The report must be intact (its
// hash verifies), be for this batch, and carry a WAIVED disposition for every
// non-passing control that matches a recorded human waiver of the CURRENT preflight
// result. The disposition is inside the hashed report, so changing a waiver or its
// reason changes what is being approved.
function approvePreflight(state, actor, preflight) {
  if (!isHuman(actor)) throw new GateError('APPROVAL_REQUIRES_HUMAN');
  if (state.stage !== 'preflight') throw new GateError('APPROVAL_ONLY_IN_PREFLIGHT');
  if (!preflight || !preflight.sha256) throw new GateError('PREFLIGHT_REPORT_REQUIRED');
  if (!require('./preflight').verifyPreflight(preflight)) throw new GateError('PREFLIGHT_REPORT_ALTERED');
  if (!preflight.batch || preflight.batch.batch_code !== state.batch_code) throw new GateError('PREFLIGHT_FOR_ANOTHER_BATCH');
  const done = latestCompletion(state, 'preflight');
  if (!done) throw new GateError('CURRENT_STAGE_NOT_COMPLETE');
  const recorded = waiversFor(state, done);
  const problems = [];
  for (const c of preflight.controls || []) {
    const d = c.disposition;
    if (c.status === 'PASS') { if (d) problems.push(`${c.code}: PASS control carries a disposition`); continue; }
    if (!d || d.disposition !== 'WAIVED') { problems.push(`${c.code}: ${c.status}, not waived`); continue; }
    const w = recorded.find((x) => x.code === c.code);
    if (!w || w.by !== d.waived_by || w.reason !== d.reason || w.at !== d.waived_at) problems.push(`${c.code}: disposition does not match a recorded waiver of the current preflight result`);
  }
  if (problems.length) throw new GateError('CONTROLS_NOT_PASSING', problems.join('; '));
  return Object.freeze({ ...state, approval: Object.freeze({ by: actor.id, preflight_sha256: preflight.sha256, completion_id: done.id, at: now() }), events: Object.freeze([...state.events, { type: 'preflight_approved', by: actor.id, preflight_sha256: preflight.sha256, completion_id: done.id }]) });
}

// Human-only, one step at a time; the current stage's latest result must be PASS
// or have every open control waived by a human for THAT result.
function advance(state, actor, to) {
  if (!isHuman(actor)) throw new GateError('ADVANCE_REQUIRES_HUMAN', 'only a human may move a batch to another stage');
  const i = STAGES.indexOf(state.stage);
  if (STAGES[i + 1] !== to) throw new GateError('STAGE_SKIP_REFUSED', `from ${state.stage} the only next stage is ${STAGES[i + 1]}`);
  const g = stageGate(state);
  if (!g.ok) throw new GateError(g.code, g.open ? `stage ${state.stage} is ${g.completion.status}; not waived: ${g.open.join(', ')}` : undefined);
  if (to === 'execute') {
    if (!state.approval) throw new GateError('EXECUTE_REQUIRES_APPROVAL');
    if (state.approval.completion_id !== g.completion.id) throw new GateError('APPROVAL_DOES_NOT_MATCH_PREFLIGHT', 'the preflight result changed after approval');
    if (g.completion.preflight_sha256 && g.completion.preflight_sha256 !== state.approval.preflight_sha256) throw new GateError('APPROVAL_DOES_NOT_MATCH_PREFLIGHT');
  }
  return Object.freeze({ ...state, stage: to, write_lock: to !== 'execute', events: Object.freeze([...state.events, { type: 'stage_advanced', from: state.stage, to, completion_id: g.completion.id, by: actor.id }]) });
}

module.exports = { STAGES, PERMITTED, GateError, newBatchState, assertPermitted, permittedActions, completeStage, waiveControl, waiversFor, latestCompletion, stageGate, approvePreflight, advance };
