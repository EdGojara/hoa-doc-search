// ============================================================================
// lib/onboarding/conversion_objects.js  (Ed 2026-10-17) — adjustments, policies
// ----------------------------------------------------------------------------
// Three durable, SEPARATE conversion concepts (migration 535). They share one
// approval / audit trail (conversion_object_events) but never one table:
//
//   ADJUSTMENT  a balanced accounting transformation of the source position:
//               lines (account, cents, debit-positive), evidence (a document of
//               the batch + locator), a reason, a fingerprint computed BY THE
//               DATABASE over the content, and an owner approval of exactly that
//               fingerprint. Effect 'opening' rides in the opening entry (it may
//               never flip an account's sign); effect 'post_opening' is its own
//               entry dated the cutoff, after the opening (a declared sign change,
//               e.g. an equity normalization, is allowed only here).
//   POLICY      an approved NON-journal instruction: cutoff authority, legacy-
//               owner routing, suspense treatment, timing treatment, preserve
//               source coding. Same fingerprint + approval rules.
//   EXCEPTION   a detected discrepancy / ambiguity with its evidence,
//               classification, confidence, proposed resolution and status
//               (conversion_exceptions, extended by 535; see bridge.js).
//
// Nothing here names a community, an account or an amount: every fact comes from
// the batch's own records. Pure: no database client.
// ============================================================================
const crypto = require('crypto');

const ADJUSTMENT_KINDS = Object.freeze(['opening_correction', 'reclassification', 'equity_normalization', 'suspense_reclassification', 'conversion_transformation']);
const EFFECTS = Object.freeze(['opening', 'post_opening']);
const POLICY_KINDS = Object.freeze(['cutoff_authority', 'legacy_owner_routing', 'suspense_treatment', 'timing_treatment', 'preserve_source_coding', 'carried_balance', 'source_discrepancy', 'fund_allocation']);
const LIVE = new Set(['proposed', 'approved']);
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
const acctOf = (l) => String((l && l.account) || '').trim();

// ------------------------------------------------------------------ validation
function validateEvidence(ev, artifactShas, at) {
  const problems = [];
  if (!ev || !ev.description || !ev.locator) problems.push({ at, problem: 'evidence needs a description and a locator (where in the document)' });
  if (!ev || !ev.artifact_sha256 || !artifactShas.has(ev.artifact_sha256)) problems.push({ at, problem: 'the evidence document is not a source report or evidence document of this batch', needs: ['evidence_document'] });
  return problems;
}

function validateAdjustment(a, { artifactShas = new Set() } = {}) {
  const at = `adjustment ${a && a.adjustment_no != null ? a.adjustment_no : '(new)'}`; const problems = [];
  if (!a || !ADJUSTMENT_KINDS.includes(a.kind)) problems.push({ at, problem: `kind must be one of ${ADJUSTMENT_KINDS.join(', ')}` });
  if (!a || !EFFECTS.includes(a.effect)) problems.push({ at, problem: `effect must be one of ${EFFECTS.join(', ')}` });
  const lines = Array.isArray(a && a.lines) ? a.lines : [];
  if (lines.length < 2) problems.push({ at, problem: 'an adjustment needs at least two lines' });
  for (const l of lines) {
    if (!acctOf(l)) problems.push({ at, problem: 'every line needs an account' });
    if (!Number.isInteger(Number(l && l.amount_cents)) || Number(l.amount_cents) === 0) problems.push({ at, problem: `line ${acctOf(l) || '?'}: amount_cents must be a non-zero integer (debit positive)` });
  }
  const net = lines.reduce((t, l) => t + (Number(l && l.amount_cents) || 0), 0);
  if (net !== 0) problems.push({ at, problem: `lines must balance (debits = credits); they net to ${net}` });
  if (!a || String(a.reason || '').trim().length < 10) problems.push({ at, problem: 'a reason of at least 10 characters is required' });
  if (a && a.allow_sign_change && a.effect !== 'post_opening') problems.push({ at, problem: 'a sign change is allowed only for a post-opening adjustment (the opening entry always equals the source sign)' });
  for (const r of (a && a.resolves) || []) if (!r || !r.control || !r.account) problems.push({ at, problem: 'each resolved control names the control code and the account it concerns' });
  // Invoices an opening correction restores to AP at the cutoff: each identified by vendor + invoice NUMBER
  // (never by amount), dated on/before the cutoff, a positive amount; validated against the AP credit in the snapshot.
  const items = (a && a.open_ap_items) || [];
  if (items.length && a.effect !== 'opening') problems.push({ at, problem: 'open AP items ride only on an opening correction' });
  for (const it of items) if (!it || !String(it.vendor || '').trim() || !String(it.invoice_number || '').trim() || !isDate(it.invoice_date) || !Number.isInteger(Number(it.amount_cents)) || !(Number(it.amount_cents) > 0)) problems.push({ at, problem: 'each open AP item needs vendor, invoice_number, invoice_date and a positive amount_cents' });
  problems.push(...validateEvidence(a && a.evidence, artifactShas, at));
  return problems;
}

