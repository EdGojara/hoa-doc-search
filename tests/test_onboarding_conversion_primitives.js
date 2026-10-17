// ============================================================================
// tests/test_onboarding_conversion_primitives.js  (Ed 2026-10-17) — migration 535 primitives
// ----------------------------------------------------------------------------
// Pure, synthetic (no client data, no database). Proves:
//   - cutoff-aware history: a history that runs past the cutoff is sliced to it, every
//     account rolls forward exactly; a broken roll-forward FAILS and slices nothing; a report
//     dated at the cutoff is untouched; a report starting after the cutoff is refused;
//   - the persisted normalized source: facts round-trip exactly; a changed / missing / extra
//     fact fails verification;
//   - adjustments and policies: validation (balance, evidence, sign change only post-opening,
//     suspense never allocated, separate legacy accounts need a stated requirement, cutoff
//     authority = the batch cutoff); only APPROVED objects act;
//   - an approved EXACT correction turns a failed source control into PASS citing itself; a
//     partial or larger move, or an unapproved one, resolves nothing (no plug, no waiver);
//   - the objects digest formula and its scopes; the audit chain's before / after / sign changes;
//   - activity bridge: counterparty-corroborated match; unique line without a counterparty;
//     a different counterparty is NOT a match; two candidate lines are NOT a match; a twin is a
//     duplicate candidate; timing by an approved policy only (entered after the cutover, inside
//     the window); every item carries its resolution;
//   - a carried balance passes a control only when exact, approved and evidenced (partial,
//     mismatched or unapproved: FAIL); an opening correction carries the open AP it restores;
//   - the service fails closed, naming migration 535, when the 535 functions are missing; an
//     approval needs the owner AND the in-app channel;
//   - the preflight plans with the batch's own source system, never an assumed one (the
//     behaviour, including a non-Vantaca source, is proven in tests/sql/535_conversion_primitives_e2e.mjs).
// ============================================================================
const assert = require('assert');
const crypto = require('crypto');
const SP = require('../lib/onboarding/source_period');
const SF = require('../lib/onboarding/source_facts');
const OBJ = require('../lib/onboarding/conversion_objects');
const { buildBridge } = require('../lib/onboarding/bridge');
const { createOnboardingService } = require('../lib/onboarding/service');
const C = require('../lib/onboarding/controls');

let pass = 0, fail = 0; const pending = [];
const check = (name, fn) => pending.push(async () => { try { await fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.log('  ✗', name, '\n     ', e.message); } });
const prov = (n) => ({ artifact_sha256: 'a'.repeat(64), locator: { line: n }, raw: `line ${n}` });
const CUT = '2026-03-31';

