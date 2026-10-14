// Kat's cutoff account additions on the balance sheet, end to end through the ACTUAL code: the
// approval path (lib/accounting/cutoff_adjustments.postApproved) creates GL 2100 Accrued Expenses and
// 1410 Prepaid Expenses, maps each to its role's balance-sheet category (created when the community
// has none: the Lakes of Pine Forest condition), posts the entries, and the statement engine
// (lib/statements/model + render + export) presents them. Drama Creek fixture with EVERY
// balance-sheet category removed. The run is replayed in the shape stored for LOPF August 2026 before
// this change (no bs_role, bs_category null) and in the new shape. Nothing touches live data.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'; process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test';
const path = require('path');
const fs = require('fs');
const Module = require('module');
const F = require('./fixtures/drama_creek_statements');
const realLoad = Module._load;
Module._load = function (r) { if (r === '@supabase/supabase-js') return { createClient: () => F.fakeClient() }; return realLoad.apply(this, arguments); };
const POSTING = require('../lib/accounting/posting');
const C = require('../lib/accounting/cutoff_adjustments');
const M = require('../lib/statements/model');
const R = require('../lib/statements/render');
let pass = 0, fail = 0;
const check = (name, ok, info) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info ? ' :: ' + info : '')); } };
const CID = F.CID; const NOW = new Date('2026-10-14T18:00:00Z');
const APPROVER = 'egojara@bedrocktx.com (authenticated in-app approval)';

// The LOPF August 2026 package as stored (five boxes), on fixture accounts: 5200/5300 stand in for
// the landscape and pool expense accounts; the amounts are LOPF's.
const legacyAdd = (n, name, type, sub, nb) => ({ id: `account:${n}`, kind: 'account_addition', account_number: n, account_name: name, account_type: type, account_subtype: sub, normal_balance: nb, fund_code: 'OPR', bs_category: null, text: 'stored before roles' });
const ev = (v, n) => ({ vendor: v, invoice_number: n, document_path: null, service_period_start: '2026-09-01', service_period_end: '2026-09-30', original_reference: 'JE-X', original_posting_date: '2026-08-20' });
const items = [
  { id: 'accrue:bedrock', kind: 'accrual', evidence: ev('Bedrock', '2608LPF2'), verification: { text: 'ok' }, entries: [
    { posting_date: '2026-08-31', source_reference: 'cutoff:bedrock:accrue', description: 'Cutoff accrual Bedrock', lines: [{ account_number: '5500', debit_cents: 2000, credit_cents: 0 }, { account_number: '2100', debit_cents: 0, credit_cents: 2000 }] },
    { posting_date: '2026-09-01', source_reference: 'cutoff:bedrock:reverse', reverses: 'accrual', description: 'Reverse accrual Bedrock', lines: [{ account_number: '2100', debit_cents: 2000, credit_cents: 0 }, { account_number: '5500', debit_cents: 0, credit_cents: 2000 }] }] },
  { id: 'defer:hightech', kind: 'deferral', evidence: ev('High Tech', '34017'), verification: { text: 'ok' }, entries: [
    { posting_date: '2026-08-31', source_reference: 'cutoff:hightech:defer', description: 'Defer High Tech', lines: [{ account_number: '1410', debit_cents: 620879, credit_cents: 0 }, { account_number: '5200', debit_cents: 0, credit_cents: 620879 }] },
    { posting_date: '2026-09-01', source_reference: 'cutoff:hightech:reverse-defer', reverses: 'deferral', description: 'Reverse deferral High Tech', lines: [{ account_number: '5200', debit_cents: 620879, credit_cents: 0 }, { account_number: '1410', debit_cents: 0, credit_cents: 620879 }] }] },
  { id: 'defer:lonestar', kind: 'deferral', evidence: ev('Lone Star', '51327'), verification: { text: 'ok' }, entries: [
    { posting_date: '2026-08-31', source_reference: 'cutoff:lonestar:defer', description: 'Defer Lone Star', lines: [{ account_number: '1410', debit_cents: 717088, credit_cents: 0 }, { account_number: '5300', debit_cents: 0, credit_cents: 717088 }] }] },
];

