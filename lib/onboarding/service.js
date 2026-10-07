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
// Snapshot (stage 3) is recorded as proposed lines only; the activity bridge
// (stage 4) only READS Trusted (read-only client) and records classifications.
// EXECUTE (M6, migration 488) is ONE database call, owner only, bound to the exact
// approved preflight hash; the writes come from the recorded preflight result,
// never from this layer. Advancing into execute any other way is refused (482).
// Not here by design (M7): post-proof.
// ============================================================================
const S = require('./stages');
const E = require('./engine');
const { sha256, verifyArtifact } = require('./artifacts');
const { summarize } = require('./controls');
const PF = require('./preflight');
const { buildSnapshot } = require('./snapshot');
const { buildBridge, trustedFingerprint, BRIDGE_VERSION } = require('./bridge');
const { buildConversionPlan } = require('./conversion_plan');

const RPC = Object.freeze(['onboarding_batches', 'onboarding_batch_view', 'onboarding_create_batch', 'onboarding_register_artifact',
  'onboarding_record_completion', 'onboarding_waive', 'onboarding_approve', 'onboarding_advance', 'onboarding_record_snapshot', 'onboarding_snapshot_view', 'onboarding_record_bridge', 'onboarding_bridge_view', 'onboarding_auto_advance',
  'onboarding_record_bridge_decisions', 'onboarding_bridge_decisions_view', 'onboarding_execute', 'onboarding_record_execution_failure', 'onboarding_execution_view',
  'onboarding_register_evidence', 'onboarding_evidence_view']);
const RUNNABLE = Object.freeze(['intake', 'normalize', 'source_controls', 'snapshot', 'activity_bridge', 'preflight', 'post_proof']);
const NEEDED_MIGRATIONS = Object.freeze(['481_onboarding_engine.sql', '482_onboarding_service.sql']);
const SNAPSHOT_MIGRATION = '483_onboarding_snapshot.sql';
const SNAPSHOT_RPCS = ['onboarding_record_snapshot', 'onboarding_snapshot_view'];
const BRIDGE_MIGRATION = '484_onboarding_activity_bridge.sql';
const BRIDGE_RPCS = ['onboarding_record_bridge', 'onboarding_bridge_view'];
const DECISIONS_MIGRATION = '486_onboarding_bridge_decisions.sql';
const DECISION_RPCS = ['onboarding_record_bridge_decisions', 'onboarding_bridge_decisions_view'];
const EXECUTE_MIGRATION = '488_onboarding_execute.sql';
const EXECUTE_RPCS = ['onboarding_execute', 'onboarding_record_execution_failure', 'onboarding_execution_view'];
const STORAGE_PREFIX = 'onboarding';

class ServiceError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}

const isOwnerHuman = (a) => a && a.kind === 'human' && a.id && a.role === 'owner';
const isStaffHuman = (a) => a && a.kind === 'human' && a.id && (a.role === 'owner' || a.role === 'admin');
const MISSING_SCHEMA = /could not find the function|function .* does not exist|relation .* does not exist|PGRST202|42883|42P01/i;