const POLICY_RULES = {
  cutoff_authority: (v, { cutoff }) => [
    ...(!v || !String(v.source_system || '').trim() ? ['source_system is required (the system that is the book of record)'] : []),
    ...(!v || !isDate(v.authoritative_through) ? ['authoritative_through must be a date'] : (cutoff && v.authoritative_through !== cutoff ? [`authoritative_through ${v.authoritative_through} must be the batch cutoff ${cutoff}`] : [])),
  ],
  legacy_owner_routing: (v) => [
    ...(!v || !['control_accounts', 'separate_accounts'].includes(v.presentation) ? ['presentation must be control_accounts (default: stay in the AR / prepaid control accounts, identified on legacy-owner records) or separate_accounts'] : []),
    ...(v && v.presentation === 'separate_accounts' && !(v.receivable_account && v.refund_account) ? ['separate_accounts needs receivable_account and refund_account'] : []),
    ...(v && v.presentation === 'separate_accounts' && String(v.community_requirement || '').trim().length < 10 ? ['separate_accounts is a community-specific accounting requirement: state it (community_requirement)'] : []),
  ],
  suspense_treatment: (v) => [
    ...(!v || !String(v.account || '').trim() ? ['account is required'] : []),
    ...(!v || String(v.label || '').trim().length < 10 ? ['label (at least 10 characters) is required: how the balance is presented'] : []),
    ...(v && v.allocate_to_owners !== false ? ['allocate_to_owners must be false: a suspense balance is never assigned to an owner'] : []),
  ],
  timing_treatment: (v) => [
    ...(!v || v.treatment !== 'record_on_cutover_date' ? ['treatment must be record_on_cutover_date'] : []),
    ...(!v || v.applies_to !== 'absent_from_source_created_after_cutover' ? ['applies_to must be absent_from_source_created_after_cutover'] : []),
    ...(!v || !Number.isInteger(v.max_days_before_cutoff) || v.max_days_before_cutoff < 1 || v.max_days_before_cutoff > 366 ? ['max_days_before_cutoff must be a whole number of days (1-366)'] : []),
  ],
  carried_balance: (v) => [
    ...(!v || !String(v.control || '').trim() ? ['control is required (the control the carried balance explains)'] : []),
    ...(!v || !String(v.reconciling_kind || '').trim() || !String(v.item_key || '').trim() ? ['reconciling_kind and item_key are required (the reconciling item the conversion carries)'] : []),
    ...(!v || !Number.isInteger(v.amount_cents) || v.amount_cents === 0 ? ['amount_cents must be the exact non-zero cents carried'] : []),
    ...(!v || String(v.label || '').trim().length < 10 ? ['label (at least 10 characters) is required: how the balance is carried'] : []),
  ],
  // The source trial balance itself is out of balance by an exact amount that sits in ONE
  // account, and the source balance sheet (which balances) shows that account's correct
  // figure. The account opens at the balance-sheet figure; the source amounts stay on record.
  source_discrepancy: (v) => [
    ...(!v || !String(v.account || '').trim() ? ['account is required (the one account the discrepancy sits in)'] : []),
    ...(!v || !Number.isInteger(v.amount_cents) || v.amount_cents === 0 ? ['amount_cents must be the exact non-zero cents (debit positive) that bring the account to the balance-sheet figure'] : []),
    ...(!v || v.basis !== 'balance_sheet' ? ['basis must be balance_sheet (the source balance sheet is the authority for the corrected figure)'] : []),
    ...(!v || String(v.label || '').trim().length < 10 ? ['label (at least 10 characters) is required: what the discrepancy is'] : []),
  ],
  // One account's opening split across funds exactly as the source's fund columns show it
  // (snapshot.validateFundAllocations checks the parts against the account's opening).
  fund_allocation: (v) => {
    const parts = v && Array.isArray(v.parts) ? v.parts : [];
    const codes = parts.map((x) => String((x && x.fund_code) || '').trim());
    return [
      ...(!v || !String(v.account || '').trim() ? ['account is required'] : []),
      ...(parts.length < 1 ? ['parts are required (fund_code + amount_cents for each fund)'] : []),
      ...(codes.some((c) => !c) || new Set(codes).size !== codes.length ? ['every part names one fund, once'] : []),
      ...(parts.some((x) => !Number.isInteger(x && x.amount_cents) || x.amount_cents === 0) ? ['every part needs a non-zero integer amount_cents'] : []),
      ...(!v || v.basis !== 'source_fund_columns' ? ['basis must be source_fund_columns (the split is read from the source, never chosen)'] : []),
    ];
  },
  preserve_source_coding: (v) => [
    ...(!v || !String(v.account || '').trim() ? ['account is required'] : []),
    ...(!v || String(v.note || '').trim().length < 10 ? ['note (at least 10 characters) is required'] : []),
  ],
};