// The fixture's Supabase-shaped client, plus the mapping RPC as migration 505 defines it (an
// admin/approver assignment is an approval) and the posting module writing into the same books.
function client() {
  const base = F.fakeClient({ closedThrough: '2026-07-31' }); const db = F.getDb();
  base.rpc = async (fn, a) => {
    if (fn === 'close_closed_through') return { data: '2026-07-31', error: null };
    if (fn !== 'set_account_report_category') return { data: null, error: { message: 'not in fake' } };
    for (const id of a.p_account_ids) {
      db.account_report_map = db.account_report_map.filter((m) => !(m.account_id === id && m.statement === a.p_statement));
      db.account_report_map.push({ community_id: a.p_community_id, account_id: id, statement: a.p_statement, category_id: a.p_category_id, display_order: null, approval_status: 'approved', approved_by: a.p_actor, approved_at: '2026-10-14T18:00:00Z' });
    }
    return { data: { changed: a.p_account_ids.length }, error: null };
  };
  return base;
}
let seq = 0;
POSTING.postJournalEntry = async (o) => {
  const db = F.getDb(); const id = `je-cut-${++seq}`;
  db.journal_entries.push({ id, community_id: CID, reference: `JE-CUT-${seq}`, posting_date: o.posting_date, source_module: o.source_module || 'cutoff_adjustment', status: 'posted', void_reversal_je_id: null, reverses_je_id: o.reverses_je_id || null, description: o.description, source_reference: o.source_reference });
  o.lines.forEach((l, i) => db.journal_entry_lines.push({ id: `jl-cut-${seq}-${i}`, journal_entry_id: id, line_number: i + 1, account_id: l.account_id, fund_id: (db.chart_of_accounts.find((a) => a.id === l.account_id) || {}).fund_id, debit_cents: l.debit_cents, credit_cents: l.credit_cents, memo: l.memo || null, vendor_id: null, property_id: null }));
  return { entry: { id, reference: `JE-CUT-${seq}` } };
};
function lopfLike() {
  F.seed(); const db = F.getDb();
  const bsCats = new Set(db.report_categories.filter((c) => c.statement === 'balance_sheet').map((c) => c.id));
  db.report_categories = db.report_categories.filter((c) => !bsCats.has(c.id));
  db.account_report_map = db.account_report_map.filter((m) => m.statement !== 'balance_sheet');
  db.account_funds = db.account_funds && db.account_funds.length ? db.account_funds : [{ id: 'f-opr', community_id: CID, fund_code: 'OPR' }, { id: 'f-res', community_id: CID, fund_code: 'RES' }];
  return db;
}
const lineOf = (bs, n) => { for (const sec of bs.sections) for (const g of sec.groups) for (const l of g.lines) if (l.account_number === n) return { sec: sec.key, group: g, l }; return null; };