// ------------------------------------------------------------- cutoff-aware history
const history = (rows, { end = '2026-05-15', start = '2026-01-01' } = {}) => ({ homeowner_transactions: { artifact_type: 'homeowner_transactions', period: { start, end }, defects: [], printed: {}, rows } });
const acct = (k, opening, ending) => ({ domain: 'homeowner_account', source_account_key: k, as_of: '2026-05-15', opening_cents: opening, ending_cents: ending, row_count: 0, provenance: prov(1) });
const txn = (k, date, charge, payment, bal, n) => ({ domain: 'homeowner_txn', source_account_key: k, date, charge_cents: charge, payment_cents: payment, balance_cents: bal, provenance: prov(n) });
check('a history running past the cutoff is sliced to it: rows after the cutoff dropped, the ending is the balance AT the cutoff, the slice is recorded', () => {
  const p = history([acct('A1', 100, 900), txn('A1', '2026-01-01', 0, 0, 100, 2), txn('A1', '2026-02-01', 500, 0, 600, 3), txn('A1', '2026-03-10', 0, -200, 400, 4), txn('A1', '2026-04-01', 500, 0, 900, 5)]);
  const r = SP.sliceToCutoff(p, CUT);
  const a = r.parsed.homeowner_transactions.rows.find((x) => x.domain === 'homeowner_account');
  assert.strictEqual(a.ending_cents, 400); assert.strictEqual(a.as_of, CUT); assert.strictEqual(a.sliced_from_as_of, '2026-05-15'); assert.strictEqual(a.printed_ending_cents, 900);
  assert.strictEqual(r.parsed.homeowner_transactions.rows.filter((x) => x.domain === 'homeowner_txn').length, 3);
  assert.strictEqual(r.parsed.homeowner_transactions.period.end, CUT);
  assert.deepStrictEqual([r.slices[0].rows_kept, r.slices[0].rows_after_cutoff, r.slices[0].printed_end], [3, 1, '2026-05-15']);
  assert.strictEqual(r.controls[0].status, 'PASS');
});
check('an account that does not roll forward to the cutoff FAILS and NOTHING is sliced (never guessed)', () => {
  const p = history([acct('A1', 100, 900), txn('A1', '2026-02-01', 500, 0, 650, 3), txn('A1', '2026-04-01', 250, 0, 900, 5)]);
  const r = SP.sliceToCutoff(p, CUT);
  assert.strictEqual(r.controls[0].status, 'FAIL'); assert.strictEqual(r.slices.length, 0); assert.strictEqual(r.parsed, p);
});
check('a report dated at the cutoff is untouched (no slice, no control); a report starting after the cutoff is refused', () => {
  const at = history([acct('A1', 0, 0)], { end: CUT });
  const r = SP.sliceToCutoff(at, CUT); assert.strictEqual(r.parsed, at); assert.strictEqual(r.controls.length, 0);
  const late = history([acct('A1', 0, 0), txn('A1', '2026-04-02', 1, 0, 1, 2)], { start: '2026-04-01' });
  const r2 = SP.sliceToCutoff(late, CUT); assert.strictEqual(r2.controls[0].status, 'FAIL');
  assert.ok(!SP.isSliceable({ rows: [{ domain: 'gl_account_balance' }] }));
});

// ------------------------------------------------------------- persisted normalized source
check('facts round-trip exactly; a changed, missing or extra fact fails verification', () => {
  const p = { ...history([acct('A1', 100, 400), txn('A1', '2026-01-01', 0, 0, 100, 2)], { end: CUT }), gl_trial_balance: { artifact_type: 'gl_trial_balance', period: { start: '2026-01-01', end: CUT }, defects: [], printed: { x: 1 }, rows: [{ domain: 'gl_account_balance', account_code: '1000', ending_cents: 5, provenance: prov(9) }] } };
  const f = SF.factsFromParsed(p, { cutoff: CUT });
  const stored = JSON.parse(JSON.stringify(f.facts));
  assert.ok(SF.verifyFacts(stored, f).ok);
  assert.strictEqual(require('../lib/onboarding/preflight').canonicalJson(SF.parsedFromFacts(stored)), require('../lib/onboarding/preflight').canonicalJson(p));
  const changed = JSON.parse(JSON.stringify(stored)); changed[1].fact.ending_cents = 6;
  assert.ok(!SF.verifyFacts(changed, f).ok);
  assert.ok(!SF.verifyFacts(stored.slice(1), f).ok);
  assert.ok(!SF.verifyFacts([...stored, { ...stored[0], seq: stored.length + 1 }], f).ok);
});