function policyKey(p) {
  if (!p) return '';
  if (p.policy_kind === 'suspense_treatment' || p.policy_kind === 'preserve_source_coding' || p.policy_kind === 'source_discrepancy' || p.policy_kind === 'fund_allocation') return String((p.value && p.value.account) || '').trim();
  if (p.policy_kind === 'carried_balance') return `${String((p.value && p.value.control) || '').trim()}:${String((p.value && p.value.item_key) || '').trim()}`;
  return '';
}

function validatePolicy(p, { cutoff = null, artifactShas = new Set() } = {}) {
  const at = `policy ${p && p.policy_kind}`; const problems = [];
  if (!p || !POLICY_KINDS.includes(p.policy_kind)) return [{ at, problem: `policy_kind must be one of ${POLICY_KINDS.join(', ')}` }];
  for (const m of POLICY_RULES[p.policy_kind](p.value, { cutoff })) problems.push({ at, problem: m });
  if (String(p.reason || '').trim().length < 10) problems.push({ at, problem: 'a reason of at least 10 characters is required' });
  if (p.policy_kind === 'carried_balance' && !p.evidence) problems.push({ at, problem: 'a carried balance is source-supported: evidence is required' });
  if (p.policy_kind === 'fund_allocation' && !p.evidence) problems.push({ at, problem: 'a fund allocation is read from the source: evidence (the fund columns) is required' });
  if (p.policy_kind === 'source_discrepancy' && !p.evidence) problems.push({ at, problem: 'a source discrepancy is source-supported: evidence (the balance sheet) is required' });
  if (p.evidence) problems.push(...validateEvidence(p.evidence, artifactShas, at));
  return problems;
}

// --------------------------------------------------------------- the approved set
const approved = (list) => (list || []).filter((x) => x.status === 'approved');
const approvedAdjustments = (objs) => approved(objs && objs.adjustments).slice().sort((a, b) => Number(a.adjustment_no) - Number(b.adjustment_no));
const approvedPolicy = (objs, kind, key = '') => approved(objs && objs.policies).find((p) => p.policy_kind === kind && (p.policy_key || '') === key) || null;
const approvedPolicies = (objs, kind) => approved(objs && objs.policies).filter((p) => p.policy_kind === kind);

// The digest a stage result and EXECUTE bind to: the approved objects by type, id and the
// database fingerprint. Same formula as migration 535 (onboarding_conversion_objects_digest):
// sha256 of "type:id:fingerprint" joined by "," in byte order. Empty set -> sha256('').
function objectsDigest(objs, { scope = 'all' } = {}) {
  const pick = [];
  for (const a of approved(objs && objs.adjustments)) if (scope === 'all' || scope === 'source_controls' && (a.resolves || []).length || scope === 'snapshot' && a.effect === 'opening') pick.push(`adjustment:${a.id}:${a.fingerprint}`);
  for (const p of approved(objs && objs.policies)) if (scope === 'all' || (scope === 'snapshot' || scope === 'source_controls') && p.policy_kind === 'source_discrepancy' || scope === 'snapshot' && p.policy_kind === 'fund_allocation' || scope === 'snapshot' && p.policy_kind === 'legacy_owner_routing' || scope === 'activity_bridge' && p.policy_kind === 'timing_treatment') pick.push(`policy:${p.id}:${p.fingerprint}`);
  pick.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return crypto.createHash('sha256').update(pick.join(','), 'utf8').digest('hex');
}

