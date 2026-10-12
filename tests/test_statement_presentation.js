#!/usr/bin/env node
// tests/test_statement_presentation.js  (Ed 2026-10-12)
// The board statement (lib/statements model + renderer) on Canyon Gate's ACTUAL September 2026
// report inputs (tests/fixtures/statements/canyon-gate-2026-09.json, recorded read-only):
//   1. Adopt-a-School accounts and activity appear only in the Adopt a School Fund;
//   2. zero-only accounts, empty sections and zero transfer lines are suppressed, and no
//      nonzero amount is ever hidden;
//   3. the $164,000 Operating-to-Reserve contribution is an interfund transfer: below
//      "Operating net income before transfers", "Transfer to Reserve Fund" in Operating,
//      "Transfer from Operating Fund" in Reserve, net change after transfers, offsetting
//      (not shown) for the whole association, never revenue or expense;
//   4. each fund's totals tie to the statement engine, the funds add up to the association
//      without double counting, and variance signs follow one stated convention.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
const assert = require('assert');
const path = require('path');
const FX = require('./fixtures/statements/canyon-gate-2026-09.json');
const FS = require('../lib/accounting/financial_statements');
FS.budgetVsActual = async (o) => { const r = FX.bva[o.period_end]; if (!r) throw new Error(`no fixture for ${o.period_end}`); return JSON.parse(JSON.stringify(r)); };
const M = require('../lib/statements/model');
const R = require('../lib/statements/render');

// Replays the recorded queries (same table + same call chain = same answer).
const replay = {
  from(t) {
    const calls = [];
    const p = new Proxy({}, { get(_, k) {
      if (k === 'then') return (res, rej) => { const hit = FX.queries.find((q) => q.t === t && q.calls === JSON.stringify(calls)); return Promise.resolve(hit ? hit.r : { data: null, error: { message: `no recorded query for ${t} ${JSON.stringify(calls)}` } }).then(res, rej); };
      return (...a) => { calls.push([k, a]); return p; };
    } });
    return p;
  },
  rpc: async (n, a) => { const hit = FX.queries.find((q) => q.rpc === n && q.a === JSON.stringify(a)); return hit ? hit.r : { data: null, error: { message: 'no rpc' } }; },
};

let passed = 0; let failed = 0;
const t = async (name, fn) => { try { await fn(); passed++; console.log('  ok  ', name); } catch (e) { failed++; console.log('  FAIL', name, '\n       ', e.message); } };
const CG = FX.community_id; const END = FX.period_end; const NOW = new Date(FX.recorded_at);
const COLS = ['mtd_actual', 'mtd_budget', 'mtd_var', 'ytd_actual', 'ytd_budget', 'ytd_var', 'annual_budget'];
const lines = (m) => m.sections.flatMap((s) => s.groups.flatMap((g) => g.lines));
const nz = (v) => v !== null && v !== undefined && Number(v) !== 0;
const AAS_ACCTS = ['4050', '4130', '5950'];

