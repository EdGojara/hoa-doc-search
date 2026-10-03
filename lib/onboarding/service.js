// ============================================================================
// lib/onboarding/service.js  (Issue #15 Milestone 2) — persisted onboarding workflow
// ----------------------------------------------------------------------------
// The ONE application path for persisted onboarding batches. Every read and
// write goes through the migration-482 SQL functions (rpc allowlist below);
// nothing here, and nothing else in the app, writes the onboarding tables
// directly. Each write lands on the migration-481 triggers, so the database
// re-proves every gate whatever this layer believes.
//
// Identity: `actor` is built by the SERVER from the authenticated user
// ({ kind: 'human', id, email, role: 'owner' | 'admin' }) or by server code for
// an agent ({ kind: 'agent', id, assigned_stage }). It is never taken from a
// request body. Waivers, advances and approvals need kind 'human' AND role
// 'owner' here, and kind 'human' again in the database.
//
// Artifact bytes are stored write-once by content hash and re-hashed on every
// read (verifyArtifact); a changed byte refuses the stage.
//
// Not here by design (later milestones): snapshot writes, activity bridge,
// EXECUTE behavior, post-proof. Advancing into execute is refused (482).
// ============================================================================
const S = require('./stages');
const E = require('./engine');
const { sha256, verifyArtifact } = require('./artifacts');
const { summarize } = require('./controls');
const PF = require('./preflight');

const RPC = Object.freeze(['onboarding_batches', 'onboarding_batch_view', 'onboarding_create_batch', 'onboarding_register_artifact',
  'onboarding_record_completion', 'onboarding_waive', 'onboarding_approve', 'onboarding_advance']);
const RUNNABLE = Object.freeze(['intake', 'normalize', 'source_controls']);
const NEEDED_MIGRATIONS = Object.freeze(['481_onboarding_engine.sql', '482_onboarding_service.sql']);
const STORAGE_PREFIX = 'onboarding';

class ServiceError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}

const isOwnerHuman = (a) => a && a.kind === 'human' && a.id && a.role === 'owner';
const isStaffHuman = (a) => a && a.kind === 'human' && a.id && (a.role === 'owner' || a.role === 'admin');
const MISSING_SCHEMA = /could not find the function|function .* does not exist|relation .* does not exist|PGRST202|42883|42P01/i;