// ------------------------------------------------------------- adjustments / policies
const EV = { description: 'GL trial balance', artifact_sha256: 'a'.repeat(64), locator: 'account 2000' };
const SHAS = new Set(['a'.repeat(64)]);
const adj = (o = {}) => ({ id: 'adj1', adjustment_no: 1, kind: 'opening_correction', effect: 'opening', allow_sign_change: false, lines: [{ account: '3050', amount_cents: 100 }, { account: '2000', amount_cents: -100 }], resolves: [{ control: 'ap.total_equals_gl', account: '2000' }], reason: 'a reason of enough length', evidence: EV, fingerprint: 'f'.repeat(64), status: 'approved', approved_by_label: 'owner@example.test', approved_at: '2026-10-17', approval_channel: 'in_app', ...o });
check('adjustment validation: balanced, evidenced by a document of the batch, sign change only post-opening', () => {
  assert.deepStrictEqual(OBJ.validateAdjustment(adj(), { artifactShas: SHAS }), []);
  assert.ok(OBJ.validateAdjustment(adj({ lines: [{ account: '1', amount_cents: 5 }, { account: '2', amount_cents: -4 }] }), { artifactShas: SHAS }).some((p) => /balance/.test(p.problem)));
  assert.ok(OBJ.validateAdjustment(adj({ evidence: { ...EV, artifact_sha256: 'b'.repeat(64) } }), { artifactShas: SHAS }).some((p) => /not a source report/.test(p.problem)));
  assert.ok(OBJ.validateAdjustment(adj({ allow_sign_change: true }), { artifactShas: SHAS }).some((p) => /post-opening/.test(p.problem)));
});
check('policy validation: suspense never allocated; separate legacy accounts need a stated requirement; cutoff authority = the batch cutoff; timing window bounded', () => {
  const pol = (kind, value) => ({ policy_kind: kind, value, reason: 'a reason of enough length' });
  assert.ok(OBJ.validatePolicy(pol('suspense_treatment', { account: '2310', label: 'labelled suspense carried', allocate_to_owners: true })).length);
  assert.deepStrictEqual(OBJ.validatePolicy(pol('suspense_treatment', { account: '2310', label: 'labelled suspense carried', allocate_to_owners: false })), []);
  assert.ok(OBJ.validatePolicy(pol('legacy_owner_routing', { presentation: 'separate_accounts', receivable_account: '1310', refund_account: '2410' })).some((p) => /community-specific/.test(p.problem)));
  assert.deepStrictEqual(OBJ.validatePolicy(pol('legacy_owner_routing', { presentation: 'control_accounts' })), []);
  assert.ok(OBJ.validatePolicy(pol('cutoff_authority', { source_system: 'x', authoritative_through: '2026-02-28' }), { cutoff: CUT }).length);
  assert.ok(OBJ.validatePolicy(pol('timing_treatment', { treatment: 'record_on_cutover_date', applies_to: 'absent_from_source_created_after_cutover', max_days_before_cutoff: 900 })).length);
});
const apCtl = () => C.equals('ap.total_equals_gl', { label: 'AP aging = GL AP', left: 150382, right: 140382 });
const glEnd = (a) => ({ 2000: -140382 }[a] ?? null);
check('an approved EXACT correction turns the failed control into PASS, citing itself and keeping the source amounts (no waiver)', () => {
  const [c] = OBJ.resolveControls([apCtl()], { adjustments: [adj({ lines: [{ account: '3050', amount_cents: 10000 }, { account: '2000', amount_cents: -10000 }] })] }, { glEnd });
  assert.strictEqual(c.status, 'PASS'); assert.strictEqual(c.difference_cents, 0);
  assert.strictEqual(c.detail.resolved_by[0].adjustment_no, 1); assert.strictEqual(c.detail.source_difference_cents, 10000);
});
check('a partial or larger move, or an unapproved correction, resolves NOTHING (no plug)', () => {
  for (const cents of [5000, 12000]) {
    const [c] = OBJ.resolveControls([apCtl()], { adjustments: [adj({ lines: [{ account: '3050', amount_cents: cents }, { account: '2000', amount_cents: -cents }] })] }, { glEnd });
    assert.strictEqual(c.status, 'FAIL'); assert.ok(/resolves nothing/.test(c.detail.resolution_refused));
  }
  const [u] = OBJ.resolveControls([apCtl()], { adjustments: [adj({ status: 'proposed', lines: [{ account: '3050', amount_cents: 10000 }, { account: '2000', amount_cents: -10000 }] })] }, { glEnd });
  assert.strictEqual(u.status, 'FAIL');
});
check('the objects digest: sha256 of "type:id:fingerprint" (approved only) in byte order; scopes pick only what a stage uses', () => {
  const objs = { adjustments: [adj({ id: 'b-adj', fingerprint: '1'.repeat(64) }), adj({ id: 'a-adj', effect: 'post_opening', resolves: [], fingerprint: '2'.repeat(64) }), adj({ id: 'p', status: 'proposed' })],
    policies: [{ id: 'pol', policy_kind: 'timing_treatment', fingerprint: '3'.repeat(64), status: 'approved' }] };
  const want = crypto.createHash('sha256').update(['adjustment:a-adj:' + '2'.repeat(64), 'adjustment:b-adj:' + '1'.repeat(64), 'policy:pol:' + '3'.repeat(64)].join(',')).digest('hex');
  assert.strictEqual(OBJ.objectsDigest(objs), want);
  assert.strictEqual(OBJ.objectsDigest(objs, { scope: 'activity_bridge' }), crypto.createHash('sha256').update('policy:pol:' + '3'.repeat(64)).digest('hex'));
  assert.strictEqual(OBJ.objectsDigest(objs, { scope: 'snapshot' }), crypto.createHash('sha256').update('adjustment:b-adj:' + '1'.repeat(64)).digest('hex'));
  assert.strictEqual(OBJ.objectsDigest({ adjustments: [], policies: [] }), crypto.createHash('sha256').update('').digest('hex'));
});
check('the audit chain: opening adjustments first, then post-opening, each with before / after; a sign change is named', () => {
  const objs = { adjustments: [adj({ id: 'x2', adjustment_no: 2, effect: 'post_opening', allow_sign_change: true, lines: [{ account: '3000', amount_cents: 6000 }, { account: '3050', amount_cents: -6000 }] }), adj({ id: 'x1' })] };
  const ch = OBJ.adjustmentChain(objs, new Map([['2000', -500], ['3000', -6000], ['3050', 1000]]));
  assert.deepStrictEqual(ch.map((c) => c.adjustment_no), [1, 2]);
  assert.deepStrictEqual([ch[0].before['2000'], ch[0].after['2000'], ch[1].before['3050'], ch[1].after['3050']], [-500, -600, 1100, -4900]);
  assert.deepStrictEqual(ch[1].sign_changes, ['3050']);
});