// Approval label carried into snapshot inputs (who approved, when, through which channel).
const approvalOf = (o) => ({ approved_by: o.approved_by_label || o.approved_by_user_id, approved_at: String(o.approved_at || '').slice(0, 10), approval_channel: o.approval_channel, fingerprint: o.fingerprint, object_id: o.id });

// Approved OPENING adjustments, in the shape snapshot.buildSnapshot validates (opening_corrections).
function openingCorrections(objs) {
  return approvedAdjustments(objs).filter((a) => a.effect === 'opening').map((a) => ({
    lines: a.lines.map((l) => ({ account: acctOf(l), amount_cents: Number(l.amount_cents), ...(l.account_name ? { account_name: l.account_name } : {}) })),
    reason: a.reason, evidence: a.evidence, ...approvalOf(a), adjustment_no: a.adjustment_no, kind: a.kind,
    ...((a.open_ap_items || []).length ? { open_ap_items: a.open_ap_items.map((it) => ({ vendor: it.vendor, invoice_number: String(it.invoice_number), invoice_date: it.invoice_date, amount_cents: Number(it.amount_cents) })) } : {}),
  }));
}

// ------------------------------------------------- controls explained by a carried balance
// A preflight control that FAILS only because the conversion carries a balance it cannot
// reconcile (e.g. an unresolved builder position, a residue outside a release schedule) PASSES
// when EVERY one of its failures is explained by an approved carried-balance policy whose
// reconciling item exists with EXACTLY the same kind, key and cents, and the failure names
// that item. The item is still recorded open at EXECUTE (carried, labelled,
// never folded in). A missing, partial or mismatched policy explains nothing (no waiver).
function resolveCarriedBalances(controls, reconcilingItems, objs) {
  const pols = approvedPolicies(objs, 'carried_balance');
  if (!pols.length) return { controls, explained: [] };
  const explained = [];
  const out = controls.map((c) => {
    if (c.status !== 'FAIL' || !Array.isArray(c.failures) || !c.failures.length) return c;
    const mine = pols.filter((p) => p.value.control === c.code);
    if (!mine.length) return c;
    const used = new Set(); const by = []; const unexplained = [];
    for (const f of c.failures) {
      // The failure names its item structurally (a lot's property_id, an account, or an item_key).
      const key = String((f && (f.item_key || f.property_id || f.account)) || '');
      const hit = key && mine.find((p) => !used.has(p.id) && String(p.value.item_key) === key
        && (reconcilingItems || []).some((r) => r.kind === p.value.reconciling_kind && String(r.item_key) === key && Number(r.amount_cents) === Number(p.value.amount_cents)));
      if (hit) { used.add(hit.id); by.push({ policy_id: hit.id, fingerprint: hit.fingerprint, item_key: hit.value.item_key, amount_cents: hit.value.amount_cents, label: hit.value.label, evidence: hit.evidence, approved_by: hit.approved_by_label || hit.approved_by_user_id, approved_at: hit.approved_at }); }
      else unexplained.push(f);
    }
    if (unexplained.length) return { ...c, carried_balance_refused: `${unexplained.length} failure(s) not explained by an approved carried balance of exactly the same item and cents`, failures: c.failures };
    explained.push(...by.map((b) => ({ control: c.code, ...b })));
    return { ...c, status: 'PASS', label: `${c.label} (carried balance${by.length > 1 ? 's' : ''} approved: ${by.map((b) => b.item_key).join(', ')})`, failures: [], explained_by: by, source_failures: c.failures };
  });
  return { controls: out, explained };
}

