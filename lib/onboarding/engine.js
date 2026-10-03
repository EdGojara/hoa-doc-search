// ============================================================================
// lib/onboarding/engine.js  (Issue #15) — bounded stage runners (stages 0-2)
// ----------------------------------------------------------------------------
// Each runner does ONE stage's work for a batch that is IN that stage, checks
// the actor is permitted (stages.assertPermitted), records the result with
// completeStage, and returns. None of them advances the batch: a human calls
// stages.advance(). None of them receives a database client; they work on the
// recorded artifacts only, so they cannot touch production.
//
// Runners exist for stages 0-2 only. Snapshot, activity bridge, preflight-with-
// writes and execute are later, separately approved milestones.
// ============================================================================
const S = require('./stages');
const { makeArtifact, verifyArtifact } = require('./artifacts');
const adapters = require('./adapters');
const { sourceControls } = require('./source_controls');
const C = require('./controls');
const { summarize } = C;

// ---------------------------------------------------------------- pure stage work
// These compute a stage's controls from recorded artifacts and record nothing.
// The runners below (in-memory) and lib/onboarding/service.js (persisted, via
// the guarded SQL functions) both use them, so the two can never diverge.

// Stage 0 controls: the batch has artifacts, every one re-hashes to its record, none duplicated.
function intakeControls(artifacts, { hashFailures = [] } = {}) {
  const dupes = artifacts.filter((a, i) => artifacts.findIndex((b) => b.sha256 === a.sha256) !== i);
  return [
    C.holds('intake.artifacts_present', { label: 'At least one source artifact is registered', failures: artifacts.length ? [] : [{ reason: 'no artifacts' }] }),
    C.holds('intake.artifacts_match_recorded_hashes', { label: 'Every artifact re-hashes to its recorded sha256', failures: hashFailures }),
    C.holds('intake.no_duplicate_artifacts', { label: 'No artifact is registered twice', failures: dupes.map((a) => ({ filename: a.filename, sha256: a.sha256 })) }),
  ];
}

// Stage 1: provider adapter -> canonical rows + extraction controls. inputs: [{ artifact, buffer }].
function normalize(sourceSystem, inputs, opts = {}) {
  const adapter = adapters.get(sourceSystem);
  const parsed = {}; const normalization = [];
  for (const { artifact, buffer } of inputs) {
    verifyArtifact(artifact, buffer);                         // bytes must be the recorded bytes
    if (!adapter.artifact_types.includes(artifact.artifact_type)) continue;
    const p = adapter.parse(artifact.artifact_type, buffer.toString('utf8'), artifact, opts);
    parsed[artifact.artifact_type] = p;
    normalization.push({ artifact_type: artifact.artifact_type, sha256: artifact.sha256, adapter: adapter.provider, adapter_version: adapter.version, rows: p.rows.length, defects: p.defects.length });
  }
  const extraction = adapter.extractionControls(parsed);
  if (!normalization.length) extraction.push(C.blocked('normalize.supported_artifacts', { label: `At least one artifact the ${adapter.provider} adapter can read`, level: C.LEVEL.EXTRACTION, reason: `no artifact of type ${adapter.artifact_types.join(' / ')}`, needs: adapter.artifact_types }));
  return { parsed, extraction, normalization, adapter: { provider: adapter.provider, version: adapter.version } };
}

// Stage 2: provider mechanics + provider-agnostic controls + authoritative totals.
function sourceControlsFor(sourceSystem, parsed, { roles = {}, expected = {}, mechanics = {} } = {}) {
  const adapter = adapters.get(sourceSystem);
  return [...(adapter.mechanicsControls ? adapter.mechanicsControls(parsed, mechanics) : []), ...sourceControls(parsed, { roles, expected })];
}

// Authoritative controls supplied as DATA (persistable), not code:
//   { code: { label, cents, derive: { kind: 'gl_ending', account } | { kind: 'gl_total', side: 'debit'|'credit' }
//                                 | { kind: 'statement_section', sections: ['assets'] } } }
function expectedFromSpec(spec = {}) {
  const out = {};
  for (const [code, s] of Object.entries(spec)) {
    if (!s || !Number.isInteger(s.cents) || !s.derive) throw new Error(`authoritative control ${code}: cents (integer) and derive are required`);
    const d = s.derive; let fn;
    if (d.kind === 'gl_ending') fn = (p, { glEnd }) => glEnd(String(d.account));
    else if (d.kind === 'gl_total') fn = (p, { bal }) => (bal.length ? bal.reduce((t, r) => t + (d.side === 'credit' ? r.credit_cents : r.debit_cents), 0) : null);
    else if (d.kind === 'statement_section') fn = (p, { bs }) => (bs.length ? bs.filter((r) => d.sections.includes(r.section)).reduce((t, r) => t + r.amount_cents, 0) : null);
    else throw new Error(`authoritative control ${code}: unknown derive kind ${d.kind}`);
    out[code] = { label: s.label || code, cents: s.cents, derive: fn };
  }
  return out;
}

const openCodes = (controls) => controls.filter((c) => c.status !== 'PASS').map((c) => c.code);

// ---------------------------------------------------------------- in-memory runners
// Stage 0: register originals (and their derived text) with hashes and provenance.
function runIntake(state, actor, inputs) {
  S.assertPermitted(state, actor, 'register_artifact');
  const artifacts = inputs.map((x) => makeArtifact(x.buffer, { batch_code: state.batch_code, community_id: state.community_id, source_system: state.source_system, ...x.meta }));
  const controls = intakeControls(artifacts);
  const sum = summarize(controls);
  const result = { status: sum.overall, open_controls: openCodes(controls), artifacts: artifacts.map((a) => ({ filename: a.filename, artifact_type: a.artifact_type, sha256: a.sha256, bytes: a.bytes })) };
  return { state: S.completeStage(state, actor, result), artifacts, controls, result };
}

// Stage 1. An extraction FAIL is an adapter defect: the stage FAILS and the batch cannot advance
// (a parser mismatch is never evidence the source books are wrong).
function runNormalize(state, actor, inputs, opts = {}) {
  S.assertPermitted(state, actor, 'run_adapter');
  const { parsed, extraction, normalization } = normalize(state.source_system, inputs, opts);
  const sum = summarize(extraction);
  const result = { status: sum.overall, normalization, extraction_controls: sum, open_controls: openCodes(extraction) };
  return { state: S.completeStage(state, actor, result), parsed, extraction, normalization, result };
}

// Stage 2.
function runSourceControls(state, actor, parsed, cfg = {}) {
  S.assertPermitted(state, actor, 'run_source_controls');
  const controls = sourceControlsFor(state.source_system, parsed, cfg);
  const sum = summarize(controls);
  const result = { status: sum.overall, controls: sum, open_controls: openCodes(controls) };
  return { state: S.completeStage(state, actor, result), controls, result };
}

module.exports = { intakeControls, normalize, sourceControlsFor, expectedFromSpec, openCodes, runIntake, runNormalize, runSourceControls };