// ------------------------------------------------------------- activity bridge rules
const glRow = (n, date, account, dr, cr, description) => ({ domain: 'gl_transaction', date, account_code: account, debit_cents: dr, credit_cents: cr, description, source_type: 'Payment', provenance: prov(n) });
const parsedSrc = (rows) => ({ gl_trial_balance: { rows }, balance_sheet: { rows: [{ domain: 'statement_line', account_code: '1000', section: 'assets', amount_cents: 1 }, { domain: 'statement_line', account_code: '2000', section: 'liabilities', amount_cents: 1 }] } });
const acctOf = (id) => ({ cash: '1000', ap: '2000', util: '5120', ar: '1300' }[id] || null);
const je = (id, date, module, amt, created = '2026-02-01T00:00:00Z') => ({ id, posting_date: date, source_module: module, status: 'posted', total_debits_cents: amt, total_credits_cents: amt, description: '', reference: id, superseded_at: null, created_at: created });
const ln = (j, acct, dr, cr, vendor = null) => ({ id: `${j}-${acct}-${dr}-${cr}`, journal_entry_id: j, account_id: acct, debit_cents: dr, credit_cents: cr, vendor_id: vendor });
const T = (jes, lines, extra = {}) => ({ journal_entries: jes, journal_entry_lines: lines, ap_invoices: [], ap_payments: [], ar_charges: [], ar_payments: [], payments: [], homeowner_transactions: [], ...extra });
const bridge = (src, t, opts = {}) => buildBridge(parsedSrc(src), t, { batch_code: 'B', cutoff_date: CUT, roles: { ar_account: '1300', prepaid_account: '2400', ap_account: '2000' }, snapshot: { completion_id: 's' }, accountNumber: acctOf,
  vendorNames: (id) => ({ v1: ['Acme Utility, LLC'], v2: ['Other Company'] }[id] || []), ...opts });