// ------------------------------------------------- controls resolved by an adjustment
// A source control that compares a source report to a GL account FAILS by an exact
// difference. An approved adjustment that (a) declares it resolves that control on that
// account and (b) moves that account by EXACTLY the difference makes it PASS, citing the
// adjustment. A partial or larger move resolves nothing (no plug). The control's original
// amounts are kept in its detail. glEnd(account) is the source TB ending balance.
function resolveControls(controls, objs, { glEnd }) {
  const adjs = approvedAdjustments(objs);
  return controls.map((c) => {
    if (c.status !== 'FAIL' || !Number.isInteger(c.left_cents) || !Number.isInteger(c.right_cents)) return c;
    const claims = adjs.filter((a) => (a.resolves || []).some((r) => r.control === c.code));
    if (!claims.length) return c;
    const byAccount = new Map();
    for (const a of claims) for (const r of a.resolves.filter((x) => x.control === c.code)) {
      const moved = a.lines.filter((l) => acctOf(l) === String(r.account)).reduce((t, l) => t + Number(l.amount_cents), 0);
      if (!byAccount.has(String(r.account))) byAccount.set(String(r.account), { moved: 0, by: [] });
      const e = byAccount.get(String(r.account)); e.moved += moved; e.by.push({ adjustment_id: a.id, adjustment_no: a.adjustment_no, fingerprint: a.fingerprint, account: String(r.account), moved_cents: moved, approved_by: a.approved_by_label || a.approved_by_user_id, approved_at: a.approved_at });
    }
    if (byAccount.size !== 1) return Object.freeze({ ...c, detail: { ...(c.detail || {}), resolution_refused: 'adjustments claim this control on more than one account' } });
    const [[account, e]] = [...byAccount];
    const gl = glEnd(account);
    if (gl === null || gl === undefined) return Object.freeze({ ...c, detail: { ...(c.detail || {}), resolution_refused: `account ${account} is not in the source trial balance` } });
    // Which side of the control is the GL account, and with which sign it is presented.
    let side = null; let sign = 0;
    if (c.right_cents === gl) { side = 'right'; sign = 1; } else if (c.right_cents === -gl) { side = 'right'; sign = -1; } else if (c.left_cents === gl) { side = 'left'; sign = 1; } else if (c.left_cents === -gl) { side = 'left'; sign = -1; }
    if (!side) return Object.freeze({ ...c, detail: { ...(c.detail || {}), resolution_refused: `neither side of the control is GL ${account}` } });
    const left = side === 'left' ? c.left_cents + sign * e.moved : c.left_cents;
    const right = side === 'right' ? c.right_cents + sign * e.moved : c.right_cents;
    if (left !== right) return Object.freeze({ ...c, detail: { ...(c.detail || {}), resolution_refused: `the approved adjustment moves ${account} by ${e.moved}; the control differs by ${c.difference_cents} (a partial or larger move resolves nothing)`, resolving_candidates: e.by } });
    return Object.freeze({ ...c, status: 'PASS', label: `${c.label} (after approved adjustment ${e.by.map((b) => b.adjustment_no).join(', ')})`,
      left_cents: left, right_cents: right, difference_cents: 0,
      detail: { ...(c.detail || {}), resolved_by: e.by, source_left_cents: c.left_cents, source_right_cents: c.right_cents, source_difference_cents: c.difference_cents } });
  });
}

// ------------------------------------------------- source discrepancies
// Approved source discrepancies, in the shape snapshot.buildSnapshot validates.
function sourceDiscrepancies(objs) {
  return approvedPolicies(objs, 'source_discrepancy').map((p) => ({ account: String(p.value.account).trim(), amount_cents: Number(p.value.amount_cents), label: p.value.label,
    reason: p.reason, evidence: p.evidence, policy_id: p.id, ...approvalOf(p) }));
}

// Approved fund allocations, in the shape snapshot.validateFundAllocations checks.
function fundAllocations(objs) {
  return approvedPolicies(objs, 'fund_allocation').map((p) => ({ account: String(p.value.account).trim(),
    parts: p.value.parts.map((x) => ({ fund_code: String(x.fund_code).trim(), amount_cents: Number(x.amount_cents) })), reason: p.reason, evidence: p.evidence, policy_id: p.id, ...approvalOf(p) }));
}

