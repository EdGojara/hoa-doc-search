// ============================================================================
// api/financial_statements.js  (Ed 2026-10-09, month-end close PR C)
// ----------------------------------------------------------------------------
// The financial statement package: ONE model (lib/statements/model.js), ONE
// renderer (lib/statements/render.js) behind web, PDF, XLSX, CSV and the native
// board-packet sections. Read-only except the balance-sheet mapping (admin).
// Staff-scoped (bare /api paths require the staff cookie via server.js).
//
//   GET  /:cid/balance-sheet?as_of=YYYY-MM-DD[&view=consolidated|fund]      model JSON
//   GET  /:cid/income-budget?period_end=YYYY-MM-DD[&fund=OPR|all]           model JSON
//   GET  /:cid/render?format=html|print|pdf|xlsx&statements=balance_sheet,income_budget
//        &as_of=..&period_end=..[&view=..&fund=..]                          rendered output
//   GET  /:cid/drill/account?kind=balance_sheet|income_budget&account_id=..[&fund_id=..]
//        &as_of=.. | &period_start=..&period_end=..                         line -> transactions
//   GET  /:cid/drill/entry/:jeId                                            transaction -> source
//   GET  /:cid/detail.csv?statement=balance_sheet|income_budget&..          every transaction
//   GET  /:cid/balance-sheet-mapping                                        categories + accounts
//   POST /:cid/balance-sheet-categories        { section, name }            admin
//   POST /:cid/balance-sheet-mapping/set       { account_ids, category_id } admin (= approval)
//   POST /:cid/balance-sheet-mapping/approve   { account_ids }              admin
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const M = require('../lib/statements/model');
const R = require('../lib/statements/render');
const D = require('../lib/statements/drill');
const X = require('../lib/statements/export');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);
const monthEndBefore = (d) => { const [y, m] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10); };

// A statement is only as true as the ledger under it (same gate as api/gl.js).
async function booksGate(req, res) {
  const { canRenderFinancials } = require('../lib/community/lifecycle');
  const ok = await canRenderFinancials(req.params.cid);
  if (!ok.allowed) { res.status(409).json({ error: 'books_not_here', detail: ok.reason }); return false; }
  return true;
}
function dateParam(v, fallback) { if (v == null || v === '') return fallback; return ISO.test(String(v)) ? String(v) : null; }
const fail = (res, where, err) => {
  if (err && (err.code === 'invalid_input')) return res.status(400).json({ error: err.message });
  if (err && (err.code === 'not_found')) return res.status(404).json({ error: err.message });
  console.error(`[financial_statements] ${where} failed:`, err && err.message);
  return res.status(500).json({ error: safeErrorMessage(err) });
};

async function modelsFor(cid, q) {
  const want = String(q.statements || 'balance_sheet,income_budget').split(',').map((s) => s.trim()).filter(Boolean);
  const defEnd = monthEndBefore(today());
  const as_of = dateParam(q.as_of, defEnd), period_end = dateParam(q.period_end, q.as_of && ISO.test(q.as_of) ? q.as_of : defEnd);
  if (!as_of || !period_end) throw Object.assign(new Error('dates_must_be_YYYY-MM-DD'), { code: 'invalid_input' });
  const out = [];
  for (const s of want) {
    if (s === 'balance_sheet') out.push(await M.buildBalanceSheetModel(supabase, { community_id: cid, as_of, view: q.view === 'fund' ? 'fund' : 'consolidated' }));
    else if (s === 'income_budget') out.push(await M.buildIncomeBudgetModel(supabase, { community_id: cid, period_end, fund: q.fund || 'OPR' }));
    else throw Object.assign(new Error(`unknown_statement:${s}`), { code: 'invalid_input' });
  }
  return out;
}

router.get('/:cid/balance-sheet', async (req, res) => {
  try {
    if (!(await booksGate(req, res))) return;
    const as_of = dateParam(req.query.as_of, monthEndBefore(today()));
    if (!as_of) return res.status(400).json({ error: 'as_of_must_be_YYYY-MM-DD' });
    res.json(await M.buildBalanceSheetModel(supabase, { community_id: req.params.cid, as_of, view: req.query.view === 'fund' ? 'fund' : 'consolidated' }));
  } catch (err) { fail(res, 'balance-sheet', err); }
});