const byKey = (b, id) => b.items.find((x) => x.event_key === `je:${id}`);
check('counterparty-corroborated: same vendor, account, side and cents within the window -> already in source (high), source line cited', () => {
  const b = bridge([glRow(1, '2026-03-12', '1000', 0, 2914, 'Acme Utility - Period 02/2026')],
    T([je('p1', '2026-03-12', 'payment_intake', 2914)], [ln('p1', 'ap', 2914, 0, 'v1'), ln('p1', 'cash', 0, 2914, 'v1')]));
  const it = byKey(b, 'p1');
  assert.strictEqual(it.classification, 'ALREADY_IN_SOURCE'); assert.strictEqual(it.method, 'corroborated_counterparty_line_in_source'); assert.strictEqual(it.confidence, 'high');
  assert.strictEqual(it.evidence.resolution, 'already_in_source'); assert.strictEqual(it.evidence.source_match.date, '2026-03-12');
});
check('a DIFFERENT counterparty on the same amount is not a match (stays for a person)', () => {
  const b = bridge([glRow(1, '2026-03-12', '1000', 0, 2914, 'Acme Utility - Period 02/2026')],
    T([je('p1', '2026-03-12', 'payment_intake', 2914)], [ln('p1', 'ap', 2914, 0, 'v2'), ln('p1', 'cash', 0, 2914, 'v2')]));
  assert.notStrictEqual(byKey(b, 'p1').classification, 'ALREADY_IN_SOURCE');
});
check('no counterparty: the ONLY source line with that account, side and cents in the window matches (medium); two candidate lines match nothing', () => {
  const one = bridge([glRow(1, '2026-03-11', '1000', 0, 30548, 'Utility - Period 05')], T([je('m1', '2026-03-08', 'manual', 30548)], [ln('m1', 'util', 30548, 0), ln('m1', 'cash', 0, 30548)]));
  assert.strictEqual(byKey(one, 'm1').method, 'corroborated_unique_line_in_source'); assert.strictEqual(byKey(one, 'm1').confidence, 'medium');
  const two = bridge([glRow(1, '2026-03-11', '1000', 0, 30548, 'Utility - A'), glRow(2, '2026-03-12', '1000', 0, 30548, 'Utility - B')], T([je('m1', '2026-03-10', 'manual', 30548)], [ln('m1', 'util', 30548, 0), ln('m1', 'cash', 0, 30548)]));
  assert.notStrictEqual(byKey(two, 'm1').classification, 'ALREADY_IN_SOURCE');
});
check('a Trusted twin of a matched entry is a DUPLICATE CANDIDATE citing its twin (the closer date wins the source line)', () => {
  const b = bridge([glRow(1, '2026-03-11', '1000', 0, 35343, 'Utility - Period 05')],
    T([je('m8', '2026-03-08', 'manual', 35343), je('m11', '2026-03-11', 'manual', 35343)], [ln('m8', 'util', 35343, 0), ln('m8', 'cash', 0, 35343), ln('m11', 'util', 35343, 0), ln('m11', 'cash', 0, 35343)]));
  assert.strictEqual(byKey(b, 'm11').method, 'corroborated_unique_line_in_source');
  assert.strictEqual(byKey(b, 'm8').method, 'corroborated_duplicate_of_trusted_entry'); assert.strictEqual(byKey(b, 'm8').evidence.twin_event, 'je:m11');
  assert.strictEqual(byKey(b, 'm8').evidence.resolution, 'duplicate_candidate');
  assert.ok(b.controls.find((c) => c.code === 'bridge.no_duplicate_on_amount_alone').status === 'PASS');
});
const TIMING = { id: 'pol-t', fingerprint: 't'.repeat(64), value: { treatment: 'record_on_cutover_date', applies_to: 'absent_from_source_created_after_cutover', max_days_before_cutoff: 31 }, approved_by_label: 'owner@example.test', approved_at: '2026-10-17' };
const lateBill = (date, created) => T([je('i1', date, 'ap_invoice', 36853, created)], [ln('i1', 'util', 36853, 0), ln('i1', 'ap', 0, 36853)]);
check('timing: a bill the source never held, entered in Trusted AFTER the cutover and dated inside the window, is recorded on the cutover date by the approved POLICY (cited)', () => {
  const it = byKey(bridge([], lateBill('2026-03-22', '2026-05-09T00:00:00Z'), { timingPolicy: TIMING }), 'i1');
  assert.strictEqual(it.classification, 'AMBIGUOUS'); assert.strictEqual(it.evidence.resolution, 'timing');
  assert.strictEqual(it.evidence.decision.recorded.via, 'policy'); assert.strictEqual(it.evidence.decision.recorded.policy_id, 'pol-t');
});
check('timing never applies without the approved policy, to a bill entered BEFORE the cutover, or outside the window: those reach the owner', () => {
  assert.strictEqual(byKey(bridge([], lateBill('2026-03-22', '2026-05-09T00:00:00Z')), 'i1').evidence.resolution, 'needs_owner');
  assert.strictEqual(byKey(bridge([], lateBill('2026-03-22', '2026-03-28T00:00:00Z'), { timingPolicy: TIMING }), 'i1').evidence.resolution, 'needs_owner');
  assert.strictEqual(byKey(bridge([], lateBill('2026-01-15', '2026-05-09T00:00:00Z'), { timingPolicy: TIMING }), 'i1').evidence.resolution, 'needs_owner');
});

