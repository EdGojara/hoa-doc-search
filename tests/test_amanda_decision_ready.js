#!/usr/bin/env node
// Amanda decision-ready behavior (Ed 2026-10-16): do the work first, use the records in trustEd
// before responding, never promise work that can be finished now, and ask the Board only for
// the Board's decision. Tests the deterministic check, the facts block and the wiring.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const D = require('../lib/amanda/decision_ready');

let passed = 0; let failed = 0;
const t = async (name, fn) => { try { await fn(); passed++; console.log('  ok  ', name); } catch (e) { failed++; console.log('  FAIL', name, '\n       ', e.message); } };
const codes = (text) => D.checkDecisionReady(text).issues.map((i) => i.code);

// Minimal read-only PostgREST stand-in: every filter is accepted, data comes from the seed per table.
function fakeDb(seed, failTables = []) {
  return { from(table) {
    const q = { select() { return q; }, eq() { return q; }, in() { return q; }, gte() { return q; }, lte() { return q; }, order() { return q; }, limit() { return q; }, range() { return q; },
      then(res, rej) { return Promise.resolve(failTables.includes(table) ? { data: null, error: { message: `${table} down` } } : { data: seed[table] || [], error: null }).then(res, rej); } };
    return q;
  } };
}

(async () => {
  console.log('Amanda decision-ready behavior');

  await t('flags every closing Ed named as handing work back to the Board', async () => {
    for (const s of ['Let me know how you would like to proceed.', 'Tell me which proposal you want me to compare.', 'I can prepare a comparison if you would like.', 'Would you like me to contact the vendor?'])
      assert.ok(codes(`Hi Hugh,\n\nThanks for sending these.\n\n${s}\n\nAmanda`).includes('passive_closer'), s);
  });

  await t('flags promises to check records that are in trustEd', async () => {
    for (const s of ['I am checking the current operating and reserve balances.', 'I will review the budget.', 'I can look at prior Board decisions.', "I'll verify whether funds are available.", "I'm validating the funding source against current operating and reserve balances."])
      assert.ok(codes(s).includes('deferred_diligence'), s);
  });

  await t('allows work that genuinely needs someone else', async () => {
    for (const s of ['I am requesting updated pricing from iTech today.', 'I asked Texas Access Works for their certificate of insurance.', "I'll confirm the warranty terms with the vendor.", 'Counsel is reviewing the easement language.'])
      assert.deepStrictEqual(codes(s), [], s);
  });

  await t('vague financial characterizations need the actual figures', async () => {
    assert.ok(codes('Given delinquency and cash position, I suggest we wait.').includes('vague_financial'));
    assert.deepStrictEqual(codes('Given the operating cash of $41,104.86 and $948,452.23 in reserves, this can be funded now.'), []);
  });

  await t('options need a recommendation', async () => {
    assert.ok(codes('Here are the choices:\n1. iTech at $12,000\n2. Gate Sentry at $9,500').includes('no_recommendation'));
    assert.deepStrictEqual(codes('Here are the choices:\n1. iTech at $12,000\n2. Gate Sentry at $9,500\nI recommend iTech because the warranty is three years longer.'), []);
  });

  await t("a decision-ready draft in Ed's structure passes", async () => {
    const good = 'Hi Hugh,\n\nSituation: the gate operator failed again and two proposals are on file.\n\nRecommendation: I recommend iTech\'s current proposal at $12,400.\n\nWhy: it is $1,900 more than Gate Sentry but includes a 3-year parts warranty. Operating cash is $41,104.86 and 5700 Fence Repair has $9,916.32 remaining, so this is funded from operating.\n\nOpen items: iTech\'s quote expires 10/31.\n\nAction underway: I am requesting iTech\'s certificate of insurance and a start date.\n\nBoard decision needed: approve the $12,400 spend, which is above management\'s $5,000 authority.\n\nAmanda';
    assert.deepStrictEqual(D.checkDecisionReady(good), { ok: true, issues: [] });
  });

  await t('the corrective retry names exactly what to fix', async () => {
    const note = D.retryNote(D.checkDecisionReady('I will review the budget. Let me know how you would like to proceed.').issues);
    assert.match(note, /state the actual figures/); assert.match(note, /handing management work back/);
  });

  await t('the facts block retrieves balances by fund, books status, budget, payables, motions and named vendors', async () => {
    const seed = {
      chart_of_accounts: [
        { id: 'a1', account_number: '1000', account_name: 'Operating Cash', account_type: 'asset', fund_id: 'op' },
        { id: 'a2', account_number: '1201', account_name: 'Reserve-Edward Jones', account_type: 'asset', fund_id: 'res' },
        { id: 'e1', account_number: '5700', account_name: 'Fence Repair', account_type: 'expense', fund_id: 'op' },
        { id: 'r1', account_number: '4000', account_name: 'Assessments', account_type: 'revenue', fund_id: 'op' }],
      account_funds: [{ id: 'op', fund_code: 'OPR', fund_name: 'Operating' }, { id: 'res', fund_code: 'RES', fund_name: 'Reserve' }],
      v_trial_balance: [{ account_number: '1000', total_debits_cents: 5000000, total_credits_cents: 900000 }, { account_number: '1201', total_debits_cents: 92563171, total_credits_cents: 0 }],
      bank_accounts: [{ id: 'b1', account_nickname: 'Operating 5313', gl_account_number: '1000' }],
      bank_reconciliations: [{ bank_account_id: 'b1', period_end: '2026-08-31', status: 'reconciled' }, { bank_account_id: 'b1', period_end: '2026-09-30', status: 'in_progress' }],
      accounting_periods: [{ period_start: '2026-09-01', period_end: '2026-09-30', status: 'open' }],
      community_budgets: [{ id: 'bud', fiscal_year: 2026, status: 'approved' }],
      budget_line_items: [{ account_id: 'e1', annual_amount_cents: 1000000 }, { account_id: 'r1', annual_amount_cents: 50000000 }],
      journal_entry_lines: [{ account_id: 'e1', debit_cents: 8368, credit_cents: 0, journal_entries: { status: 'posted' } }, { account_id: 'r1', debit_cents: 0, credit_cents: 40000000, journal_entries: { status: 'posted' } }, { account_id: 'e1', debit_cents: 99999, credit_cents: 0, journal_entries: { status: 'draft' } }],
      ap_invoices: [{ total_cents: 250000, amount_paid_cents: 0, status: 'approved', vendor_id: 'v1', invoice_date: '2026-09-01', vendors: { name: 'Texas Access Works LLC' } }],
      board_motions: [{ title: 'Approve 2027 budget', status: 'passed', closed_at: '2026-10-10T00:00:00Z' }],
      vendor_contracts: [{ vendor_id: 'v9', vendor_name_raw: 'United Protective Services of South Texas, L.P.', annualized_amount: 216638.93, status: 'active' }],
    };
    const out = await D.boardDecisionFacts(fakeDb(seed), 'cg', 'Can we fund the Texas Access Works gate repair?', { today: '2026-10-16' });
    assert.match(out, /Operating: \$41,000\.00/); assert.match(out, /Reserve: \$925,631\.71/);
    assert.match(out, /Operating 5313: reconciled through 2026-08-31/); assert.match(out, /Last closed month: none closed yet/);
    assert.match(out, /5700 Fence Repair: budget \$10,000\.00, actual \$83\.68, remaining \$9,916\.32/, 'drafts do not count as actual');
    assert.match(out, /OPEN PAYABLES: 1 unpaid bill\(s\) totaling \$2,500\.00/); assert.match(out, /"Approve 2027 budget" passed 2026-10-10/);
    assert.match(out, /Texas Access Works LLC: 1 bill\(s\), \$2,500\.00 in the last 12 months/);
    assert.match(out, /no active contract on file/, '"South Texas" in another vendor\'s contract must not match Texas Access Works');
  });

  await t('a failed source becomes a named limitation, never silence', async () => {
    const out = await D.boardDecisionFacts(fakeDb({}, ['v_trial_balance', 'community_budgets']), 'cg', '', { today: '2026-10-16' });
    assert.match(out, /CASH AND INVESTMENTS: unavailable \(v_trial_balance down\)/); assert.match(out, /BUDGET 2026: unavailable/);
  });

  await t('Amanda\'s board replies get the rule, the facts before drafting, and the check with one retry', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'community', 'amanda_reply.js'), 'utf8');
    assert.ok(/boardDecisionFactsDetailed\(supabase, communityId, inboundText\)/.test(src), 'facts (with their confidence) are retrieved before drafting');
    assert.ok(/BOARD DECISION FACTS \(retrieved from trustEd before drafting/.test(src), 'facts go into the prompt');
    assert.ok(/if \(audience === 'board'\) system \+= '\\n\\n' \+ decisionReady\.DECISION_READY_RULE/.test(src), 'rule on board drafts');
    assert.ok(/checkDecisionReady\(out, drOpts\);\s*if \(!dr\.ok\) \{ out = await ask\(decisionReady\.retryNote\(dr\.issues, intent\)\)/.test(src), 'one corrective retry, with the data-confidence and intent checks');
    assert.ok(!/Give 2 to 3 options with the tradeoffs/.test(src), 'the old options-first instruction is gone');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
