#!/usr/bin/env node
// ============================================================================
// Budget Phase 0 (Ed 2026-09-25): budget saves never drop lines or flatten a
// seasonal monthly schedule; an approved budget is locked; Budget vs Actual
// meets on (account, fund); revenue variance colours are right.
//
// Live checks read the Lakes of Pine Forest FY2026 approved budget (read-only).
// No budget data is committed here: the assertions are structural (every line,
// every month identical), not copies of the numbers.
// ============================================================================
require('dotenv').config({ quiet: true });
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { mergeBudgetLines, evenSplit, isEvenSchedule, scaleSchedule } = require('../lib/accounting/budget_merge');

let failed = 0;
const t = async (name, fn) => { try { await fn(); console.log('PASS  ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); } };
const SEASONAL = [100, 100, 100, 200, 400, 800, 1000, 800, 400, 200, 100, 100]; // sums 4300
const line = (id, annual, monthly) => ({ account_id: id, fund_id: 'F', annual_amount_cents: annual, monthly_amounts_cents: monthly, notes: null });

(async () => {
  // ---- merge rules (synthetic) ----
  await t('even split: remainder in December, sums to annual', () => {
    const m = evenSplit(1000); assert.strictEqual(m.length, 12); assert.strictEqual(m.reduce((a, b) => a + b, 0), 1000); assert.strictEqual(m[11], 83 + 4);
  });
  await t('annual unchanged + no months sent -> saved seasonal schedule kept exactly', () => {
    const r = mergeBudgetLines([line('pool', 4300, SEASONAL)], [{ account_id: 'pool', annual_amount_cents: 4300 }]);
    assert.deepStrictEqual(r.rows[0].monthly_amounts_cents, SEASONAL);
    assert.strictEqual(r.decisionsNeeded.length, 0);
  });
  await t('annual changed on a seasonal line -> decision required, never a silent /12', () => {
    const r = mergeBudgetLines([line('pool', 4300, SEASONAL)], [{ account_id: 'pool', annual_amount_cents: 8600 }]);
    assert.strictEqual(r.rows.length, 0); assert.strictEqual(r.decisionsNeeded.length, 1);
  });
  await t("phasing 'scale' keeps the pattern; 'even' spreads only when chosen", () => {
    const sc = mergeBudgetLines([line('pool', 4300, SEASONAL)], [{ account_id: 'pool', annual_amount_cents: 8600 }], { phasing: 'scale' });
    assert.deepStrictEqual(sc.rows[0].monthly_amounts_cents, SEASONAL.map((v) => v * 2));
    const ev = mergeBudgetLines([line('pool', 4300, SEASONAL)], [{ account_id: 'pool', annual_amount_cents: 8600 }], { phasing: 'even' });
    assert.deepStrictEqual(ev.rows[0].monthly_amounts_cents, evenSplit(8600));
  });
  await t('scale rounding always sums exactly to the new annual', () => {
    for (const target of [1, 7, 4301, 999999, 123457]) assert.strictEqual(scaleSchedule(SEASONAL, 4300, target).reduce((a, b) => a + b, 0), target);
  });
  await t('an evenly spread line re-spreads freely (nothing to lose)', () => {
    assert.ok(isEvenSchedule(evenSplit(1200), 1200));
    assert.ok(isEvenSchedule([208700, ...Array(11).fill(208300)], 2500000), 'whole-dollar split, January residue');
    assert.ok(!isEvenSchedule([100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 5000], 6100), 'one big month is a schedule');
    const r = mergeBudgetLines([line('a', 1200, evenSplit(1200))], [{ account_id: 'a', annual_amount_cents: 2400 }]);
    assert.deepStrictEqual(r.rows[0].monthly_amounts_cents, evenSplit(2400));
  });
  await t('lines not sent are kept; removal only when explicitly requested', () => {
    const ex = [line('a', 1200, evenSplit(1200)), line('b', 4300, SEASONAL), line('c', 600, evenSplit(600))];
    const r = mergeBudgetLines(ex, [{ account_id: 'a', annual_amount_cents: 1200 }]);
    assert.deepStrictEqual(r.kept.sort(), ['b', 'c']); assert.deepStrictEqual(r.removed, []);
    const r2 = mergeBudgetLines(ex, [{ account_id: 'a', annual_amount_cents: 1200 }], { removeAccountIds: ['c'] });
    assert.deepStrictEqual(r2.removed, ['c']); assert.deepStrictEqual(r2.kept, ['b']);
  });
  await t('months sent must add to the annual (no silent mismatch)', () => {
    const r = mergeBudgetLines([], [{ account_id: 'a', annual_amount_cents: 1000, monthly_amounts_cents: evenSplit(999) }]);
    assert.strictEqual(r.errors[0].error, 'monthly_total_does_not_equal_annual');
  });
  await t('fund and notes carry over when the request omits them', () => {
    const r = mergeBudgetLines([{ ...line('a', 1200, evenSplit(1200)), fund_id: 'RES', notes: 'n' }], [{ account_id: 'a', annual_amount_cents: 1200 }]);
    assert.strictEqual(r.rows[0].fund_id, 'RES'); assert.strictEqual(r.rows[0].notes, 'n');
  });

  // ---- server + screen wiring (static) ----
  const books = fs.readFileSync(path.join(__dirname, '..', 'api/books.js'), 'utf8').replace(/\r\n/g, '\n');
  const block = (start) => { const i = books.indexOf(start); assert.ok(i >= 0, 'missing ' + start); return books.slice(i, books.indexOf('\n});', i)); };
  await t('POST /budgets: lock refusal comes before any write; no delete-all of lines; approve is last', () => {
    const b = block("router.post('/budgets', express.json");
    const iLock = b.indexOf("'budget_locked'");
    const firstWrite = Math.min(...['.update(', '.insert(', '.upsert(', '.delete('].map((w) => { const i = b.indexOf(w); return i < 0 ? Infinity : i; }));
    assert.ok(iLock > 0 && iLock < firstWrite, 'lock check must precede writes');
    assert.ok(!/budget_line_items'\)\.delete\(\)\.eq\('budget_id', \w+\);/.test(b), 'no unconditional delete of every line');
    assert.ok(/\.in\('account_id', merged\.removed\)/.test(b), 'removal only of explicitly removed lines');
    assert.ok(b.lastIndexOf("status: 'approved'") > b.indexOf('.upsert('), 'approval after lines are written');
  });
  await t('DELETE /budgets/:id and reserve-budget replace refuse a locked year', () => {
    const d = block("router.delete('/budgets/:id'");
    assert.ok(d.indexOf("'budget_locked'") > 0 && d.indexOf("'budget_locked'") < d.indexOf('.delete()'));
    const rv = block("router.post('/reserve-budget'");
    assert.ok(rv.indexOf("'budget_locked'") > 0 && rv.indexOf("'budget_locked'") < rv.indexOf('.delete()'));
  });
  await t('reopen is owner-only and needs a reason', () => {
    const r = block("router.post('/budgets/:id/reopen'");
    assert.ok(/requireOwner\(req, res\)/.test(r) && /reason_required/.test(r) && /reopen_community_budget/.test(r));
  });
  const html = fs.readFileSync(path.join(__dirname, '..', 'public/accounting.html'), 'utf8').replace(/\r\n/g, '\n');
  await t('upload: ambiguous source numbers are never auto-mapped; unmatched lines need acknowledgement; file path is kept', () => {
    // Load the page's matcher and run it against a chart with a duplicate number.
    const src = html.slice(html.indexOf('  function bdgMatchLines('), html.indexOf('  async function commitBudget('));
    const fn = new Function('_coaCache', src + '; return bdgMatchLines;');
    const coa = [{ id: '1', account_number: '5300', vantaca_account_number: '5300' }, { id: '2', account_number: '4000', vantaca_account_number: null }, { id: '3', account_number: '4000', vantaca_account_number: null, fund_code: 'RES' }];
    const out = fn(coa)([{ account_number: '5300' }, { account_number: '4000' }, { account_number: '9999' }]);
    assert.strictEqual(out[0]._a.id, '1');
    assert.strictEqual(out[1]._a, null); assert.strictEqual(out[1]._why, 'ambiguous');
    assert.strictEqual(out[2]._a, null); assert.strictEqual(out[2]._why, 'none');
    assert.ok(/id="bdg-unm-ack"/.test(html) && /\$\('bdg-unm-ack'\)\.checked/.test(html), 'acknowledgement gates saving');
    assert.ok(/source_storage_path:_pendingBudget\.source_storage_path/.test(html), 'commit sends the kept file');
    assert.ok(/Excluded on upload/.test(html), 'exclusions recorded in notes');
  });
  await t('BvA colours: revenue over budget is green, expense over budget is red (arithmetic unchanged)', () => {
    const src = html.slice(html.indexOf('    const vc = (v, r) =>'), html.indexOf('\n', html.indexOf('    const vc = (v, r) =>')));
    const vc = new Function(src + '; return vc;')();
    const GREEN = '#166534', RED = '#991b1b';
    // variance = budget - actual
    assert.strictEqual(vc(1000 - 1500, { account_type: 'revenue' }), GREEN, 'revenue above budget');
    assert.strictEqual(vc(1000 - 500, { account_type: 'revenue' }), RED, 'revenue below budget');
    assert.strictEqual(vc(1000 - 1500, { account_type: 'expense' }), RED, 'expense above budget');
    assert.strictEqual(vc(1000 - 500, { account_type: 'expense' }), GREEN, 'expense below budget');
  });

  // ---- live LOPF (read-only) ----
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) { console.log('      (live checks skipped: no Supabase env)'); return done(); }
  const { createClient } = require('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const { data: comm, error: cErr } = await sb.from('communities').select('id').eq('name', 'Lakes of Pine Forest').maybeSingle();
  if (cErr) throw cErr;
  const { data: bud, error: bErr } = await sb.from('community_budgets').select('id, status').eq('community_id', comm.id).eq('fiscal_year', 2026).maybeSingle();
  if (bErr) throw bErr;
  const { data: saved, error: lErr } = await sb.from('budget_line_items')
    .select('account_id, fund_id, annual_amount_cents, monthly_amounts_cents, notes, chart_of_accounts(account_number)').eq('budget_id', bud.id);
  if (lErr) throw lErr;

  await t('LOPF FY2026: a planner-style save (annual only) keeps every line and every month', () => {
    const payload = saved.map((l) => ({ account_id: l.account_id, fund_id: l.fund_id || null, annual_amount_cents: Number(l.annual_amount_cents) }));
    const r = mergeBudgetLines(saved, payload);
    assert.strictEqual(r.errors.length + r.decisionsNeeded.length, 0);
    assert.strictEqual(r.rows.length, saved.length);
    for (const l of saved) {
      const o = r.rows.find((x) => x.account_id === l.account_id);
      assert.deepStrictEqual(o.monthly_amounts_cents, l.monthly_amounts_cents.map(Number), 'months changed on ' + l.chart_of_accounts.account_number);
      assert.strictEqual(o.annual_amount_cents, Number(l.annual_amount_cents));
    }
    console.log(`      ${saved.length} lines, ${saved.filter((l) => !isEvenSchedule(l.monthly_amounts_cents, l.annual_amount_cents)).length} seasonal, all months identical`);
  });
  await t('LOPF FY2026: a partial save (10 lines sent) drops none of the others', () => {
    const r = mergeBudgetLines(saved, saved.slice(0, 10).map((l) => ({ account_id: l.account_id, annual_amount_cents: Number(l.annual_amount_cents) })));
    assert.strictEqual(r.rows.length + r.kept.length, saved.length); assert.strictEqual(r.removed.length, 0);
  });
  await t('LOPF FY2026: Pool Management 5300 keeps its seasonal schedule; changing its annual asks first', () => {
    const pool = saved.find((l) => l.chart_of_accounts && l.chart_of_accounts.account_number === '5300');
    assert.ok(pool, 'pool line present');
    assert.ok(!isEvenSchedule(pool.monthly_amounts_cents, pool.annual_amount_cents), 'pool is seasonal');
    const same = mergeBudgetLines(saved, [{ account_id: pool.account_id, annual_amount_cents: Number(pool.annual_amount_cents) }]);
    assert.deepStrictEqual(same.rows[0].monthly_amounts_cents, pool.monthly_amounts_cents.map(Number));
    const changed = mergeBudgetLines(saved, [{ account_id: pool.account_id, annual_amount_cents: Number(pool.annual_amount_cents) + 100000 }]);
    assert.strictEqual(changed.decisionsNeeded.length, 1);
  });

  await t('LOPF: Budget vs Actual identical before/after the fund-aware change (several dates)', async () => {
    const oldPath = process.env.BVA_OLD_MODULE;
    if (!oldPath) return console.log('      (skipped: set BVA_OLD_MODULE to the pre-change financial_statements.js)');
    const oldBva = require(oldPath).budgetVsActual;
    const newBva = require('../lib/accounting/financial_statements').budgetVsActual;
    const key = (r) => r.account_id + '|' + r.fund_id;
    const F = ['annual_budget_cents', 'mtd_budget_cents', 'mtd_actual_cents', 'mtd_variance_cents', 'ytd_budget_cents', 'ytd_actual_cents', 'ytd_variance_cents'];
    for (const d of ['2026-01-31', '2026-03-31', '2026-06-30', '2026-07-31', '2026-08-31', '2026-09-25']) {
      const [a, b] = await Promise.all([oldBva({ community_id: comm.id, period_end: d }), newBva({ community_id: comm.id, period_end: d })]);
      assert.strictEqual(a.rows.length, b.rows.length, d + ' row count');
      const bm = new Map(b.rows.map((r) => [key(r), r]));
      const tot = Object.fromEntries(F.map((k) => [k, 0]));
      for (const r of a.rows) { const n = bm.get(key(r)); assert.ok(n, d + ' missing ' + r.account_number); for (const k of F) { assert.strictEqual(n[k], r[k], `${d} ${r.account_number} ${k}`); tot[k] += r[k]; } assert.strictEqual(n.fund_code, r.fund_code); }
      console.log(`      ${d}: ${a.rows.length} rows · YTD budget ${(tot.ytd_budget_cents / 100).toFixed(2)} · YTD actual ${(tot.ytd_actual_cents / 100).toFixed(2)} · annual ${(tot.annual_budget_cents / 100).toFixed(2)}  (old = new)`);
    }
  });

  await t('POST /budgets on the approved LOPF FY2026 returns 409 and makes NO write (writes blocked in-process)', async () => {
    // Block every write from books.js's client, so a regression can't touch live data.
    const sbjs = require('@supabase/supabase-js'); const real = sbjs.createClient; const writes = [];
    sbjs.createClient = (...a) => { const c = real(...a); const from = c.from.bind(c);
      c.from = (tb) => { const q = from(tb); for (const w of ['insert', 'update', 'upsert', 'delete']) q[w] = () => { writes.push(tb + '.' + w); throw new Error('write blocked in test: ' + tb + '.' + w); }; return q; };
      c.storage = { from: () => ({ upload: async () => { writes.push('storage'); return { error: { message: 'blocked' } }; } }) }; return c; };
    delete require.cache[require.resolve('../api/books.js')];
    const { router } = require('../api/books.js'); sbjs.createClient = real;
    const express = require('express'); const app = express(); app.use('/api/books', router);
    const srv = app.listen(0); const port = srv.address().port;
    try {
      const body = { community_id: comm.id, fiscal_year: 2026, status: 'draft', line_items: saved.map((l) => ({ account_id: l.account_id, annual_amount_cents: 1 })) };
      const r = await fetch(`http://127.0.0.1:${port}/api/books/budgets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      assert.strictEqual(r.status, 409, JSON.stringify(j)); assert.strictEqual(j.error, 'budget_locked');
      const del = await fetch(`http://127.0.0.1:${port}/api/books/budgets/${bud.id}?community_id=${comm.id}`, { method: 'DELETE' });
      assert.strictEqual(del.status, 409);
      const rv = await fetch(`http://127.0.0.1:${port}/api/books/reserve-budget`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ community_id: comm.id, fiscal_year: 2026, items: [] }) });
      assert.strictEqual(rv.status, 409);
      assert.deepStrictEqual(writes, [], 'no write attempted');
    } finally { srv.close(); }
  });

  done();
  function done() { console.log(failed ? `\n${failed} failure(s)` : '\nall passed'); process.exitCode = failed ? 1 : 0; }
})().catch((e) => { console.error(e); process.exitCode = 1; });