// ------------------------------------------------------------- service: fail closed
check('the service fails closed, naming migration 535, when the 535 functions are missing', async () => {
  const rpc = async (name) => { if (name === 'onboarding_batch_view') return null; const e = new Error(`function ${name}(...) does not exist`); e.code = '42883'; throw e; };
  const svc = createOnboardingService({ rpc, storage: { putOnce: async () => {}, get: async () => Buffer.alloc(0) } });
  const view = { batch: { id: 'b', as_of_date: CUT, source_system: 'vantaca' }, latest_by_stage: { normalize: { completion_id: 'n' } }, artifacts: [] };
  await assert.rejects(() => svc.loadSource(view), (e) => e.code === 'SCHEMA_NOT_APPLIED' && /535_conversion_primitives\.sql/.test(e.message));
  await assert.rejects(() => svc.listObjects('b'), (e) => e.code === 'SCHEMA_NOT_APPLIED' && /535/.test(e.message));
});
check('an approval needs the signed-in OWNER and the in-app channel (the service refuses before any call)', async () => {
  let called = false; const svc = createOnboardingService({ rpc: async () => { called = true; return null; }, storage: { putOnce: async () => {}, get: async () => Buffer.alloc(0) } });
  const fp = 'f'.repeat(64);
  await assert.rejects(() => svc.decideObject({ kind: 'human', id: 's', role: 'admin' }, 'b', { object_type: 'adjustment', id: 'x', decision: 'approved', fingerprint: fp, channel: 'in_app' }), (e) => e.code === 'OWNER_ONLY');
  await assert.rejects(() => svc.decideObject({ kind: 'system', id: 'onboarding-operator' }, 'b', { object_type: 'adjustment', id: 'x', decision: 'approved', fingerprint: fp, channel: 'in_app' }), (e) => e.code === 'OWNER_ONLY');
  await assert.rejects(() => svc.decideObject({ kind: 'human', id: 'o', role: 'owner' }, 'b', { object_type: 'adjustment', id: 'x', decision: 'approved', fingerprint: fp }), (e) => e.code === 'IN_APP_ONLY');
  assert.strictEqual(called, false);
});

check('a plan that needs the 536 EXECUTE writes is refused while 536 is not applied; a plan that needs none never asks', async () => {
  const calls = [];
  const missing = createOnboardingService({ rpc: async (name) => { calls.push(name); const e = new Error(`function ${name}() does not exist`); e.code = '42883'; throw e; }, storage: { putOnce: async () => {}, get: async () => Buffer.alloc(0) } });
  assert.ok(/536_conversion_execute_establishment\.sql/.test(await missing.executeSupportsPlan({ establishments: [{}] })));
  assert.ok(/536/.test(await missing.executeSupportsPlan({ adjustment_journal_entries: [{}] })));
  assert.strictEqual(await missing.executeSupportsPlan({ establishments: [], legacy_tenures: [] }), null);
  assert.deepStrictEqual(calls, ['onboarding_execute_capabilities', 'onboarding_execute_capabilities']);
  const present = createOnboardingService({ rpc: async () => ['initial_ownership'], storage: { putOnce: async () => {}, get: async () => Buffer.alloc(0) } });
  assert.strictEqual(await present.executeSupportsPlan({ legacy_tenures: [{}] }), null);
});

