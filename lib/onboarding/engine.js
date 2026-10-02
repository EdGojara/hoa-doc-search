// ============================================================================
// lib/onboarding/engine.js  (Issue #15) — bounded stage runners (stages 0-2)
// ----------------------------------------------------------------------------
// Each runner does ONE stage's work for a batch that is IN that stage, checks
// the actor is permitted (stages.assertPermitted), records the result with
// completeStage, and returns. None of them advances the batch: a human calls
// stages.advance(). None of them receives a database client; they work on the
// recorded artifacts only, so they cannot touch production.
//
// This milestone stops at source controls. Snapshot, activity bridge,
// preflight-with-writes and execute are later, separately approved milestones.
// ============================================================================
const S = require('./stages');
const { makeArtifact, verifyArtifact } = require('./artifacts');
const adapters = require('./adapters');
const { sourceControls } = require('./source_controls');
const { summarize } = require('./controls');

// Stage 0: register originals (and their derived text) with hashes and provenance.
function runIntake(state, actor, inputs) {
  S.assertPermitted(state, actor, 'register_artifact');
  const artifacts = inputs.map((x) => makeArtifact(x.buffer, { batch_code: state.batch_code, community_id: state.community_id, source_system: state.source_system, ...x.meta }));
  const types = artifacts.map((a) => a.artifact_type);
  const dupes = artifacts.filter((a, i) => artifacts.findIndex((b) => b.sha256 === a.sha256) !== i);
  const result = { status: dupes.length ? 'FAIL' : 'PASS', artifacts: artifacts.map((a) => ({ filename: a.filename, artifact_type: a.artifact_type, sha256: a.sha256, bytes: a.bytes })), artifact_types: types, duplicate_artifacts: dupes.map((a) => a.filename) };
  return { state: S.completeStage(state, actor, result), artifacts, result };
}

// Stage 1: provider adapter -> canonical rows. inputs: [{ artifact, buffer }] (text artifacts).
function runNormalize(state, actor, inputs, opts = {}) {
  S.assertPermitted(state, actor, 'run_adapter');
  const adapter = adapters.get(state.source_system);
  const parsed = {}; const normalization = [];
  for (const { artifact, buffer } of inputs) {
    verifyArtifact(artifact, buffer);                         // bytes must be the recorded bytes
    if (!adapter.artifact_types.includes(artifact.artifact_type)) continue;
    const p = adapter.parse(artifact.artifact_type, buffer.toString('utf8'), artifact, opts);
    parsed[artifact.artifact_type] = p;
    normalization.push({ artifact_type: artifact.artifact_type, adapter: adapter.provider, adapter_version: adapter.version, rows: p.rows.length, defects: p.defects.length });
  }
  const extraction = adapter.extractionControls(parsed);
  const sum = summarize(extraction);
  // An extraction FAIL is an adapter defect: the stage FAILS and the batch cannot advance
  // (a parser mismatch is never evidence the source books are wrong).
  const result = { status: sum.overall, normalization, extraction_controls: sum, open_controls: extraction.filter((c) => c.status !== 'PASS').map((c) => c.code) };
  return { state: S.completeStage(state, actor, result), parsed, extraction, normalization, result };
}

// Stage 2: source controls (provider mechanics + provider-agnostic controls + authoritative totals).
function runSourceControls(state, actor, parsed, { roles = {}, expected = {}, mechanics = {} } = {}) {
  S.assertPermitted(state, actor, 'run_source_controls');
  const adapter = adapters.get(state.source_system);
  const controls = [...(adapter.mechanicsControls ? adapter.mechanicsControls(parsed, mechanics) : []), ...sourceControls(parsed, { roles, expected })];
  const sum = summarize(controls);
  const result = { status: sum.overall, controls: sum, open_controls: controls.filter((c) => c.status !== 'PASS').map((c) => c.code) };
  return { state: S.completeStage(state, actor, result), controls, result };
}

module.exports = { runIntake, runNormalize, runSourceControls };
