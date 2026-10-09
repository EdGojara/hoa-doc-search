// ============================================================================
// lib/onboarding/preflight.js  (Issue #15) — preflight report format
// ----------------------------------------------------------------------------
// The single document a human approves before any write. It is canonical JSON
// with a sha256 over its content; the approval is bound to that hash, so
// approving one report can never authorize a different one.
// Format id: trusted.onboarding.preflight/v1
// ============================================================================
const crypto = require('crypto');
const { summarize, applyWaivers } = require('./controls');
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
  // Human waivers ride along as a separate disposition; the control keeps its real status and amounts.
  const controls = applyWaivers(input.controls, input.waivers || []);
  const body = {
    format: FORMAT,
    batch: input.batch,                               // { batch_code, community_id, source_system, stage }
    source_cutoff: input.source_cutoff,               // { cutoff_date, period_start, period_end }
    artifacts: input.artifacts.map((a) => ({ filename: a.filename, artifact_type: a.artifact_type, sha256: a.sha256, bytes: a.bytes, derived_from_sha256: a.derived_from_sha256 || null })),
    normalization: input.normalization || [],         // [{ artifact_type, adapter, adapter_version, rows, defects }]
    controls: controls.map((c) => ({ code: c.code, label: c.label, level: c.level, status: c.status, left_cents: c.left_cents ?? null, right_cents: c.right_cents ?? null, difference_cents: c.difference_cents ?? null, failures: c.failures ? c.failures.length : null, reason: c.reason || null, disposition: c.disposition || null })),
    status: { ...summarize(controls), domains: input.domain_status || {} },  // GL / AR / AP / cash / ownership
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
    `**Controls: ${r.status.overall}** (${r.status.counts.PASS} pass, ${r.status.counts.FAIL} fail, ${r.status.counts.BLOCKED} blocked; ${r.status.waived} waived, ${r.status.unresolved} unresolved) · ${{ eligible: 'eligible to advance', eligible_with_waiver: 'eligible to advance WITH WAIVER', not_eligible: 'NOT eligible to advance' }[r.status.eligibility]}`, '',
    '## Source artifacts', '| File | Type | sha256 |', '|---|---|---|', ...r.artifacts.map((a) => `| ${a.filename} | ${a.artifact_type} | \`${a.sha256.slice(0, 16)}…\` |`), '',
    '## Controls', '| Status | Disposition | Control | Left | Right | Diff |', '|---|---|---|---|---|---|',
    ...r.controls.map((c) => `| ${c.status} | ${c.disposition ? `WAIVED by ${c.disposition.waived_by} ${c.disposition.waived_at}: ${c.disposition.reason}` : ''} | ${c.label} | ${c.left_cents == null ? (c.failures != null ? `${c.failures} failing` : '') : fmt(c.left_cents)} | ${c.right_cents == null ? (c.reason || '') : fmt(c.right_cents)} | ${c.difference_cents ? fmt(c.difference_cents) : ''} |`), '',
    '## Proposed writes', r.proposed_writes.length ? r.proposed_writes.map((w) => `- ${w.action} ${w.count} × \`${w.table}\` (${w.key || ''})`).join('\n') : '_none (this report authorizes no writes)_', '',
    '## Exceptions for a human', r.human_exceptions.length ? r.human_exceptions.map((e) => `- ${e}`).join('\n') : '_none_', '',
    '## Unexplained differences', r.unexplained_differences.length ? r.unexplained_differences.map((e) => `- ${e}`).join('\n') : '_none_', '',
    `Rollback: ${r.rollback || '_n/a_'}`, `Idempotency: batch \`${r.idempotency.batch_code}\``);
  return L.join('\n');
}

// ---------------------------------------------------------------- v2: conversion preflight (M5)
// The exact review package for EXECUTE: the bound inputs (snapshot, PASS bridge,
// owner decisions, waivers), the line-level write contract, the controls, the
// execute preconditions, the post-execute proof plan, rollback and idempotency.
// The sha256 covers ALL of it. Waivers ride as dispositions next to their control
// (the control keeps its real status), so a different waiver = a different hash.
const FORMAT_V2 = 'trusted.onboarding.preflight/v2';

