// ============================================================================
// tests/test_transfer_proration.js  (Ed 2026-10-08, GitHub issue #94)
// ----------------------------------------------------------------------------
// The JS half of the Still Creek builder-to-homeowner proration
// (lib/accounting/transfer_proration.js). The SQL half (the calculation, the
// ambiguity gate, the draft ledger rows) is proved on real Postgres by
// tests/sql/500_transfer_proration_e2e.mjs. Here:
//   - GL lines: debits = credits; charge / credit directions; property tagged
//   - posting: one GL entry keyed to the batch, batch committed, rows marked
//     posted; a retry after any failure finishes without a second entry
//   - the gate: staff must SEE and confirm the numbers; blocked needs an
//     explicit acknowledgment; other transfers pass; missing migration passes
//   - wiring: both transfer paths gate before and post after the transfer;
//     the manual Prorate tool cannot double-charge a configured community
// ============================================================================
require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || undefined, quiet: true });
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// postJournalEntry is the real GL engine elsewhere; here it records what it was asked.
const posted = [];
const postingPath = require.resolve('../lib/accounting/posting');
require.cache[postingPath] = { id: postingPath, filename: postingPath, loaded: true, exports: {
  postJournalEntry: async (je) => { posted.push(je); return { entry: { id: 'je-' + posted.length, reference: 'JE-2026-' + String(900 + posted.length) } }; },
} };
const TP = require('../lib/accounting/transfer_proration');

const tests = []; const check = (n, fn) => tests.push([n, fn]);
const ACCT = { 1300: 'acct-ar', 4000: 'acct-income' };
const balanced = (lines) => lines.reduce((s, l) => s + l.debit_cents - l.credit_cents, 0) === 0;

// A minimal supabase double: rpc results by name, tables as arrays, chained filters.
function fakeDb({ rpc = {}, tables = {}, failUpdate = null } = {}) {
  const t = JSON.parse(JSON.stringify(tables));
  const calls = { rpc: [], updates: [] };
  const q = (name) => {
    let rows = (t[name] || []).slice(); let upd = null; const filters = [];
    const api = {
      select() { return api; },
      eq(k, v) { filters.push((r) => r[k] === v); return api; },
      in(k, vs) { filters.push((r) => vs.includes(r[k])); return api; },
      update(p) { upd = p; return api; },
      maybeSingle() { return api._done(true); },
      then(res, rej) { return api._done(false).then(res, rej); },
      async _done(single) {
        const hit = rows.filter((r) => filters.every((f) => f(r)));
        if (upd) {
          if (failUpdate === name) return { data: null, error: { message: 'simulated ' + name + ' failure' } };
          calls.updates.push({ table: name, patch: upd, n: hit.length });
          for (const r of t[name] || []) if (filters.every((f) => f(r))) Object.assign(r, upd);
          return { data: hit, error: null };
        }
        return { data: single ? (hit[0] || null) : hit, error: null };
      },
    };
    return api;
  };
  return {
    calls, t,
    from: q,
    async rpc(name, args) { calls.rpc.push({ name, args }); const v = rpc[name]; return typeof v === 'function' ? v(args) : (v || { data: null, error: { message: 'no rpc ' + name } }); },
  };
}

const PLAN = {
  applies: true, blocked: false, blocked_reasons: [], builder: 'Lennar', buyer_name: 'Pat Homeowner', settlement_date: '2026-07-01',
  fiscal_year: 2026, days_in_year: 365, annual_assessment_cents: 49500, builder_rate_pct: 50, builder_days: 181, homeowner_days: 184,
  builder_due_cents: 12273, homeowner_due_cents: 24953, builder_adjustment_cents: 12273, builder_prior_billed_cents: 0,
};
const WRITTEN = { ...PLAN, written: true, batch_id: 'batch-1', property_id: 'prop-1', community_id: 'scr', seller_tenure_id: 'ten-lennar', buyer_tenure_id: 'ten-buyer' };
const ROWS = [
  { id: 'ap-b', role: 'builder_adjustment', status: 'draft', prorated_amount_cents: 12273, batch_id: 'batch-1', tenure_id: 'ten-lennar', community_id: 'scr', property_id: 'prop-1', proposal_id: 'prop-x' },
  { id: 'ap-h', role: 'homeowner_charge', status: 'draft', prorated_amount_cents: 24953, batch_id: 'batch-1', tenure_id: 'ten-buyer', community_id: 'scr', property_id: 'prop-1', proposal_id: 'prop-x' },
];
const BASE_TABLES = {
  chart_of_accounts: [{ id: 'acct-ar', account_number: '1300', community_id: 'scr' }, { id: 'acct-income', account_number: '4000', community_id: 'scr' }],
  assessment_prorations: ROWS,
  journal_entries: [],
  transaction_upload_batches: [{ id: 'batch-1', status: 'draft' }],
};