router.get('/:cid/income-budget', async (req, res) => {
  try {
    if (!(await booksGate(req, res))) return;
    const period_end = dateParam(req.query.period_end, monthEndBefore(today()));
    if (!period_end) return res.status(400).json({ error: 'period_end_must_be_YYYY-MM-DD' });
    res.json(await M.buildIncomeBudgetModel(supabase, { community_id: req.params.cid, period_end, fund: req.query.fund || 'OPR' }));
  } catch (err) { fail(res, 'income-budget', err); }
});

router.get('/:cid/render', async (req, res) => {
  try {
    if (!(await booksGate(req, res))) return;
    const format = String(req.query.format || 'html');
    const models = await modelsFor(req.params.cid, req.query);
    const slug = String(models[0].community.name || 'statements').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const stamp = models[0].period.as_of || models[0].period.period_end;
    if (format === 'html') return res.json({ html: models.map((m) => R.renderHtml(m, { mode: 'web', noStyle: true })).join(''), css: R.CSS, models: models.map((m) => ({ kind: m.kind, snapshot_sha256: m.snapshot_sha256, lifecycle: m.lifecycle, warnings: m.warnings, mapping: m.mapping, period: m.period, columns: m.columns })) });
    if (format === 'print') return res.set('Content-Type', 'text/html').send(R.renderDocument(models));
    if (format === 'xlsx') {
      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.set('Content-Disposition', `attachment; filename="${slug}-statements-${stamp}.xlsx"`);
      return res.send(X.xlsxBuffer(models));
    }
    if (format === 'pdf') {
      const buf = await X.pdfBuffer(models);
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `inline; filename="${slug}-statements-${stamp}.pdf"`);
      return res.send(buf);
    }
    res.status(400).json({ error: 'format_must_be_html_print_pdf_or_xlsx' });
  } catch (err) { fail(res, 'render', err); }
});

router.get('/:cid/drill/account', async (req, res) => {
  try {
    if (!(await booksGate(req, res))) return;
    const q = req.query;
    if (!q.account_id) return res.status(400).json({ error: 'account_id_required' });
    const kind = q.kind === 'balance_sheet' ? 'balance_sheet' : 'income_budget';
    const args = { community_id: req.params.cid, kind, account_id: String(q.account_id), fund_id: q.fund_id || null };
    if (kind === 'balance_sheet') { args.as_of = dateParam(q.as_of, null); if (!args.as_of) return res.status(400).json({ error: 'as_of_required' }); }
    else { args.period_start = dateParam(q.period_start, null); args.period_end = dateParam(q.period_end, null); if (!args.period_start || !args.period_end) return res.status(400).json({ error: 'period_required' }); }
    res.json(await D.drillAccount(supabase, args));
  } catch (err) { fail(res, 'drill/account', err); }
});

router.get('/:cid/drill/entry/:jeId', async (req, res) => {
  try {
    if (!(await booksGate(req, res))) return;
    res.json(await D.drillEntry(supabase, { community_id: req.params.cid, journal_entry_id: req.params.jeId }));
  } catch (err) { fail(res, 'drill/entry', err); }
});

router.get('/:cid/detail.csv', async (req, res) => {
  try {
    if (!(await booksGate(req, res))) return;
    const st = req.query.statement === 'income_budget' ? 'income_budget' : 'balance_sheet';
    const [model] = await modelsFor(req.params.cid, { ...req.query, statements: st });
    const rows = await D.detailRows(supabase, model);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${st}-detail-${model.period.as_of || model.period.period_end}.csv"`);
    res.send(X.csvDetail(rows));
  } catch (err) { fail(res, 'detail.csv', err); }
});

