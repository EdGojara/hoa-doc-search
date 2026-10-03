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
// Nothing is posted. Not here by design (later milestones): EXECUTE behavior,
// post-proof. Advancing into execute is refused (482).
// ============================================================================
const S = require('./stages');
const E = require('./engine');
const { sha256, verifyArtifact } = require('./artifacts');
const { summarize } = require('./controls');
const PF = require('./preflight');
const { buildSnapshot } = require('./snapshot');
const { buildBridge, trustedFingerprint } = require('./bridge');

const RPC = Object.freeze(['onboarding_batches', 'onboarding_batch_view', 'onboarding_create_batch', 'onboarding_register_artifact',
  'onboarding_record_completion', 'onboarding_waive', 'onboarding_approve', 'onboarding_advance', 'onboarding_record_snapshot', 'onboarding_snapshot_view', 'onboarding_record_bridge', 'onboarding_bridge_view', 'onboarding_auto_advance']);
const RUNNABLE = Object.freeze(['intake', 'normalize', 'source_controls', 'snapshot', 'activity_bridge']);
const NEEDED_MIGRATIONS = Object.freeze(['481_onboarding_engine.sql', '482_onboarding_service.sql']);
const SNAPSHOT_MIGRATION = '483_onboarding_snapshot.sql';
const SNAPSHOT_RPCS = ['onboarding_record_snapshot', 'onboarding_snapshot_view'];
const BRIDGE_MIGRATION = '484_onboarding_activity_bridge.sql';
const BRIDGE_RPCS = ['onboarding_record_bridge', 'onboarding_bridge_view'];
const STORAGE_PREFIX = 'onboarding';

class ServiceError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}

const isOwnerHuman = (a) => a && a.kind === 'human' && a.id && a.role === 'owner';
const isStaffHuman = (a) => a && a.kind === 'human' && a.id && (a.role === 'owner' || a.role === 'admin');
const MISSING_SCHEMA = /could not find the function|function .* does not exist|relation .* does not exist|PGRST202|42883|42P01/i;