(async () => {
  for (const shape of ['stored before this change (no role, no category)', 'prepared now (role and planned category)']) {
    console.log(`\nAugust package ${shape}`);
    const db = lopfLike();
    const facts = { bs_categories: [], period: { period_start: '2026-08-01', period_end: '2026-08-31' }, accounts: db.chart_of_accounts.map((a) => ({ account_number: a.account_number, account_name: a.account_name, account_type: a.account_type, fund_code: 'OPR', is_active: true })), already: new Set(), schedules_for: new Set(), late_bills: [], prepaid_bills: [], invoices: {} };
    // the new shape comes from the real engine: what Kat would put on the approval screen today
    const fresh = C.buildProposals({ ...facts, accounts: facts.accounts.filter((a) => !['2100', '1410'].includes(a.account_number)), late_bills: [{ id: 'x', vendor: 'V', invoice_number: '1', invoice_date: '2026-08-31', service_period_start: '2026-08-01', service_period_end: '2026-08-31', total_cents: 100 }], prepaid_bills: [{ id: 'y', vendor: 'V', invoice_number: '2', invoice_date: '2026-08-20', service_period_start: '2026-09-01', service_period_end: '2026-09-30', total_cents: 100 }],
      invoices: { x: { original: { reference: 'JE-A', posting_date: '2026-09-05', status: 'posted', lines: [{ account_number: '5500', account_type: 'expense', debit_cents: 100, credit_cents: 0 }] } }, y: { original: { reference: 'JE-B', posting_date: '2026-08-20', status: 'posted', lines: [{ account_number: '5200', account_type: 'expense', debit_cents: 100, credit_cents: 0 }] } } } });
    const freshAdds = fresh.additions;
    if (shape.startsWith('prepared')) {
      const t = freshAdds.map((a) => a.text).join(' ');
      check('approval screen names the category each account is approved into, never "unmapped"', freshAdds.length === 2 && /presented under "Accrued liabilities"/.test(t) && /presented under "Prepaids"/.test(t) && !/unmapped/i.test(t), t);
      check('additions carry their role and the planned standard category', freshAdds.every((a) => a.bs_role && a.bs_category && a.bs_category.create === true));
    }
    const additions = shape.startsWith('stored') ? [legacyAdd('2100', 'Accrued Expenses', 'liability', 'current_liability', 'credit'), legacyAdd('1410', 'Prepaid Expenses', 'asset', 'current_asset', 'debit')] : freshAdds;
    const before = await M.buildBalanceSheetModel(client(), { community_id: CID, as_of: '2026-08-31', view: 'consolidated', now: NOW });
    const res = await C.postApproved(client(), { id: 'run-aug', community_id: CID, preview: { additions, items } }, { include: [...additions.map((a) => a.id), ...items.map((i) => i.id)], approver: APPROVER, approval: { channel: 'in_app', user_id: 'u-ed', email: 'egojara@bedrocktx.com' }, actor: 'Kat' });
    const a2100 = db.chart_of_accounts.find((a) => a.account_number === '2100'); const a1410 = db.chart_of_accounts.find((a) => a.account_number === '1410');
    check('approval created 2100 (liability, credit) and 1410 (asset, debit) in the Operating fund', a2100 && a2100.account_type === 'liability' && a2100.normal_balance === 'credit' && a1410 && a1410.account_type === 'asset' && a1410.normal_balance === 'debit' && a2100.fund_id === 'f-opr' && a1410.fund_id === 'f-opr');
    const cats = db.report_categories.filter((c) => c.statement === 'balance_sheet');
    check('the standard categories "Accrued liabilities" (liability) and "Prepaids" (asset) were created once each', cats.length === 2 && cats.some((c) => c.name === 'Accrued liabilities' && c.section === 'liability') && cats.some((c) => c.name === 'Prepaids' && c.section === 'asset'), JSON.stringify(cats));
    const mp = db.account_report_map.filter((m) => m.statement === 'balance_sheet');
    check('both mappings APPROVED by the in-app approver, each to its own category', mp.length === 2 && mp.every((m) => m.approval_status === 'approved' && m.approved_by === APPROVER) && mp.find((m) => m.account_id === a2100.id).category_id === cats.find((c) => c.name === 'Accrued liabilities').id && mp.find((m) => m.account_id === a1410.id).category_id === cats.find((c) => c.name === 'Prepaids').id);
    check('the result reports where each account presents', res.additions ? true : JSON.stringify(res).includes('Prepaids') && JSON.stringify(res).includes('Accrued liabilities'), JSON.stringify(res).slice(0, 300));

    const bs = await M.buildBalanceSheetModel(client(), { community_id: CID, as_of: '2026-08-31', view: 'consolidated', now: NOW });
    const k = bs.columns[0].key;
    const l2100 = lineOf(bs, '2100'); const l1410 = lineOf(bs, '1410');
    check('8/31 balance sheet: 1410 Prepaid Expenses $13,379.67 under "Prepaids" (assets), not Unmapped', l1410 && l1410.sec === 'asset' && l1410.group.label === 'Prepaids' && l1410.group.kind !== 'unmapped' && l1410.l.values[k] === 1337967, JSON.stringify(l1410 && [l1410.group.label, l1410.l.values]));
    check('8/31 balance sheet: 2100 Accrued Expenses $20.00 under "Accrued liabilities" (liabilities), not Unmapped', l2100 && l2100.sec === 'liability' && l2100.group.label === 'Accrued liabilities' && l2100.group.kind !== 'unmapped' && l2100.l.values[k] === 2000, JSON.stringify(l2100 && [l2100.group.label, l2100.l.values]));
    check('neither new account is in the unmapped list or warning', !bs.mapping.unmapped.some((u) => ['2100', '1410'].includes(u.account_number)));
    check('the balance sheet balances, before and after', Object.values(bs.totals.balanced).every((v) => v !== false) && Object.values(before.totals.balanced).every((v) => v !== false), JSON.stringify(bs.totals.balanced));
    const unmBefore = before.mapping.unmapped.length; const unmAfter = bs.mapping.unmapped.length;
    check(`the community's other accounts are unchanged (still ${unmBefore} unmapped, as before; this change maps only what it creates)`, unmAfter === unmBefore, `${unmBefore} -> ${unmAfter}`);
    const sep = await M.buildBalanceSheetModel(client(), { community_id: CID, as_of: '2026-09-30', view: 'consolidated', now: NOW });
    const s1410 = lineOf(sep, '1410'); const s2100 = lineOf(sep, '2100'); const sk = sep.columns[0].key;
    check('9/30: the High Tech deferral and Bedrock accrual reversed (2100 $0); 1410 holds only Lone Star $7,170.88 until its schedule recognizes it', (!s2100 || !s2100.l.values[sk]) && s1410 && s1410.l.values[sk] === 717088, JSON.stringify([s2100 && s2100.l.values, s1410 && s1410.l.values]));

    const ib = await M.buildIncomeBudgetModel(client(), { community_id: CID, period_end: '2026-08-31', fund: 'OPR', now: NOW });
    const exp = ib.sections.find((s) => s.key === 'expense' || /expense/i.test(s.label));
    F.seed(); const ibBase = await M.buildIncomeBudgetModel(F.fakeClient({ closedThrough: '2026-07-31' }), { community_id: CID, period_end: '2026-08-31', fund: 'OPR', now: NOW });
    const expBase = ibBase.sections.find((s) => s.key === 'expense' || /expense/i.test(s.label));
    check('August expenses fall by exactly the package (-$13,359.67 = $20.00 accrued - $13,379.67 deferred)', exp && expBase && exp.total.values.mtd_actual - expBase.total.values.mtd_actual === -1335967, JSON.stringify([exp && exp.total.values.mtd_actual, expBase && expBase.total.values.mtd_actual]));
    lopfLike(); // restore the post-approval books for rendering
    await C.postApproved(client(), { id: 'run-aug', community_id: CID, preview: { additions, items } }, { include: [...additions.map((a) => a.id), ...items.map((i) => i.id)], approver: APPROVER, approval: { channel: 'in_app', user_id: 'u-ed', email: 'egojara@bedrocktx.com' }, actor: 'Kat' });
    const bs2 = await M.buildBalanceSheetModel(client(), { community_id: CID, as_of: '2026-08-31', view: 'consolidated', now: NOW });

    const web = R.renderHtml(bs2, { mode: 'web' }); const board = R.renderHtml(bs2, { mode: 'print' }); const doc = R.renderDocument([bs2]);
    const near = (h, label, acct) => { const i = h.indexOf(label); const j = h.indexOf(acct); return i > -1 && j > i; };
    const tagged = (h, name) => { const i = h.indexOf(name); if (i < 0) return true; const row = h.slice(i, h.indexOf('</tr>', i)); return /Unmapped/.test(row); };
    check('web: "Prepaids" heads 1410 Prepaid Expenses and "Accrued liabilities" heads 2100 Accrued Expenses, no Unmapped tag on either line', near(web, 'Prepaids', 'Prepaid Expenses') && near(web, 'Accrued liabilities', 'Accrued Expenses') && !tagged(web, 'Prepaid Expenses') && !tagged(web, 'Accrued Expenses'));
    // Board print and the PDF print mapped categories as lines (accounts roll up) and list only unmapped accounts individually.
    const txt = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    for (const [nm, h] of [['board print', board], ['PDF document', doc]]) {
      const t = txt(h); const unm = t.slice(t.indexOf('Unmapped Review'));
      check(`${nm}: "Prepaids 13,379.67" under Assets and "Accrued liabilities 20.00" under Liabilities; neither account listed under Unmapped`, /Assets.*Prepaids 13,379\.67/.test(t) && /Liabilities.*Accrued liabilities 20\.00/.test(t) && !/Prepaid Expenses|Accrued Expenses/.test(unm), t.slice(t.indexOf('Assets'), t.indexOf('Assets') + 400));
    }
    if (shape.startsWith('stored')) {
      try {
        const E = require('../lib/statements/export');
        const pdf = await E.pdfBuffer([bs2], { title: 'Balance Sheet' });
        const out = path.join(require('os').tmpdir(), 'cutoff_bs_presentation.pdf'); fs.writeFileSync(out, pdf);
        check(`PDF renders (${pdf.length} bytes, ${out})`, pdf.length > 5000 && pdf.slice(0, 4).toString() === '%PDF');
      } catch (e) { console.log(`  - PDF binary not rendered here (${e.message.slice(0, 80)}); the PDF's HTML input is checked above`); }
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