// ------------------------------------------------------------- carried balances (no waiver)
{
  const EV = { artifact_sha256: 'e'.repeat(64), locator: { page: 1 }, description: 'source aging line for the item' };
  const items = [
    { kind: 'builder_position_unresolved', item_key: 'lot-1', amount_cents: 9018 },
    { kind: 'deferral_residue', item_key: '2205', amount_cents: 200 },
  ];
  const builderCtl = () => ({ code: 'preflight.builder_positions_resolved', label: 'builder', status: 'FAIL', failures: [{ lot: '1 Main', property_id: 'lot-1', problem: 'unresolved', rows: [] }] });
  const deferCtl = () => ({ code: 'preflight.deferral_schedule_reconciles', label: 'deferral', status: 'FAIL', failures: [{ account: '2205', residue_cents: 200, problem: 'residue' }] });
  const cbp = (over = {}) => ({ id: over.id || 'cb1', policy_kind: 'carried_balance', status: 'approved', fingerprint: 'c'.repeat(64), approved_by_label: 'Owner', approved_at: '2026-10-17T00:00:00Z', evidence: EV,
    value: { control: 'preflight.builder_positions_resolved', reconciling_kind: 'builder_position_unresolved', item_key: 'lot-1', amount_cents: 9018, label: 'builder position carried as a reconciling item', ...(over.value || {}) }, ...over, ...(over.value ? { value: { control: 'preflight.builder_positions_resolved', reconciling_kind: 'builder_position_unresolved', item_key: 'lot-1', amount_cents: 9018, label: 'builder position carried as a reconciling item', ...over.value } } : {}) });

  check('carried balance: an exact, approved, evidenced policy PASSES the control and cites the policy + evidence', () => {
    const { controls, explained } = OBJ.resolveCarriedBalances([builderCtl(), deferCtl()], items, { policies: [cbp(), cbp({ id: 'cb2', value: { control: 'preflight.deferral_schedule_reconciles', reconciling_kind: 'deferral_residue', item_key: '2205', amount_cents: 200 } })] });
    assert.deepStrictEqual(controls.map((c) => c.status), ['PASS', 'PASS']);
    assert.strictEqual(controls[0].explained_by[0].policy_id, 'cb1');
    assert.strictEqual(controls[0].explained_by[0].evidence.artifact_sha256, 'e'.repeat(64));
    assert.strictEqual(controls[0].source_failures.length, 1);
    assert.strictEqual(explained.length, 2);
  });
  check('carried balance: wrong cents, wrong item, wrong kind, unapproved, or another control explains nothing (FAIL stays)', () => {
    for (const over of [{ value: { amount_cents: 9000 } }, { value: { item_key: 'lot-2' } }, { value: { reconciling_kind: 'deferral_residue' } }, { status: 'proposed' }, { value: { control: 'preflight.other' } }]) {
      const { controls, explained } = OBJ.resolveCarriedBalances([builderCtl()], items, { policies: [cbp(over)] });
      assert.strictEqual(controls[0].status, 'FAIL', JSON.stringify(over)); assert.strictEqual(explained.length, 0);
    }
  });
  check('carried balance: partial (one of two failures explained) leaves the control FAIL', () => {
    const two = { ...builderCtl(), failures: [...builderCtl().failures, { lot: '2 Main', property_id: 'lot-2', problem: 'unresolved', rows: [] }] };
    const { controls } = OBJ.resolveCarriedBalances([two], [...items, { kind: 'builder_position_unresolved', item_key: 'lot-2', amount_cents: 500 }], { policies: [cbp()] });
    assert.strictEqual(controls[0].status, 'FAIL'); assert.ok(/1 failure/.test(controls[0].carried_balance_refused));
  });
  check('carried balance: a BLOCKED control is never passed by a policy', () => {
    const { controls } = OBJ.resolveCarriedBalances([{ ...builderCtl(), status: 'BLOCKED' }], items, { policies: [cbp()] });
    assert.strictEqual(controls[0].status, 'BLOCKED');
  });
  check('carried balance: validation requires control, item, exact non-zero cents, a label and evidence', () => {
    const shas = new Set(['e'.repeat(64)]);
    const ok = { policy_kind: 'carried_balance', reason: 'a reason of enough length', evidence: EV, value: cbp().value };
    assert.deepStrictEqual(OBJ.validatePolicy(ok, { artifactShas: shas }), []);
    assert.strictEqual(OBJ.policyKey(ok), 'preflight.builder_positions_resolved:lot-1');
    assert.ok(OBJ.validatePolicy({ ...ok, evidence: undefined }, { artifactShas: shas }).some((p) => /evidence is required/.test(p.problem)));
    assert.ok(OBJ.validatePolicy({ ...ok, value: { ...ok.value, amount_cents: 90.18 } }, { artifactShas: shas }).length);
    assert.ok(OBJ.validatePolicy({ ...ok, value: { ...ok.value, item_key: '' } }, { artifactShas: shas }).length);
  });
}