// ------------------------------------------------------------------ GL lines
check('GL (7/1/2026, Lennar unbilled): Dr 1300 $122.73 / Cr 4000 $122.73 and Dr 1300 $249.53 / Cr 4000 $249.53, AR lines tagged to the lot', () => {
  const l = TP.glLines(ACCT, { ...WRITTEN });
  assert.ok(balanced(l));
  assert.deepStrictEqual(l.map((x) => [x.account_id, x.debit_cents, x.credit_cents, x.property_id || null]), [
    ['acct-ar', 12273, 0, 'prop-1'], ['acct-income', 0, 12273, null], ['acct-ar', 24953, 0, 'prop-1'], ['acct-income', 0, 24953, null]]);
});
check('GL (Lennar billed $495.00): the builder credit reverses income and AR (Dr 4000 / Cr 1300 $372.27)', () => {
  const l = TP.glLines(ACCT, { ...WRITTEN, builder_adjustment_cents: -37227 });
  assert.ok(balanced(l));
  assert.deepStrictEqual(l.slice(0, 2).map((x) => [x.account_id, x.debit_cents, x.credit_cents, x.property_id || null]), [['acct-income', 37227, 0, null], ['acct-ar', 0, 37227, 'prop-1']]);
});
check('GL (Jan 1: no builder share, Lennar unbilled): only the homeowner charge', () => {
  const l = TP.glLines(ACCT, { ...WRITTEN, builder_adjustment_cents: 0, homeowner_due_cents: 49500 });
  assert.deepStrictEqual(l.map((x) => x.debit_cents + x.credit_cents), [49500, 49500]);
});

// ------------------------------------------------------------------ posting
check('post: one GL entry keyed to the batch (source assessment_billing, dated the settlement), batch committed, rows marked posted', async () => {
  posted.length = 0;
  const db = fakeDb({ rpc: { post_transfer_assessment_proration: { data: WRITTEN, error: null } }, tables: BASE_TABLES });
  const r = await TP.postTransferProration(db, { proposalId: 'prop-x', postedBy: 'ed' });
  assert.strictEqual(r.status, 'posted');
  assert.strictEqual(posted.length, 1);
  assert.deepStrictEqual([posted[0].source_module, posted[0].source_reference, posted[0].posting_date, posted[0].community_id], ['assessment_billing', 'batch-1', '2026-07-01', 'scr']);
  assert.ok(balanced(posted[0].lines));
  assert.strictEqual(db.t.transaction_upload_batches[0].status, 'committed');
  assert.deepStrictEqual(db.t.assessment_prorations.map((x) => [x.status, x.journal_entry_id]), [['posted', 'je-1'], ['posted', 'je-1']]);
});
check('retry after the GL posted but the commit failed: no second GL entry, finishes the commit', async () => {
  posted.length = 0;
  const db = fakeDb({ rpc: { post_transfer_assessment_proration: { data: WRITTEN, error: null } }, tables: BASE_TABLES, failUpdate: 'transaction_upload_batches' });
  await assert.rejects(() => TP.postTransferProration(db, { proposalId: 'prop-x' }), /could not be committed/);
  assert.strictEqual(posted.length, 1);
  // Second attempt: the draft exists (already_prorated, not all posted) and the GL entry is found by batch id.
  const db2 = fakeDb({
    rpc: { post_transfer_assessment_proration: { data: { already_prorated: true, all_posted: false, batch_id: 'batch-1' }, error: null } },
    tables: { ...BASE_TABLES, journal_entries: [{ id: 'je-1', reference: 'JE-2026-901', status: 'posted', community_id: 'scr', source_module: 'assessment_billing', source_reference: 'batch-1' }],
      homeowner_transactions: [{ id: 'h1', source_batch_id: 'batch-1', amount_cents: 12273, tenure_id: 'ten-lennar', raw_row_jsonb: { plan: PLAN } }] },
  });
  const r = await TP.postTransferProration(db2, { proposalId: 'prop-x' });
  assert.strictEqual(r.status, 'completed_retry');
  assert.strictEqual(posted.length, 1, 'no second GL entry');
  assert.strictEqual(db2.t.transaction_upload_batches[0].status, 'committed');
});
check('already fully posted: nothing happens', async () => {
  posted.length = 0;
  const db = fakeDb({ rpc: { post_transfer_assessment_proration: { data: { already_prorated: true, all_posted: true }, error: null } }, tables: BASE_TABLES });
  assert.strictEqual((await TP.postTransferProration(db, { proposalId: 'prop-x' })).status, 'already_posted');
  assert.strictEqual(posted.length, 0);
});
check('not applicable / blocked: no GL, no writes', async () => {
  posted.length = 0;
  for (const data of [{ applies: false, reason: 'seller_not_builder' }, { ...PLAN, blocked: true, blocked_reasons: ['ambiguous_builder_assessment'] }]) {
    const db = fakeDb({ rpc: { post_transfer_assessment_proration: { data, error: null } }, tables: BASE_TABLES });
    const r = await TP.postTransferProration(db, { proposalId: 'prop-x' });
    assert.ok(['not_applicable', 'blocked'].includes(r.status));
    assert.strictEqual(db.calls.updates.length, 0);
  }
  assert.strictEqual(posted.length, 0);
});

