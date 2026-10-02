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
//     skipping a stage.
//   - Entering EXECUTE additionally needs a human approval bound to the exact
//     preflight report hash, with every control PASS (or explicitly waived by a
//     human with a reason).
//   - The write lock is open only in EXECUTE with that approval.
// The database enforces the same rules (migration 481 guard trigger); this
// module is the application-side copy so a script cannot even ask.
// ============================================================================

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
  return Object.freeze({ batch_code, community_id, source_system, stage: 'intake', stage_results: Object.freeze({}), events: Object.freeze([]), approval: null, waivers: Object.freeze({}), write_lock: true });
}

const isHuman = (actor) => actor && actor.kind === 'human' && actor.id;
const isAgent = (actor) => actor && actor.kind === 'agent';

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

// Record a stage's result. Never changes the stage.
function completeStage(state, actor, result) {
  assertPermitted(state, actor, 'complete_stage');
  if (!result || !result.status) throw new GateError('STAGE_RESULT_REQUIRED');
  const stage_results = Object.freeze({ ...state.stage_results, [state.stage]: Object.freeze({ ...result, by: actor.id || actor.kind, at: new Date().toISOString() }) });
  return Object.freeze({ ...state, stage_results, events: Object.freeze([...state.events, { type: 'stage_completed', stage: state.stage, by: actor.id || actor.kind, status: result.status }]) });
}

// Human-only waiver of one non-PASS control, with a reason. Recorded, never silent.
function waiveControl(state, actor, code, reason) {
  if (!isHuman(actor)) throw new GateError('WAIVER_REQUIRES_HUMAN');
  if (!reason || String(reason).trim().length < 10) throw new GateError('WAIVER_REASON_REQUIRED');
  return Object.freeze({ ...state, waivers: Object.freeze({ ...state.waivers, [code]: { by: actor.id, reason, at: new Date().toISOString() } }), events: Object.freeze([...state.events, { type: 'control_waived', code, by: actor.id }]) });
}

// Human-only approval of an exact preflight report.
function approvePreflight(state, actor, preflight) {
  if (!isHuman(actor)) throw new GateError('APPROVAL_REQUIRES_HUMAN');
  if (state.stage !== 'preflight') throw new GateError('APPROVAL_ONLY_IN_PREFLIGHT');
  if (!preflight || !preflight.sha256) throw new GateError('PREFLIGHT_REPORT_REQUIRED');
  const open = (preflight.controls || []).filter((c) => c.status !== 'PASS' && !state.waivers[c.code]);
  if (open.length) throw new GateError('CONTROLS_NOT_PASSING', `not passing and not waived: ${open.map((c) => c.code).join(', ')}`);
  return Object.freeze({ ...state, approval: Object.freeze({ by: actor.id, preflight_sha256: preflight.sha256, at: new Date().toISOString() }), events: Object.freeze([...state.events, { type: 'preflight_approved', by: actor.id, preflight_sha256: preflight.sha256 }]) });
}

// Human-only, one step at a time, current stage must be complete.
function advance(state, actor, to) {
  if (!isHuman(actor)) throw new GateError('ADVANCE_REQUIRES_HUMAN', 'only a human may move a batch to another stage');
  const i = STAGES.indexOf(state.stage);
  if (STAGES[i + 1] !== to) throw new GateError('STAGE_SKIP_REFUSED', `from ${state.stage} the only next stage is ${STAGES[i + 1]}`);
  const done = state.stage_results[state.stage];
  if (!done) throw new GateError('CURRENT_STAGE_NOT_COMPLETE');
  if (done.status !== 'PASS') {
    // FAIL / BLOCKED stays put unless a human waived every non-passing control by code.
    const open = (done.open_controls || []).filter((c) => !state.waivers[c]);
    if (!done.open_controls || open.length) throw new GateError('CURRENT_STAGE_NOT_PASSING', `stage ${state.stage} is ${done.status}; not waived: ${(open.length ? open : ['(stage result)']).join(', ')}`);
  }
  if (to === 'execute') {
    if (!state.approval) throw new GateError('EXECUTE_REQUIRES_APPROVAL');
    const pf = state.stage_results.preflight;
    if (!pf || pf.preflight_sha256 !== state.approval.preflight_sha256) throw new GateError('APPROVAL_DOES_NOT_MATCH_PREFLIGHT');
  }
  return Object.freeze({ ...state, stage: to, write_lock: to !== 'execute', events: Object.freeze([...state.events, { type: 'stage_advanced', from: state.stage, to, by: actor.id }]) });
}

module.exports = { STAGES, PERMITTED, GateError, newBatchState, assertPermitted, permittedActions, completeStage, waiveControl, approvePreflight, advance };
