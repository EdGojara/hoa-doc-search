#!/usr/bin/env node
// ============================================================================
// Reporting categories Phase 1 (Ed 2026-09-25). Grouping is presentation only:
//   * the flat Budget vs Actual is unchanged,
//   * grouped totals tie exactly to flat totals (every amount column, by fund),
//   * unmapped accounts stay visible and inside every total,
//   * the grouped Income Statement's fund totals equal the current statement's,
//   * the LOPF seed covers every income/expense account exactly once.
// Live checks read Lakes of Pine Forest (read-only). Before migration 463 is
// applied they use the approved seed file as the mapping; after, the database's.
// BVA_MAIN_MODULE (optional) = path to main's financial_statements.js for the
// before/after comparison.
// ============================================================================
require('dotenv').config({ quiet: true });
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildMapping, groupStatementRows, UNMAPPED_LABEL } = require('../lib/accounting/report_categories');

let failed = 0;
const t = async (name, fn) => { try { await fn(); console.log('PASS  ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); } };
const ROOT = path.join(__dirname, '..');
const SEED = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib/accounting/report_seeds/lopf_income_statement.json'), 'utf8'));
const KEYS = ['mtd_budget_cents', 'mtd_actual_cents', 'mtd_variance_cents', 'ytd_budget_cents', 'ytd_actual_cents', 'ytd_variance_cents', 'annual_budget_cents'];
const IS_KEYS6 = ['mtd_actual_cents', 'mtd_budget_cents', 'mtd_variance_cents', 'ytd_actual_cents', 'ytd_budget_cents', 'ytd_variance_cents'];
const DATES = ['2026-01-31', '2026-03-31', '2026-06-30', '2026-07-31', '2026-08-31', '2026-09-25'];
const sum = (rows, k) => rows.reduce((s, r) => s + Number(r[k] || 0), 0);

// Build a mapping object from the seed file + the community's accounts (ids are synthetic).
function mappingFromSeed(coa, seed = SEED, dropAccounts = []) {
  const byNum = new Map(coa.map((a) => [a.account_number, a]));
  const cats = []; const maps = []; let n = 0;
  seed.categories.forEach((c, ci) => {
    const top = { id: 'c' + (++n), section: c.section, name: c.name, report_label: c.report_label || null, parent_category_id: null, display_order: (ci + 1) * 10, is_active: true };
    cats.push(top);
    c.subcategories.forEach((s, si) => {
      const sub = { id: 'c' + (++n), section: c.section, name: s.name, report_label: s.report_label || null, parent_category_id: top.id, display_order: (si + 1) * 10, is_active: true };
      cats.push(sub);
      for (const num of s.accounts) { if (dropAccounts.includes(num)) continue; const a = byNum.get(num); if (a) maps.push({ account_id: a.id, category_id: sub.id, display_order: null }); }
    });
  });
  return buildMapping(cats, maps);
}

// Pull named functions out of accounting.html (brace-matched) to run them here.
function pageFns(names) {
  const html = fs.readFileSync(path.join(ROOT, 'public/accounting.html'), 'utf8').replace(/\r\n/g, '\n');
  const grab = (startToken) => {
    const i = html.indexOf(startToken); assert.ok(i >= 0, 'missing ' + startToken);
    let depth = 0, j = html.indexOf('{', i);
    for (; j < html.length; j++) { if (html[j] === '{') depth++; else if (html[j] === '}') { depth--; if (depth === 0) break; } }
    return html.slice(i, j + 1);
  };
  const consts = [
    "const fmt = (cents) => '$' + (Number(cents||0)/100).toLocaleString(undefined,{minimumFractionDigits:2, maximumFractionDigits:2});",
    'const esc = (s) => String(s==null?\'\':s).replace(/[&<>"]/g,(c)=>({\'&\':\'&amp;\',\'<\':\'&lt;\',\'>\':\'&gt;\',\'"\':\'&quot;\'}[c]));',
    html.slice(html.indexOf('  const _FUND_TITLES'), html.indexOf('\n', html.indexOf('  const _FUND_TITLES'))),
    html.slice(html.indexOf('  const _BVA_KEYS'), html.indexOf('\n', html.indexOf('  const _BVA_KEYS'))),
    grab('function _bvaVarCell('), grab('function _bvaSum('),
  ];
  const src = consts.join('\n') + '\n' + names.map((n) => grab('function ' + n + '(')).join('\n') + `\nreturn { ${names.join(', ')} };`;
  return new Function(src)();
}

(async () => {
  // ---- seed file ----
  await t('migration 463 embeds exactly the approved seed file', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'migrations/463_report_categories.sql'), 'utf8');
    const m = sql.match(/\$spec\$([\s\S]*?)\$spec\$/);
    assert.ok(m, 'no embedded spec');
    assert.deepStrictEqual(JSON.parse(m[1]), SEED);
  });
  await t('seed: 10 categories, 51 subcategories, 54 accounts, none twice; 4010 prints as "Less: Reserve Contribution"', () => {
    assert.strictEqual(SEED.categories.length, 10);
    const subs = SEED.categories.flatMap((c) => c.subcategories);
    assert.strictEqual(subs.length, 51);
    const accts = subs.flatMap((s) => s.accounts);
    assert.strictEqual(accts.length, 54); assert.strictEqual(new Set(accts).size, 54);
    for (const c of SEED.categories) assert.strictEqual(new Set(c.subcategories.map((s) => s.name.toLowerCase())).size, c.subcategories.length, 'duplicate subcategory in ' + c.name);
    const rc = subs.find((s) => s.accounts.includes('4010'));
    assert.strictEqual(rc.name, 'Reserve Contribution'); assert.strictEqual(rc.report_label, 'Less: Reserve Contribution');
    // Approved changes
    const where = (num) => { for (const c of SEED.categories) for (const s of c.subcategories) if (s.accounts.includes(num)) return c.name + ' / ' + s.name; };
    assert.strictEqual(where('5126'), 'Landscaping / Irrigation Maintenance');
    assert.strictEqual(where('5127'), 'Lakes & Fountains / Irrigation & Repair');
    assert.strictEqual(where('5795'), 'Common Area Maintenance / Pest Control');
    assert.strictEqual(where('5210'), 'Landscaping / MUD / Lakes Landscaping');
    assert.strictEqual(where('4110'), 'Revenue / Interest Income');
  });

  // ---- pure grouping ----
  await t('grouping: subtotals are sums of rows, unmapped stays visible, totals tie to flat', () => {
    const cats = [
      { id: 'R', section: 'revenue', name: 'Revenue', parent_category_id: null, display_order: 10, is_active: true },
      { id: 'R1', section: 'revenue', name: 'Assessments', parent_category_id: 'R', display_order: 10, is_active: true },
      { id: 'E', section: 'expense', name: 'Pool', parent_category_id: null, display_order: 10, is_active: true },
      { id: 'E1', section: 'expense', name: 'Pool Mgmt', parent_category_id: 'E', display_order: 10, is_active: true },
    ];
    const mapping = buildMapping(cats, [{ account_id: 'a1', category_id: 'R1' }, { account_id: 'a2', category_id: 'E1' }]);
    const rows = [
      { account_id: 'a1', account_type: 'revenue', account_number: '4000', mtd_budget_cents: 100, annual_budget_cents: 1200 },
      { account_id: 'a2', account_type: 'expense', account_number: '5300', mtd_budget_cents: 40, annual_budget_cents: 480 },
      { account_id: 'a3', account_type: 'expense', account_number: '5999', mtd_budget_cents: 7, annual_budget_cents: 84 },
    ];
    const g = groupStatementRows(rows, mapping, ['mtd_budget_cents', 'annual_budget_cents']);
    assert.strictEqual(g.sections[1].unmapped.rows[0].account_number, '5999');
    assert.strictEqual(g.sections[1].unmapped.label, UNMAPPED_LABEL);
    assert.strictEqual(g.sections[1].totals.mtd_budget_cents, 47, 'unmapped included in the section total');
    assert.strictEqual(g.totals.net.annual_budget_cents, 1200 - 564);
    assert.strictEqual(g.unmapped_count, 1);
  });
  await t('grouping: a revenue account mapped to an expense category is treated as unmapped, never moved', () => {
    const cats = [{ id: 'E', section: 'expense', name: 'X', parent_category_id: null, display_order: 1, is_active: true }];
    const g = groupStatementRows([{ account_id: 'a', account_type: 'revenue', account_number: '4000', v: 5 }], buildMapping(cats, [{ account_id: 'a', category_id: 'E' }]), ['v']);
    assert.strictEqual(g.sections[0].unmapped.rows.length, 1); assert.strictEqual(g.sections[1].totals.v, 0);
  });

  // ---- static: flat view untouched ----
  await t('flat Budget vs Actual renderer and request are byte-identical to main', () => {
    const { execSync } = require('child_process');
    let mainHtml; try { mainHtml = execSync('git show main:public/accounting.html', { cwd: ROOT, maxBuffer: 64e6 }).toString(); } catch (_) { return console.log('      (skipped: main not available)'); }
    const cur = fs.readFileSync(path.join(ROOT, 'public/accounting.html'), 'utf8');
    const fnText = (h) => { h = h.replace(/\r\n/g, '\n'); const i = h.indexOf('  function bvaHTML('); return h.slice(i, h.indexOf('\n  }\n', i)); };
    assert.strictEqual(fnText(cur), fnText(mainHtml), 'bvaHTML changed');
    assert.ok(/budget-vs-actual\?community_id=\$\{CID\}&period_end=\$\{e\}\$\{mode==='grouped'\?'&grouped=1':''\}/.test(cur), 'flat request adds nothing');
  });

  // ---- live LOPF ----
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) { console.log('      (live checks skipped: no Supabase env)'); return done(); }
  const { createClient } = require('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const FS = require('../lib/accounting/financial_statements');
  const { data: comm, error: cErr } = await sb.from('communities').select('id').eq('name', SEED.community_name).maybeSingle();
  if (cErr) throw cErr;
  const cid = comm.id;
  const { data: coa, error: coaErr } = await sb.from('chart_of_accounts').select('id, account_number, account_name, account_type').eq('community_id', cid).in('account_type', ['revenue', 'expense']).order('account_number').limit(5000);
  if (coaErr) throw coaErr;

  // Which mapping: the database's once 463 is applied, else the seed file.
  const probe = await sb.from('report_categories').select('id').limit(1);
  const applied = !probe.error;
  const { loadReportMapping } = require('../lib/accounting/report_categories');
  const MAP = applied ? await loadReportMapping(sb, cid) : mappingFromSeed(coa);
  console.log(`      mapping source: ${applied ? 'database (463 applied)' : 'seed file (463 not applied yet)'}`);

  await t('LOPF: every income/expense account is mapped exactly once, into its own section', () => {
    const seedNums = SEED.categories.flatMap((c) => c.subcategories.flatMap((s) => s.accounts));
    assert.deepStrictEqual([...seedNums].sort(), coa.map((a) => a.account_number).sort(), 'seed accounts vs chart');
    for (const a of coa) {
      const m = MAP.byAccount.get(a.id); assert.ok(m, a.account_number + ' unmapped');
      assert.strictEqual(m.top.section, a.account_type, a.account_number + ' in the wrong section');
    }
  });
  if (applied) {
    await t('LOPF: database mapping equals the approved seed', () => {
      const seedMap = mappingFromSeed(coa);
      for (const a of coa) {
        const d = MAP.byAccount.get(a.id), s = seedMap.byAccount.get(a.id);
        assert.strictEqual(d.top.name, s.top.name, a.account_number); assert.strictEqual(d.sub && d.sub.name, s.sub && s.sub.name, a.account_number);
      }
    });
  }

  const mainFS = process.env.BVA_MAIN_MODULE ? require(process.env.BVA_MAIN_MODULE) : null;
  const snap = {};
  await t('flat Budget vs Actual unchanged; grouped totals tie to flat on every column, overall and by fund', async () => {
    for (const d of DATES) {
      const flat = await FS.budgetVsActual({ community_id: cid, period_end: d });
      if (mainFS) assert.deepStrictEqual(flat, await mainFS.budgetVsActual({ community_id: cid, period_end: d }), d + ' flat differs from main');
      const grp = await FS.budgetVsActualGrouped({ community_id: cid, period_end: d, _mapping: MAP });
      const { grouped, ...rest } = grp;
      assert.deepStrictEqual(rest, flat, d + ' grouped response altered the flat part');
      const all = grouped.all;
      for (const k of KEYS) {
        assert.strictEqual(all.totals.revenue[k], sum(flat.rows.filter((r) => r.account_type === 'revenue'), k), `${d} revenue ${k}`);
        assert.strictEqual(all.totals.expense[k], sum(flat.rows.filter((r) => r.account_type === 'expense'), k), `${d} expense ${k}`);
        for (const sec of all.sections) {
          const catSum = sec.categories.reduce((s, c) => s + c.totals[k], 0) + sec.unmapped.totals[k];
          assert.strictEqual(catSum, sec.totals[k], `${d} ${sec.section} categories ${k}`);
          for (const c of sec.categories) {
            assert.strictEqual(c.totals[k], sum([...c.rows, ...c.subcategories.flatMap((s) => s.rows)], k), `${d} ${c.name} ${k}`);
            for (const s of c.subcategories) assert.strictEqual(s.totals[k], sum(s.rows, k), `${d} ${s.name} ${k}`);
          }
        }
        // by fund: each fund's tree ties to that fund's flat rows; funds add to the whole
        let fundSum = 0;
        for (const [fc, tree] of Object.entries(grouped.by_fund)) {
          const fr = flat.rows.filter((r) => (r.fund_code || '—') === fc);
          assert.strictEqual(tree.totals.net[k], sum(fr.filter((r) => r.account_type === 'revenue'), k) - sum(fr.filter((r) => r.account_type === 'expense'), k), `${d} ${fc} net ${k}`);
          fundSum += tree.totals.net[k];
        }
        assert.strictEqual(fundSum, all.totals.net[k], `${d} funds add to whole ${k}`);
      }
      const shown = [...all.sections.flatMap((s) => [...s.categories.flatMap((c) => [...c.rows, ...c.subcategories.flatMap((x) => x.rows)]), ...s.unmapped.rows])];
      assert.strictEqual(shown.length, flat.rows.length, d + ' every flat row appears once in the grouped view');
      snap[d] = { rows: flat.rows.length, rev: all.totals.revenue, exp: all.totals.expense, unmapped: all.unmapped_count, funds: Object.fromEntries(Object.entries(grouped.by_fund).map(([fc, tr]) => [fc, tr.totals.net.ytd_actual_cents])) };
      console.log(`      ${d}: ${flat.rows.length} rows · rev YTD act ${(all.totals.revenue.ytd_actual_cents / 100).toFixed(2)} · exp YTD act ${(all.totals.expense.ytd_actual_cents / 100).toFixed(2)} · annual rev ${(all.totals.revenue.annual_budget_cents / 100).toFixed(2)} exp ${(all.totals.expense.annual_budget_cents / 100).toFixed(2)} · unmapped ${all.unmapped_count} · funds ${Object.entries(snap[d].funds).map(([f, v]) => f + ' ' + (v / 100).toFixed(2)).join(', ')}`);
    }
  });

  await t('unmapped accounts stay visible and inside the totals (5126, 5300, 4100 removed from the map)', async () => {
    const partial = mappingFromSeed(coa, SEED, ['5126', '5300', '4100']);
    const d = '2026-09-25';
    const flat = await FS.budgetVsActual({ community_id: cid, period_end: d });
    const g = (await FS.budgetVsActualGrouped({ community_id: cid, period_end: d, _mapping: partial })).grouped.all;
    const um = g.sections.flatMap((s) => s.unmapped.rows.map((r) => r.account_number)).sort();
    assert.deepStrictEqual(um, ['4100', '5300'], 'active accounts show as Unmapped (5126 has no activity, so no row)');
    for (const k of KEYS) assert.strictEqual(g.totals.net[k], sum(flat.rows.filter((r) => r.account_type === 'revenue'), k) - sum(flat.rows.filter((r) => r.account_type === 'expense'), k), k);
  });

  await t('grouped Income Statement: fund totals equal the current statement; unmapped communities keep today\'s groups', async () => {
    for (const d of DATES) {
      const mapped = await FS.perFundIncomeStatement({ community_id: cid, period_end: d, _mapping: MAP });
      const unmapped = await FS.perFundIncomeStatement({ community_id: cid, period_end: d, _mapping: { has_mapping: false, categories: [], byAccount: new Map() } });
      const base = mainFS ? await mainFS.perFundIncomeStatement({ community_id: cid, period_end: d }) : unmapped;
      assert.deepStrictEqual(mapped.funds.map((f) => f.fund_code), base.funds.map((f) => f.fund_code), d + ' fund sections');
      for (const f of mapped.funds) {
        const b = base.funds.find((x) => x.fund_code === f.fund_code);
        for (const k of IS_KEYS6) for (const tot of ['revenue_totals', 'expense_totals', 'net_totals']) assert.strictEqual(f[tot][k], b[tot][k], `${d} ${f.fund_code} ${tot} ${k}`);
        const nRows = [...f.revenue_groups, ...f.expense_groups].reduce((s, g) => s + g.rows.length, 0);
        const bRows = [...b.revenue_groups, ...b.expense_groups].reduce((s, g) => s + g.rows.length, 0);
        assert.strictEqual(nRows, bRows, `${d} ${f.fund_code} every account appears once`);
      }
      if (mainFS) {
        for (const f of unmapped.funds) {
          const b = base.funds.find((x) => x.fund_code === f.fund_code);
          assert.deepStrictEqual(f.revenue_groups.map((g) => [g.group, g.rows.length, ...IS_KEYS6.map((k) => g.totals[k])]), b.revenue_groups.map((g) => [g.group, g.rows.length, ...IS_KEYS6.map((k) => g.totals[k])]), 'fallback revenue groups');
          assert.deepStrictEqual(f.expense_groups.map((g) => [g.group, g.rows.length, ...IS_KEYS6.map((k) => g.totals[k])]), b.expense_groups.map((g) => [g.group, g.rows.length, ...IS_KEYS6.map((k) => g.totals[k])]), 'fallback expense groups');
        }
      }
    }
  });

  await t('rendered views: every account once; "Less: Reserve Contribution" printed; no Unmapped block when fully mapped', async () => {
    const d = '2026-09-25';
    const j = await FS.budgetVsActualGrouped({ community_id: cid, period_end: d, _mapping: MAP });
    const { bvaHTML, bvaGroupedHTML, _budgetISBody } = pageFns(['bvaHTML', 'bvaGroupedHTML', '_budgetISBody']);
    const grouped = bvaGroupedHTML(j);
    for (const r of j.rows) assert.ok(grouped.includes(`>${r.account_number}</td>`), 'grouped BvA missing ' + r.account_number);
    assert.ok(!grouped.includes(UNMAPPED_LABEL), 'unexpected Unmapped block');
    assert.strictEqual(bvaHTML(j), bvaHTML({ ...j, grouped: undefined }), 'flat renderer ignores the grouped data');
    const is = _budgetISBody(j.rows, j.fiscal_year, j.has_budget, j.grouped);
    assert.ok(is.includes('Less: Reserve Contribution'));
    assert.ok(is.includes('Annual Budget'));
    for (const r of j.rows) assert.strictEqual(is.split(`<td class="mono">${r.account_number}</td>`).length - 1, 1, 'IS shows ' + r.account_number + ' once');
    const fallback = _budgetISBody(j.rows, j.fiscal_year, j.has_budget, null);
    for (const r of j.rows) assert.ok(fallback.includes(`<td class="mono">${r.account_number}</td>`));
  });

  done();
  function done() { console.log(failed ? `\n${failed} failure(s)` : '\nall passed'); process.exitCode = failed ? 1 : 0; }
})().catch((e) => { console.error(e); process.exitCode = 1; });