// ------------------------------------------------------------------ accounting readiness (Ed 2026-10-08)
check('not converted: the post returns STAGED; no GL entry, no batch commit, no row marked posted', async () => {
  posted.length = 0;
  const db = fakeDb({ rpc: { post_transfer_assessment_proration: { data: { ...PLAN, posting_ready: false, not_ready_reason: 'accounting_not_converted', staged: true }, error: null } }, tables: BASE_TABLES });
  const r = await TP.postTransferProration(db, { proposalId: 'prop-x' });
  assert.strictEqual(r.status, 'staged');
  assert.strictEqual(posted.length, 0);
  assert.strictEqual(db.calls.updates.length, 0);
});
check('after conversion, a staged proration is shown again (recomputed) and posts only once confirmed', async () => {
  posted.length = 0;
  const rpc = { post_transfer_assessment_proration: ({ p_dry_run }) => ({ data: p_dry_run ? { ...PLAN, posting_ready: true, staged: true, dry_run: true } : { ...WRITTEN, from_staged: true }, error: null }) };
  const db1 = fakeDb({ rpc, tables: BASE_TABLES });
  const ask = await TP.postStagedProration(db1, { proposalId: 'prop-x' });
  assert.strictEqual(ask.status, 'confirmation_required');
  assert.strictEqual(ask.plan.builder_due_cents, 12273);
  assert.strictEqual(posted.length, 0, 'nothing posts without the confirmation');
  assert.ok(db1.calls.rpc.every((c) => c.args.p_dry_run === true));
  const db2 = fakeDb({ rpc, tables: BASE_TABLES });
  const done = await TP.postStagedProration(db2, { proposalId: 'prop-x', confirmed: true });
  assert.strictEqual(done.status, 'posted');
  assert.strictEqual(posted.length, 1);
});
check('still not converted: posting a staged proration stays staged even when confirmed', async () => {
  posted.length = 0;
  const db = fakeDb({ rpc: { post_transfer_assessment_proration: { data: { ...PLAN, posting_ready: false, staged: true, dry_run: true }, error: null } }, tables: BASE_TABLES });
  assert.strictEqual((await TP.postStagedProration(db, { proposalId: 'prop-x', confirmed: true })).status, 'staged');
  assert.strictEqual(posted.length, 0);
});

// ------------------------------------------------------------------ the gate
const gate = (data, extra = {}) => TP.gateTransferProration(fakeDb({ rpc: { transfer_proration_plan: data } }),
  { propertyId: 'p', sellerTenureId: 't', settlementDate: '2026-07-01', buyerName: 'Pat', ...extra });