// ------------------------------------------------------------- an opening correction restores open AP
check('opening correction: open AP items validate (number, date, positive cents; opening only) and ride into the snapshot shape', () => {
  const EV = { artifact_sha256: 'f'.repeat(64), locator: { page: 1 }, description: 'the vendor invoice' };
  const base = { kind: 'opening_correction', effect: 'opening', reason: 'an invoice omitted from the legacy AP', evidence: EV,
    lines: [{ account: '5250', amount_cents: 72000 }, { account: '2000', amount_cents: -72000 }],
    open_ap_items: [{ vendor: 'Vendor LLC', invoice_number: '4654', invoice_date: '2026-02-25', amount_cents: 72000 }] };
  const shas = new Set(['f'.repeat(64)]);
  const probs = (a) => OBJ.validateAdjustment(a, { artifactShas: shas }).map((p) => p.problem).join(' | ');
  assert.ok(!/open AP/.test(probs(base)), probs(base));
  assert.ok(/open AP items ride only on an opening correction/.test(probs({ ...base, effect: 'post_opening' })));
  assert.ok(/each open AP item needs/.test(probs({ ...base, open_ap_items: [{ vendor: 'Vendor LLC', invoice_number: '', invoice_date: '2026-02-25', amount_cents: 72000 }] })));
  assert.ok(/each open AP item needs/.test(probs({ ...base, open_ap_items: [{ vendor: 'Vendor LLC', invoice_number: '4654', invoice_date: '2026-02-25', amount_cents: -1 }] })));
  const [oc] = OBJ.openingCorrections({ adjustments: [{ ...base, id: 'adj', status: 'approved', fingerprint: '9'.repeat(64), adjustment_no: 3, approved_by_label: 'Owner', approved_at: 'x', approval_channel: 'in_app' }] });
  assert.deepStrictEqual(oc.open_ap_items, [{ vendor: 'Vendor LLC', invoice_number: '4654', invoice_date: '2026-02-25', amount_cents: 72000 }]);
  const [none] = OBJ.openingCorrections({ adjustments: [{ ...base, open_ap_items: [], id: 'a2', status: 'approved', fingerprint: '8'.repeat(64), adjustment_no: 4 }] });
  assert.ok(!('open_ap_items' in none));
});

check('source system: the preflight hands the planner the BATCH source system, and the planner never assumes one', () => {
  const fs = require('fs'); const path = require('path');
  const svcSrc = fs.readFileSync(path.join(__dirname, '../lib/onboarding/service.js'), 'utf8');
  const call = svcSrc.slice(svcSrc.indexOf('buildConversionPlan({'), svcSrc.indexOf('buildConversionPlan({') + 400);
  assert.ok(/batch:\s*\{[^}]*source_system:\s*view\.batch\.source_system/.test(call), 'service.js must pass source_system: view.batch.source_system into the plan batch');
  const planSrc = fs.readFileSync(path.join(__dirname, '../lib/onboarding/conversion_plan.js'), 'utf8');
  assert.ok(!/source_system\s*\|\|\s*['"]/.test(planSrc), 'conversion_plan.js must not default a missing source system');
  assert.ok(/names no source system/.test(planSrc), 'a missing source system must fail the establishment closed');
});

(async () => {
  console.log('onboarding conversion primitives (535)');
  for (const t of pending) await t();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