function createOnboardingService({ rpc, storage }) {
  if (typeof rpc !== 'function' || !storage) throw new Error('onboarding service needs rpc and storage');
  const call = async (name, args) => {
    if (!RPC.includes(name)) throw new Error(`onboarding rpc not allowed: ${name}`);
    try { return await rpc(name, args); }
    catch (e) {
      if (MISSING_SCHEMA.test(`${e.code || ''} ${e.message || ''}`)) throw new ServiceError(503, 'SCHEMA_NOT_APPLIED', `onboarding schema not applied (needs ${NEEDED_MIGRATIONS.join(', ')})`);
      // Database gate refusals (check_violation / unique) are expected outcomes, surfaced verbatim.
      if (/23514|23505|check_violation|unique/i.test(`${e.code || ''}`) || /^onboarding|stage|waiv|advance|approv|preflight|append-only|human|completion/i.test(e.message || '')) throw new ServiceError(409, 'REFUSED_BY_DATABASE', e.message);
      throw e;
    }
  };

  async function schemaStatus() {
    try { await rpc('onboarding_batches', { p_community: null }); return { ready: true, needs: [] }; }
    catch (e) { if (MISSING_SCHEMA.test(`${e.code || ''} ${e.message || ''}`)) return { ready: false, needs: [...NEEDED_MIGRATIONS] }; throw e; }
  }

  const listBatches = (communityId = null) => call('onboarding_batches', { p_community: communityId });

  async function rawView(batchId) {
    const v = await call('onboarding_batch_view', { p_batch: batchId });
    if (!v) throw new ServiceError(404, 'NO_SUCH_BATCH');
    return v;
  }

  // What the viewer may do now, and the explicit human action the batch is waiting for.
  function derive(view, actor) {
    const stage = view.batch.stage; const cur = view.current;
    const i = S.STAGES.indexOf(stage); const next = S.STAGES[i + 1] || null;
    const runnable = RUNNABLE.includes(stage);
    const waived = new Set(((cur && cur.waivers) || []).map((w) => w.code));
    const unwaived = cur ? (cur.open_controls || []).filter((c) => !waived.has(c)) : [];
    const eligible = !!cur && !cur.gate;
    const actions = [];
    if (runnable && isStaffHuman(actor)) actions.push({ action: 'run_stage', stage });
    if (stage === 'intake' && isStaffHuman(actor)) actions.push({ action: 'register_artifact' });
    if (cur && isOwnerHuman(actor)) for (const code of unwaived) actions.push({ action: 'waive', code, completion_id: cur.completion_id });
    if (eligible && next && next !== 'execute' && isOwnerHuman(actor)) actions.push({ action: 'advance', to: next, completion_id: cur.completion_id });
    let required;
    if (!runnable && !cur) required = { who: 'nobody yet', text: `Stage "${stage}" has no runner yet (later milestone). Nothing can be recorded for it.` };
    else if (!cur) required = { who: 'staff', text: `Run the ${stage.replace('_', ' ')} stage.` };
    else if (unwaived.length) required = { who: 'owner', text: `Stage is ${cur.status}. Fix the source and re-run, or waive each open control with a reason: ${unwaived.join(', ')}.` };
    else if (next === 'execute') required = { who: 'nobody yet', text: 'EXECUTE is not available in this milestone.' };
    else if (next) required = { who: 'owner', text: `Stage is ${cur.status === 'PASS' ? 'PASS' : `${cur.status}, eligible WITH WAIVER`}. A human may advance to ${next}.` };
    else required = { who: 'nobody', text: 'Batch complete.' };
    const summary = cur ? summarize((cur.controls || []).map((c) => ({ ...c, disposition: c.disposition || undefined }))) : null;
    return { stage, next_stage: next, write_locked: view.batch.write_locked, runner_available: runnable, eligibility: summary ? summary.eligibility : null, summary, unwaived_open_controls: unwaived, permitted_actions: actions, required_action: required };
  }

  async function getBatch(batchId, actor) { const view = await rawView(batchId); return { ...view, derived: derive(view, actor) }; }

  async function createBatch(actor, { community_id, batch_code, as_of_date, source_system }) {
    if (!isStaffHuman(actor)) throw new ServiceError(403, 'STAFF_ONLY');
    const id = await call('onboarding_create_batch', { p_community: community_id, p_batch_code: batch_code, p_as_of: as_of_date, p_source_system: source_system, p_actor_kind: 'human', p_actor_id: actor.id });
    return id;
  }

  async function registerArtifact(actor, batchId, { buffer, filename, artifact_type, derived_from_sha256 = null, period_start = null, period_end = null, cutoff_date = null, version_label = null }) {
    if (!(actor && (isStaffHuman(actor) || actor.kind === 'agent'))) throw new ServiceError(403, 'STAFF_ONLY');
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new ServiceError(400, 'FILE_REQUIRED');
    if (!filename || !artifact_type) throw new ServiceError(400, 'FILENAME_AND_TYPE_REQUIRED');
    const view = await rawView(batchId);
    if (view.batch.stage !== 'intake') throw new ServiceError(409, 'NOT_IN_INTAKE', 'artifacts can only be registered while the batch is in intake');
    const hash = sha256(buffer);
    const storage_path = `${STORAGE_PREFIX}/${batchId}/${hash}`;
    await storage.putOnce(storage_path, buffer);             // write-once by content hash
    return call('onboarding_register_artifact', { p_batch: batchId, p_artifact: { artifact_type, filename, sha256: hash, bytes: buffer.length, storage_path, derived_from_sha256, period_start, period_end, cutoff_date, version_label }, p_actor_kind: actor.kind, p_actor_id: actor.id });
  }

  // Load every artifact's bytes and re-hash against the record.
  async function loadArtifacts(view) {
    const out = []; const hashFailures = [];
    for (const a of view.artifacts) {
      const record = { ...a, bytes: Number(a.bytes) };
      let buf = null;
      try { buf = await storage.get(a.storage_path); verifyArtifact(record, buf); out.push({ artifact: record, buffer: buf }); }
      catch (e) { hashFailures.push({ filename: a.filename, sha256: a.sha256, error: e.code || e.message }); }
    }
    return { inputs: out, hashFailures };
  }

  const serialize = (controls) => controls.map((c) => ({
    code: c.code, label: c.label, level: c.level || null, status: c.status,
    left_label: c.left_label || null, right_label: c.right_label || null,
    left_cents: c.left_cents ?? null, right_cents: c.right_cents ?? null, difference_cents: c.difference_cents ?? null,
    tolerance_cents: c.tolerance_cents || 0, tolerance_reason: c.tolerance_reason || null,
    failures: c.failures ? { count: c.failures.length, items: c.failures.slice(0, 200) } : null,
    reason: c.reason || null, needs: c.needs || null,
  }));

  // Run the CURRENT stage (0-2 only) and record its result through the guarded path.
  async function runStage(actor, batchId, config = {}) {
    const view = await rawView(batchId);
    const stage = view.batch.stage;
    if (!RUNNABLE.includes(stage)) throw new ServiceError(409, 'NO_RUNNER_FOR_STAGE', `stage ${stage} has no runner in this milestone`);
    if (!(actor && (isStaffHuman(actor) || actor.kind === 'agent'))) throw new ServiceError(403, 'STAFF_ONLY');
    // Same permission rule as the in-memory engine (an agent only in its assigned stage).
    S.assertPermitted({ stage }, actor, stage === 'intake' ? 'register_artifact' : stage === 'normalize' ? 'run_adapter' : 'run_source_controls');
    const { inputs, hashFailures } = await loadArtifacts(view);
    let controls; let summaryExtra = {};
    if (stage === 'intake') {
      controls = E.intakeControls(view.artifacts, { hashFailures });
    } else {
      if (hashFailures.length) controls = [require('./controls').holds('artifacts.match_recorded_hashes', { label: 'Every artifact re-hashes to its recorded sha256', failures: hashFailures })];
      else {
        const n = E.normalize(view.batch.source_system, inputs);
        summaryExtra = { adapter: n.adapter, normalization: n.normalization };
        if (stage === 'normalize') controls = n.extraction;
        else {
          const roles = config.roles || {};
          const spec = config.authoritative || {};
          controls = E.sourceControlsFor(view.batch.source_system, n.parsed, { roles, expected: E.expectedFromSpec(spec) });
          summaryExtra = { ...summaryExtra, roles, authoritative: spec };
        }
      }
    }
    const sum = summarize(controls);
    const completionId = await call('onboarding_record_completion', {
      p_batch: batchId, p_stage: stage, p_status: sum.overall, p_open: E.openCodes(controls), p_controls: serialize(controls),
      p_summary: { counts: sum.counts, artifacts: view.artifacts.map((a) => ({ filename: a.filename, sha256: a.sha256 })), ...summaryExtra },
      p_actor_kind: actor.kind, p_actor_id: actor.id,
    });
    return { completion_id: completionId, status: sum.overall, counts: sum.counts };
  }

  async function waive(actor, batchId, { completion_id, code, reason }) {
    if (!isOwnerHuman(actor)) throw new ServiceError(403, 'OWNER_ONLY', 'only the owner may waive a control');
    if (!completion_id || !code) throw new ServiceError(400, 'COMPLETION_AND_CODE_REQUIRED');
    if (!reason || String(reason).trim().length < 10) throw new ServiceError(400, 'WAIVER_REASON_REQUIRED', 'a waiver needs a reason of at least 10 characters');
    return call('onboarding_waive', { p_batch: batchId, p_completion: completion_id, p_code: code, p_reason: String(reason).trim(), p_actor_kind: 'human', p_actor_id: actor.id });
  }

  async function advance(actor, batchId, { completion_id, to }) {
    if (!isOwnerHuman(actor)) throw new ServiceError(403, 'OWNER_ONLY', 'only the owner may advance a batch');
    if (!completion_id || !to) throw new ServiceError(400, 'COMPLETION_AND_TARGET_REQUIRED');
    return call('onboarding_advance', { p_batch: batchId, p_completion: completion_id, p_to: to, p_actor_kind: 'human', p_actor_id: actor.id });
  }

  // Approval of an exact preflight report for the current preflight result. The
  // report must verify, be for this batch, and carry dispositions that match the
  // recorded waivers exactly (same rule as stages.approvePreflight).
  async function approve(actor, batchId, { completion_id, preflight }) {
    if (!isOwnerHuman(actor)) throw new ServiceError(403, 'OWNER_ONLY', 'only the owner may approve a preflight');
    const view = await rawView(batchId);
    if (!preflight || !PF.verifyPreflight(preflight)) throw new ServiceError(400, 'PREFLIGHT_REPORT_ALTERED');
    if (!preflight.batch || preflight.batch.batch_code !== view.batch.batch_code) throw new ServiceError(400, 'PREFLIGHT_FOR_ANOTHER_BATCH');
    const cur = view.current;
    if (!cur || cur.completion_id !== completion_id) throw new ServiceError(409, 'NOT_THE_CURRENT_PREFLIGHT_RESULT');
    const recorded = cur.waivers || [];
    for (const c of preflight.controls || []) {
      if (c.status === 'PASS') { if (c.disposition) throw new ServiceError(409, 'CONTROLS_NOT_PASSING', `${c.code}: PASS control carries a disposition`); continue; }
      const d = c.disposition; const w = recorded.find((x) => x.code === c.code);
      if (!d || d.disposition !== 'WAIVED' || !w || w.by !== d.waived_by || w.reason !== d.reason) throw new ServiceError(409, 'CONTROLS_NOT_PASSING', `${c.code}: not waived for the current preflight result`);
    }
    return call('onboarding_approve', { p_batch: batchId, p_completion: completion_id, p_preflight_sha256: preflight.sha256, p_actor_kind: 'human', p_actor_id: actor.id });
  }

  return { schemaStatus, listBatches, getBatch, createBatch, registerArtifact, runStage, waive, advance, approve, derive, RUNNABLE, NEEDED_MIGRATIONS };
}

// Production wiring: supabase rpc + a write-once storage area in the private documents bucket.
function supabaseBackends(supabase, bucket = 'documents') {
  const rpc = async (name, args) => {
    const { data, error } = await supabase.rpc(name, args);
    if (error) { const e = new Error(error.message); e.code = error.code; e.details = error.details; throw e; }
    return data;
  };
  const storage = {
    async putOnce(path, buffer) {
      const { error } = await supabase.storage.from(bucket).upload(path, buffer, { contentType: 'application/octet-stream', upsert: false });
      if (error && !/exists|duplicate/i.test(error.message || '')) throw new Error(`artifact upload failed: ${error.message}`);
      // If it already existed it was stored under its own content hash; get() re-verifies the bytes.
    },
    async get(path) {
      const { data, error } = await supabase.storage.from(bucket).download(path);
      if (error) throw new Error(`artifact download failed: ${error.message}`);
      return Buffer.from(await data.arrayBuffer());
    },
  };
  return { rpc, storage };
}

module.exports = { createOnboardingService, supabaseBackends, ServiceError, RPC, RUNNABLE, NEEDED_MIGRATIONS };