function buildConversionPreflight(base, waivers = []) {
  for (const k of ['batch', 'source_cutoff', 'inputs', 'plan', 'controls']) if (!base || !base[k]) throw new Error(`preflight ${k} required`);
  const plain = base.controls.map((c) => { const { disposition, ...rest } = c; return rest; });
  const controls = applyWaivers(plain, waivers);
  const body = {
    format: FORMAT_V2,
    batch: base.batch,
    source_cutoff: base.source_cutoff,
    inputs: { ...base.inputs, waivers: waivers.map((w) => ({ code: w.code, by: w.by, reason: w.reason, at: w.at })) },
    controls: controls.map((c) => ({ code: c.code, label: c.label, level: c.level || 'preflight', status: c.status, left_cents: c.left_cents ?? null, right_cents: c.right_cents ?? null,
      difference_cents: c.difference_cents ?? null, failures: Array.isArray(c.failures) ? c.failures : [], reason: c.reason || null, disposition: c.disposition || null })),
    status: summarize(controls),
    plan: base.plan,
  };
  const sha256 = crypto.createHash('sha256').update(canonicalJson(body)).digest('hex');
  return Object.freeze({ ...body, sha256 });
}

// The recorded (pre-waiver) body of a v2 report: what a preflight result stores.
function preflightBase(report) {
  return { batch: report.batch, source_cutoff: report.source_cutoff, inputs: { ...report.inputs, waivers: [] }, plan: report.plan,
    controls: report.controls.map((c) => ({ ...c, disposition: null })) };
}

