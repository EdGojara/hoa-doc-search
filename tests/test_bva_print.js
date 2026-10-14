// The board-facing Budget vs. Actual (Ed 2026-10-13): the configured two-level categories
// (category > subcategory > GL account) group the statement without changing a number, a
// section whose only category is the section itself shows its subcategories, a missing budget
// is n/a (never zero), unmapped accounts stay in every total, and the printed layout is six
// columns with the notes gathered once at the end. Drama Creek fixture; no network.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'; process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test';
const Module = require('module');
const F = require('./fixtures/drama_creek_statements');
const realLoad = Module._load;
Module._load = function (r) { if (r === '@supabase/supabase-js') return { createClient: () => F.fakeClient() }; return realLoad.apply(this, arguments); };
const M = require('../lib/statements/model');
const R = require('../lib/statements/render');
let pass = 0, fail = 0;
const check = (name, ok, info) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info ? ' :: ' + info : '')); } };
const NOW = new Date('2026-10-13T18:00:00Z');
const build = (fund = 'OPR') => M.buildIncomeBudgetModel(F.fakeClient(), { community_id: F.CID, period_end: '2026-09-30', fund, now: NOW });
const KEYS = ['mtd_actual', 'mtd_budget', 'mtd_var', 'ytd_actual', 'ytd_budget', 'ytd_var'];
const same = (a, b) => KEYS.every((k) => a[k] === b[k]);
const sum = (vals) => Object.fromEntries(KEYS.map((k) => [k, vals.reduce((t, v) => t + v[k], 0)]));

// LOPF's shape: Revenue > Assessments / Late fees / Amenity; Landscaping > Landscape maintenance
// (5200) / Irrigation repairs (5210).
function twoLevel(db) {
  const cat = (id, section, name, parent, order) => db.report_categories.push({ id, community_id: F.CID, statement: 'income_statement', section, name, report_label: null, parent_category_id: parent, display_order: order, is_active: true });
  cat('ic-rev', 'revenue', 'Revenue', null, 0);
  for (const id of ['ic-assess', 'ic-late', 'ic-other']) db.report_categories.find((c) => c.id === id).parent_category_id = 'ic-rev';
  cat('ic-land-mx', 'expense', 'Landscape maintenance', 'ic-land', 1); cat('ic-land-irr', 'expense', 'Irrigation repairs', 'ic-land', 2);
  db.account_report_map.find((m) => m.account_id === F.aid(5200) && m.statement === 'income_statement').category_id = 'ic-land-mx';
  db.account_report_map.find((m) => m.account_id === F.aid(5210) && m.statement === 'income_statement').category_id = 'ic-land-irr';
}

