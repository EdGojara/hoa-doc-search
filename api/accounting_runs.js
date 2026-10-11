// ============================================================================
// api/accounting_runs.js  (Ed 2026-10-11) — Kat's controlled monthly runs
// ----------------------------------------------------------------------------
//   GET  /api/accounting-runs/pending              runs awaiting a person (all communities)
//   GET  /api/accounting-runs/community/:cid       recent runs for a community
//   GET  /api/accounting-runs/run/:id              one run: preview, exceptions, events
//   GET  /api/accounting-runs/run/:id/csv          owner-by-owner / entry-by-entry CSV
//   POST /api/accounting-runs/community/:cid/prepare { process, period_month, run_date }   staff
//   POST /api/accounting-runs/run/:id/approve      { include: [tenure_id] }   OWNER ONLY
//   POST /api/accounting-runs/run/:id/hold         { reason }                 OWNER ONLY
//   POST /api/accounting-runs/run/:id/supersede    { reason }                 OWNER ONLY
// Preparing never posts. Approval posts exactly the stored preview.
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { requireStaff, requireOwner } = require('./_require_admin');
const R = require('../lib/accounting/monthly_runs');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const fail = (res, what, err) => {
  const known = ['invalid_state', 'invalid_input', 'blocked', 'duplicate'];
  if (known.includes(err.code)) return res.status(409).json({ error: err.message, code: err.code });
  console.error(`[accounting_runs] ${what} failed:`, err.message);
  res.status(500).json({ error: safeErrorMessage(err) });
};
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const SUMMARY = 'id, community_id, process, period_month, run_date, status, totals, exceptions, prepared_by, prepared_at, approved_by, approved_at, posted_at, held_reason, error';

router.get('/pending', async (req, res) => {
  try {
    if (!(await requireStaff(req, res))) return;
    const { data, error } = await supabase.from('accounting_runs').select(SUMMARY).in('status', ['prepared', 'held', 'failed']).order('period_month', { ascending: false }).limit(100);
    if (error) throw error;
    const ids = [...new Set(data.map((r) => r.community_id))];
    const { data: comms } = ids.length ? await supabase.from('communities').select('id, name').in('id', ids) : { data: [] };
    const N = Object.fromEntries((comms || []).map((c) => [c.id, c.name]));
    res.json({ runs: data.map((r) => ({ ...r, community_name: N[r.community_id] || null })) });
  } catch (err) { fail(res, 'pending', err); }
});

router.get('/community/:cid', async (req, res) => {
  try {
    if (!(await requireStaff(req, res))) return;
    const { data, error } = await supabase.from('accounting_runs').select(SUMMARY).eq('community_id', req.params.cid).order('period_month', { ascending: false }).order('created_at', { ascending: false }).limit(60);
    if (error) throw error;
    const { data: auto } = await supabase.from('community_accounting_automation').select('process, enabled, auto_post, settings, updated_by, updated_at').eq('community_id', req.params.cid);
    res.json({ runs: data, automation: auto || [] });
  } catch (err) { fail(res, 'community', err); }
});

router.get('/run/:id', async (req, res) => {
  try {
    if (!(await requireStaff(req, res))) return;
    const { data: run, error } = await supabase.from('accounting_runs').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    const { data: events } = await supabase.from('accounting_run_events').select('event, actor, detail, created_at').eq('run_id', run.id).order('created_at');
    res.json({ run, events: events || [] });
  } catch (err) { fail(res, 'run', err); }
});

router.get('/run/:id/csv', async (req, res) => {
  try {
    if (!(await requireStaff(req, res))) return;
    const { data: run, error } = await supabase.from('accounting_runs').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    const items = (run.preview && run.preview.items) || [];
    const cols = run.process === 'interest'
      ? ['address', 'vantaca_account_id', 'trusted_account_number', 'eligible_charges_cents', 'receipts_cents', 'returns_cents', 'applied_cents', 'eligible_principal_cents', 'interest_cents', 'exception', 'skip', 'flags']
      : ['schedule', 'type', 'month', 'posting_date', 'amount_cents', 'balance_account', 'catch_up'];
    const cell = (v) => { const s = Array.isArray(v) ? v.map((f) => f.code || f).join('|') : (v === null || v === undefined ? '' : String(v)); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const money = (k, v) => (/_cents$/.test(k) ? (Number(v || 0) / 100).toFixed(2) : v);
    const csv = [cols.map((c) => c.replace(/_cents$/, '')).join(',')].concat(items.map((i) => cols.map((c) => cell(money(c, i[c]))).join(','))).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${run.process}-${String(run.period_month).slice(0, 7)}.csv"`);
    res.send(csv);
  } catch (err) { fail(res, 'csv', err); }
});

router.post('/community/:cid/prepare', express.json(), async (req, res) => {
  try {
    const u = await requireStaff(req, res); if (!u) return;
    const b = req.body || {};
    if (!['recognition', 'interest'].includes(b.process)) return res.status(400).json({ error: 'process must be recognition or interest' });
    if (!isDate(b.period_month)) return res.status(400).json({ error: 'period_month must be YYYY-MM-DD' });
    if (b.run_date && !isDate(b.run_date)) return res.status(400).json({ error: 'run_date must be YYYY-MM-DD' });
    const r = await R.prepare(supabase, { community_id: req.params.cid, process: b.process, period_month: b.period_month, run_date: b.run_date || null, actor: `${R.KAT} (requested by ${u.email || 'staff'})` });
    if (r.skipped) return res.status(409).json({ error: r.skipped, code: 'not_enabled' });
    if (r.failed) return res.status(500).json({ error: r.error, run_id: r.run_id });
    res.json(r);
  } catch (err) { fail(res, 'prepare', err); }
});

router.post('/run/:id/approve', express.json(), async (req, res) => {
  try {
    const u = await requireOwner(req, res); if (!u) return;
    const include = Array.isArray((req.body || {}).include) ? req.body.include.map(String) : [];
    res.json(await R.approveAndPost(supabase, { run_id: req.params.id, approver: u.email, include }));
  } catch (err) { fail(res, 'approve', err); }
});

router.post('/run/:id/hold', express.json(), async (req, res) => {
  try {
    const u = await requireOwner(req, res); if (!u) return;
    res.json(await R.hold(supabase, { run_id: req.params.id, actor: u.email, reason: (req.body || {}).reason }));
  } catch (err) { fail(res, 'hold', err); }
});

router.post('/run/:id/supersede', express.json(), async (req, res) => {
  try {
    const u = await requireOwner(req, res); if (!u) return;
    res.json(await R.supersede(supabase, { run_id: req.params.id, actor: u.email, reason: (req.body || {}).reason }));
  } catch (err) { fail(res, 'supersede', err); }
});

module.exports = router;