// ------------------------------------------------------------- balance-sheet mapping
router.get('/:cid/balance-sheet-mapping', async (req, res) => {
  try {
    const cid = req.params.cid;
    const [cats, maps, coa] = await Promise.all([
      supabase.from('report_categories').select('id, section, name, report_label, parent_category_id, display_order, is_active').eq('community_id', cid).eq('statement', 'balance_sheet').order('display_order').order('name').limit(2000),
      supabase.from('account_report_map').select('account_id, category_id, approval_status, approved_by, approved_at, updated_by, updated_at').eq('community_id', cid).eq('statement', 'balance_sheet').order('account_id').limit(5000),
      supabase.from('chart_of_accounts').select('id, account_number, account_name, account_type, is_active').eq('community_id', cid).in('account_type', ['asset', 'liability', 'equity']).order('account_number').limit(5000),
    ]);
    for (const r of [cats, maps, coa]) if (r.error) {
      if (/approval_status|balance_sheet|check constraint/i.test(r.error.message || '')) return res.json({ available: false, message: 'Balance-sheet categories need migration 505.', categories: [], accounts: [] });
      throw r.error;
    }
    const byAcct = new Map((maps.data || []).map((m) => [m.account_id, m]));
    const accounts = (coa.data || []).map((a) => { const m = byAcct.get(a.id); return { ...a, category_id: m ? m.category_id : null, status: m ? m.approval_status : 'unmapped', approved_by: m ? m.approved_by : null, approved_at: m ? m.approved_at : null }; });
    res.json({ available: true, categories: cats.data || [], accounts, counts: { approved: accounts.filter((a) => a.status === 'approved').length, proposed: accounts.filter((a) => a.status === 'proposed').length, unmapped: accounts.filter((a) => a.status === 'unmapped').length } });
  } catch (err) { fail(res, 'balance-sheet-mapping', err); }
});

async function admin(req, res) { const { requireAdmin } = require('./_require_admin'); return requireAdmin(req, res); }
const uuidList = (v) => (Array.isArray(v) ? v.map(String).filter((x) => /^[0-9a-f-]{36}$/i.test(x)) : []);

router.post('/:cid/balance-sheet-categories', async (req, res) => {
  try {
    const u = await admin(req, res); if (!u) return;
    const { section, name, report_label, display_order, parent_category_id } = req.body || {};
    if (!['asset', 'liability', 'equity'].includes(section)) return res.status(400).json({ error: 'section_must_be_asset_liability_or_equity' });
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name_required' });
    const { data, error } = await supabase.from('report_categories').insert({
      community_id: req.params.cid, statement: 'balance_sheet', section, name: String(name).trim(), report_label: report_label || null,
      display_order: Number.isFinite(Number(display_order)) ? Number(display_order) : 100, parent_category_id: parent_category_id || null, updated_by: u.email || u.full_name,
    }).select().single();
    if (error) throw error;
    res.json({ category: data });
  } catch (err) { fail(res, 'balance-sheet-categories', err); }
});

router.post('/:cid/balance-sheet-mapping/set', async (req, res) => {
  try {
    const u = await admin(req, res); if (!u) return;
    const ids = uuidList(req.body && req.body.account_ids);
    if (!ids.length) return res.status(400).json({ error: 'account_ids_required' });
    const category_id = (req.body && req.body.category_id) || null;
    const { data, error } = await supabase.rpc('set_account_report_category', { p_community_id: req.params.cid, p_account_ids: ids, p_category_id: category_id, p_actor: u.email || u.full_name, p_statement: 'balance_sheet' });
    if (error) throw error;
    res.json({ ok: true, result: data });
  } catch (err) { fail(res, 'balance-sheet-mapping/set', err); }
});

router.post('/:cid/balance-sheet-mapping/approve', async (req, res) => {
  try {
    const u = await admin(req, res); if (!u) return;
    const ids = uuidList(req.body && req.body.account_ids);
    if (!ids.length) return res.status(400).json({ error: 'account_ids_required' });
    const { data, error } = await supabase.rpc('approve_account_report_map', { p_community_id: req.params.cid, p_account_ids: ids, p_actor: u.email || u.full_name, p_statement: 'balance_sheet' });
    if (error) throw error;
    res.json({ ok: true, result: data });
  } catch (err) { fail(res, 'balance-sheet-mapping/approve', err); }
});

module.exports = router;