(async () => {
  F.seed();
  const flat = await build();
  F.seed(); twoLevel(F.getDb());
  const two = await build();
  const rev = two.sections.find((s) => s.key === 'revenue'), exp = two.sections.find((s) => s.key === 'expense');

  console.log('categories from configuration');
  check('grouping never changes a number: section totals and net are identical with and without subcategories',
    two.sections.every((s, i) => same(s.total.values, flat.sections[i].total.values)) && same(two.net.values, flat.net.values));
  check('a section whose only category is the section itself shows its subcategories as the categories',
    rev.groups.map((g) => g.label).join('|') === 'Assessments|Late fees & interest|Amenity & other income', rev.groups.map((g) => g.label).join('|'));
  const land = exp.groups.find((g) => g.label === 'Landscaping');
  check('a category with subcategories carries them in configured order, each with its accounts',
    land && land.subgroups.map((s) => s.label).join('|') === 'Landscape maintenance|Irrigation repairs' && land.subgroups[0].lines[0].account_number === '5200' && land.subgroups[1].lines[0].account_number === '5210');
  check('subcategory subtotals add to the category total; category totals add to the section total',
    land && same(sum(land.subgroups.map((s) => s.values)), land.values) && same(sum(exp.groups.map((g) => g.values)), exp.total.values));

  console.log('unmapped accounts');
  F.seed(); twoLevel(F.getDb());
  const db = F.getDb(); db.account_report_map.splice(db.account_report_map.findIndex((m) => m.account_id === F.aid(5600) && m.statement === 'income_statement'), 1);
  const um = await build();
  const ug = um.sections.find((s) => s.key === 'expense').groups.find((g) => g.kind === 'unmapped');
  check('an unmapped account still appears, flagged, and stays in every total', ug && ug.lines.some((l) => l.account_number === '5600') && same(um.sections.find((s) => s.key === 'expense').total.values, exp.total.values));
  check('printed: the unmapped account is listed and flagged for mapping', /Unmapped/.test(R.renderHtml(um, { mode: 'print', noStyle: true })) && /5600/.test(R.renderHtml(um, { mode: 'print', noStyle: true })));

  console.log('missing budget');
  F.seed(); F.getDb().community_budgets.length = 0;
  const nb = await build();
  const nbl = nb.sections[0].groups[0].lines[0];
  check('no approved budget: budget and variance are n/a (null) at every level, never zero', nbl.values.mtd_budget === null && nbl.values.ytd_var === null && nb.sections.every((s) => s.total.values.ytd_budget === null && s.total.values.ytd_var === null) && nb.net.values.mtd_var === null);
  check('...actuals are unaffected and a warning says why', nb.sections[0].total.values.ytd_actual === flat.sections[0].total.values.ytd_actual && nb.warnings.some((w) => w.code === 'no_approved_budget'));
  check('...and the printed budget cells read n/a', /n\/a/.test(R.renderHtml(nb, { mode: 'print', noStyle: true })));

  console.log('printed layout');
  const p = R.renderHtml(two, { mode: 'print', noStyle: true });
  check('six figure columns: month and year to date actual, budget, variance; no annual budget column', (p.match(/<col>/g) || []).length === 6 && !/Annual/.test(p) && /Current month/.test(p) && /Year to date/.test(p));
  check('the on-screen statement keeps the annual budget', /Annual/.test(R.renderHtml(two, { mode: 'web', noStyle: true })));
  check('category heading, its accounts, then "Total <Category>"', /<tr class="cat subhead"><td><span>Landscaping<\/span>/.test(p) && /Total Landscaping/.test(p));
  check('a one-account category prints as one line', /<tr class="cat one"><td>Insurance /.test(p));
  check('each short category is a keep-together block', /<tbody class="blk"><tr class="cat subhead"><td><span>Landscaping/.test(p));
  check('header names the fund and the reporting month and fiscal year to date; notes are not repeated in the header',
    /Operating/.test(p) && /Month ended September 30, 2026 · Fiscal year to date, January 1 to September 30, 2026/.test(p) && !/class="notes"/.test(p));
  const doc = R.renderDocument([two, await build('RES')]);
  check('the document gathers the notes once at the end: posted actuals only, variance convention, carry-forward by fund', /Notes to the statements/.test(doc) && /posted general-ledger entries only/.test(doc) && /favorable is positive/.test(doc) && /year to date includes activity carried from the prior accounting system through July 31, 2026/.test(doc) && (doc.match(/Prior-year comparison is hidden/g) || []).length === 1);
  check('US Letter landscape with margins under half an inch at the sides', /@page\{size:Letter landscape;margin:0\.62in 0\.45in 0\.6in\}/.test(doc));
  check('a later fund in the package gets the compact header (the page header names the association)', (doc.match(/class="assoc"/g) || []).length === 1 && /th-head compact/.test(doc));

  console.log('proposed budget is untouched');
  // The proposed budget shares the income_budget kind but has no variance columns.
  const po = { ...two, columns: two.columns.filter((c) => !c.is_var) };
  const pp = R.renderHtml(po, { mode: 'print', noStyle: true });
  check('a statement without variance columns (the proposed budget) keeps its own layout', !/tstmt print board/.test(pp) && !/Notes to the statements/.test(R.renderDocument([po])));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