function createOnboardingService({ rpc, storage, trustedReader = null, conversionContext = null, postProofReader = null }) {
  if (typeof rpc !== 'function' || !storage) throw new Error('onboarding service needs rpc and storage');
  const call = async (name, args) => {
    if (!RPC.includes(name)) throw new Error(`onboarding rpc not allowed: ${name}`);
    try { return await rpc(name, args); }
    catch (e) {
      if (MISSING_SCHEMA.test(`${e.code || ''} ${e.message || ''}`)) throw new ServiceError(503, 'SCHEMA_NOT_APPLIED', `onboarding schema not applied (needs ${EXECUTE_RPCS.includes(name) ? EXECUTE_MIGRATION : DECISION_RPCS.includes(name) ? DECISIONS_MIGRATION : BRIDGE_RPCS.includes(name) ? BRIDGE_MIGRATION : SNAPSHOT_RPCS.includes(name) ? SNAPSHOT_MIGRATION : NEEDED_MIGRATIONS.join(', ')})`);
      // Database gate refusals (check_violation / unique) are expected outcomes, surfaced verbatim.
      if (/23514|23505|check_violation|unique/i.test(`${e.code || ''}`) || /^onboarding|stage|waiv|advance|approv|preflight|append-only|human|completion|decision|choice|execute/i.test(e.message || '')) throw new ServiceError(409, 'REFUSED_BY_DATABASE', e.message);
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
    if (stage === 'complete') required = { who: 'nobody', text: 'Batch complete: executed, post-proof PASS, write-locked.' };
    else if (!runnable && !cur) required = { who: 'nobody yet', text: `Stage "${stage}" has no runner yet (later milestone). Nothing can be recorded for it.` };
    else if (!cur) required = { who: 'staff', text: `Run the ${stage.replace('_', ' ')} stage.` };
    else if (unwaived.length) required = { who: 'owner', text: `Stage is ${cur.status}. Fix the source and re-run, or waive each open control with a reason: ${unwaived.join(', ')}.` };
    else if (next === 'execute') required = { who: 'nobody yet', text: 'EXECUTE is not available in this milestone.' };
    else if (next) required = { who: 'owner', text: `Stage is ${cur.status === 'PASS' ? 'PASS' : `${cur.status}, eligible WITH WAIVER`}. A human may advance to ${next}.` };
    else required = { who: 'nobody', text: 'Batch complete.' };
    const summary = cur ? summarize((cur.controls || []).map((c) => ({ ...c, disposition: c.disposition || undefined }))) : null;
    return { stage, next_stage: next, write_locked: view.batch.write_locked, runner_available: runnable, eligibility: summary ? summary.eligibility : null, summary, unwaived_open_controls: unwaived, permitted_actions: actions, required_action: required };
  }

  async function getBatch(batchId, actor) {
    const view = await rawView(batchId);
    view.bridge_decisions = await listDecisions(batchId);
    const bridgeSummary = (view.latest_by_stage && view.latest_by_stage.activity_bridge && view.latest_by_stage.activity_bridge.summary) || {};
    return { ...view, viewer_is_owner: !!isOwnerHuman(actor), derived: derive(view, actor), operator: { asks: await operatorAsks(view), metrics: operatorMetrics(view), package: packageStatus(view),
      decisions: view.bridge_decisions, source_notes: bridgeSummary.source_notes || [] } };
  }

  // Owner decisions on bridge questions (486). Before 486 is applied there are none.
  async function listDecisions(batchId) {
    try { return (await call('onboarding_bridge_decisions_view', { p_batch: batchId })) || []; }
    catch (e) { if (e.code === 'SCHEMA_NOT_APPLIED') return []; throw e; }
  }
  // Record the owner's answers as DECISIONS (never as waivers), then let the operator
  // continue: the bridge is recomputed with the decisions and, if nothing else is open,
  // passes. The operator never advances into execute.
  async function decide(actor, batchId, { completion_id, decisions } = {}) {
    if (!isOwnerHuman(actor)) throw new ServiceError(403, 'OWNER_ONLY', 'only the owner records a bridge decision');
    if (!completion_id) throw new ServiceError(400, 'COMPLETION_REQUIRED');
    if (!Array.isArray(decisions) || !decisions.length || decisions.some((d) => !d || typeof d.event_key !== 'string' || typeof d.choice !== 'string')) throw new ServiceError(400, 'DECISIONS_REQUIRED', 'each decision needs an event_key and a choice');
    const clean = decisions.map((d) => ({ event_key: d.event_key, choice: d.choice, ...(d.reason ? { reason: String(d.reason).slice(0, 2000) } : {}) }));
    return call('onboarding_record_bridge_decisions', { p_batch: batchId, p_completion: completion_id, p_decisions: clean, p_actor_kind: 'human', p_actor_id: actor.id });
  }

  async function createBatch(actor, { community_id, batch_code, as_of_date, source_system }) {
    if (!isStaffHuman(actor)) throw new ServiceError(403, 'STAFF_ONLY');
    const id = await call('onboarding_create_batch', { p_community: community_id, p_batch_code: batch_code, p_as_of: as_of_date, p_source_system: source_system, p_actor_kind: 'human', p_actor_id: actor.id });
    return id;
  }

  async function registerArtifact(actor, batchId, { buffer, filename, artifact_type, derived_from_sha256 = null, period_start = null, period_end = null, cutoff_date = null, version_label = null }) {
    if (!(actor && (isStaffHuman(actor) || actor.kind === 'agent' || actor.kind === 'system'))) throw new ServiceError(403, 'STAFF_ONLY');
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new ServiceError(400, 'FILE_REQUIRED');
    if (!filename || !artifact_type) throw new ServiceError(400, 'FILENAME_AND_TYPE_REQUIRED');
    const view = await rawView(batchId);
    if (view.batch.stage !== 'intake') throw new ServiceError(409, 'NOT_IN_INTAKE', 'artifacts can only be registered while the batch is in intake');
    const hash = sha256(buffer);
    const storage_path = `${STORAGE_PREFIX}/${batchId}/${hash}`;
    await storage.putOnce(storage_path, buffer);             // write-once by content hash
    return call('onboarding_register_artifact', { p_batch: batchId, p_artifact: { artifact_type, filename, sha256: hash, bytes: buffer.length, storage_path, derived_from_sha256, period_start, period_end, cutoff_date, version_label }, p_actor_kind: actor.kind, p_actor_id: actor.id });
  }

  // EVIDENCE-ONLY documents (migration 495, Ed 2026-10-07): attachable at any stage before
  // execution, write-once by content hash, with a stated purpose. They never replace or feed
  // the source reports: normalization and source controls never read them, nothing is rerun,
  // and the cutoff is untouched. The snapshot accepts their fingerprints as citable evidence.
  async function attachEvidence(actor, batchId, { buffer, filename, purpose }) {
    if (!(actor && (isStaffHuman(actor) || actor.kind === 'agent' || actor.kind === 'system'))) throw new ServiceError(403, 'STAFF_ONLY');
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new ServiceError(400, 'FILE_REQUIRED');
    if (!filename) throw new ServiceError(400, 'FILENAME_REQUIRED');
    if (!purpose || String(purpose).trim().length < 10) throw new ServiceError(400, 'PURPOSE_REQUIRED', 'say what the document evidences (at least 10 characters)');
    const hash = sha256(buffer);
    const storage_path = `${STORAGE_PREFIX}/${batchId}/evidence/${hash}`;
    await storage.putOnce(storage_path, buffer);             // write-once by content hash
    return call('onboarding_register_evidence', { p_batch: batchId, p_evidence: { filename, sha256: hash, bytes: buffer.length, storage_path, purpose: String(purpose).trim() }, p_actor_kind: actor.kind, p_actor_id: actor.id });
  }
  async function listEvidence(batchId) {
    try { return (await call('onboarding_evidence_view', { p_batch: batchId })) || []; }
    catch (e) { if (/onboarding_evidence|does not exist|schema cache|PGRST20[2-5]/i.test(`${e.message} ${e.code || ''}`)) return []; throw e; }
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

  // Run the CURRENT stage (0-3) and record its result through the guarded path.
  async function runStage(actor, batchId, config = {}) {
    const view = await rawView(batchId);
    const stage = view.batch.stage;
    if (!RUNNABLE.includes(stage)) throw new ServiceError(409, 'NO_RUNNER_FOR_STAGE', `stage ${stage} has no runner in this milestone`);
    if (!(actor && (isStaffHuman(actor) || actor.kind === 'agent' || actor.kind === 'system'))) throw new ServiceError(403, 'STAFF_ONLY');
    // Same permission rule as the in-memory engine (an agent only in its assigned stage).
    S.assertPermitted({ stage }, actor, { intake: 'register_artifact', normalize: 'run_adapter', source_controls: 'run_source_controls', snapshot: 'build_snapshot', activity_bridge: 'compare_activity', preflight: 'build_preflight', post_proof: 'run_post_proof' }[stage]);
    if (stage === 'snapshot') return runSnapshot(actor, view, config);
    if (stage === 'activity_bridge') return runBridge(actor, view);
    if (stage === 'preflight') return runPreflight(actor, view);
    if (stage === 'post_proof') return runPostProof(actor, view);
    const { inputs, hashFailures } = await loadArtifacts(view);
    let controls; let summaryExtra = {};
    if (stage === 'intake') {
      controls = E.intakeControls(view.artifacts, { hashFailures });
      // Which supporting reports does this GL need, and is every original recognized?
      if (!hashFailures.length) {
        const req = sourceRequirements(view, E.normalize(view.batch.source_system, inputs).parsed);
        controls.push(req.missing.length
          ? Object.freeze({ ...require('./controls').holds('intake.required_sources_present', { label: 'Every supporting report the source needs is present', failures: req.missing.map((m) => ({ type: m.type, report: m.report, why: m.why })) }), status: 'BLOCKED', needs: req.missing.map((m) => m.report) })
          : require('./controls').holds('intake.required_sources_present', { label: 'Every supporting report the source needs is present', failures: [] }));
        controls.push(req.unrecognized.length
          ? Object.freeze({ ...require('./controls').holds('intake.originals_recognized', { label: 'Every uploaded original is a recognized report', failures: req.unrecognized.map((filename) => ({ filename })) }), status: 'BLOCKED', needs: ['known report format'] })
          : require('./controls').holds('intake.originals_recognized', { label: 'Every uploaded original is a recognized report', failures: [] }));
        const adapter = require('./adapters').get(view.batch.source_system);
        if (adapter.reportDates) {
          const cutoff = String(view.batch.as_of_date).slice(0, 10);
          const entry = (t) => (adapter.PACKAGE || []).find((e) => e.type === t);
          const off = adapter.reportDates(E.normalize(view.batch.source_system, inputs).parsed).filter((d) => d.as_of !== cutoff);
          controls.push(off.length
            ? Object.freeze({ ...require('./controls').holds('intake.reports_match_cutoff', { label: `Every recognized report is dated at the cutoff ${cutoff}`, failures: off.map((d) => ({ type: d.type, as_of: d.as_of, report: entry(d.type) ? adapter.reportLabel(entry(d.type), cutoff) : d.type, why: `the uploaded one is dated ${d.as_of}` })) }), status: 'BLOCKED', needs: off.map((d) => (entry(d.type) ? adapter.reportLabel(entry(d.type), cutoff) : d.type)) })
            : require('./controls').holds('intake.reports_match_cutoff', { label: `Every recognized report is dated at the cutoff ${cutoff}`, failures: [] }));
        }
        summaryExtra = { roles: req.roles, required_sources: req.required };
      }
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

  // Stage 3: the proposed opening position at the cutoff, from the validated source.
  // Roles (AR / prepaid accounts) are the ones the source-controls stage was run and
  // validated with; only the AP account and an optional fund map may be added here.
  async function runSnapshot(actor, view, config) {
    const sc = view.latest_by_stage && view.latest_by_stage.source_controls;
    const srcRoles = sc && sc.summary && sc.summary.roles;
    if (!srcRoles || !srcRoles.ar_account) throw new ServiceError(409, 'SOURCE_CONTROL_ROLES_MISSING', 'the snapshot uses the roles the source-controls stage was validated with; none are recorded');
    const roles = { ...srcRoles, ap_account: config.ap_account || srcRoles.ap_account || undefined };
    // Opening reclassifications are an accounting decision: the owner only.
    const openingReclasses = Array.isArray(config.opening_reclasses) ? config.opening_reclasses : [];
    const openingCorrections = Array.isArray(config.opening_corrections) ? config.opening_corrections : [];
    if ((openingReclasses.length || openingCorrections.length) && !(actor && actor.role === 'owner')) throw new ServiceError(403, 'OWNER_ONLY', 'opening reclassifications and corrections are an owner decision');
    const { inputs, hashFailures } = await loadArtifacts(view);
    let snap; let controls; let summaryExtra = {};
    if (hashFailures.length) {
      controls = [require('./controls').holds('artifacts.match_recorded_hashes', { label: 'Every artifact re-hashes to its recorded sha256', failures: hashFailures })];
      snap = { lines: [], components: [], sha256: sha256(Buffer.from('no-snapshot:' + view.batch.id)) };
    } else {
      const n = E.normalize(view.batch.source_system, inputs);
      snap = buildSnapshot(n.parsed, { batch_code: view.batch.batch_code, cutoff_date: String(view.batch.as_of_date).slice(0, 10), roles, fund_by_account: config.fund_by_account || {},
        opening_reclasses: openingReclasses, opening_corrections: openingCorrections,
        // Citable: the source reports AND the evidence-only documents attached to the batch (migration 495).
        artifact_shas: [...view.artifacts.map((a) => a.sha256), ...(await listEvidence(view.batch.id)).map((e) => e.sha256)] });
      controls = snap.controls; summaryExtra = { adapter: n.adapter, components: snap.components, ...(openingReclasses.length ? { opening_reclasses: openingReclasses } : {}), ...(openingCorrections.length ? { opening_corrections: openingCorrections } : {}) };
    }
    const sum = summarize(controls);
    const lines = snap.lines.map((l) => ({ line_no: l.line_no, kind: l.kind, component: l.component, account_code: l.account_code || null, fund_code: l.fund_code || null,
      source_account_key: l.source_account_key || null, amount_cents: l.amount_cents, provenance: l.provenance, batch_code: l.batch_code, cutoff_date: l.cutoff_date,
      detail: Object.fromEntries(Object.entries({ account_name: l.account_name, reason: l.reason, charge_type: l.charge_type, buckets: l.buckets, source_vendor_key: l.source_vendor_key, invoice_number: l.invoice_number, invoice_date: l.invoice_date, former_owner: l.former_owner, source_ending_cents: l.source_ending_cents, reclassified_cents: l.reclassified_cents, reclass: l.reclass, corrections: l.corrections }).filter(([, v]) => v !== undefined)) }));
    const completionId = await call('onboarding_record_snapshot', {
      p_batch: view.batch.id, p_status: sum.overall, p_open: E.openCodes(controls), p_controls: serialize(controls),
      p_summary: { counts: sum.counts, roles, artifacts: view.artifacts.map((a) => ({ filename: a.filename, sha256: a.sha256 })), ...summaryExtra },
      p_lines: lines, p_snapshot_sha256: snap.sha256, p_actor_kind: actor.kind, p_actor_id: actor.id,
    });
    return { completion_id: completionId, status: sum.overall, counts: sum.counts, snapshot_sha256: snap.sha256, lines: lines.length };
  }

  const getSnapshot = (batchId, completionId = null) => call('onboarding_snapshot_view', { p_batch: batchId, p_completion: completionId });

  // Stage 4: activity bridge. READS Trusted financial activity through the read-only
  // client (trustedReader) and the validated source, classifies every candidate record
  // exactly once, and records the classification. Changes nothing in Trusted.
  async function runBridge(actor, view) {
    if (!trustedReader) throw new ServiceError(503, 'NO_TRUSTED_READER', 'the activity bridge needs the read-only Trusted reader');
    const snapRef = view.latest_by_stage && view.latest_by_stage.snapshot;
    if (!snapRef || !snapRef.completion_id) throw new ServiceError(409, 'NO_SNAPSHOT', 'the bridge is built on the current snapshot result; none is recorded');
    const roles = (snapRef.summary && snapRef.summary.roles) || {};
    const { inputs, hashFailures } = await loadArtifacts(view);
    if (hashFailures.length) throw new ServiceError(409, 'ARTIFACT_HASH_MISMATCH', `artifact bytes no longer match their records: ${hashFailures.map((h) => h.filename).join(', ')}`);
    const n = E.normalize(view.batch.source_system, inputs);
    const loaded = await trustedReader(view.batch.community_id);
    const decisions = await listDecisions(view.batch.id);
    const bridge = buildBridge(n.parsed, loaded.trusted, { decisions, batch_code: view.batch.batch_code, cutoff_date: String(view.batch.as_of_date).slice(0, 10), roles,
      snapshot: { completion_id: snapRef.completion_id, stale: false }, accountOfProperty: loaded.accountOfProperty, accountNumber: loaded.accountNumber, apApplications: loaded.apApplications || [] });
    const sum = summarize(bridge.controls);
    const items = bridge.items.map((it) => ({ item_no: it.item_no, event_key: it.event_key, kind: it.kind, classification: it.classification, method: it.method, confidence: it.confidence,
      event_date: it.event_date, amount_cents: it.amount_cents, evidence: it.evidence, structural_issues: it.structural_issues, records: it.records, batch_code: it.batch_code, cutoff_date: it.cutoff_date }));
    const completionId = await call('onboarding_record_bridge', {
      p_batch: view.batch.id, p_status: sum.overall, p_open: E.openCodes(bridge.controls), p_controls: serialize(bridge.controls),
      p_summary: { counts: sum.counts, roles, totals: bridge.totals, candidate_records: bridge.candidate_records, snapshot_completion_id: snapRef.completion_id, adapter: n.adapter, bridge_engine: bridge.bridge_engine, source_notes: bridge.source_notes, decisions_applied: decisions.length },
      p_items: items, p_bridge_sha256: bridge.sha256, p_trusted_fingerprint: bridge.trusted_fingerprint, p_actor_kind: actor.kind, p_actor_id: actor.id,
    });
    return { completion_id: completionId, status: sum.overall, counts: sum.counts, totals: bridge.totals, bridge_sha256: bridge.sha256, items: items.length };
  }

  const getBridge = (batchId, completionId = null) => call('onboarding_bridge_view', { p_batch: batchId, p_completion: completionId });

  // Stage 5: PREFLIGHT. Builds the exact review package EXECUTE would carry out:
  // inputs bound by id + hash (current snapshot, current PASS bridge, recorded owner
  // decisions, bridge waivers), the line-level write contract, controls, execute
  // preconditions, the post-execute proof plan, rollback and idempotency; canonical
  // JSON + sha256, recorded append-only as the preflight result. READS only (read-only
  // reader + conversion context). Never approves, never advances, never opens the lock.
  async function preflightInputs(view) {
    const snapRef = view.latest_by_stage && view.latest_by_stage.snapshot;
    const bridgeRef = view.latest_by_stage && view.latest_by_stage.activity_bridge;
    const decisions = await listDecisions(view.batch.id);
    const bridgeWaivers = (view.events || []).filter((e) => e.type === 'control_waived' && bridgeRef && e.completion_id === bridgeRef.completion_id).map((e) => ({ code: e.control_code, by: e.actor_id, reason: e.reason, at: e.at }));
    return { snapRef, bridgeRef, decisions, bridgeWaivers };
  }

  async function runPreflight(actor, view) {
    const { snapRef, bridgeRef, decisions, bridgeWaivers } = await preflightInputs(view);
    const record = (controls, summary) => {
      const sum = summarize(controls);
      return call('onboarding_record_completion', { p_batch: view.batch.id, p_stage: 'preflight', p_status: sum.overall, p_open: E.openCodes(controls), p_controls: serialize(controls),
        p_summary: { counts: sum.counts, ...summary }, p_actor_kind: actor.kind, p_actor_id: actor.id }).then((id) => ({ completion_id: id, status: sum.overall, counts: sum.counts, ...summary }));
    };
    const blocked = (code, label, reason) => record([{ ...require('./controls').blocked(code, { label, reason }), level: 'preflight' }], { preflight_report: null, preflight_sha256: null });
    if (!snapRef || !bridgeRef) return blocked('preflight.inputs_present', 'The snapshot and activity-bridge results exist', 'no snapshot or bridge result is recorded');
    if (!trustedReader || !conversionContext) return blocked('preflight.context_available', 'Trusted activity and conversion reference data are readable', 'the read-only Trusted reader / conversion context is not configured');
    const [snapshot, bridge] = await Promise.all([getSnapshot(view.batch.id, snapRef.completion_id), getBridge(view.batch.id, bridgeRef.completion_id)]);
    const { inputs, hashFailures } = await loadArtifacts(view);
    if (hashFailures.length) return blocked('artifacts.match_recorded_hashes', 'Every artifact re-hashes to its recorded sha256', hashFailures.map((h) => h.filename).join(', '));
    const parsed = E.normalize(view.batch.source_system, inputs).parsed;
    const loaded = await trustedReader(view.batch.community_id);
    const ctx = await conversionContext(view.batch.community_id);
    const cutoff = String(view.batch.as_of_date).slice(0, 10);
    const plan = buildConversionPlan({
      batch: { id: view.batch.id, batch_code: view.batch.batch_code, community_id: view.batch.community_id, as_of_date: cutoff },
      snapshot: { completion_id: snapRef.completion_id, sha256: snapshot.snapshot_sha256 || (snapRef.summary && snapRef.summary.snapshot_sha256) || null, roles: (snapRef.summary && snapRef.summary.roles) || {}, lines: snapshot.lines || [] },
      bridge: { completion_id: bridgeRef.completion_id, sha256: bridge.bridge_sha256, trusted_fingerprint: bridge.trusted_fingerprint, status: bridgeRef.status, items: bridge.items || [] },
      decisions, source: { prepaid_rows: (parsed.prepaid_homeowners && parsed.prepaid_homeowners.rows) || [] },
      trusted: loaded.trusted, ctx: { ...ctx, current_trusted_fingerprint: trustedFingerprint(loaded.trusted) },
    });
    const { controls, ...planBody } = plan;
    const base = {
      batch: { batch_code: view.batch.batch_code, community_id: view.batch.community_id, source_system: view.batch.source_system, stage: 'preflight' },
      source_cutoff: { cutoff_date: cutoff, cutover_date: plan.cutover },
      inputs: {
        snapshot: { completion_id: snapRef.completion_id, sha256: snapshot.snapshot_sha256 || null, status: snapRef.status },
        bridge: { completion_id: bridgeRef.completion_id, sha256: bridge.bridge_sha256 || null, trusted_fingerprint: bridge.trusted_fingerprint || null, status: bridgeRef.status, engine: (bridgeRef.summary && bridgeRef.summary.bridge_engine) || null },
        decisions: decisions.map((d) => ({ id: d.id, event_key: d.event_key, decision_type: d.decision_type, choice_key: d.choice_key, actor_id: d.actor_id, decided_at: d.decided_at, bridge_completion_id: d.bridge_completion_id })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
        bridge_waivers: bridgeWaivers,
        artifacts: view.artifacts.map((a) => ({ filename: a.filename, artifact_type: a.artifact_type, sha256: a.sha256 })),
      },
      plan: planBody, controls,
    };
    const report = PF.buildConversionPreflight(base, []);
    return record(controls, { preflight_format: report.format, preflight_sha256: report.sha256, preflight_report: report, plan_summary: plan.summary });
  }

  // Why the recorded preflight no longer describes what EXECUTE would do (null = current).
  async function preflightStaleReason(view, latest) {
    const r = latest && latest.summary && latest.summary.preflight_report;
    if (!r) return 'no preflight report recorded';
    const { snapRef, bridgeRef, decisions } = await preflightInputs(view);
    if (!snapRef || snapRef.completion_id !== r.inputs.snapshot.completion_id) return 'the snapshot result changed';
    if (!bridgeRef || bridgeRef.completion_id !== r.inputs.bridge.completion_id) return 'the activity-bridge result changed';
    if (JSON.stringify(decisions.map((d) => d.id).sort()) !== JSON.stringify(r.inputs.decisions.map((d) => d.id).sort())) return 'owner decisions changed';
    if (r.plan.plan_version !== require('./conversion_plan').PLAN_VERSION) return `preflight rules changed (${r.plan.plan_version} -> ${require('./conversion_plan').PLAN_VERSION})`;
    if (trustedReader) {
      const now = trustedFingerprint((await trustedReader(view.batch.community_id)).trusted);
      if (r.inputs.bridge.trusted_fingerprint && now !== r.inputs.bridge.trusted_fingerprint) return 'Trusted financial activity changed since the preflight';
    }
    return null;
  }

  // The current preflight report (with the current waivers as dispositions) + a readable rendering.
  async function getPreflight(batchId) {
    const view = await rawView(batchId);
    const latest = view.latest_by_stage && view.latest_by_stage.preflight;
    if (!latest || !latest.summary || !latest.summary.preflight_report) return null;
    const waivers = (view.current && view.current.completion_id === latest.completion_id ? view.current.waivers || [] : []).map((w) => ({ code: w.code, by: w.by, reason: w.reason, at: w.at }));
    const report = PF.buildConversionPreflight(PF.preflightBase(latest.summary.preflight_report), waivers);
    const stale = await preflightStaleReason(view, latest);
    return { completion_id: latest.completion_id, status: latest.status, recorded_sha256: latest.summary.preflight_sha256, report, markdown: PF.renderConversionMarkdown(report), stale: stale || null };
  }

  async function bridgeStaleReason(view, latest) {
    const summary = latest.summary || {};
    if (summary.bridge_engine !== BRIDGE_VERSION) return `bridge rules changed (${summary.bridge_engine || 'earlier version'} -> ${BRIDGE_VERSION})`;
    const decisions = await listDecisions(view.batch.id);
    if (decisions.some((d) => String(d.decided_at) > String(latest.at))) return 'owner decisions recorded after this result';
    if (trustedReader) {
      const b = await getBridge(view.batch.id, latest.completion_id);
      const current = trustedFingerprint((await trustedReader(view.batch.community_id)).trusted);
      if (b && b.trusted_fingerprint && current !== b.trusted_fingerprint) return 'Trusted financial activity changed since this result';
    }
    return null;
  }

  // Has Trusted financial activity changed since the bridge was recorded? (stale on source change)
  async function bridgeFreshness(batchId) {
    const b = await getBridge(batchId);
    if (!b) return null;
    if (!trustedReader) return { fresh: null, reason: 'no reader' };
    const view = await rawView(batchId);
    const current = trustedFingerprint((await trustedReader(view.batch.community_id)).trusted);
    return { fresh: current === b.trusted_fingerprint, recorded: b.trusted_fingerprint, current };
  }

  // Stage 7: POST-PROOF. READ-ONLY with respect to the books and community data: it reads the
  // committed execution, the approved preflight report it executed (its proof expectations),
  // the bridge records that preflight bound, and the books after execution, and records ONLY
  // the normal post-proof stage result. Never rebuilds the preflight or bridge, never executes.
  async function runPostProof(actor, view) {
    const record = (controls, summary) => {
      const sum = summarize(controls);
      return call('onboarding_record_completion', { p_batch: view.batch.id, p_stage: 'post_proof', p_status: sum.overall, p_open: E.openCodes(controls), p_controls: serialize(controls),
        p_summary: { counts: sum.counts, ...summary }, p_actor_kind: actor.kind, p_actor_id: actor.id }).then((id) => ({ completion_id: id, status: sum.overall, counts: sum.counts, ...summary }));
    };
    const blocked = (code, label, reason) => record([{ ...require('./controls').blocked(code, { label, reason }), level: 'post_proof' }], {});
    if (!postProofReader) return blocked('post_proof.reader_available', 'The books after execution are readable', 'the read-only post-proof reader is not configured');
    const executions = (await getExecution(view.batch.id)) || [];
    const ex = executions.find((x) => x.status === 'committed');
    if (!ex) return blocked('post_proof.execution_committed', 'A committed execution exists', 'no committed execution for this batch');
    const pfEvent = (view.events || []).find((e) => e.id === ex.preflight_completion_id);
    const pfLatest = view.latest_by_stage && view.latest_by_stage.preflight;
    const report = pfLatest && pfLatest.completion_id === ex.preflight_completion_id ? pfLatest.summary && pfLatest.summary.preflight_report : null;
    if (!pfEvent || !report || !PF.verifyPreflight(report)) return blocked('post_proof.approved_report_available', 'The executed preflight report is recorded and verifies', 'the preflight result the execution was bound to is not the recorded current one');
    const bridge = report.inputs && report.inputs.bridge && report.inputs.bridge.completion_id ? await getBridge(view.batch.id, report.inputs.bridge.completion_id) : null;
    const data = await postProofReader(view.batch.community_id, { execution_id: ex.id, ar_uploaded_by: report.plan.writes.ar_opening_batch.uploaded_by });
    const { buildPostProof } = require('./post_proof');
    const proof = buildPostProof({ batch: view.batch, executions, report, preflight_completion_id: ex.preflight_completion_id, bridge_items: (bridge && bridge.items) || [], data });
    return record(proof.controls, { post_proof: proof.summary });
  }

  // ------------------------------------------------------------------ OPERATOR
  // Trusted operates the gated engine itself (Ed, Issue #15): it extracts and
  // recognizes the uploaded originals, runs each stage, continues automatically
  // through routine PASS stages (onboarding_auto_advance; the database refuses it
  // on anything but a plain PASS and never into execute), and STOPS only for a
  // missing source, an unrecognized format, an ambiguity / exception / waiver that
  // needs a human, or a stage with no runner yet. Deterministic: no AI calls.
  const OPERATOR = Object.freeze({ kind: 'system', id: 'onboarding-operator' });
  const isPdf = (a) => /\.pdf$/i.test(a.filename || '') || a.artifact_type === 'original_pdf' || a.artifact_type === 'original';

  // Intake: every original PDF gets a layout-text derivative, recognized by its header.
  async function ingestOriginals(batchId) {
    const view = await rawView(batchId);
    if (view.batch.stage !== 'intake') return { added: [] };
    const adapter = require('./adapters').get(view.batch.source_system);
    const derived = new Set(view.artifacts.filter((a) => a.derived_from_sha256).map((a) => a.derived_from_sha256));
    const added = [];
    for (const a of view.artifacts.filter((x) => isPdf(x) && !derived.has(x.sha256))) {
      const buf = await storage.get(a.storage_path);
      verifyArtifact({ ...a, bytes: Number(a.bytes) }, buf);
      const text = await require('./pdf_layout').pdfToLayoutText(buf);
      const id = adapter.identify ? adapter.identify(text) : (adapter.detect && adapter.detect(text) ? { type: adapter.detect(text) } : null);
      const type = (id && id.type) || 'unrecognized';
      await registerArtifact(OPERATOR, batchId, { buffer: Buffer.from(text, 'utf8'), filename: a.filename.replace(/\.pdf$/i, '') + '.layout.txt', artifact_type: type, derived_from_sha256: a.sha256,
        cutoff_date: (id && id.as_of) || null, period_end: (id && id.as_of) || null, period_start: (id && id.period_start) || null });
      added.push({ from: a.filename, type });
    }
    return { added };
  }

  // Which supporting reports does the source need, and which are present?
  function sourceRequirements(view, parsed) {
    const adapter = require('./adapters').get(view.batch.source_system);
    if (!adapter.requiredSources) return { roles: {}, required: [], missing: [], unrecognized: [] };
    const roles = adapter.inferRoles ? adapter.inferRoles(parsed) : {};
    const cutoff = String(view.batch.as_of_date).slice(0, 10);
    const required = adapter.requiredSources(parsed, roles, cutoff);
    const present = new Set(view.artifacts.map((a) => a.artifact_type));
    const unrecognized = view.artifacts.filter((a) => a.artifact_type === 'unrecognized').map((a) => a.filename);
    return { roles, required, missing: required.filter((r) => !present.has(r.type)), unrecognized };
  }

  async function operate(batchId, { maxSteps = 12 } = {}) {
    const steps = [];
    for (let n = 0; n < maxSteps; n++) {
      let view = await rawView(batchId);
      const stage = view.batch.stage;
      if (stage === 'intake') { const ing = await ingestOriginals(batchId); if (ing.added.length) steps.push({ stage, action: 'recognized', files: ing.added }); view = await rawView(batchId); }
      if (!RUNNABLE.includes(stage)) return { stopped_at: stage, reason: 'no_runner', steps };
      const latest = view.latest_by_stage && view.latest_by_stage[stage];
      // Intake re-runs whenever files were added after its last result; other stages run once.
      const newer = latest && stage === 'intake' && view.artifacts.some((a) => a.received_at > latest.at);
      let completion = latest && !newer ? { completion_id: latest.completion_id, status: latest.status } : null;
      // A bridge result is recomputed when its deterministic inputs changed: another
      // engine version, owner decisions recorded after it, or Trusted activity that no
      // longer matches its fingerprint. Only while the batch is write-locked (always
      // true before execute); the recomputed result goes through the same gates.
      if (completion && stage === 'activity_bridge' && view.batch.write_locked) {
        const why = await bridgeStaleReason(view, latest);
        if (why) { completion = null; steps.push({ stage, action: 'recompute', why }); }
      }
      // A preflight result is rebuilt when it no longer describes what EXECUTE would do
      // (snapshot / bridge / decisions / Trusted activity / plan rules changed). Same
      // write-locked gate; the rebuilt result is a new append-only completion.
      if (completion && stage === 'preflight' && view.batch.write_locked) {
        const why = await preflightStaleReason(view, latest);
        if (why) { completion = null; steps.push({ stage, action: 'rebuild', why }); }
      }
      if (!completion) {
        const config = {};
        if (stage === 'source_controls') {
          const { inputs } = await loadArtifacts(view);
          const req = sourceRequirements(view, E.normalize(view.batch.source_system, inputs).parsed);
          config.roles = req.roles;
        }
        const r = await runStage(OPERATOR, batchId, config);
        completion = { completion_id: r.completion_id, status: r.status };
        steps.push({ stage, action: 'ran', status: r.status });
      }
      if (completion.status !== 'PASS') return { stopped_at: stage, reason: 'needs_human', steps };
      const next = S.STAGES[S.STAGES.indexOf(stage) + 1];
      // execute and complete are owner transitions: the operator stops for the human (the database refuses a system advance into either)
      if (!next || next === 'execute' || next === 'complete') return { stopped_at: stage, reason: 'ready_for_human_authorization', steps };
      await call('onboarding_auto_advance', { p_batch: batchId, p_completion: completion.completion_id, p_actor_id: OPERATOR.id });
      steps.push({ stage, action: 'advanced', to: next });
    }
    return { stopped_at: (await rawView(batchId)).batch.stage, reason: 'step_limit', steps };
  }

  // An open bridge item as one plain question with its factual choices. Items the bridge
  // could not settle from evidence get the generic factual choice.
  function questionFor(it, control, completionId) {
    const d = it.evidence && it.evidence.decision;
    const usd = (c) => '$' + (Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const base = { type: 'decision', control, completion_id: completionId, item_no: it.item_no, event_key: it.event_key, amount_cents: it.amount_cents, event_date: it.event_date };
    if (d) return { ...base, decision_type: d.type || null, question: d.question, context: d.context || [], choices: d.choices, recommended: d.recommended || null };
    return { ...base, question: `${String(it.kind).replace(/_/g, ' ')} of ${usd(it.amount_cents)} dated ${it.event_date ? Number(it.event_date.slice(5, 7)) + "/" + Number(it.event_date.slice(8, 10)) + "/" + it.event_date.slice(0, 4) : "(no date)"}: is it already in the legacy books, or is it real activity Trusted must keep?`,
      context: [it.evidence && it.evidence.note ? it.evidence.note : String(it.method).replace(/_/g, ' ')],
      choices: [{ key: 'already_in_legacy_books', label: 'Already in the legacy books (do not carry it forward)' }, { key: 'keep_as_trusted_activity', label: 'Real activity Trusted must keep' }], recommended: null };
  }

  // What the operator needs from a human right now, in plain words.
  async function operatorAsks(view) {
    const asks = [];
    const cur = view.current;
    if (!cur) return asks;
    for (const c of cur.controls || []) {
      if (c.status === 'PASS' || c.disposition) continue;
      const needs = Array.isArray(c.needs) ? c.needs : [];
      if (c.code === 'intake.required_sources_present' || c.code === 'intake.reports_match_cutoff') for (const f of (c.failures && c.failures.items) || []) asks.push({ type: 'missing_source', report: f.report, why: f.why });
      else if (c.code === 'intake.originals_recognized') for (const f of (c.failures && c.failures.items) || []) asks.push({ type: 'unrecognized_format', file: f.filename });
      else if (c.code === 'bridge.ambiguous_items_reviewed') {
        let items = [];
        try { const b = await getBridge(view.batch.id, cur.completion_id); items = ((b && b.items) || []).filter((it) => it.classification === 'AMBIGUOUS'); }
        catch (e) { console.warn('[onboarding] operatorAsks: bridge read failed', { batch: view.batch.id, error: e.message }); }
        if (!items.length) asks.push({ type: 'ambiguity', control: c.code, text: c.reason });
        const decidedHere = new Set((view.bridge_decisions || []).filter((d) => d.bridge_completion_id === cur.completion_id).map((d) => d.event_key));
        for (const it of items) if (!(it.evidence && it.evidence.decision && it.evidence.decision.recorded) && !decidedHere.has(it.event_key)) asks.push(questionFor(it, c.code, cur.completion_id));
      }
      else if (c.status === 'BLOCKED' && needs.length) asks.push({ type: 'missing_source', control: c.code, needs, text: c.reason || c.label });
      else asks.push({ type: c.status === 'FAIL' ? 'exception' : 'blocked', control: c.code, text: c.label, difference_cents: c.difference_cents ?? null });
    }
    return asks;
  }

  // ------------------------------------------------------------ SOURCE PACKAGE
  // What Trusted expects from the legacy system for a cutoff (pure; provider adapter).
  function sourcePackage(system, cutoff) {
    let adapter; try { adapter = require('./adapters').get(system); } catch (_) { throw new ServiceError(400, 'UNKNOWN_SOURCE_SYSTEM'); }
    if (cutoff && !/^\d{4}-\d{2}-\d{2}$/.test(String(cutoff))) throw new ServiceError(400, 'CUTOFF_MUST_BE_YYYY_MM_DD');
    return adapter.sourcePackage ? adapter.sourcePackage(cutoff || null) : null;
  }
  // Recognize files BEFORE a batch exists: nothing stored, nothing recorded.
  async function recognize(system, cutoff, files) {
    let adapter; try { adapter = require('./adapters').get(system); } catch (_) { throw new ServiceError(400, 'UNKNOWN_SOURCE_SYSTEM'); }
    const out = [];
    for (const f of files || []) {
      const buf = f.buffer || Buffer.alloc(0);
      const isPdfBytes = buf.slice(0, 5).toString('latin1') === '%PDF-';
      let text = null; let note = null;
      if (isPdfBytes) { try { text = await require('./pdf_layout').pdfToLayoutText(buf); } catch (e) { note = 'this PDF could not be read'; console.warn('[onboarding] recognize: pdf read failed', { file: f.originalname, error: e.message }); } }
      else if (/\.txt$/i.test(f.originalname || '')) text = buf.toString('utf8');
      else note = /\.(xls|xlsx|csv)$/i.test(f.originalname || '') ? 'download the PDF version of this report; Trusted reads the report exactly as Vantaca prints it' : 'not a PDF report';
      const id = text && adapter.identify ? adapter.identify(text) : null;
      const check = id && adapter.cutoffCheck ? adapter.cutoffCheck(id, cutoff || null) : { ok: null, note: null };
      out.push({ filename: f.originalname, type: id ? id.type : null, as_of: id ? id.as_of : null, period_start: id ? id.period_start : null,
        dated_at_cutoff: check.ok, note: note || check.note || (text && !id ? 'not a report Trusted recognizes yet' : null) });
    }
    return out;
  }
  // The batch checklist: every package report, supplied / needed / not needed.
  function packageStatus(view) {
    let adapter; try { adapter = require('./adapters').get(view.batch.source_system); } catch (_) { return null; }
    if (!adapter.sourcePackage) return null;
    const cutoff = String(view.batch.as_of_date).slice(0, 10);
    const pkg = adapter.sourcePackage(cutoff);
    const arts = view.artifacts || [];
    const original = (a) => arts.find((x) => x.sha256 === a.derived_from_sha256);
    const latestOf = (t) => arts.filter((a) => a.artifact_type === t).slice(-1)[0] || null;
    const intake = view.latest_by_stage && view.latest_by_stage.intake;
    const required = intake && intake.summary && Array.isArray(intake.summary.required_sources) ? intake.summary.required_sources.map((r) => r.type) : null;
    const glKnown = !!(required && latestOf('gl_trial_balance'));
    const reports = pkg.reports.map((r) => {
      const a = latestOf(r.type);
      if (a) {
        const dated = a.cutoff_date ? String(a.cutoff_date).slice(0, 10) : null;
        return { ...r, status: 'supplied', file: (original(a) || a).filename, as_of: dated, dated_at_cutoff: dated ? dated === cutoff : null };
      }
      if (glKnown && !(required || []).includes(r.type)) return { ...r, status: 'not_needed', note: 'the GL carries no balance this report supports' };
      return { ...r, status: 'needed' };
    });
    return { ...pkg, reports, unrecognized: arts.filter((a) => a.artifact_type === 'unrecognized').map((a) => (original(a) || a).filename) };
  }

  // Scaling metrics for the batch. "Human interventions" counts only real human
  // work (Ed, Issue #15): the initial handoff, each separate upload of requested
  // source material, each judgment (waiver), each authorization (preflight approval
  // or an owner advance of a result that was not a plain PASS). Manual engine
  // clicks the operator would have done (a human-run stage, a human advance of a
  // plain PASS) are ceremony: reported separately, not counted. The audit trail
  // itself stays complete.
  function operatorMetrics(view) {
    const ev = view.events || [];
    const start = view.batch.created_at; const last = ev.length ? ev[ev.length - 1].at : start;
    const statusOf = new Map(ev.filter((e) => e.type === 'stage_completed').map((e) => [e.id, e.status]));
    const human = ev.filter((e) => e.actor_kind === 'human');
    const firstSystem = ev.find((e) => e.actor_kind === 'system');
    // uploads after the operator first ran = requested-source uploads; one action per 5-minute window
    const later = (view.artifacts || []).filter((a) => !a.derived_from_sha256 && a.supplied_by !== OPERATOR.id && firstSystem && Date.parse(a.received_at) > Date.parse(firstSystem.at)).map((a) => Date.parse(a.received_at)).sort((x, y) => x - y);
    let uploads = 0; let windowStart = null;
    for (const t of later) { if (windowStart === null || t - windowStart > 5 * 60000) { uploads++; windowStart = t; } }
    const interventions = {
      handoff: 1,
      source_uploads: uploads,
      judgments: human.filter((e) => e.type === 'control_waived').length + (view.bridge_decisions || []).filter((d) => d.actor_kind === 'human').length,
      authorizations: human.filter((e) => e.type === 'preflight_approved' || (e.type === 'stage_advanced' && statusOf.get(e.completion_id) !== 'PASS')).length,
    };
    const latest = Object.values(view.latest_by_stage || {});
    const controls = (view.current && view.current.controls) || [];
    return {
      elapsed_seconds: Math.max(0, Math.round((Date.parse(last) - Date.parse(start)) / 1000)),
      human_interventions: Object.values(interventions).reduce((t, n) => t + n, 0),
      interventions,
      manual_engine_actions: human.filter((e) => e.type === 'stage_completed' || (e.type === 'stage_advanced' && statusOf.get(e.completion_id) === 'PASS')).length,
      operator_steps: ev.filter((e) => e.actor_kind === 'system' || e.actor_kind === 'agent').length,
      stages_passed: latest.filter((l) => l.status === 'PASS').length,
      current_controls_passing: controls.length ? `${controls.filter((c) => c.status === 'PASS').length}/${controls.length}` : null,
      ai_calls: 0,
    };
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
  // Owner approval by HASH: the caller names the current preflight result and the exact
  // fingerprint it reviewed; the server rebuilds the report from what it RECORDED (+ the
  // current waivers), requires that hash to equal the caller's, then runs every check of
  // approve() on that rebuilt report. Nothing large crosses the wire; no check is skipped.
  async function approveByHash(actor, batchId, { completion_id, preflight_sha256 } = {}) {
    if (!isOwnerHuman(actor)) throw new ServiceError(403, 'OWNER_ONLY', 'only the owner may approve a preflight');
    if (!completion_id || !/^[0-9a-f]{64}$/.test(String(preflight_sha256 || ''))) throw new ServiceError(400, 'COMPLETION_AND_HASH_REQUIRED', 'approval needs the preflight result id and its exact sha256');
    const view = await rawView(batchId);
    const cur = view.current;
    if (view.batch.stage !== 'preflight' || !cur || cur.completion_id !== completion_id) throw new ServiceError(409, 'NOT_THE_CURRENT_PREFLIGHT_RESULT');
    const rec = cur.summary && cur.summary.preflight_report;
    if (!rec) throw new ServiceError(409, 'NO_RECORDED_PREFLIGHT', 'the current preflight result carries no report');
    if (!PF.verifyPreflight(rec)) throw new ServiceError(409, 'PREFLIGHT_REPORT_ALTERED', 'the recorded preflight report no longer verifies');
    const report = PF.buildConversionPreflight(PF.preflightBase(rec), (cur.waivers || []).map((w) => ({ code: w.code, by: w.by, reason: w.reason, at: w.at })));
    if (report.sha256 !== preflight_sha256) throw new ServiceError(409, 'PREFLIGHT_HASH_MISMATCH', 'the fingerprint you approved is not the current preflight (with its current waivers)');
    return approve(actor, batchId, { completion_id, preflight: report });
  }

  async function approve(actor, batchId, { completion_id, preflight }) {
    if (!isOwnerHuman(actor)) throw new ServiceError(403, 'OWNER_ONLY', 'only the owner may approve a preflight');
    const view = await rawView(batchId);
    if (!preflight || !PF.verifyPreflight(preflight)) throw new ServiceError(400, 'PREFLIGHT_REPORT_ALTERED');
    if (!preflight.batch || preflight.batch.batch_code !== view.batch.batch_code) throw new ServiceError(400, 'PREFLIGHT_FOR_ANOTHER_BATCH');
    const cur = view.current;
    if (!cur || cur.completion_id !== completion_id) throw new ServiceError(409, 'NOT_THE_CURRENT_PREFLIGHT_RESULT');
    const recorded = cur.waivers || [];
    // A v2 (conversion) report must be EXACTLY the recorded preflight result plus the current
    // waivers: rebuild it from what was recorded and compare hashes; and its inputs must still
    // be current (snapshot, bridge, decisions, Trusted activity, preflight rules).
    if (preflight.format === PF.FORMAT_V2) {
      const rec = cur.summary && cur.summary.preflight_report;
      if (!rec) throw new ServiceError(409, 'NO_RECORDED_PREFLIGHT', 'the current preflight result carries no report');
      const expected = PF.buildConversionPreflight(PF.preflightBase(rec), recorded.map((w) => ({ code: w.code, by: w.by, reason: w.reason, at: w.at })));
      if (expected.sha256 !== preflight.sha256) throw new ServiceError(409, 'PREFLIGHT_NOT_THE_RECORDED_REPORT', 'this report is not the recorded preflight result with its current waivers');
      const stale = await preflightStaleReason(view, { summary: cur.summary });
      if (stale) throw new ServiceError(409, 'PREFLIGHT_STALE', `the preflight is stale: ${stale}; the operator must rebuild it`);
    }
    for (const c of preflight.controls || []) {
      if (c.status === 'PASS') { if (c.disposition) throw new ServiceError(409, 'CONTROLS_NOT_PASSING', `${c.code}: PASS control carries a disposition`); continue; }
      const d = c.disposition; const w = recorded.find((x) => x.code === c.code);
      if (!d || d.disposition !== 'WAIVED' || !w || w.by !== d.waived_by || w.reason !== d.reason) throw new ServiceError(409, 'CONTROLS_NOT_PASSING', `${c.code}: not waived for the current preflight result`);
    }
    return call('onboarding_approve', { p_batch: batchId, p_completion: completion_id, p_preflight_sha256: preflight.sha256, p_actor_kind: 'human', p_actor_id: actor.id });
  }

  // ------------------------------------------------------------------ EXECUTE (M6)
  // Owner only. Carries out the write contract of the exact preflight result the owner
  // approved, in ONE database transaction (onboarding_execute, migration 488), which
  // reads the writes from the recorded result and re-checks every precondition against
  // live data. Before the call this layer re-proves what the database cannot compute:
  // the approved hash IS the recorded report (+ its current waivers), and the report's
  // inputs are still current (snapshot, bridge, decisions, plan rules, and the FULL
  // Trusted activity fingerprint). A committed execution is returned on retry, never
  // repeated. A failed attempt rolls back completely and is recorded as failed.
  const getExecution = (batchId) => call('onboarding_execution_view', { p_batch: batchId });

  async function execute(actor, batchId, { completion_id, preflight_sha256 } = {}) {
    if (!isOwnerHuman(actor)) throw new ServiceError(403, 'OWNER_ONLY', 'only the owner may execute a conversion');
    if (!completion_id || !/^[0-9a-f]{64}$/.test(String(preflight_sha256 || ''))) throw new ServiceError(400, 'COMPLETION_AND_HASH_REQUIRED');
    const committed = (await getExecution(batchId) || []).find((x) => x.status === 'committed');
    if (committed) {
      if (committed.preflight_completion_id !== completion_id || committed.preflight_sha256 !== preflight_sha256) throw new ServiceError(409, 'ALREADY_EXECUTED', `this batch was already executed (execution ${committed.id}) from another preflight`);
      return { status: 'already_executed', execution_id: committed.id, execute_completion_id: committed.execute_completion_id, write_counts: committed.write_counts, proof: committed.proof, rows_written_now: 0 };
    }
    const view = await rawView(batchId);
    if (view.batch.stage !== 'preflight') throw new ServiceError(409, 'NOT_IN_PREFLIGHT', `execute starts from the preflight stage; the batch is in ${view.batch.stage}`);
    const cur = view.current;
    if (!cur || cur.completion_id !== completion_id) throw new ServiceError(409, 'NOT_THE_CURRENT_PREFLIGHT_RESULT');
    if (!view.batch.approved_preflight_sha256) throw new ServiceError(409, 'NOT_APPROVED', 'the owner has not approved this preflight');
    if (view.batch.approved_preflight_sha256 !== preflight_sha256) throw new ServiceError(409, 'APPROVAL_FOR_ANOTHER_HASH', 'the approved preflight hash is not the one being executed');
    const rec = cur.summary && cur.summary.preflight_report;
    if (!rec || rec.format !== PF.FORMAT_V2) throw new ServiceError(409, 'NO_RECORDED_PREFLIGHT', 'the current preflight result carries no conversion report');
    if (!PF.verifyPreflight(rec) || rec.sha256 !== cur.summary.preflight_sha256) throw new ServiceError(409, 'PREFLIGHT_REPORT_ALTERED', 'the recorded report no longer verifies against its recorded hash');
    const waivers = (cur.waivers || []).map((w) => ({ code: w.code, by: w.by, reason: w.reason, at: w.at }));
    const approved = PF.buildConversionPreflight(PF.preflightBase(rec), waivers);
    if (approved.sha256 !== preflight_sha256) throw new ServiceError(409, 'PREFLIGHT_NOT_THE_RECORDED_REPORT', 'the approved hash is not the recorded preflight result with its current waivers');
    if (approved.status.eligibility === 'not_eligible') throw new ServiceError(409, 'CONTROLS_NOT_PASSING', 'the preflight is not eligible');
    const stale = await preflightStaleReason(view, { summary: cur.summary });
    if (stale) throw new ServiceError(409, 'PREFLIGHT_STALE', `the preflight is stale: ${stale}; the operator must rebuild it and the owner approve again`);
    try {
      return await call('onboarding_execute', { p_batch: batchId, p_completion: completion_id, p_preflight_sha256: preflight_sha256, p_actor_kind: 'human', p_actor_id: actor.id });
    } catch (e) {
      // The transaction rolled back (nothing partial). Record the attempt truthfully, then surface the refusal.
      try { await call('onboarding_record_execution_failure', { p_batch: batchId, p_completion: completion_id, p_preflight_sha256: preflight_sha256, p_error: String(e.message || e).slice(0, 2000), p_actor_kind: 'human', p_actor_id: actor.id }); }
      catch (logErr) { console.warn('[onboarding] execute failure could not be recorded:', JSON.stringify({ batch: batchId, error: e.message, record_error: logErr.message })); }
      throw e;
    }
  }

  return { schemaStatus, listBatches, getBatch, decide, listDecisions, sourcePackage, recognize, packageStatus, getSnapshot, getBridge, getPreflight, getExecution, bridgeFreshness, operate, ingestOriginals, operatorAsks, operatorMetrics, createBatch, registerArtifact, attachEvidence, listEvidence, runStage, waive, advance, approve, approveByHash, execute, derive, RUNNABLE, NEEDED_MIGRATIONS };
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
  const { readOnlyClient } = require('./write_gate');
  const { loadTrustedActivity, loadConversionContext, loadPostProofData } = require('./trusted_activity');
  const ro = readOnlyClient(supabase);
  const trustedReader = (communityId) => loadTrustedActivity(ro, communityId);
  const conversionContext = (communityId) => loadConversionContext(ro, communityId);
  const postProofReader = (communityId, opts) => loadPostProofData(ro, communityId, opts);
  return { rpc, storage, trustedReader, conversionContext, postProofReader };
}

module.exports = { createOnboardingService, supabaseBackends, ServiceError, RPC, RUNNABLE, NEEDED_MIGRATIONS };