// A source trial balance that does not net to zero FAILS the TB-balance controls, and the
// account the difference sits in FAILS its balance-sheet comparison. Approved source
// discrepancies resolve exactly those controls, and only when (a) together they bring the
// source TB to exactly zero and (b) each discrepancy brings its account exactly to the
// balance-sheet figure. Anything partial, larger or on another account resolves nothing.
// The source amounts stay in each control's detail; nothing about the source changes.
const TB_BALANCE_CONTROLS = ['gl.beginning_trial_balance_balances', 'gl.ending_trial_balance_balances'];
function resolveSourceDiscrepancies(controls, objs, { glEnd }) {
  const ds = sourceDiscrepancies(objs);
  if (!ds.length) return controls;
  const total = ds.reduce((t, d) => t + d.amount_cents, 0);
  const cite = ds.map((d) => ({ policy_id: d.policy_id, fingerprint: d.fingerprint, account: d.account, amount_cents: d.amount_cents, approved_by: d.approved_by, approved_at: d.approved_at }));
  return controls.map((c) => {
    if (c.status !== 'FAIL' || !Number.isInteger(c.left_cents) || !Number.isInteger(c.right_cents)) return c;
    if (TB_BALANCE_CONTROLS.includes(c.code)) {
      if (c.left_cents + total !== c.right_cents) return Object.freeze({ ...c, detail: { ...(c.detail || {}), resolution_refused: `the approved source discrepancies total ${total}; the trial balance is out by ${c.left_cents - c.right_cents}` } });
      return Object.freeze({ ...c, status: 'PASS', label: `${c.label} (source out of balance by ${c.left_cents - c.right_cents}; approved source discrepancy on ${ds.map((d) => d.account).join(', ')})`,
        left_cents: c.left_cents + total, difference_cents: 0, detail: { ...(c.detail || {}), resolved_by_source_discrepancy: cite, source_left_cents: c.left_cents, source_right_cents: c.right_cents, source_difference_cents: c.difference_cents } });
    }
    const m = /^vantaca\.bs_vs_gl\.(.+)$/.exec(c.code);
    const d = m && ds.find((x) => x.account === m[1]);
    if (!d) return c;
    const gl = glEnd(d.account);
    if (gl === null || gl === undefined) return Object.freeze({ ...c, detail: { ...(c.detail || {}), resolution_refused: `account ${d.account} is not in the source trial balance` } });
    // The GL side (right) presents the account as +gl or -gl (credit-positive for liabilities / equity), plus any P&L.
    const carried = c.detail && Number.isInteger(c.detail.gl_carried_cents) ? c.detail.gl_carried_cents : c.right_cents;
    const sign = carried === gl ? 1 : carried === -gl ? -1 : 0;
    if (!sign) return Object.freeze({ ...c, detail: { ...(c.detail || {}), resolution_refused: `the GL side of the control is not GL ${d.account}` } });
    const right = c.right_cents + sign * d.amount_cents;
    if (right !== c.left_cents) return Object.freeze({ ...c, detail: { ...(c.detail || {}), resolution_refused: `the approved source discrepancy moves ${d.account} by ${d.amount_cents}; the balance sheet differs by ${c.difference_cents}` } });
    return Object.freeze({ ...c, status: 'PASS', label: `${c.label} (after the approved source discrepancy on ${d.account})`, right_cents: right, difference_cents: 0,
      detail: { ...(c.detail || {}), resolved_by_source_discrepancy: cite.filter((x) => x.account === d.account), source_left_cents: c.left_cents, source_right_cents: c.right_cents, source_difference_cents: c.difference_cents } });
  });
}

// ------------------------------------------------- before / after per adjustment
// The permanent audit chain: source state -> approved transformation -> resulting
// state. "before" is the cutoff position of every touched account just before this
// adjustment (source TB + the earlier adjustments in order); "after" adds its lines.
function adjustmentChain(objs, sourceTb) {
  const running = new Map(sourceTb);
  return approvedAdjustments(objs).slice().sort((a, b) => (a.effect === b.effect ? Number(a.adjustment_no) - Number(b.adjustment_no) : a.effect === 'opening' ? -1 : 1)).map((a) => {
    const touched = [...new Set(a.lines.map(acctOf))].sort();
    const before = Object.fromEntries(touched.map((x) => [x, running.get(x) || 0]));
    for (const l of a.lines) running.set(acctOf(l), (running.get(acctOf(l)) || 0) + Number(l.amount_cents));
    const after = Object.fromEntries(touched.map((x) => [x, running.get(x) || 0]));
    const flips = touched.filter((x) => before[x] !== 0 && after[x] !== 0 && Math.sign(before[x]) !== Math.sign(after[x]));
    return { adjustment_id: a.id, adjustment_no: a.adjustment_no, kind: a.kind, effect: a.effect, fingerprint: a.fingerprint, approved_by: a.approved_by_label || a.approved_by_user_id, approved_at: a.approved_at,
      lines: a.lines.map((l) => ({ account: acctOf(l), amount_cents: Number(l.amount_cents) })), before, after, sign_changes: flips, allow_sign_change: !!a.allow_sign_change };
  });
}

module.exports = { ADJUSTMENT_KINDS, EFFECTS, POLICY_KINDS, LIVE, validateAdjustment, validatePolicy, policyKey, approvedAdjustments, approvedPolicy, approvedPolicies, objectsDigest, openingCorrections, resolveControls, resolveCarriedBalances, adjustmentChain, approvalOf, sourceDiscrepancies, resolveSourceDiscrepancies, fundAllocations };