check('gate: a Lennar transfer stops until staff confirm the numbers (409 with the full calculation)', async () => {
  const g = await gate({ data: PLAN, error: null });
  assert.deepStrictEqual([g.proceed, g.status, g.body.code], [false, 409, 'proration_confirmation_required']);
  assert.strictEqual(g.body.proration.builder_due_cents, 12273);
  assert.strictEqual((await gate({ data: PLAN, error: null }, { confirmed: true })).proceed, true);
});
check('gate: ambiguous activity stops; recording the transfer anyway needs an explicit acknowledgment, and the proration then stays blocked', async () => {
  const B = { ...PLAN, blocked: true, blocked_reasons: ['ambiguous_builder_assessment'] };
  const g = await gate({ data: B, error: null }, { confirmed: true });
  assert.deepStrictEqual([g.proceed, g.body.code], [false, 'proration_blocked']);
  assert.ok(/does not show clearly what it was billed/.test(g.body.error));
  const ok = await gate({ data: B, error: null }, { blockedAck: true });
  assert.strictEqual(ok.proceed, true);
  assert.strictEqual((await TP.afterTransfer(null, ok, { proposalId: 'x' })).status, 'blocked');
});
check('gate: ordinary transfers pass untouched, and nothing posts after them', async () => {
  const g = await gate({ data: { applies: false, reason: 'seller_not_builder' }, error: null });
  assert.strictEqual(g.proceed, true);
  assert.strictEqual(await TP.afterTransfer(null, g, { proposalId: 'x' }), null);
});
check('gate: before migration 500 is applied, transfers proceed exactly as before', async () => {
  const g = await gate({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.transfer_proration_plan' } });
  assert.deepStrictEqual([g.proceed, g.plan.applies], [true, false]);
});
check('a post failure after the transfer is reported pending, never thrown into the transfer', async () => {
  const db = fakeDb({ rpc: { post_transfer_assessment_proration: { data: null, error: { message: 'boom' } } } });
  const r = await TP.afterTransfer(db, { proceed: true, plan: PLAN }, { proposalId: 'x' });
  assert.deepStrictEqual([r.status, r.error], ['pending', 'boom']);
});

// ------------------------------------------------------------------ wiring
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
check('wiring: Home Sales record-closing gates BEFORE the transfer and posts AFTER it (after the payoff)', () => {
  const s = read('api/home_sales.js');
  const g = s.indexOf('TP.gateTransferProration'), a = s.indexOf("rpc('approve_ownership_proposal'"), pay = s.indexOf('postTenurePayment(supabase, payoffArgs(b'), p = s.indexOf('TP.afterTransfer');
  assert.ok(g > 0 && a > g && p > a && p > pay, JSON.stringify({ g, a, pay, p }));
  assert.ok(/proration,\n/.test(s.replace(/\r\n/g, '\n')), 'the response carries the proration');
  assert.ok(/router\.post\('\/proration-preview'/.test(s) && /router\.post\('\/proration-retry'/.test(s));
});
check('wiring: Ownership Review approve gates BEFORE and posts AFTER the transfer', () => {
  const s = read('api/ownership_proposals.js');
  const g = s.indexOf('TP.gateTransferProration'), a = s.indexOf("rpc('approve_ownership_proposal'"), p = s.indexOf('TP.afterTransfer');
  assert.ok(g > 0 && a > g && p > a, JSON.stringify({ g, a, p }));
});
check('wiring: posting later (Home Sales retry and the generic transfer endpoint) goes through postStagedProration, which requires confirmation', () => {
  assert.ok(read('api/home_sales.js').includes('TP.postStagedProration(supabase'));
  const ap = read('api/assessment_proration.js');
  assert.ok(ap.includes("router.get('/transfer/staged'") && ap.includes("router.post('/transfer/:proposalId/post'") && ap.includes('TP.postStagedProration'));
});
check('wiring: the manual Prorate tool refuses a builder-to-homeowner proration where the transfer does it', () => {
  const s = read('lib/accounting/assessment_proration.js');
  assert.ok(/transfer_type === 'builder_to_homeowner' && await transferProrationConfigured\(community_id\)/.test(s));
  assert.ok(/proration_runs_at_transfer/.test(read('api/assessment_proration.js')));
});
check('no assessment amount is hard-coded in the JS (rates come from community_assessment_rates)', () => {
  for (const f of ['lib/accounting/transfer_proration.js', 'api/home_sales.js', 'api/ownership_proposals.js']) assert.ok(!/49500|495\.00|\b495\b/.test(read(f)), f);
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, fn] of tests) {
    try { await fn(); pass++; console.log('PASS ', n); }
    catch (e) { fail++; console.log('FAIL ', n, '\n   ', e.message); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
