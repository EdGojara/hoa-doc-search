// ============================================================================
// lib/onboarding/preflight.js  (Issue #15) — preflight report format
// ----------------------------------------------------------------------------
// The single document a human approves before any write. It is canonical JSON
// with a sha256 over its content; the approval is bound to that hash, so
// approving one report can never authorize a different one.
// Format id: trusted.onboarding.preflight/v1
// ============================================================================
const crypto = require('crypto');
const { summarize } = require('./controls');
const { fmt } = require('./money');

const FORMAT = 'trusted.onboarding.preflight/v1';
const SECTIONS = ['batch', 'source_cutoff', 'artifacts', 'normalization', 'controls', 'status', 'collisions', 'automatic_matches', 'human_exceptions', 'unexplained_differences', 'proposed_writes', 'rollback', 'idempotency'];

// Stable JSON: keys sorted at every level so the hash does not depend on insertion order.
function canonicalJson(v) {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}

function buildPreflight(input) {
  for (const k of ['batch', 'source_cutoff', 'artifacts', 'controls']) if (!input[k]) throw new Error(`preflight ${k} required`);
  const body = {
    format: FORMAT,
    batch: input.batch,                               // { batch_code, community_id, source_system, stage }
    source_cutoff: input.source_cutoff,               // { cutoff_date, period_start, period_end }
    artifacts: input.artifacts.map((a) => ({ filename: a.filename, artifact_type: a.artifact_type, sha256: a.sha256, bytes: a.bytes, derived_from_sha256: a.derived_from_sha256 || null })),
    normalization: input.normalization || [],         // [{ artifact_type, adapter, adapter_version, rows, defects }]
    controls: input.controls.map((c) => ({ code: c.code, label: c.label, level: c.level, status: c.status, left_cents: c.left_cents ?? null, right_cents: c.right_cents ?? null, difference_cents: c.difference_cents ?? null, failures: c.failures ? c.failures.length : null, reason: c.reason || null })),
    status: { ...summarize(input.controls), domains: input.domain_status || {} },  // GL / AR / AP / cash / ownership
    collisions: input.collisions || { evaluated: false, note: 'activity bridge not run' },
    automatic_matches: input.automatic_matches || [],
    human_exceptions: input.human_exceptions || [],
    unexplained_differences: input.unexplained_differences || [],
    proposed_writes: input.proposed_writes || [],     // [{ table, action, count, key }]
    rollback: input.rollback || null,
    idempotency: input.idempotency || { batch_code: input.batch.batch_code },
  };
  const sha256 = crypto.createHash('sha256').update(canonicalJson(body)).digest('hex');
  return Object.freeze({ ...body, sha256 });
}

function verifyPreflight(report) {
  const { sha256, ...body } = report;
  return crypto.createHash('sha256').update(canonicalJson(body)).digest('hex') === sha256;
}

function renderMarkdown(r) {
  const L = [];
  L.push(`# Preflight: ${r.batch.batch_code}`, '', `Format \`${r.format}\` · report sha256 \`${r.sha256}\``, '',
    `Community \`${r.batch.community_id}\` · source **${r.batch.source_system}** · cutoff **${r.source_cutoff.cutoff_date}** · stage **${r.batch.stage}**`, '',
    `**Controls: ${r.status.overall}** (${r.status.counts.PASS} pass, ${r.status.counts.FAIL} fail, ${r.status.counts.BLOCKED} blocked)`, '',
    '## Source artifacts', '| File | Type | sha256 |', '|---|---|---|', ...r.artifacts.map((a) => `| ${a.filename} | ${a.artifact_type} | \`${a.sha256.slice(0, 16)}…\` |`), '',
    '## Controls', '| Status | Control | Left | Right | Diff |', '|---|---|---|---|---|',
    ...r.controls.map((c) => `| ${c.status} | ${c.label} | ${c.left_cents == null ? (c.failures != null ? `${c.failures} failing` : '') : fmt(c.left_cents)} | ${c.right_cents == null ? (c.reason || '') : fmt(c.right_cents)} | ${c.difference_cents ? fmt(c.difference_cents) : ''} |`), '',
    '## Proposed writes', r.proposed_writes.length ? r.proposed_writes.map((w) => `- ${w.action} ${w.count} × \`${w.table}\` (${w.key || ''})`).join('\n') : '_none (this report authorizes no writes)_', '',
    '## Exceptions for a human', r.human_exceptions.length ? r.human_exceptions.map((e) => `- ${e}`).join('\n') : '_none_', '',
    '## Unexplained differences', r.unexplained_differences.length ? r.unexplained_differences.map((e) => `- ${e}`).join('\n') : '_none_', '',
    `Rollback: ${r.rollback || '_n/a_'}`, `Idempotency: batch \`${r.idempotency.batch_code}\``);
  return L.join('\n');
}

module.exports = { FORMAT, SECTIONS, buildPreflight, verifyPreflight, renderMarkdown, canonicalJson };
