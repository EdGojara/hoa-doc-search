#!/usr/bin/env node
// ============================================================================
// Budget Phase 2 (Ed 2026-09-25): the monthly plan.
//   * an existing seasonal schedule survives unchanged; even spreading happens
//     only when chosen; scaling keeps the shape; manual months reconcile;
//   * a project lands in the chosen month; components explain 100% of a line;
//   * a contract schedule says whether it is documented or assumed;
//   * approved budgets cannot be edited; LOPF FY2026 is untouched.
// Live checks read Lakes of Pine Forest (read-only).
// ============================================================================
require('dotenv').config({ quiet: true });
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const P = require('../lib/accounting/budget_phasing');
const { evenSplit } = require('../lib/accounting/budget_merge');

let failed = 0;
const t = async (name, fn) => { try { await fn(); console.log('PASS  ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); } };
const POOL = [124500, 124500, 124500, 124500, 861300, 1583700, 1739200, 1051500, 718100, 124500, 124500, 124500]; // LOPF 5300 FY2026 (public budget shape)
const sum = (m) => m.reduce((s, v) => s + v, 0);

(async () => {
  await t('1. seasonal pool line: kept exactly; a changed annual needs a choice; nothing flattens it', () => {
    assert.ok(P.needsAnnualDecision(POOL, sum(POOL)), 'pool is recognised as an intentional schedule');
    assert.deepStrictEqual(P.applyAnnualChange(POOL, sum(POOL) + 100000, 'keep_months').monthly, POOL);
    assert.throws(() => P.applyAnnualChange(POOL, sum(POOL) + 100000, undefined), /choose/);
  });
  await t('2. even line: spread evenly only because Even was chosen', () => {
    const r = P.phase({ method: 'even', annual_cents: 132500 });
    assert.deepStrictEqual(r.monthly, evenSplit(132500)); assert.strictEqual(sum(r.monthly), 132500);
    assert.strictEqual(r.basis, 'calculated'); assert.match(r.explanation, /chosen explicitly/);
  });
  await t('manual month edits reconcile exactly to the annual', () => {
    const m = [0, 0, 0, 0, 50000, 50000, 50000, 0, 0, 0, 0, 12345];
    const r = P.phase({ method: 'manual', current_months: m });
    assert.deepStrictEqual(r.monthly, m); assert.strictEqual(sum(r.monthly), 162345); assert.strictEqual(r.basis, 'manual');
  });
  await t('scaling keeps the pattern\'s shape (each month within a cent) and totals exactly', () => {
    const target = 7542133;
    const r = P.applyAnnualChange(POOL, target, 'scale').monthly;
    assert.strictEqual(sum(r), target);
    const f = target / sum(POOL);
    r.forEach((v, i) => assert.ok(Math.abs(v - POOL[i] * f) <= 1, `month ${i} off shape`));
  });
  await t('allocate the difference to selected months only', () => {
    const r = P.applyAnnualChange(POOL, sum(POOL) + 60000, 'allocate_difference', { months: [5, 6] }).monthly;
    assert.deepStrictEqual(r.map((v, i) => v - POOL[i]), [0, 0, 0, 0, 0, 30000, 30000, 0, 0, 0, 0, 0]);
  });
  await t('3. one-time project: $30,000 lands entirely in October', () => {
    const m = P.placeInMonths(3000000, [9]);
    assert.deepStrictEqual(m, [0, 0, 0, 0, 0, 0, 0, 0, 0, 3000000, 0, 0]);
    assert.deepStrictEqual(P.checkComponents(m, [{ name: 'Fence replacement', kind: 'project', monthly_amounts_cents: m }]).problems, []);
  });
  await t('4. recurring $3,000 + October project $30,000 explain exactly the $33,000 line; a partial set is refused', () => {
    const recurring = evenSplit(300000); const project = P.placeInMonths(3000000, [9]);
    const comps = [{ name: 'Recurring repairs', kind: 'recurring', monthly_amounts_cents: recurring }, { name: 'Fence replacement', kind: 'project', monthly_amounts_cents: project }];
    const line = P.lineMonthsFromComponents(comps);
    assert.strictEqual(sum(line), 3300000);
    assert.ok(P.checkComponents(line, comps).ok);
    const partial = P.checkComponents(line, [comps[1]]);
    assert.ok(!partial.ok); assert.strictEqual(sum(partial.residual), 300000, 'the unexplained $3,000 is reported');
    const base = P.baseComponentFor(line, [comps[1]]);
    assert.strictEqual(base.kind, 'recurring'); assert.deepStrictEqual(base.monthly_amounts_cents, recurring);
    assert.ok(P.checkComponents(line, [comps[1], base]).ok, 'auto base component closes the gap exactly');
  });
  await t('a project component with no planned month is flagged', () => {
    const r = P.checkComponents(Array(12).fill(0), [{ name: 'Paint', kind: 'project', monthly_amounts_cents: Array(12).fill(0) }]);
    assert.ok(r.problems.some((p) => /no planned month/.test(p)));
  });
  await t('5a. contract with only amount + dates: calculated and labelled an assumption to confirm', () => {
    const r = P.phase({ method: 'contract', fy: 2027, contract: { annual_cents: 6120000, effective_date: '2027-01-01', end_date: '2027-12-31', source_label: 'Landscape contract' } });
    assert.deepStrictEqual(r.monthly, Array(12).fill(510000)); assert.strictEqual(sum(r.monthly), 6120000);
    assert.strictEqual(r.basis, 'calculated'); assert.strictEqual(r.settings.assumption, true); assert.strictEqual(r.settings.confirmed_at, null);
    assert.match(r.explanation, /no payment schedule/); assert.match(r.explanation, /assumption/);
  });
  await t('5b. contract whose document has a schedule: documented, months exactly as the document says', () => {
    const sched = [{ month: 5, amount_cents: 900000 }, { month: 6, amount_cents: 1500000 }, { month: 7, amount_cents: 1500000 }, { month: 8, amount_cents: 1200000 }, { month: 9, amount_cents: 600000 }];
    const r = P.phase({ method: 'contract', fy: 2027, contract: { documented_schedule: sched, source_label: 'Pool management contract' } });
    assert.strictEqual(r.basis, 'documented'); assert.strictEqual(r.settings.assumption, false);
    assert.deepStrictEqual(r.monthly, [0, 0, 0, 0, 900000, 1500000, 1500000, 1200000, 600000, 0, 0, 0]);
  });
  await t('contract starting mid-year covers only its active months; escalator applies from the anniversary', () => {
    const r = P.contractSchedule({ annual_cents: 1200000, effective_date: '2027-04-01' }, 2027);
    assert.deepStrictEqual(r.monthly.slice(0, 3), [0, 0, 0]); assert.ok(r.monthly.slice(3).every((v) => v === 100000));
    const e = P.contractSchedule({ annual_cents: 1200000, effective_date: '2026-07-01', escalator_pct: 3 }, 2027);
    assert.deepStrictEqual(e.monthly.slice(0, 6), Array(6).fill(100000)); assert.ok(e.monthly.slice(6).every((v) => v === 103000));
  });
  await t('weighted and prior-year patterns total exactly; bad weights are refused', () => {
    const w = [5, 5, 5, 5, 10, 15, 15, 10, 10, 10, 5, 5];
    assert.strictEqual(sum(P.phase({ method: 'weighted', annual_cents: 1000001, settings: { weights_pct: w } }).monthly), 1000001);
    assert.throws(() => P.phase({ method: 'weighted', annual_cents: 100, settings: { weights_pct: Array(12).fill(5) } }), /total_100/);
    const pa = P.phase({ method: 'prior_actual', annual_cents: 7000000, prior_actual_months: POOL, settings: { source_year: 2026 } });
    assert.strictEqual(sum(pa.monthly), 7000000); assert.ok(pa.monthly[6] > pa.monthly[0] * 10, 'keeps the summer peak');
    assert.throws(() => P.phase({ method: 'prior_budget', annual_cents: 100, prior_budget_months: null }), /no_usable_months/);
  });
  await t('negative (contra-revenue) lines phase exactly, e.g. 4010 Reserve Contribution', () => {
    const r = P.phase({ method: 'even', annual_cents: -4270000 });
    assert.strictEqual(sum(r.monthly), -4270000);
    assert.strictEqual(sum(P.applyAnnualChange(r.monthly, -5000001, 'scale').monthly), -5000001);
  });

  // ---- server wiring (static) ----
  const books = fs.readFileSync(path.join(__dirname, '..', 'api/books.js'), 'utf8').replace(/\r\n/g, '\n');
  const block = (start) => { const i = books.indexOf(start); assert.ok(i >= 0, 'missing ' + start); return books.slice(i, books.indexOf('\n});', i)); };
  await t('plan save: draft-only refusal and component check come before the database write', () => {
    const b = block("router.post('/budgets/:id/lines/:lineId/plan'");
    const iLock = b.indexOf("'budget_locked'"), iChk = b.indexOf('checkComponents('), iRpc = b.indexOf("rpc('save_budget_line_plan'");
    assert.ok(iLock > 0 && iChk > iLock && iRpc > iChk);
  });
  await t('annual planner save cannot overwrite a line that has components', () => {
    const b = block("router.post('/budgets', express.json");
    assert.ok(b.indexOf("'line_has_components'") > 0 && b.indexOf("'line_has_components'") < b.indexOf('.upsert('));
  });
  await t('preview endpoints never write', () => {
    for (const r of ["router.post('/budgets/:id/lines/:lineId/phase-preview'", "router.post('/budgets/:id/lines/:lineId/annual-change'"]) {
      const b = block(r); assert.ok(!/\.(insert|update|upsert|delete)\(|rpc\(/.test(b), r + ' writes');
    }
  });
  await t('Budget vs Actual and the statements are untouched by Phase 2', () => {
    const { execSync } = require('child_process');
    let d; try { d = execSync('git diff --stat main -- lib/accounting/financial_statements.js lib/accounting/report_categories.js api/gl.js', { cwd: path.join(__dirname, '..') }).toString(); } catch (_) { return console.log('      (skipped: main not available)'); }
    assert.strictEqual(d.trim(), '', 'statement code changed: ' + d);
  });

  // ---- live ----
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) { console.log('      (live checks skipped)'); return done(); }
  const { createClient } = require('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const { data: comm, error: cErr } = await sb.from('communities').select('id').eq('name', 'Lakes of Pine Forest').maybeSingle();
  if (cErr) throw cErr;
  const { data: bud, error: bErr } = await sb.from('community_budgets').select('id, status').eq('community_id', comm.id).eq('fiscal_year', 2026).maybeSingle();
  if (bErr) throw bErr;
  const { data: lines, error: lErr } = await sb.from('budget_line_items').select('id, account_id, annual_amount_cents, monthly_amounts_cents, chart_of_accounts(account_number)').eq('budget_id', bud.id).order('id');
  if (lErr) throw lErr;

  await t('LOPF FY2026 unchanged: approved, 37 lines, $733,826.00, pool schedule intact, fingerprints match', () => {
    const crypto = require('crypto');
    assert.strictEqual(bud.status, 'approved'); assert.strictEqual(lines.length, 37);
    assert.strictEqual(lines.reduce((s, l) => s + Number(l.annual_amount_cents), 0), 73382600);
    assert.deepStrictEqual(lines.find((l) => l.chart_of_accounts.account_number === '5300').monthly_amounts_cents.map(Number), POOL);
    const months = lines.map((l) => l.chart_of_accounts.account_number + ':' + l.monthly_amounts_cents.join(',')).sort().join('\n');
    assert.strictEqual(crypto.createHash('sha256').update(months).digest('hex').slice(0, 16), '95e3991e8e39e640');
  });

  await t('saving a line of the approved LOPF FY2026 budget returns 409 and attempts no write', async () => {
    const sbjs = require('@supabase/supabase-js'); const real = sbjs.createClient; const writes = [];
    sbjs.createClient = (...a) => { const c = real(...a); const from = c.from.bind(c);
      c.from = (tb) => { const q = from(tb); for (const w of ['insert', 'update', 'upsert', 'delete']) q[w] = () => { writes.push(tb + '.' + w); throw new Error('write blocked'); }; return q; };
      c.rpc = async (fn) => { writes.push('rpc.' + fn); return { data: null, error: { code: 'XX', message: 'blocked' } }; }; return c; };
    delete require.cache[require.resolve('../api/books.js')];
    const { router } = require('../api/books.js'); sbjs.createClient = real; delete require.cache[require.resolve('../api/books.js')];
    const express = require('express'); const app = express(); app.use('/api/books', router);
    const srv = app.listen(0); const base = 'http://127.0.0.1:' + srv.address().port + '/api/books';
    try {
      const pool = lines.find((l) => l.chart_of_accounts.account_number === '5300');
      const r = await fetch(`${base}/budgets/${bud.id}/lines/${pool.id}/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ community_id: comm.id, monthly_amounts_cents: Array(12).fill(1), phasing_method: 'even' }) });
      const j = await r.json();
      assert.strictEqual(r.status, 409, JSON.stringify(j)); assert.strictEqual(j.error, 'budget_locked');
      assert.deepStrictEqual(writes, []);
    } finally { srv.close(); }
  });

  const applied = !(await sb.from('budget_line_components').select('id').limit(1)).error;
  if (applied) {
    await t('monthly plan read for LOPF FY2026: view-only, categories shown, months as stored', async () => {
      const { loadBudgetPlan } = require('../lib/accounting/budget_plan_data');
      const plan = await loadBudgetPlan(sb, bud.id);
      assert.strictEqual(plan.editable, false); assert.strictEqual(plan.lines.length, 37); assert.ok(plan.has_categories);
      const pool = plan.lines.find((l) => l.account_number === '5300');
      assert.deepStrictEqual(pool.monthly_amounts_cents, POOL); assert.strictEqual(pool.category, 'Pool'); assert.strictEqual(pool.subcategory, 'Pool Management');
      assert.strictEqual(plan.lines.find((l) => l.account_number === '4010').subcategory, 'Less: Reserve Contribution');
    });
  } else console.log('      (monthly plan read skipped: migration 464 not applied yet)');

  done();
  function done() { console.log(failed ? `\n${failed} failure(s)` : '\nall passed'); process.exitCode = failed ? 1 : 0; }
})().catch((e) => { console.error(e); process.exitCode = 1; });