function renderConversionMarkdown(r) {
  const usd = (c) => (c == null ? '' : fmt(c));
  const p = r.plan; const w = p.writes; const tick = '`';
  const L = [
    `# Conversion preflight: ${r.batch.batch_code}`, '',
    `Format ${tick}${r.format}${tick} · report sha256 ${tick}${r.sha256}${tick}`, '',
    `Cutoff **${r.source_cutoff.cutoff_date}** · cutover **${p.cutover}** · plan ${tick}${p.plan_version}${tick}`, '',
    `**Controls: ${r.status.overall}** (${r.status.counts.PASS} pass, ${r.status.counts.FAIL} fail, ${r.status.counts.BLOCKED} blocked; ${r.status.waived} waived) · ${{ eligible: 'eligible for approval', eligible_with_waiver: 'eligible for approval WITH WAIVER', not_eligible: 'NOT eligible for approval' }[r.status.eligibility]}`, '',
    '## Bound inputs',
    `- Snapshot result ${tick}${r.inputs.snapshot.completion_id}${tick} (sha256 ${tick}${String(r.inputs.snapshot.sha256 || '').slice(0, 16)}…${tick})`,
    `- Bridge result ${tick}${r.inputs.bridge.completion_id}${tick} (${r.inputs.bridge.status}, engine ${r.inputs.bridge.engine}, Trusted fingerprint ${tick}${String(r.inputs.bridge.trusted_fingerprint || '').slice(0, 16)}…${tick})`,
    `- Owner decisions: ${(r.inputs.decisions || []).length ? r.inputs.decisions.map((d) => `${d.choice_key} (${d.event_key}, by ${d.actor_id})`).join('; ') : 'none'}`,
    `- Waivers on this result: ${(r.inputs.waivers || []).length ? r.inputs.waivers.map((x) => `${x.code} by ${x.by}`).join('; ') : 'none'}`, '',
    '## Controls', '| Status | Disposition | Control | Detail |', '|---|---|---|---|',
    ...r.controls.map((c) => `| ${c.status} | ${c.disposition ? `WAIVED by ${c.disposition.waived_by}: ${c.disposition.reason}` : ''} | ${c.label} | ${c.left_cents != null ? `${usd(c.left_cents)} vs ${usd(c.right_cents)}` : (c.failures.length ? `${c.failures.length} failing` : '')} |`), '',
    '## Proposed writes (nothing is written until an approved EXECUTE)',
    ...w.opening_journal_entries.map((j) => `- **${j.reference}** ${j.posting_date}: ${j.lines.length} lines, ${usd(j.total_debits_cents)} Dr / ${usd(j.total_credits_cents)} Cr`),
    `- Supersede ${w.supersede_journal_entries.length} legacy-import journal entries (status superseded; rows kept)`,
    `- Neutralize ${w.neutralize_journal_entries.length} entries (equal reversal on the original date)${w.neutralize_journal_entries.length ? ': ' + w.neutralize_journal_entries.map((j) => `${j.reference} ${j.posting_date} ${usd(j.total_debits_cents)}`).join('; ') : ''}`,
    `- Re-post ${w.repost_journal_entries.length} entries on ${p.cutover}${w.repost_journal_entries.length ? ': ' + w.repost_journal_entries.map((j) => `${j.reference} ${usd(j.total_debits_cents)}`).join('; ') : ''}`,
    `- Revert ${w.revert_ar_batches.length} legacy homeowner-ledger batch(es)${w.revert_ar_batches.length ? ` (${w.revert_ar_batches.map((b) => `${b.rows} rows`).join(', ')}; rows kept)` : ''}`,
    `- Homeowner-ledger opening batch ${w.ar_opening_batch.key}: ${w.ar_opening_batch.row_count} rows; receivables ${usd(w.ar_opening_batch.receivable_cents)}; current-owner prepaids ${usd(w.ar_opening_batch.current_owner_prepaid_cents)}; prior-owner credits ${usd(w.ar_opening_batch.prior_owner_credit_cents)}`,
    `- Open AP invoices at the cutoff: ${w.ap_opening_invoices.length} (${usd(w.ap_opening_invoices.reduce((t, a) => t + a.total_cents, 0))}), posted by the opening entry`,
    ...(w.builder_coverage_batch ? [
      `- Builder assessments ${w.builder_coverage_batch.key} (entry ${w.builder_coverage_batch.journal_entry_reference || 'none'}, dated the cutover): ${w.builder_coverage_batch.rows.length} lots covered at the builder rate through the cutoff (${usd(w.builder_coverage_batch.coverage_cents)}); ledger ${usd(w.builder_coverage_batch.ledger_cents)}`,
      ...w.builder_coverage_batch.rows.filter((r) => r.kind === 'normalization').map((r) => `  - ${r.street_address}: ${usd(r.annual_billed_cents)} annual assessment normalized to ${usd(r.base_amount_cents)} (${r.days}/${r.days_in_year} days at ${r.builder_rate_pct}%); ledger ${usd(r.ledger_amount_cents)}`),
      `  - ${w.builder_coverage_batch.rows.filter((r) => r.kind === 'baseline').length} lots never billed this year: ${usd(w.builder_coverage_batch.rows.filter((r) => r.kind === 'baseline').reduce((t, r) => t + r.base_amount_cents, 0))} at the builder rate (no historical charge recreated)`,
      ...(w.deferral_schedules || []).map((s) => `- Release schedule: ${s.balance_account_number} to ${s.recognition_account_number}, ${usd(s.recognize_amount_cents)} over ${s.term_months} months from ${s.start_month} (${usd(s.monthly_amount_cents)}/month). ${s.explanation}`),
      ...(w.reconciling_items || []).map((i) => `- Reconciling item (carried separately, never folded in): ${i.kind === 'deferral_residue' ? `${usd(i.amount_cents)} in ${i.account_number} outside the release schedule` : `${(i.detail && i.detail.lot) || i.item_key}: ${(i.detail && i.detail.reason) || 'unresolved'} (${usd(i.amount_cents)} of activity)`}`),
    ] : []),
    `- GL cutover date: ${w.cutover_date.from || '(none)'} → ${w.cutover_date.to}`, '',
    `## Untouched: ${p.untouched.length} bridge items; ${p.summary.post_cutover_entries_preserved} post-cutover entries preserved`, '',
    '## Notes', ...(p.notes.length ? p.notes.map((n) => `- ${n.text}`) : ['_none_']), '',
    '## After EXECUTE, prove', ...p.proof_plan.map((x) => `- ${x.text}`), '',
    '## Rollback', `- ${p.rollback.before_commit}`, ...p.rollback.after_commit.map((x) => `- after commit: ${x}`), '',
    '## Idempotency', `- ${p.idempotency.retry_behavior}`,
  ];
  return L.join('\n');
}

module.exports = { FORMAT, FORMAT_V2, SECTIONS, buildPreflight, verifyPreflight, renderMarkdown, canonicalJson, buildConversionPreflight, preflightBase, renderConversionMarkdown };
