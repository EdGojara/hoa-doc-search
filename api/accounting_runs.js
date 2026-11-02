// ============================================================================
// api/accounting_runs.js  (Ed 2026-10-11) — Kat's controlled monthly runs
// ----------------------------------------------------------------------------
//   GET  /api/accounting-runs/pending              runs awaiting a person (all communities)
//   GET  /api/accounting-runs/community/:cid       recent runs for a community
//   GET  /api/accounting-runs/run/:id              one run: preview, exceptions, events
//   GET  /api/accounting-runs/run/:id/csv          owner-by-owner / entry-by-entry CSV
//   GET  /api/accounting-runs/bank-accounts         bank accounts enabled for Kat's reconciliation
//   GET  /api/accounting-runs/cutoff/overview       Cutoff Corrections page: managed communities, their
//                                                   open months since cutover, cutoff runs, viewer_is_owner
//   POST /api/accounting-runs/community/:cid/prepare { process, period_month, run_date, subject_id }   staff
//        (bank_reconciliation: subject_id = the bank account; period_month = the month reconciled)
//   POST /api/accounting-runs/run/:id/approve      { include: [tenure_id] }   OWNER ONLY
//   POST /api/accounting-runs/run/:id/hold         { reason }                 OWNER ONLY
//   POST /api/accounting-runs/run/:id/supersede    { reason }                 OWNER ONLY
//   POST /api/accounting-runs/run/:id/refresh      { codings?, items? }  staff: re-prepare an UNAPPROVED run on the current books
//                                                   (items: a corrected journal entry, same ids)
// Preparing never posts. Approval posts exactly the stored preview.
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { requireStaff, requireOwner, OWNER_EMAIL } = require('./_require_admin');
const R = require('../lib/accounting/monthly_runs');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const fail = (res, what, err) => {
  if (err.code === 'approval_required') return res.status(403).json({ error: err.message, code: err.code });
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

router.get('/bank-accounts', async (req, res) => {
  try {
    if (!(await requireStaff(req, res))) return;
    const { data: autos, error } = await supabase.from('community_accounting_automation').select('community_id, settings').eq('process', 'bank_reconciliation').eq('enabled', true);
    if (error) { if (/process_check|invalid input/i.test(error.message)) return res.json({ accounts: [] }); throw error; }
    const ids = [...new Set(autos.flatMap((a) => (a.settings && a.settings.bank_account_ids) || []))];
    if (!ids.length) return res.json({ accounts: [] });
    const { data: bas, error: e2 } = await supabase.from('bank_accounts').select('id, community_id, account_nickname, account_last4, gl_account_number, communities(name)').in('id', ids);
    if (e2) throw e2;
    res.json({ accounts: bas.map((b) => ({ id: b.id, community_id: b.community_id, community_name: b.communities && b.communities.name, label: `${b.account_nickname || 'Bank account'}${b.account_last4 ? ' ' + b.account_last4 : ''}`, gl_account_number: b.gl_account_number }))
      .sort((a, b) => `${a.community_name} ${a.label}`.localeCompare(`${b.community_name} ${b.label}`)) });
  } catch (err) { fail(res, 'bank-accounts', err); }
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

// The Cutoff Corrections page (/app/financial/cutoff): one read for everything it lists.
router.get('/cutoff/overview', async (req, res) => {
  try {
    const u = await requireStaff(req, res); if (!u) return;
    const { operationalCommunities } = require('../lib/community/lifecycle');
    const comms = (await operationalCommunities(supabase)).filter((c) => !c.is_demo);
    const ids = comms.map((c) => c.id);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const { data: cut, error: ce } = await supabase.from('communities').select('id, name, gl_cutover_date').in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
    if (ce) throw ce;
    const { data: periods, error: pe } = await supabase.from('accounting_periods').select('community_id, period_start, period_end, status').in('community_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']).lt('period_end', today).order('period_start').limit(5000);
    if (pe) throw pe;
    const { data: runs, error: re } = await supabase.from('accounting_runs').select(SUMMARY).eq('process', 'cutoff_adjustment').in('community_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']).order('created_at', { ascending: false }).limit(500);
    if (re) throw re;
    // Only communities whose books are kept in trustEd (a GL cutover), and only their months since it.
    const communities = (cut || []).filter((c) => c.gl_cutover_date).map((c) => ({ id: c.id, name: c.name, gl_cutover_date: c.gl_cutover_date,
      months: (periods || []).filter((p) => p.community_id === c.id && String(p.period_end) >= String(c.gl_cutover_date))
        .map((p) => ({ period_month: String(p.period_start).slice(0, 10), period_end: String(p.period_end).slice(0, 10), status: p.status,
          runs: (runs || []).filter((r) => r.community_id === c.id && String(r.period_month).slice(0, 10) === String(p.period_start).slice(0, 10)) })) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ communities, viewer_is_owner: u.role === 'admin' && String(u.email || '').toLowerCase() === String(OWNER_EMAIL || '').toLowerCase() });
  } catch (err) { fail(res, 'cutoff overview', err); }
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
      : run.process === 'bank_reconciliation'
        ? ['category', 'date_ref', 'amount_cents', 'check_number', 'description', 'gl_ref', 'match_method', 'operator_notes']
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
    if (!['recognition', 'interest', 'bank_reconciliation', 'cutoff_adjustment', 'reclassification', 'journal_entry'].includes(b.process)) return res.status(400).json({ error: 'process must be recognition, interest, bank_reconciliation, cutoff_adjustment, reclassification or journal_entry' });
    // A reclassification carries Kat's items (what moves, from and to which expense account, and the
    // evidence); lib/accounting/reclassifications validates each against the GL. Nothing posts here.
    if (b.process === 'reclassification' && (!Array.isArray(b.items) || !b.items.length || b.items.length > 200)) return res.status(400).json({ error: 'a reclassification needs 1 to 200 items' });
    if (b.process === 'journal_entry' && (!Array.isArray(b.items) || !b.items.length || b.items.length > 50)) return res.status(400).json({ error: 'a journal entry run needs 1 to 50 entries' });
    if (b.process === 'bank_reconciliation' && !/^[0-9a-f-]{36}$/i.test(String(b.subject_id || ''))) return res.status(400).json({ error: 'subject_id (the bank account) is required' });
    if (!isDate(b.period_month)) return res.status(400).json({ error: 'period_month must be YYYY-MM-DD' });
    if (b.run_date && !isDate(b.run_date)) return res.status(400).json({ error: 'run_date must be YYYY-MM-DD' });
    const codings = parseCodings(b.codings); if (codings.error) return res.status(400).json({ error: codings.error });
    const r = await R.prepare(supabase, { community_id: req.params.cid, process: b.process, period_month: b.period_month, run_date: b.run_date || null, subject_id: b.process === 'bank_reconciliation' ? b.subject_id : null, actor: `${R.KAT} (requested by ${u.email || 'staff'})`, codings: codings.list, follow_up: b.follow_up === true, items: ['reclassification', 'journal_entry'].includes(b.process) ? b.items : [] });
    if (r.skipped) return res.status(409).json({ error: r.skipped, code: 'not_enabled' });
    if (r.failed) return res.status(500).json({ error: r.error, run_id: r.run_id });
    res.json(r);
  } catch (err) { fail(res, 'prepare', err); }
});

// Bank-line codings supplied with their evidence at prepare / refresh time (bank_reconciliation).
const UUIDRE = /^[0-9a-f-]{36}$/i; const ACCTRE = /^[0-9]{3,6}$/;
function parseCodings(v) {
  if (v == null) return { list: [] };
  if (!Array.isArray(v) || v.length > 50) return { error: 'codings must be an array of at most 50' };
  const list = [];
  for (const c of v) {
    const hasReceipts = c && Array.isArray(c.receipts);
    // unidentified:true takes its account from the community's unidentified_receipts role (mig 524), never the coding.
    const unid = !!c && c.unidentified === true && !hasReceipts;
    if (!c || !UUIDRE.test(String(c.bank_transaction_id || '')) || (!hasReceipts && !unid && !ACCTRE.test(String(c.account_number || ''))) || !String(c.basis || '').trim()) return { error: 'each coding needs bank_transaction_id, account_number (or receipts, or unidentified: true) and basis (the evidence)' };
    if (unid) { list.push({ bank_transaction_id: String(c.bank_transaction_id), unidentified: true, basis: String(c.basis).trim().slice(0, 600) }); continue; }
    if (!hasReceipts) { list.push({ bank_transaction_id: String(c.bank_transaction_id), account_number: String(c.account_number), basis: String(c.basis).trim().slice(0, 600) }); continue; }
    // A deposit coded with its payout contents: one row per homeowner payment.
    if (!c.receipts.length || c.receipts.length > 50) return { error: 'receipts must list 1 to 50 payments' };
    const receipts = [];
    for (const x of c.receipts) {
      const amt = Number(x && x.amount_cents);
      if (!x || !/^[0-9A-Za-z-]{3,20}$/.test(String(x.vantaca_account_id || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(x.payment_date || '')) || !Number.isInteger(amt) || amt <= 0) return { error: 'each receipt needs vantaca_account_id, payment_date (YYYY-MM-DD) and a positive whole amount_cents' };
      receipts.push({ vantaca_account_id: String(x.vantaca_account_id), payment_date: String(x.payment_date), amount_cents: amt, method: x.method ? String(x.method).slice(0, 40) : null, reference: x.reference ? String(x.reference).slice(0, 80) : null });
    }
    list.push({ bank_transaction_id: String(c.bank_transaction_id), basis: String(c.basis).trim().slice(0, 600), receipts });
  }
  return { list };
}

// Refresh an unapproved run on the current books (preparation, staff). Optional codings replace the run's.
router.post('/run/:id/refresh', express.json(), async (req, res) => {
  try {
    const u = await requireStaff(req, res); if (!u) return;
    const b = req.body || {};
    const codings = b.codings === undefined ? { list: null } : parseCodings(b.codings); if (codings.error) return res.status(400).json({ error: codings.error });
    // A corrected journal entry is resubmitted with its corrected items (same ids, so it posts once).
    if (b.items !== undefined && (!Array.isArray(b.items) || !b.items.length || b.items.length > 50)) return res.status(400).json({ error: 'items must be 1 to 50 entries' });
    const r = await R.refresh(supabase, { run_id: req.params.id, requested_by: u.email || 'staff', codings: codings.list, items: b.items || null });
    if (r.failed) return res.status(500).json({ error: r.error, run_id: r.run_id });
    res.json(r);
  } catch (err) { fail(res, 'refresh', err); }
});

router.post('/run/:id/approve', express.json(), async (req, res) => {
  try {
    const u = await requireOwner(req, res); if (!u) return;
    const include = Array.isArray((req.body || {}).include) ? req.body.include.map(String) : [];
    // The signed-in owner's session is the approval (never a chat instruction or a script).
    res.json(await R.approveAndPost(supabase, { run_id: req.params.id, approval: { channel: 'in_app', user_id: u.user && u.user.id, email: u.email }, include }));
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