function createOnboardingService({ rpc, storage, trustedReader = null }) {
  if (typeof rpc !== 'function' || !storage) throw new Error('onboarding service needs rpc and storage');
  const call = async (name, args) => {
    if (!RPC.includes(name)) throw new Error(`onboarding rpc not allowed: ${name}`);
    try { return await rpc(name, args); }
    catch (e) {
      if (MISSING_SCHEMA.test(`${e.code || ''} ${e.message || ''}`)) throw new ServiceError(503, 'SCHEMA_NOT_APPLIED', `onboarding schema not applied (needs ${BRIDGE_RPCS.includes(name) ? BRIDGE_MIGRATION : SNAPSHOT_RPCS.includes(name) ? SNAPSHOT_MIGRATION : NEEDED_MIGRATIONS.join(', ')})`);
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

  async function getBatch(batchId, actor) {
    const view = await rawView(batchId);
    return { ...view, derived: derive(view, actor), operator: { asks: await operatorAsks(view), metrics: operatorMetrics(view), package: packageStatus(view) } };
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
    S.assertPermitted({ stage }, actor, { intake: 'register_artifact', normalize: 'run_adapter', source_controls: 'run_source_controls', snapshot: 'build_snapshot', activity_bridge: 'compare_activity' }[stage]);
    if (stage === 'snapshot') return runSnapshot(actor, view, config);
    if (stage === 'activity_bridge') return runBridge(actor, view);
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
    const { inputs, hashFailures } = await loadArtifacts(view);
    let snap; let controls; let summaryExtra = {};
    if (hashFailures.length) {
      controls = [require('./controls').holds('artifacts.match_recorded_hashes', { label: 'Every artifact re-hashes to its recorded sha256', failures: hashFailures })];
      snap = { lines: [], components: [], sha256: sha256(Buffer.from('no-snapshot:' + view.batch.id)) };
    } else {
      const n = E.normalize(view.batch.source_system, inputs);
      snap = buildSnapshot(n.parsed, { batch_code: view.batch.batch_code, cutoff_date: String(view.batch.as_of_date).slice(0, 10), roles, fund_by_account: config.fund_by_account || {} });
      controls = snap.controls; summaryExtra = { adapter: n.adapter, components: snap.components };
    }
    const sum = summarize(controls);
    const lines = snap.lines.map((l) => ({ line_no: l.line_no, kind: l.kind, component: l.component, account_code: l.account_code || null, fund_code: l.fund_code || null,
      source_account_key: l.source_account_key || null, amount_cents: l.amount_cents, provenance: l.provenance, batch_code: l.batch_code, cutoff_date: l.cutoff_date,
      detail: Object.fromEntries(Object.entries({ account_name: l.account_name, reason: l.reason, charge_type: l.charge_type, buckets: l.buckets, source_vendor_key: l.source_vendor_key, invoice_number: l.invoice_number, invoice_date: l.invoice_date, former_owner: l.former_owner }).filter(([, v]) => v !== undefined)) }));
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
    const bridge = buildBridge(n.parsed, loaded.trusted, { batch_code: view.batch.batch_code, cutoff_date: String(view.batch.as_of_date).slice(0, 10), roles,
      snapshot: { completion_id: snapRef.completion_id, stale: false }, accountOfProperty: loaded.accountOfProperty, accountNumber: loaded.accountNumber });
    const sum = summarize(bridge.controls);
    const items = bridge.items.map((it) => ({ item_no: it.item_no, event_key: it.event_key, kind: it.kind, classification: it.classification, method: it.method, confidence: it.confidence,
      event_date: it.event_date, amount_cents: it.amount_cents, evidence: it.evidence, structural_issues: it.structural_issues, records: it.records, batch_code: it.batch_code, cutoff_date: it.cutoff_date }));
    const completionId = await call('onboarding_record_bridge', {
      p_batch: view.batch.id, p_status: sum.overall, p_open: E.openCodes(bridge.controls), p_controls: serialize(bridge.controls),
      p_summary: { counts: sum.counts, roles, totals: bridge.totals, candidate_records: bridge.candidate_records, snapshot_completion_id: snapRef.completion_id, adapter: n.adapter },
      p_items: items, p_bridge_sha256: bridge.sha256, p_trusted_fingerprint: bridge.trusted_fingerprint, p_actor_kind: actor.kind, p_actor_id: actor.id,
    });
    return { completion_id: completionId, status: sum.overall, counts: sum.counts, totals: bridge.totals, bridge_sha256: bridge.sha256, items: items.length };
  }

  const getBridge = (batchId, completionId = null) => call('onboarding_bridge_view', { p_batch: batchId, p_completion: completionId });

  // Has Trusted financial activity changed since the bridge was recorded? (stale on source change)
  async function bridgeFreshness(batchId) {
    const b = await getBridge(batchId);
    if (!b) return null;
    if (!trustedReader) return { fresh: null, reason: 'no reader' };
    const view = await rawView(batchId);
    const current = trustedFingerprint((await trustedReader(view.batch.community_id)).trusted);
    return { fresh: current === b.trusted_fingerprint, recorded: b.trusted_fingerprint, current };
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
      if (!next || next === 'execute') return { stopped_at: stage, reason: 'ready_for_human_authorization', steps };
      await call('onboarding_auto_advance', { p_batch: batchId, p_completion: completion.completion_id, p_actor_id: OPERATOR.id });
      steps.push({ stage, action: 'advanced', to: next });
    }
    return { stopped_at: (await rawView(batchId)).batch.stage, reason: 'step_limit', steps };
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
      else if (c.code === 'bridge.ambiguous_items_reviewed') asks.push({ type: 'ambiguity', control: c.code, text: c.reason });
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
      if (r.need === 'always' || (required && required.includes(r.type))) return { ...r, status: 'needed' };
      if (glKnown) return { ...r, status: 'not_needed', note: 'the GL carries no balance this report supports' };
      return { ...r, status: 'needed_if_balance' };
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
      judgments: human.filter((e) => e.type === 'control_waived').length,
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

  return { schemaStatus, listBatches, getBatch, sourcePackage, recognize, packageStatus, getSnapshot, getBridge, bridgeFreshness, operate, ingestOriginals, operatorAsks, operatorMetrics, createBatch, registerArtifact, runStage, waive, advance, approve, derive, RUNNABLE, NEEDED_MIGRATIONS };
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
  const { loadTrustedActivity } = require('./trusted_activity');
  const ro = readOnlyClient(supabase);
  const trustedReader = (communityId) => loadTrustedActivity(ro, communityId);
  return { rpc, storage, trustedReader };
}

module.exports = { createOnboardingService, supabaseBackends, ServiceError, RPC, RUNNABLE, NEEDED_MIGRATIONS };