(async () => {
  console.log('Statement presentation (Canyon Gate, September 2026 actual data)');
  const model = {};
  for (const f of ['OPR', 'RES', 'AAS', 'all']) model[f] = await M.buildIncomeBudgetModel(replay, { community_id: CG, period_end: END, fund: f, now: NOW });
  const rows = FX.bva[END].rows;

  await t('1. Adopt-a-School accounts appear only in the Adopt a School Fund (and the association total), never in Operating or Reserve', () => {
    for (const f of ['OPR', 'RES']) assert.ok(!lines(model[f]).some((l) => AAS_ACCTS.includes(String(l.account_number))), `${f} shows an Adopt-a-School account`);
    const aas = lines(model.AAS).map((l) => String(l.account_number)).sort();
    assert.deepStrictEqual(aas, AAS_ACCTS.slice().sort());
    assert.ok(lines(model.AAS).every((l) => l.fund_code === 'AAS'));
    // The Operating-fund rows the old screen printed (4050 / 5950 posted to OPR and netted to zero) are all zero.
    const oprAas = rows.filter((r) => r.fund_code === 'OPR' && AAS_ACCTS.includes(String(r.account_number)));
    assert.ok(oprAas.length > 0 && oprAas.every((r) => ['mtd_actual_cents', 'mtd_budget_cents', 'ytd_actual_cents', 'ytd_budget_cents', 'annual_budget_cents'].every((k) => !nz(r[k]))), 'the Operating-fund Adopt-a-School rows are zero-only (no misposted balance)');
  });

  await t('2. zero suppression: every printed account has a nonzero amount; no nonzero row is hidden; empty sections are suppressed', () => {
    for (const f of ['OPR', 'RES', 'AAS', 'all']) for (const l of lines(model[f])) assert.ok(COLS.some((k) => nz(l.values[k])), `${f} prints zero-only ${l.account_number}`);
    for (const f of ['OPR', 'RES', 'AAS']) {
      const printed = new Set(lines(model[f]).map((l) => `${l.account_id}|${l.fund_id}`));
      const hidden = rows.filter((r) => (r.fund_code || 'OPR') === f && r.account_subtype !== 'interfund_transfer' && !printed.has(`${r.account_id}|${r.fund_id || null}`));
      for (const r of hidden) assert.ok(['mtd_actual_cents', 'mtd_budget_cents', 'ytd_actual_cents', 'ytd_budget_cents', 'annual_budget_cents'].every((k) => !nz(r[k])), `${f} hid nonzero ${r.account_number}`);
    }
    const html = R.renderHtml({ ...model.AAS, sections: model.AAS.sections.map((s) => (s.key === 'revenue' ? { ...s, groups: [], suppressed: true } : s)) }, { mode: 'print' });
    assert.ok(!/>Revenue</.test(html) && !/Total revenue/.test(html) && /Expenses/.test(html), 'a suppressed section prints no heading and no zero total');
  });

  await t('3. the $164,000 reserve contribution is a transfer, below Operating net income before transfers', () => {
    const o = model.OPR, r = model.RES;
    assert.strictEqual(o.net.label, 'Operating net income before transfers');
    assert.ok(!lines(o).some((l) => String(l.account_number) === '4010') && !lines(r).some((l) => String(l.account_number) === '4010'), '4010 is not revenue or expense in any fund');
    const to = o.transfers.groups[0].lines; const from = r.transfers.groups[0].lines;
    assert.deepStrictEqual(to.map((l) => [l.account_name, l.values.annual_budget, l.values.ytd_budget, l.values.ytd_actual]), [['Transfer to Reserve Fund', -16400000, -12299900, 0]]);
    assert.deepStrictEqual(from.map((l) => [l.account_name, l.values.annual_budget, l.values.ytd_budget, l.values.ytd_actual]), [['Transfer from Operating Fund', 16400000, 12299900, 0]]);
    assert.strictEqual(o.change.label, 'Net change in fund balance after transfers');
    for (const k of ['ytd_actual', 'ytd_budget', 'annual_budget']) { assert.strictEqual(o.change.values[k], o.net.values[k] + to[0].values[k]); assert.strictEqual(r.change.values[k], r.net.values[k] + from[0].values[k]); }
    assert.ok(to.every((l) => l.is_transfer) && o.notes.some((n) => n.code === 'transfer_variance'));
  });

  await t('3b. the whole association: transfers offset, are not revenue or expense, and are not presented (a note says what was budgeted)', () => {
    const a = model.all;
    assert.ok(!a.transfers, 'no transfer section for the association');
    assert.ok(!a.change || (a.prior_period && a.change.label === 'Net change in fund balance'), 'a change line only for prior-period items, never for transfers');
    assert.strictEqual(a.net.label, 'Association net income (all funds)');
    const note = a.notes.find((n) => n.code === 'transfers_offset');
    assert.ok(note && /\$164,000\.00/.test(note.text) && /\$122,999\.00/.test(note.text), note && note.text);
    const sum = (k) => ['OPR', 'RES', 'AAS'].reduce((s, f) => s + (model[f].change ? model[f].change.values[k] : model[f].net.values[k]), 0);
    const assoc = (k) => (a.change ? a.change.values[k] : a.net.values[k]);
    for (const k of ['ytd_actual', 'ytd_budget', 'annual_budget', 'mtd_actual', 'mtd_budget']) assert.strictEqual(sum(k), assoc(k), `${k}: funds after transfers add up to the association with no double counting`);
  });

  await t('4. each fund ties to the statement engine; Operating net income is not reduced by the reserve contribution', () => {
    for (const f of ['OPR', 'RES', 'AAS']) {
      const m = model[f];
      for (const [type, sec] of [['revenue', 0], ['expense', 1]]) {
        const want = rows.filter((x) => (x.fund_code || 'OPR') === f && x.account_type === type && x.account_subtype !== 'interfund_transfer').reduce((s, x) => s + Number(x.ytd_actual_cents || 0), 0);
        assert.strictEqual(m.sections[sec].total.values.ytd_actual, want, `${f} ${type} ytd ties to the engine`);
      }
    }
    const o = model.OPR;
    assert.strictEqual(o.net.values.annual_budget, o.sections[0].total.values.annual_budget - o.sections[1].total.values.annual_budget, 'operating net income = operating revenue - operating expense (no transfer inside)');
    assert.strictEqual(o.net.values.annual_budget, 14071800, '$140,718.00 operating net income before the $164,000 transfer');
    assert.strictEqual(o.change.values.annual_budget, 14071800 - 16400000);
  });

  await t('4b. variance convention: revenue actual - budget, expense budget - actual, transfers actual - budget printed without favorable/unfavorable color', () => {
    for (const l of lines(model.OPR)) {
      const v = l.values; if (v.ytd_actual === null) continue;
      const want = l.account_type === 'expense' || model.OPR.sections[1].groups.some((g) => g.lines.includes(l)) ? v.ytd_budget - v.ytd_actual : v.ytd_actual - v.ytd_budget;
      assert.strictEqual(v.ytd_var, want, `${l.account_number} ytd variance`);
    }
    const html = R.renderHtml(model.OPR, { mode: 'print' });
    const transferRow = html.split('<tr').find((r) => r.includes('Transfer to Reserve Fund'));
    assert.ok(transferRow && !/\b(fav|unfav)\b/.test(transferRow), 'transfer row has no favorable/unfavorable tone');
    assert.ok(/Operating net income before transfers/.test(html) && /Net change in fund balance after transfers/.test(html));
  });

  await t('the approved $164,000 is unchanged on both sides and no actual transfer is invented', () => {
    const b = rows.find((x) => String(x.account_number) === '4010');
    assert.strictEqual(Number(b.annual_budget_cents), -16400000, 'the stored budget line is untouched (-164,000 on 4010 in Reserve)');
    assert.strictEqual(Number(b.ytd_actual_cents || 0), 0);
    assert.strictEqual(model.OPR.transfers.total.values.ytd_actual, 0); assert.strictEqual(model.RES.transfers.total.values.ytd_actual, 0);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
