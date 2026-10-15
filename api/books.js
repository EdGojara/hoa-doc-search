// ============================================================================
// Books API — General Ledger surface
// ----------------------------------------------------------------------------
// Mounted at /api/books.
//
// Phase 1 surface (this ship):
//   POST   /onboard                          seed CoA + funds + initial periods for a community
//   GET    /coa?community_id                  list chart of accounts
//   GET    /funds?community_id                list account funds
//   GET    /periods?community_id              list accounting periods
//   POST   /periods/:id/close                 close a period (sets status=closed)
//   POST   /periods/:id/reopen                reopen w/ reason (audit trail)
//   POST   /journal-entries                   post a JE
//   GET    /journal-entries                   list JEs (filter community_id, period_id, account_id, date range)
//   GET    /journal-entries/:id               JE detail + lines
//   POST   /journal-entries/:id/void          void w/ reason — creates offsetting entry
//   GET    /trial-balance?community_id        trial balance from v_trial_balance view
//
// Phase 2+ (queued):
//   - AR sub-ledger posting (assessment billing, payment intake)
//   - AP sub-ledger posting (vendor invoices, check disbursements)
//   - Financial statements (BS, IS, Equity, CF)
//   - Vantaca import → JE replay
// ============================================================================

const { route: aiRoute, executedModel: aiExecuted } = require('../lib/ai/router');
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { postJournalEntry, voidJournalEntry, editJournalEntry } = require('../lib/accounting/posting');
const { onboardCommunityToGL, openInitialPeriods } = require('../lib/accounting/coa_template');
const { balanceSheet, incomeStatement, equityStatement, budgetVsActual, budgetVsActualGrouped } = require('../lib/accounting/financial_statements');
// A YTD amount that is not available in trustEd (null: a period ending before a conversion
// cutover, lib/accounting/statement_periods.js) must never be read as zero by the budget builder.
const ytdOf = (r) => { if (r.ytd_amount_cents === null) throw Object.assign(new Error('Year-to-date actuals for this period are not available in TrustEd (before the conversion cutover).'), { code: 'ytd_not_available_in_trusted', userMessage: 'Year-to-date actuals for this period are not available in TrustEd (before the conversion cutover).' }); return r.ytd_amount_cents || 0; };
// A whole statement year that is not available in trustEd (a converted community's
// pre-history, or a period inside its carryforward window).
const yearNA = (is) => !!(is && is.availability && is.availability.ytd && is.availability.ytd.status === 'not_available');
const ytdTot = (t, k) => { if (t && t.ytd && t.ytd[k] === null) return ytdOf({ ytd_amount_cents: null }); return (t && t.ytd && t.ytd[k]) || 0; };
const { extractBudget } = require('../lib/accounting/budget_pdf_extractor');
const { rollForwardBudget } = require('../lib/accounting/budget_roll_forward');
const { mergeBudgetLines } = require('../lib/accounting/budget_merge');
const { requireOwner, requireAdmin, getAuthedUser } = require('./_require_admin');
const phasing = require('../lib/accounting/budget_phasing');
const { loadBudgetPlan } = require('../lib/accounting/budget_plan_data');
const LOCKED_BUDGET_STATUSES = ['approved', 'active'];
const { safeErrorMessage } = require('./_safe_error');
const Anthropic = require('../lib/ai/anthropic');
const { COUNTED_JE_STATUSES, countsInGl } = require('../lib/accounting/je_status');
const _anthropic = new Anthropic();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const router = express.Router();

// ---------------------------------------------------------------------------
// Community onboarding to GL
// ---------------------------------------------------------------------------
router.post('/onboard', express.json(), async (req, res) => {
  try {
    const { community_id, start_date } = req.body || {};
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    const coa = await onboardCommunityToGL({ community_id, supabase });
    let periods = null;
    if (start_date) {
      periods = await openInitialPeriods({ community_id, supabase, start_date, months_ahead: 12 });
    }
    res.json({ coa, periods });
  } catch (err) {
    console.error('[books] onboard failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------
router.get('/coa', async (req, res) => {
  try {
    const { community_id, account_type, include_inactive } = req.query;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    let q = supabase.from('chart_of_accounts')
      .select('*, account_funds(fund_code, fund_name)')
      .eq('community_id', community_id)
      .order('account_number')
      .limit(500);
    if (account_type) q = q.eq('account_type', account_type);
    if (!include_inactive) q = q.eq('is_active', true);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ accounts: data || [] });
  } catch (err) {
    console.error('[books] list coa failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/funds', async (req, res) => {
  try {
    const { community_id } = req.query;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    const { data, error } = await supabase
      .from('account_funds').select('*')
      .eq('community_id', community_id).eq('is_active', true)
      .order('display_order').limit(50);
    if (error) throw error;
    res.json({ funds: data || [] });
  } catch (err) {
    console.error('[books] list funds failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------
router.get('/periods', async (req, res) => {
  try {
    const { community_id } = req.query;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    const { data, error } = await supabase
      .from('accounting_periods').select('*')
      .eq('community_id', community_id)
      .order('period_end', { ascending: false })
      .limit(60);
    if (error) throw error;
    res.json({ periods: data || [] });
  } catch (err) {
    console.error('[books] list periods failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Closing and reopening a period is the month-end close (Ed 2026-10-09,
// migration 502): a computed checklist, owner-only BLOCK overrides, admin authority
// and a written reason, all recorded. The old bare status flip is retired; the
// database also refuses a status change made any other way.
router.post('/periods/:id/close', (req, res) => res.status(410).json({ error: 'Closing a month now runs the month-end close checklist: Accounting > Close.', moved_to: '/api/close/:community/periods/:period/close' }));
router.post('/periods/:id/reopen', (req, res) => res.status(410).json({ error: 'Reopening a month now goes through the month-end close (owner/admin, with a reason): Accounting > Close.', moved_to: '/api/close/:community/periods/:period/reopen' }));

// ---------------------------------------------------------------------------
// Journal entries
// ---------------------------------------------------------------------------
router.post('/journal-entries', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const result = await postJournalEntry(req.body || {});
    res.json(result);
  } catch (err) {
    if (require('../lib/accounting/ownership').isBooksClosed(err)) return res.status(409).json({ error: 'books_closed', detail: err.message });
    if (err.code === 'unbalanced' || err.code === 'invalid_input' || err.code === 'period_closed') {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    console.error('[books] post JE failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /transfer — move cash between two accounts. Same-fund is a plain
// reallocation (Dr destination / Cr source); cross-fund settles the interfund
// Due To/Due From toward zero (lib/accounting/interfund.buildTransferLines), so
// a transfer between funds clears the payable/receivable instead of piling it
// up. Lines are balanced per fund, so the auto-bridge adds nothing. (Ed 2026-09-05.)
router.post('/transfer', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const b = req.body || {};
    const { community_id, from_account_id, to_account_id, posting_date, memo } = b;
    const amount_cents = Math.round(Number(b.amount_cents) || 0);
    if (!community_id || !from_account_id || !to_account_id) return res.status(400).json({ error: 'community_id_from_to_required' });
    if (from_account_id === to_account_id) return res.status(400).json({ error: 'from_and_to_must_differ' });
    if (!(amount_cents > 0)) return res.status(400).json({ error: 'amount_must_be_positive' });
    const date = /^\d{4}-\d{2}-\d{2}/.test(String(posting_date || '')) ? String(posting_date).slice(0, 10) : new Date().toISOString().slice(0, 10);

    const { data: accts, error: ae } = await supabase.from('chart_of_accounts')
      .select('id, account_number, account_name, account_type, fund_id, community_id, is_active').in('id', [from_account_id, to_account_id]);
    if (ae) throw ae;
    const from = (accts || []).find((a) => a.id === from_account_id);
    const to = (accts || []).find((a) => a.id === to_account_id);
    if (!from || !to) return res.status(400).json({ error: 'account_not_found' });
    if (from.community_id !== community_id || to.community_id !== community_id) return res.status(400).json({ error: 'account_in_different_community' });
    if (!from.is_active || !to.is_active) return res.status(400).json({ error: 'account_inactive' });
    const isCash = (a) => String(a.account_type || '') === 'asset' || /^1/.test(String(a.account_number || ''));
    if (!isCash(from) || !isCash(to)) return res.status(400).json({ error: 'transfer_between_cash_accounts_only', detail: 'Both accounts must be cash/asset accounts.' });

    const { resolveInterfund, buildTransferLines } = require('../lib/accounting/interfund');
    const resolved = await resolveInterfund(supabase, community_id);
    let lines;
    try { lines = buildTransferLines({ from, to, amountCents: amount_cents, resolved }); }
    catch (e) { return res.status(400).json({ error: e.message, code: e.code || 'invalid_input' }); }

    const desc = (`Transfer: ${from.account_number} ${from.account_name} → ${to.account_number} ${to.account_name}` + (memo ? ` (${memo})` : '')).slice(0, 300);
    const result = await postJournalEntry({ community_id, posting_date: date, description: desc, source_module: 'manual', lines });
    res.json({ ok: true, entry: result.entry });
  } catch (err) {
    if (require('../lib/accounting/ownership').isBooksClosed(err)) return res.status(409).json({ error: 'books_closed', detail: err.message });
    if (err.code === 'unbalanced' || err.code === 'invalid_input' || err.code === 'period_closed') return res.status(400).json({ error: err.message, code: err.code });
    console.error('[books] transfer failed:', err); res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /interfund-balances?community_id — nonzero interfund balances (what each
// non-Operating fund owes Operating). Powers the transfer hint + month-end
// reminder to keep interfund at zero.
router.get('/interfund-balances', async (req, res) => {
  try {
    const { community_id } = req.query;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    const { interfundBalances } = require('../lib/accounting/interfund');
    res.json({ ok: true, balances: await interfundBalances(supabase, community_id) });
  } catch (err) { console.error('[books] interfund balances failed:', err); res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.get('/journal-entries', async (req, res) => {
  try {
    const { community_id, period_id, account_id, from_date, to_date, status, limit = '100' } = req.query;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    let q = supabase.from('journal_entries')
      .select('*')
      .eq('community_id', community_id)
      .order('posting_date', { ascending: false })
      .order('reference', { ascending: false })
      .limit(Math.min(parseInt(limit, 10) || 100, 500));
    if (period_id) q = q.eq('period_id', period_id);
    if (status) q = q.eq('status', status);
    if (from_date) q = q.gte('posting_date', from_date);
    if (to_date) q = q.lte('posting_date', to_date);
    const { data, error } = await q;
    if (error) throw error;
    // If account_id filter, narrow to entries with at least one line on that account
    let filtered = data || [];
    if (account_id && filtered.length > 0) {
      const ids = filtered.map((e) => e.id);
      const { data: lns } = await supabase.from('journal_entry_lines')
        .select('journal_entry_id').eq('account_id', account_id).in('journal_entry_id', ids);
      const hit = new Set((lns || []).map((l) => l.journal_entry_id));
      filtered = filtered.filter((e) => hit.has(e.id));
    }
    res.json({ journal_entries: filtered });
  } catch (err) {
    console.error('[books] list JEs failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/journal-entries/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [{ data: je }, { data: lines }] = await Promise.all([
      supabase.from('journal_entries').select('*').eq('id', id).maybeSingle(),
      supabase.from('journal_entry_lines')
        .select('*, chart_of_accounts(account_number, account_name, account_type)')
        .eq('journal_entry_id', id).order('line_number'),
    ]);
    if (!je) return res.status(404).json({ error: 'not_found' });
    res.json({ entry: je, lines: lines || [] });
  } catch (err) {
    console.error('[books] JE detail failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /journal-entries/:id/summary — "what actually happened?" (Ed 2026-09-28).
// Read-only: the real-world transaction behind an entry (payee, bill, method,
// documents, approvals, origin), each fact tagged with its data source, plus the
// accounting lines and audit info, and the gaps the data can't answer.
router.get('/journal-entries/:id/summary', async (req, res) => {
  try {
    const { summarizeJournalEntry } = require('../lib/accounting/je_transaction_summary');
    const out = await summarizeJournalEntry(supabase, req.params.id);
    if (out.error === 'not_found') return res.status(404).json({ error: 'not_found' });
    res.json(out);
  } catch (err) {
    console.error('[books] JE summary failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Edit a posted entry in place (open period only) with a change-log row.
router.patch('/journal-entries/:id', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const b = req.body || {};
    const result = await editJournalEntry({
      journal_entry_id: req.params.id,
      edited_by_user_id: b.edited_by_user_id, edited_by_name: b.edited_by_name, reason: b.reason,
      description: b.description, notes: b.notes,
      source_document_id: b.source_document_id, source_document_path: b.source_document_path,
      classification_reason: b.classification_reason, needs_review: b.needs_review,
      lines: b.lines,
    });
    res.json(result);
  } catch (err) {
    if (require('../lib/accounting/ownership').isBooksClosed(err)) return res.status(409).json({ error: 'books_closed', detail: err.message });
    if (['unbalanced', 'invalid_input', 'period_closed', 'invalid_state', 'not_found'].includes(err.code)) {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    console.error('[books] edit JE failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Change history for one entry (audit trail of in-place edits).
router.get('/journal-entries/:id/edits', async (req, res) => {
  try {
    const { data, error } = await supabase.from('journal_entry_edits')
      .select('id, edited_by_user_id, edited_by_name, reason, changes, created_at')
      .eq('journal_entry_id', req.params.id).order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ edits: data || [] });
  } catch (err) {
    console.error('[books] JE edits failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Phase 2 — suggest the GL account for a transaction (vendor default -> history
// -> budget fit -> description), the way a CPA would. Read-only; the AP/JE flows
// call this to pre-code entries, and staff confirm/correct in review.
router.get('/classify', async (req, res) => {
  try {
    const { community_id, vendor_id, vendor_name, description, payment_leg } = req.query;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    const { suggestClassification } = require('../lib/accounting/gl_classifier');
    const suggestion = await suggestClassification({
      communityId: community_id, vendorId: vendor_id || null, vendorName: vendor_name || null,
      description: description || null, isPaymentLeg: payment_leg === '1' || payment_leg === 'true',
    });
    res.json({ suggestion });
  } catch (err) {
    console.error('[books] classify failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/journal-entries/:id/void', express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const { void_reason, reversal_date, posted_by_user_id } = req.body || {};
    const result = await voidJournalEntry({
      journal_entry_id: id, void_reason, reversal_date, posted_by_user_id,
    });
    res.json(result);
  } catch (err) {
    if (require('../lib/accounting/ownership').isBooksClosed(err)) return res.status(409).json({ error: 'books_closed', detail: err.message });
    if (err.code === 'invalid_input' || err.code === 'invalid_state' || err.code === 'not_found' || err.code === 'period_closed') {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    console.error('[books] void JE failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// Trial balance
// ---------------------------------------------------------------------------
router.get('/trial-balance', async (req, res) => {
  try {
    const { community_id, fund_id } = req.query;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    let q = supabase.from('v_trial_balance')
      .select('*').eq('community_id', community_id)
      .order('account_number').limit(500);
    if (fund_id) q = q.eq('fund_id', fund_id);
    const { data, error } = await q;
    if (error) throw error;
    // Compute the totals so the UI can show whether the TB is in balance
    const totals = (data || []).reduce((acc, r) => {
      acc.total_debits += Number(r.total_debits_cents) || 0;
      acc.total_credits += Number(r.total_credits_cents) || 0;
      return acc;
    }, { total_debits: 0, total_credits: 0 });
    res.json({
      accounts: data || [],
      totals,
      balanced: totals.total_debits === totals.total_credits,
    });
  } catch (err) {
    console.error('[books] trial balance failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// FINANCIAL STATEMENTS
// ============================================================================

router.get('/balance-sheet', async (req, res) => {
  try {
    const { community_id, as_of_date, fund_id } = req.query;
    const result = await balanceSheet({ community_id, as_of_date, fund_id });
    res.json(result);
  } catch (err) {
    if (err.code === 'invalid_input') return res.status(400).json({ error: err.message });
    console.error('[books] balance-sheet failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/income-statement', async (req, res) => {
  try {
    const { community_id, period_start, period_end, fund_id } = req.query;
    const result = await incomeStatement({ community_id, period_start, period_end, fund_id });
    res.json(result);
  } catch (err) {
    if (err.code === 'invalid_input') return res.status(400).json({ error: err.message });
    console.error('[books] income-statement failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/equity-statement', async (req, res) => {
  try {
    const { community_id, period_start, period_end } = req.query;
    const result = await equityStatement({ community_id, period_start, period_end });
    res.json(result);
  } catch (err) {
    if (err.code === 'invalid_input') return res.status(400).json({ error: err.message });
    console.error('[books] equity-statement failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/budget-vs-actual', async (req, res) => {
  try {
    const { community_id, period_end, fund_id } = req.query;
    // ?grouped=1 adds the reporting-category tree; without it the response is
    // exactly the flat Budget vs Actual (Phase 1: flat view unchanged).
    const result = req.query.grouped === '1'
      ? await budgetVsActualGrouped({ community_id, period_end, fund_id })
      : await budgetVsActual({ community_id, period_end, fund_id });
    res.json(result);
  } catch (err) {
    if (err.code === 'invalid_input') return res.status(400).json({ error: err.message });
    console.error('[books] budget-vs-actual failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// REPORT CATEGORIES (Phase 1, migration 463) — presentation only. The GL
// account is never changed; this is how each account presents on statements.
// ============================================================================
const REPORT_STATEMENT = 'income_statement';

// Setup screen data: every income/expense account with its fund and current
// category (or Unmapped), plus the community's categories.
router.get('/report-categories', async (req, res) => {
  try {
    const { community_id } = req.query;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    const [cats, mapsR, coa] = await Promise.all([
      supabase.from('report_categories').select('id, section, name, report_label, parent_category_id, display_order, is_active, updated_by, updated_at')
        .eq('community_id', community_id).eq('statement', REPORT_STATEMENT).order('display_order').order('name').limit(2000),
      supabase.from('account_report_map').select('account_id, category_id, display_order, updated_by, updated_at, approval_status')
        .eq('community_id', community_id).eq('statement', REPORT_STATEMENT).order('account_id').limit(5000),
      supabase.from('chart_of_accounts').select('id, account_number, account_name, account_type, is_active, account_funds(fund_code)')
        .eq('community_id', community_id).in('account_type', ['revenue', 'expense']).order('account_number').limit(5000),
    ]);
    // Before migration 505 there is no approval state (every 463 row is a person's decision).
    let maps = mapsR;
    if (maps.error && /approval_status/.test(maps.error.message || '')) {
      maps = await supabase.from('account_report_map').select('account_id, category_id, display_order, updated_by, updated_at')
        .eq('community_id', community_id).eq('statement', REPORT_STATEMENT).order('account_id').limit(5000);
      if (!maps.error) maps.data = (maps.data || []).map((m) => ({ ...m, approval_status: 'approved' }));
    }
    for (const r of [cats, maps, coa]) if (r.error) throw r.error;
    const catById = new Map((cats.data || []).map((c) => [c.id, c]));
    const mapByAcct = new Map((maps.data || []).map((m) => [m.account_id, m]));
    const accounts = (coa.data || []).map((a) => {
      const m = mapByAcct.get(a.id); const leaf = m ? catById.get(m.category_id) : null;
      const top = leaf ? (leaf.parent_category_id ? catById.get(leaf.parent_category_id) : leaf) : null;
      return {
        account_id: a.id, account_number: a.account_number, account_name: a.account_name, account_type: a.account_type,
        is_active: a.is_active, fund_code: a.account_funds ? a.account_funds.fund_code : null,
        category_id: m ? m.category_id : null,
        category_name: top ? top.name : null,
        subcategory_name: leaf && leaf.parent_category_id ? leaf.name : null,
        display_order: m ? m.display_order : null,
        updated_by: m ? m.updated_by : null, updated_at: m ? m.updated_at : null,
        approval_status: m ? m.approval_status : null,   // 'proposed' does not group a statement until approved
      };
    });
    res.json({ categories: cats.data || [], accounts, unmapped_count: accounts.filter((a) => !a.category_id || a.approval_status !== 'approved').length });
  } catch (err) {
    console.error('[books] report-categories read failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Writes below are admin/owner only (Ed 2026-09-25); any signed-in staffer can view.
// Create or edit a category/subcategory. Categories are never deleted
// (deactivate instead); the database refuses anything that would orphan accounts.
router.post('/report-categories', express.json(), async (req, res) => {
  try {
    const user = await requireAdmin(req, res); if (!user) return;   // configuration: admin/owner only
    const b = req.body || {};
    if (!b.community_id) return res.status(400).json({ error: 'community_id_required' });
    const actor = user.email || 'staff';
    const patch = { updated_by: actor };
    if (b.name !== undefined) { if (!String(b.name).trim()) return res.status(400).json({ error: 'name_required' }); patch.name = String(b.name).trim(); }
    if (b.report_label !== undefined) patch.report_label = String(b.report_label || '').trim() || null;
    if (b.display_order !== undefined) { const n = parseInt(b.display_order, 10); if (!Number.isFinite(n)) return res.status(400).json({ error: 'display_order_must_be_a_number' }); patch.display_order = n; }
    if (b.is_active !== undefined) patch.is_active = !!b.is_active;
    if (b.parent_category_id !== undefined) patch.parent_category_id = b.parent_category_id || null;
    let q;
    if (b.id) {
      const { data: cur, error: cErr } = await supabase.from('report_categories').select('community_id').eq('id', b.id).maybeSingle();
      if (cErr) throw cErr;
      if (!cur) return res.status(404).json({ error: 'category_not_found' });
      if (cur.community_id !== b.community_id) return res.status(403).json({ error: 'category_belongs_to_a_different_community' });
      q = supabase.from('report_categories').update(patch).eq('id', b.id);
    } else {
      if (!['revenue', 'expense'].includes(b.section)) return res.status(400).json({ error: 'section_must_be_revenue_or_expense' });
      if (!patch.name) return res.status(400).json({ error: 'name_required' });
      q = supabase.from('report_categories').insert({ ...patch, community_id: b.community_id, statement: REPORT_STATEMENT, section: b.section });
    }
    const { data, error } = await q.select('*').single();
    if (error) return res.status(error.code === 'P0001' || error.code === '23505' ? 409 : 500).json({ error: error.code === '23505' ? 'a category with that name already exists here' : (error.code === 'P0001' ? error.message : safeErrorMessage(error)) });
    res.json({ category: data });
  } catch (err) {
    console.error('[books] report-categories save failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Assign (or with category_id null, unmap) one or many accounts. Explicit only:
// nothing here guesses a category.
router.post('/report-map', express.json(), async (req, res) => {
  try {
    const user = await requireAdmin(req, res); if (!user) return;   // configuration: admin/owner only
    const { community_id, account_ids, category_id } = req.body || {};
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    if (!Array.isArray(account_ids) || !account_ids.length) return res.status(400).json({ error: 'account_ids_required' });
    if (account_ids.length > 500) return res.status(400).json({ error: 'too_many_accounts' });
    const { data, error } = await supabase.rpc('set_account_report_category', {
      p_community_id: community_id, p_account_ids: account_ids, p_category_id: category_id || null, p_actor: user.email || 'staff', p_statement: REPORT_STATEMENT,
    });
    if (error) return res.status(error.code === 'P0001' ? 409 : 500).json({ error: error.code === 'P0001' ? error.message : safeErrorMessage(error) });
    res.json(data);
  } catch (err) {
    console.error('[books] report-map save failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Order of an account within its category (blank = by account number).
router.post('/report-map/order', express.json(), async (req, res) => {
  try {
    const user = await requireAdmin(req, res); if (!user) return;   // configuration: admin/owner only
    const { community_id, account_id, display_order } = req.body || {};
    if (!community_id || !account_id) return res.status(400).json({ error: 'community_id_and_account_id_required' });
    const n = display_order === null || display_order === '' || display_order === undefined ? null : parseInt(display_order, 10);
    if (n !== null && !Number.isFinite(n)) return res.status(400).json({ error: 'display_order_must_be_a_number' });
    const { data, error } = await supabase.from('account_report_map').update({ display_order: n, updated_by: user.email || 'staff' })
      .eq('community_id', community_id).eq('account_id', account_id).eq('statement', REPORT_STATEMENT).select('account_id');
    if (error) throw error;
    if (!data || !data.length) return res.status(404).json({ error: 'account_is_unmapped' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[books] report-map order failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// RESERVES — accounting view over the existing reserve engine + the GL
//   current reserve balance  = the reserve-fund cash account balance (GL)
//   expected reserve expenses = the active study's funding plan for the year
//   components due this year  = reserve_components scheduled for replacement
// Reads the canonical reserve tables; no parallel data. Graceful when a
// community has no study loaded yet (everything study-driven returns null).
// ============================================================================
async function computeReserveSummary(community_id, year) {
    if (!community_id) throw new Error('community_id_required');
    year = Number(year) || new Date().getUTCFullYear();
    const today = new Date().toISOString().slice(0, 10);
    const yearStart = `${year}-01-01`, yearEnd = `${year}-12-31`;

    // 1) Current reserve balance = the reserve-type bank account's GL cash account.
    const { data: rba } = await supabase.from('bank_accounts')
      .select('account_nickname, gl_account_number').eq('community_id', community_id).eq('account_type', 'reserve').limit(1);
    let reserve_account = null, reserve_balance_cents = 0;
    if (rba && rba[0] && rba[0].gl_account_number) {
      const { data: acct } = await supabase.from('chart_of_accounts')
        .select('id, account_number, account_name, normal_balance')
        .eq('community_id', community_id).eq('account_number', rba[0].gl_account_number).maybeSingle();
      if (acct) {
        reserve_account = { account_number: acct.account_number, account_name: acct.account_name, nickname: rba[0].account_nickname };
        const { data: lines } = await supabase.from('journal_entry_lines')
          .select('debit_cents, credit_cents, journal_entries!inner(community_id, posting_date)')
          .eq('account_id', acct.id)
          .eq('journal_entries.community_id', community_id)
          .lte('journal_entries.posting_date', today);
        let d = 0, c = 0;
        for (const l of lines || []) { d += Number(l.debit_cents || 0); c += Number(l.credit_cents || 0); }
        reserve_balance_cents = acct.normal_balance === 'credit' ? (c - d) : (d - c);
      }
    }

    // 2) Active reserve study + this year's funding-plan row.
    const { data: study } = await supabase.from('reserve_study_versions')
      .select('id, study_firm, fiscal_year, beginning_balance_cents, contributions_per_year')
      .eq('community_id', community_id).eq('is_active', true).maybeSingle();
    let funding = null;
    if (study) {
      const { data: fp } = await supabase.from('reserve_funding_plan')
        .select('fiscal_year, beginning_balance_cents, recommended_contribution_cents, total_contribution_cents, anticipated_expenditures_cents, ending_balance_cents')
        .eq('community_id', community_id).eq('reserve_study_version_id', study.id).eq('fiscal_year', year).maybeSingle();
      funding = fp || null;
    }

    // 3) Components scheduled for replacement this year.
    const { data: due } = await supabase.from('reserve_components')
      .select('component_name, future_cost_estimate_cents, current_cost_estimate_cents')
      .eq('community_id', community_id).eq('status', 'active').eq('next_scheduled_replacement_year', year)
      .order('component_name').limit(500);
    const components_due = (due || []).map((c) => ({ name: c.component_name, cost_cents: Number(c.future_cost_estimate_cents || c.current_cost_estimate_cents || 0) }));

    // 4) Actual reserve spending YTD (operational ledger).
    const { data: exps } = await supabase.from('reserve_expenditures')
      .select('amount_cents').eq('community_id', community_id).gte('expenditure_date', yearStart).lte('expenditure_date', yearEnd).limit(2000);
    const actual_reserve_expenses_ytd_cents = (exps || []).reduce((s, e) => s + Number(e.amount_cents || 0), 0);

    return {
      year,
      has_study: !!study,
      study: study ? { firm: study.study_firm, fiscal_year: study.fiscal_year, contributions_per_year: study.contributions_per_year } : null,
      reserve_account,
      reserve_balance_cents,
      expected_reserve_expenses_cents: funding ? Number(funding.anticipated_expenditures_cents || 0) : null,
      recommended_contribution_cents: funding ? Number(funding.total_contribution_cents || funding.recommended_contribution_cents || 0) : null,
      projected_ending_balance_cents: funding ? Number(funding.ending_balance_cents || 0) : null,
      study_beginning_balance_cents: funding ? Number(funding.beginning_balance_cents || 0) : null,
      components_due,
      components_due_total_cents: components_due.reduce((s, c) => s + c.cost_cents, 0),
      actual_reserve_expenses_ytd_cents,
    };
}
router.get('/reserve-summary', async (req, res) => {
  try {
    const { community_id } = req.query;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    res.json(await computeReserveSummary(community_id, req.query.year));
  } catch (err) {
    console.error('[books] reserve-summary failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// BUDGETS
// ============================================================================

router.get('/budgets', async (req, res) => {
  try {
    const { community_id, fiscal_year } = req.query;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    let q = supabase.from('community_budgets')
      .select('*').eq('community_id', community_id)
      .order('fiscal_year', { ascending: false }).limit(20);
    if (fiscal_year) q = q.eq('fiscal_year', fiscal_year);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ budgets: data || [] });
  } catch (err) {
    console.error('[books] list budgets failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/budgets/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    // This parameterized route is registered before literal /budgets/<word>
    // routes (plan-seed, ai-plan, living-lines). Without this guard it would
    // capture them as an :id and 404. Only handle real UUIDs; fall through.
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return next();
    const [{ data: budget }, { data: lines }] = await Promise.all([
      supabase.from('community_budgets').select('*').eq('id', id).maybeSingle(),
      supabase.from('budget_line_items')
        .select('*, chart_of_accounts(account_number, account_name, account_type, account_subtype)')
        .eq('budget_id', id).order('chart_of_accounts(account_number)'),
    ]);
    if (!budget) return res.status(404).json({ error: 'not_found' });
    res.json({ budget, lines: lines || [] });
  } catch (err) {
    console.error('[books] budget detail failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /api/books/budgets/:id/seasonalize   (Ed 2026-07-05)
// Distribute each budget line's ANNUAL amount across 12 months using the
// account's HISTORICAL monthly spend/revenue curve from posted GL activity —
// so a landscaping account front-loads spring/summer and a pool account spikes
// in season, instead of a flat 1/12. Every line's 12 months sum EXACTLY to its
// annual (Ed's rule: "the total always equals the yearly budget"). Accounts
// with no usable history fall back to an even split, flagged so.
//
//   ?years=2   how many prior calendar years of GL to learn the curve from
// Returns { lines: [{ account_id, monthly_amounts_cents, basis, months_of_data }] }
// Nothing is written — the editor applies + saves via POST /budgets.
// ----------------------------------------------------------------------------
function _distributeToWeights(annual, weights) {
  // weights: 12 non-negative numbers. Distribute `annual` (signed int cents) by
  // weight, then force the sum to equal `annual` exactly by parking the residual
  // in the largest-weight month. Zero/degenerate weights => even split.
  const total = weights.reduce((s, w) => s + (w > 0 ? w : 0), 0);
  let monthly;
  if (!(total > 0)) {
    const each = Math.trunc(annual / 12);
    monthly = Array(12).fill(each);
  } else {
    monthly = weights.map((w) => Math.round(annual * ((w > 0 ? w : 0) / total)));
  }
  const drift = annual - monthly.reduce((s, x) => s + x, 0);
  if (drift !== 0) {
    // Park residual in the month with the largest weight (or largest magnitude
    // on the even-split path) so the line still ties to the penny.
    let li = 0, best = -Infinity;
    const basisArr = total > 0 ? weights : monthly.map((v) => Math.abs(v));
    basisArr.forEach((w, idx) => { if ((w > 0 ? w : 0) > best) { best = (w > 0 ? w : 0); li = idx; } });
    monthly[li] += drift;
  }
  return monthly;
}

router.get('/budgets/:id/seasonalize', async (req, res) => {
  try {
    const { id } = req.params;
    const years = Math.min(5, Math.max(1, parseInt(req.query.years, 10) || 2));
    const { data: budget } = await supabase.from('community_budgets').select('id, community_id, fiscal_year').eq('id', id).maybeSingle();
    if (!budget) return res.status(404).json({ error: 'not_found' });
    const { data: lines } = await supabase.from('budget_line_items')
      .select('account_id, annual_amount_cents, chart_of_accounts(normal_balance)')
      .eq('budget_id', id);
    if (!lines || !lines.length) return res.json({ lines: [] });

    const acctIds = [...new Set(lines.map((l) => l.account_id))];
    const normalBal = {};
    lines.forEach((l) => { normalBal[l.account_id] = (l.chart_of_accounts && l.chart_of_accounts.normal_balance) || 'debit'; });

    // Learn the curve from the calendar years PRIOR to the budget's fiscal year.
    const endYear = (budget.fiscal_year || new Date().getUTCFullYear()) - 1;
    const startYear = endYear - years + 1;
    const start = `${startYear}-01-01`, end = `${endYear}-12-31`;

    // month sums per account: accId -> [12] signed in the account's normal direction
    const curve = {};
    acctIds.forEach((a) => { curve[a] = Array(12).fill(0); });
    for (let batch = 0; batch < acctIds.length; batch += 100) {
      const ids = acctIds.slice(batch, batch + 100);
      for (let f = 0; ; f += 1000) {
        const { data: jl, error } = await supabase.from('journal_entry_lines')
          .select('account_id, debit_cents, credit_cents, journal_entries!inner(posting_date, status, void_reversal_je_id)')
          .in('account_id', ids)
          .in('journal_entries.status', COUNTED_JE_STATUSES)
          .gte('journal_entries.posting_date', start)
          .lte('journal_entries.posting_date', end)
          .order('id', { ascending: true })
          .range(f, f + 999);
        if (error) throw error;
        (jl || []).forEach((row) => {
          if (!countsInGl(row.journal_entries)) return;
          const d = row.journal_entries && row.journal_entries.posting_date;
          if (!d) return;
          const mo = parseInt(String(d).slice(5, 7), 10) - 1; // 0..11
          if (mo < 0 || mo > 11) return;
          const signed = (normalBal[row.account_id] === 'credit')
            ? (row.credit_cents || 0) - (row.debit_cents || 0)
            : (row.debit_cents || 0) - (row.credit_cents || 0);
          curve[row.account_id][mo] += signed;
        });
        if (!jl || jl.length < 1000) break;
      }
    }

    // A real seasonal curve needs the year broadly represented. A freshly
    // migrated community whose GL only holds a month or two of backfill would
    // otherwise dump a whole annual into that month — an artifact, not a season.
    // Require activity in >= MIN_MONTHS distinct months before trusting the shape;
    // below that, even-split and say so honestly.
    const MIN_MONTHS = 5;
    let shaped = 0, evenCount = 0;
    const out = lines.map((l) => {
      const raw = curve[l.account_id] || Array(12).fill(0);
      // Only positive monthly activity informs the seasonal weight (a lone
      // negative adjustment month shouldn't pull weight negative).
      const weights = raw.map((v) => (v > 0 ? v : 0));
      const monthsWithData = weights.filter((w) => w > 0).length;
      const trust = monthsWithData >= MIN_MONTHS;
      const useWeights = trust ? weights : Array(12).fill(0); // fall back to even
      const monthly = _distributeToWeights(Number(l.annual_amount_cents) || 0, useWeights);
      if (trust) shaped++; else evenCount++;
      return {
        account_id: l.account_id,
        monthly_amounts_cents: monthly,
        basis: trust ? 'history' : 'even',
        months_of_data: monthsWithData,
      };
    });
    res.json({
      from_years: `${startYear}-${endYear}`,
      min_months: MIN_MONTHS,
      shaped_from_history: shaped,
      even_split: evenCount,
      lines: out,
    });
  } catch (err) {
    console.error('[books] seasonalize failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Upload a budget PDF — Claude binary extract, return preview (not yet saved)
router.post('/budgets/preview-pdf', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file_required' });
    const extracted = await extractBudget(req.file.buffer, req.file.mimetype, req.file.originalname);
    const sha256 = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    // Keep the source file (Phase 0): the saved budget references exactly what was uploaded.
    let source_storage_path = null;
    const cid = (req.body && req.body.community_id) || 'unscoped';
    const ext = (String(req.file.originalname || '').match(/\.[a-z0-9]{1,5}$/i) || [''])[0].toLowerCase();
    const path = `budgets/${cid}/${sha256}${ext}`;
    const { error: upErr } = await supabase.storage.from('documents').upload(path, req.file.buffer, { contentType: req.file.mimetype || 'application/octet-stream', upsert: true });
    if (upErr) console.warn('[books] budget source file not stored:', upErr.message);
    else source_storage_path = path;
    res.json({
      extraction: extracted,
      filename: req.file.originalname,
      sha256,
      file_size_bytes: req.file.size,
      source_storage_path,
    });
  } catch (err) {
    console.error('[books] budget pdf extract failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Commit an extracted budget — operator confirms mapping after preview.
// Body: { community_id, fiscal_year, status, source_filename, line_items: [{account_id, annual_amount_cents, monthly_amounts_cents}], notes }
router.post('/budgets', express.json({ limit: '1mb' }), async (req, res) => {
  // Budget Phase 0 (Ed 2026-09-25): an approved budget is locked; a save never
  // drops saved lines it wasn't sent and never flattens a monthly schedule.
  // Body: { community_id, fiscal_year, status, source_filename, source_storage_path, notes,
  //         line_items:[{account_id, fund_id?, annual_amount_cents, monthly_amounts_cents?, phasing?}],
  //         phasing?: 'scale'|'even', remove_account_ids?: [] }
  try {
    const { community_id, fiscal_year, status = 'draft', source_filename, source_storage_path, line_items, notes, approved_by_user_id } = req.body || {};
    if (!community_id || !fiscal_year) return res.status(400).json({ error: 'community_id_and_fiscal_year_required' });
    if (!Array.isArray(line_items) || line_items.length === 0) return res.status(400).json({ error: 'line_items_required' });
    if (!['draft', 'approved'].includes(status)) return res.status(400).json({ error: 'status_must_be_draft_or_approved' });

    const { data: existing, error: exErr } = await supabase
      .from('community_budgets')
      .select('id, status, fiscal_year').eq('community_id', community_id).eq('fiscal_year', fiscal_year).maybeSingle();
    if (exErr) throw exErr;
    if (existing && LOCKED_BUDGET_STATUSES.includes(existing.status)) {
      return res.status(409).json({ error: 'budget_locked', detail: `The FY${fiscal_year} budget is approved and locked. It can't be changed in place; an admin must reopen it (with a reason) first.` });
    }

    // Merge with what is saved (read everything; this budget's lines are small).
    let saved = [];
    if (existing) {
      const { data: sl, error: slErr } = await supabase.from('budget_line_items')
        .select('account_id, fund_id, annual_amount_cents, monthly_amounts_cents, notes').eq('budget_id', existing.id);
      if (slErr) throw slErr;
      saved = sl || [];
    }
    const merged = mergeBudgetLines(saved, line_items, { phasing: req.body.phasing || null, removeAccountIds: req.body.remove_account_ids || [] });
    if (merged.errors.length) return res.status(400).json({ error: 'invalid_budget_lines', detail: merged.errors });
    // Budget Phase 2: a line explained by components can only change in the
    // monthly plan (where the components change with it). Refuse here rather
    // than let the save fail on the completeness rule.
    if (existing) {
      const { data: cl, error: clErr } = await supabase.from('budget_line_components').select('budget_line_id, budget_line_items!inner(account_id, monthly_amounts_cents)').eq('budget_id', existing.id).limit(5000);
      if (clErr) throw clErr;
      const withComps = new Map((cl || []).map((c) => [c.budget_line_items.account_id, (c.budget_line_items.monthly_amounts_cents || []).map(Number)]));
      const touched = merged.rows.filter((r) => withComps.has(r.account_id) && r.monthly_amounts_cents.some((v, i) => v !== withComps.get(r.account_id)[i]));
      const removedWithComps = merged.removed.filter((id) => withComps.has(id));
      if (touched.length || removedWithComps.length) {
        return res.status(409).json({ error: 'line_has_components', detail: 'These lines are explained by components (for example a recurring allowance plus a project). Change them in the monthly plan so the components change with them.', account_ids: [...touched.map((r) => r.account_id), ...removedWithComps] });
      }
    }
    if (merged.decisionsNeeded.length) {
      return res.status(409).json({ error: 'monthly_schedule_decision_required',
        detail: 'Some lines have a seasonal monthly schedule and their annual changed. Choose: keep each pattern (scaled to the new annual) or spread evenly.',
        lines: merged.decisionsNeeded });
    }

    // Header: always written as draft; the lock engages only when approved last.
    let budgetId;
    if (existing) {
      // Only fields the caller sent: a planner save must not erase the upload's source reference.
      const hdr = {};
      if (source_filename !== undefined) hdr.source_filename = source_filename || null;
      if (source_storage_path !== undefined) hdr.source_storage_path = source_storage_path || null;
      if (notes !== undefined) hdr.notes = notes || null;
      if (Object.keys(hdr).length) {
        const { error } = await supabase.from('community_budgets').update(hdr).eq('id', existing.id);
        if (error) throw error;
      }
      budgetId = existing.id;
    } else {
      const { data: ins, error } = await supabase.from('community_budgets').insert({
        community_id, fiscal_year, status: 'draft',
        source_filename: source_filename || null,
        source_storage_path: source_storage_path || null,
        notes: notes || null,
      }).select('id').single();
      if (error) throw error;
      budgetId = ins.id;
    }

    // Lines: upsert what was sent; keep everything else; remove only on request.
    const rows = merged.rows.map((r) => ({ ...r, budget_id: budgetId }));
    if (rows.length) {
      const { error: lnErr } = await supabase.from('budget_line_items').upsert(rows, { onConflict: 'budget_id,account_id' });
      if (lnErr) throw lnErr;
    }
    if (merged.removed.length) {
      const { error: rmErr } = await supabase.from('budget_line_items').delete().eq('budget_id', budgetId).in('account_id', merged.removed);
      if (rmErr) throw rmErr;
    }

    if (status === 'approved') {
      const { error: apErr } = await supabase.from('community_budgets').update({
        status: 'approved', approved_at: new Date().toISOString(), approved_by_user_id: approved_by_user_id || null,
      }).eq('id', budgetId);
      if (apErr) throw apErr;
    }

    const { data: budget, error: bErr } = await supabase.from('community_budgets').select('*').eq('id', budgetId).maybeSingle();
    if (bErr) throw bErr;
    res.json({ budget, line_items_count: rows.length, lines_kept_unchanged: merged.kept.length, lines_removed: merged.removed.length });
  } catch (err) {
    console.error('[books] save budget failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// MONTHLY PLAN (Budget Phase 2, migration 464). Draft budgets only; approved
// budgets are view-only here and locked in the database.
// ============================================================================
async function _planLine(req, res) {
  const { data: line, error } = await supabase.from('budget_line_items').select('id, budget_id, account_id, annual_amount_cents, monthly_amounts_cents').eq('id', req.params.lineId).maybeSingle();
  if (error) throw error;
  if (!line || line.budget_id !== req.params.id) { res.status(404).json({ error: 'budget_line_not_found' }); return null; }
  const { data: bud, error: bErr } = await supabase.from('community_budgets').select('id, community_id, fiscal_year, status').eq('id', line.budget_id).maybeSingle();
  if (bErr) throw bErr;
  if (req.body && req.body.community_id && bud.community_id !== req.body.community_id) { res.status(403).json({ error: 'budget_belongs_to_a_different_community' }); return null; }
  return { line, bud };
}

// Everything the monthly plan screen shows for one budget.
router.get('/budgets/:id/plan', async (req, res) => {
  try {
    if (!/^[0-9a-fA-F-]{36}$/.test(req.params.id)) return res.status(400).json({ error: 'invalid_budget_id' });
    const plan = await loadBudgetPlan(supabase, req.params.id);
    if (!plan) return res.status(404).json({ error: 'budget_not_found' });
    if (req.query.community_id && plan.budget.community_id !== req.query.community_id) return res.status(403).json({ error: 'budget_belongs_to_a_different_community' });
    res.json(plan);
  } catch (err) {
    console.error('[books] budget plan read failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Compute (never save) a line's months for a phasing method.
// Body: { method, annual_cents, settings, contract_ref, current_months }
router.post('/budgets/:id/lines/:lineId/phase-preview', express.json(), async (req, res) => {
  try {
    const ctx = await _planLine(req, res); if (!ctx) return;
    const b = req.body || {};
    let contract = null;
    if (b.method === 'contract') {
      const plan = await loadBudgetPlan(supabase, ctx.bud.id);
      contract = plan.contract_sources.find((c) => c.ref === b.contract_ref);
      if (!contract) return res.status(400).json({ error: 'choose_a_contract' });
    }
    let prior_budget_months = null, prior_actual_months = null;
    if (b.method === 'prior_budget' || b.method === 'prior_actual') {
      const plan = await loadBudgetPlan(supabase, ctx.bud.id);
      const pl = plan.lines.find((l) => l.id === ctx.line.id);
      prior_budget_months = pl.prior_budget_months; prior_actual_months = pl.prior_actual_months;
    }
    const settings = { ...(b.settings || {}) };
    if (b.method === 'prior_budget') settings.source_year = ctx.bud.fiscal_year - 1;
    if (b.method === 'prior_actual') settings.source_year = ctx.bud.fiscal_year - 1;
    if (contract) Object.assign(settings, { contract_ref: contract.ref, vendor_contract_id: contract.vendor_contract_id || null, amenity_id: contract.amenity_id || null, source_label: contract.source_label });
    const r = phasing.phase({ method: b.method, annual_cents: b.annual_cents, settings, fy: ctx.bud.fiscal_year, prior_budget_months, prior_actual_months, contract, current_months: b.current_months });
    res.json({ ...r, annual_cents: phasing.sum(r.monthly) });
  } catch (err) {
    if (/^[a-z_]+$/.test(err.message)) return res.status(400).json({ error: err.message });
    console.error('[books] phase preview failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Compute (never save) the months after an annual change: scale | even | allocate_difference | keep_months.
router.post('/budgets/:id/lines/:lineId/annual-change', express.json(), async (req, res) => {
  try {
    const ctx = await _planLine(req, res); if (!ctx) return;
    const b = req.body || {};
    const r = phasing.applyAnnualChange(b.current_months, b.new_annual_cents, b.choice, { months: b.months || [] });
    res.json({ ...r, annual_cents: phasing.sum(r.monthly) });
  } catch (err) {
    if (/^[a-z_]+$/.test(err.message)) return res.status(400).json({ error: err.message });
    console.error('[books] annual change failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Save one line's plan atomically: months + phasing + (optionally) components.
// Body: { monthly_amounts_cents, phasing_method, phasing_settings, schedule_basis, description, notes,
//         components: null (leave) | [] (remove) | [..] (replace), confirm_assumption }
router.post('/budgets/:id/lines/:lineId/plan', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const ctx = await _planLine(req, res); if (!ctx) return;
    if (ctx.bud.status !== 'draft') return res.status(409).json({ error: 'budget_locked', detail: `The FY${ctx.bud.fiscal_year} budget is ${ctx.bud.status}; only draft budgets can be edited.` });
    const b = req.body || {};
    const months = (b.monthly_amounts_cents || []).map((v) => Math.round(Number(v)));
    if (months.length !== 12 || months.some((v) => !Number.isFinite(v))) return res.status(400).json({ error: 'a line needs 12 monthly values' });
    if (b.phasing_method != null && !phasing.METHODS.includes(b.phasing_method)) return res.status(400).json({ error: 'unknown phasing method' });
    if (b.schedule_basis != null && !phasing.BASES.includes(b.schedule_basis)) return res.status(400).json({ error: 'unknown schedule basis' });
    let components = b.components === undefined ? null : b.components;
    if (components !== null) {
      if (!Array.isArray(components)) return res.status(400).json({ error: 'components must be a list' });
      if (components.length > 50) return res.status(400).json({ error: 'too many components' });
      components = components.map((c) => ({ ...c, monthly_amounts_cents: (c.monthly_amounts_cents || []).map((v) => Math.round(Number(v))) }));
      const chk = phasing.checkComponents(months, components);
      if (!chk.ok) return res.status(400).json({ error: 'components_incomplete', detail: chk.problems, residual_cents: chk.residual });
    }
    const settings = b.phasing_settings && typeof b.phasing_settings === 'object' ? { ...b.phasing_settings } : null;
    if (settings && settings.assumption && b.confirm_assumption) {
      const u = await getAuthedUser(req);
      settings.confirmed_by = (u && u.email) || 'staff'; settings.confirmed_at = new Date().toISOString();
    }
    const { data, error } = await supabase.rpc('save_budget_line_plan', {
      p_line_id: ctx.line.id, p_monthly: months, p_phasing_method: b.phasing_method || null, p_phasing_settings: settings,
      p_schedule_basis: b.schedule_basis || null, p_description: b.description || null, p_notes: b.notes || null, p_components: components,
    });
    if (error) return res.status(error.code === 'P0001' ? 409 : 500).json({ error: error.code === 'P0001' ? error.message : safeErrorMessage(error) });
    res.json(data);
  } catch (err) {
    console.error('[books] save line plan failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Reopen an approved budget (owner only, reason required, logged). The only way
// to change an approved budget until budget versions exist.
router.post('/budgets/:id/reopen', express.json(), async (req, res) => {
  try {
    const user = await requireOwner(req, res); if (!user) return;
    const reason = String((req.body && req.body.reason) || '').trim();
    if (!reason) return res.status(400).json({ error: 'reason_required' });
    const { data: bud, error: bErr } = await supabase.from('community_budgets').select('id, community_id').eq('id', req.params.id).maybeSingle();
    if (bErr) throw bErr;
    if (!bud) return res.status(404).json({ error: 'budget_not_found' });
    if (req.body.community_id && bud.community_id !== req.body.community_id) return res.status(403).json({ error: 'budget_belongs_to_a_different_community' });
    const { data, error } = await supabase.rpc('reopen_community_budget', { p_budget_id: bud.id, p_reason: reason, p_by: user.email || user.id || 'admin' });
    if (error) return res.status(error.code === 'P0001' ? 409 : 500).json({ error: error.code === 'P0001' ? error.message : safeErrorMessage(error) });
    res.json(data);
  } catch (err) {
    console.error('[books] reopen budget failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Build next year's DRAFT budget from a prior year's adopted budget: carry each
// line forward, flag expense lines tracking materially off this year's run-rate,
// and note the reserve-study recommendation for the target year. Never clobbers
// an existing target-year budget (returns 409 with its id). (Ed 2026-09-02.)
// Body: { community_id, from_year, to_year, basis?: 'flat'|'inflation', inflation_pct?, user_id? }
router.post('/budgets/roll-forward', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.community_id) return res.status(400).json({ error: 'community_id_required' });
    if (!b.from_year || !b.to_year) return res.status(400).json({ error: 'from_year_and_to_year_required' });
    const out = await rollForwardBudget(supabase, {
      communityId: b.community_id,
      fromYear: b.from_year,
      toYear: b.to_year,
      basis: b.basis || 'flat',
      inflationPct: b.inflation_pct || 0,
      createdByUserId: b.user_id || null,
    });
    if (out.conflict) {
      return res.status(409).json({ error: 'target_year_budget_exists', detail: `A FY${b.to_year} budget already exists (${out.existing_status}). Delete it first or edit it directly.`, existing_budget_id: out.existing_budget_id });
    }
    res.json(out);
  } catch (err) {
    if (err.code === 'invalid_input') return res.status(400).json({ error: err.message });
    console.error('[books] budget roll-forward failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Delete a budget (e.g. one uploaded to the wrong community). Community-scoped:
// the caller must pass the community_id it belongs to, and we verify it before
// deleting so one community can't delete another's budget by guessing an id.
router.delete('/budgets/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const community_id = req.query.community_id;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    const { data: bud, error: findErr } = await supabase
      .from('community_budgets').select('id, community_id, fiscal_year').eq('id', id).maybeSingle();
    if (findErr) throw findErr;
    if (!bud) return res.status(404).json({ error: 'budget_not_found' });
    if (bud.community_id !== community_id) return res.status(403).json({ error: 'budget_belongs_to_a_different_community' });
    const { data: st, error: stErr } = await supabase.from('community_budgets').select('status').eq('id', id).maybeSingle();
    if (stErr) throw stErr;
    if (st && LOCKED_BUDGET_STATUSES.includes(st.status)) {
      return res.status(409).json({ error: 'budget_locked', detail: `The FY${bud.fiscal_year} budget is approved and locked; it can't be deleted. An admin must reopen it (with a reason) first.` });
    }
    const { error: lnDelErr } = await supabase.from('budget_line_items').delete().eq('budget_id', id);
    if (lnDelErr) throw lnDelErr;
    const { error: delErr } = await supabase.from('community_budgets').delete().eq('id', id).eq('community_id', community_id);
    if (delErr) throw delErr;
    res.json({ deleted: true, fiscal_year: bud.fiscal_year });
  } catch (err) {
    console.error('[books] delete budget failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// Reserve budget — the planned capital-expenditure PROJECTS for the year (the
// reserve side of the budget). Named projects without GL accounts, so they
// live in reserve_budget_items, not budget_line_items. (Ed 2026-08-12.)
// ----------------------------------------------------------------------------
router.get('/reserve-budget', async (req, res) => {
  try {
    const { community_id, fiscal_year } = req.query;
    if (!community_id || !fiscal_year) return res.status(400).json({ error: 'community_id_and_fiscal_year_required' });
    const { loadReservePlanProjects } = require('../lib/accounting/reserve_plan');
    const { projects: items, columns_ready } = await loadReservePlanProjects(supabase, { community_id, fiscal_year });
    res.json({ items, columns_ready, total_cents: items.reduce((s, i) => s + (i.planned_amount_cents || 0), 0) });
  } catch (err) {
    console.error('[books] reserve-budget list failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// The Reserve Budget as the proposed-budget statement computes it (lib/statements/model.js
// buildProposedBudgetModel for the reserve fund): projects, legacy saved amounts flagged for
// review, funding, the projected beginning balance and the prior-year reference history.
// The editor recalculates live with the same public/js/reserve_plan_core.js.
router.get('/reserve-plan', async (req, res) => {
  try {
    const { community_id, fiscal_year } = req.query;
    if (!community_id || !fiscal_year) return res.status(400).json({ error: 'community_id_and_fiscal_year_required' });
    const fy = parseInt(fiscal_year, 10);
    const { data: funds, error: fErr } = await supabase.from('account_funds').select('id, fund_code, fund_name, fund_type').eq('community_id', community_id).limit(50);
    if (fErr) throw fErr;
    const rf = (funds || []).find((f) => f.fund_type === 'reserve');
    if (!rf) return res.json({ available: false, reason: 'no_reserve_fund' });
    const { data: accts, error: aErr } = await supabase.from('chart_of_accounts').select('id, account_number, account_name, account_type, fund_id, is_active')
      .eq('community_id', community_id).eq('fund_id', rf.id).eq('account_type', 'expense').limit(500);
    if (aErr) throw aErr;
    const accounts = (accts || []).filter((a) => a.is_active !== false).map((a) => ({ id: a.id, account_number: a.account_number, account_name: a.account_name }))
      .sort((a, b) => String(a.account_name).localeCompare(String(b.account_name)));
    const now = new Date(); const cy = now.getUTCFullYear();
    // The base year's last closed month (the working forecast's as-of); a past base year uses its year end.
    let asOf = fy - 1 === cy ? new Date(Date.UTC(cy, now.getUTCMonth(), 0)).toISOString().slice(0, 10) : `${fy - 1}-12-31`;
    if (asOf < `${fy - 1}-01-31`) asOf = `${fy - 1}-01-31`;
    const M = require('../lib/statements/model');
    let m;
    try { m = await M.buildProposedBudgetModel(supabase, { community_id, target_year: fy, as_of: asOf, fund: rf.fund_code }); }
    catch (e) {
      if (e.code !== 'not_found') throw e;
      const { loadReservePlanProjects } = require('../lib/accounting/reserve_plan');
      const { columns_ready } = await loadReservePlanProjects(supabase, { community_id, fiscal_year: fy });
      return res.json({ available: false, reason: 'no_draft_budget', detail: e.message, fund_code: rf.fund_code, fund_id: rf.id, columns_ready, accounts });
    }
    const history = [];
    for (const sec of m.sections) if (sec.key === 'expense') for (const g of sec.groups) for (const l of g.lines) history.push({ account_id: l.account_id, account_number: l.account_number, account_name: l.account_name, approved_cents: l.values.appr, ytd_cents: l.values.ytd, projected_cents: l.values.proj });
    const rp = m.reserve_plan;
    res.json({
      available: true, fund_code: rf.fund_code, fund_name: rf.fund_name, fund_id: rf.id, base_year: fy - 1, as_of: m.period.as_of, accounts, history,
      projects: rp.projects, review_items: rp.review_items, columns_ready: rp.columns_ready, plan_saved: rp.projects.some((p) => p.account_id),
      saved_lines: rp.review_items.map((r) => ({ account_id: r.account_id, amount_cents: r.amount_cents })),
      beginning_cents: rp.totals.beginning_cents, totals: rp.totals, warnings: m.warnings,
    });
  } catch (err) {
    console.error('[books] reserve-plan failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Replace the whole reserve project list for (community, year) — the grid saves
// the full set at once, so this is a clean delete-then-insert in one call.
router.post('/reserve-budget', express.json({ limit: '512kb' }), async (req, res) => {
  try {
    const { community_id, fiscal_year, items } = req.body || {};
    if (!community_id || !fiscal_year) return res.status(400).json({ error: 'community_id_and_fiscal_year_required' });
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items_required' });
    const fy = parseInt(fiscal_year, 10);
    const { data: bdg, error: bdgErr } = await supabase.from('community_budgets').select('status').eq('community_id', community_id).eq('fiscal_year', fy).maybeSingle();
    if (bdgErr) throw bdgErr;
    if (bdg && LOCKED_BUDGET_STATUSES.includes(bdg.status)) {
      return res.status(409).json({ error: 'budget_locked', detail: `The FY${fy} budget is approved and locked; its reserve projects can't be replaced.` });
    }
    const rows = items
      .map((it, i) => ({
        community_id,
        fiscal_year: fy,
        project_name: String(it.project_name || '').trim(),
        category: it.category ? String(it.category).trim() : null,
        planned_amount_cents: Math.round(Number(it.planned_amount_cents) || 0),
        note: it.note ? String(it.note).trim() : null,
        sort_order: Number.isFinite(Number(it.sort_order)) ? Number(it.sort_order) : i,
        account_id: it.account_id || null,
        planned_month: it.planned_month ? parseInt(it.planned_month, 10) : null,
        review_status: it.review_status === 'needs_review' ? 'needs_review' : 'planned',
      }))
      .filter((r) => r.project_name);
    // Each project's GL account must be a reserve-fund expense account of THIS community.
    const acctIds = [...new Set(rows.map((r) => r.account_id).filter(Boolean))];
    if (acctIds.length) {
      const { data: ok, error: aErr } = await supabase.from('chart_of_accounts').select('id, account_type, account_funds ( fund_type )').eq('community_id', community_id).in('id', acctIds);
      if (aErr) throw aErr;
      const good = new Set((ok || []).filter((a) => a.account_type === 'expense' && a.account_funds && a.account_funds.fund_type === 'reserve').map((a) => a.id));
      if (acctIds.some((id) => !good.has(id))) return res.status(400).json({ error: 'reserve_project_account_invalid', detail: 'Each project must use a reserve-fund expense account of this community.' });
    }
    if (rows.some((r) => r.planned_month !== null && !(r.planned_month >= 1 && r.planned_month <= 12))) return res.status(400).json({ error: 'planned_month_invalid' });
    const { loadReservePlanProjects } = require('../lib/accounting/reserve_plan');
    const { columns_ready } = await loadReservePlanProjects(supabase, { community_id, fiscal_year: fy });
    if (!columns_ready) {
      // Before migration 512 a project cannot keep its GL account, timing or review flag.
      // Refuse rather than silently drop them (nothing is deleted or written).
      if (rows.some((r) => r.account_id || r.planned_month || r.review_status !== 'planned')) {
        return res.status(409).json({ error: 'migration_512_required', detail: 'Planned projects need migration 512 (GL account, timing, review status) before they can be saved. Nothing was changed.' });
      }
      for (const r of rows) { delete r.account_id; delete r.planned_month; delete r.review_status; }
    }
    await supabase.from('reserve_budget_items').delete().eq('community_id', community_id).eq('fiscal_year', fy);
    if (rows.length) {
      const { error } = await supabase.from('reserve_budget_items').insert(rows);
      if (error) throw error;
    }
    res.json({ saved: true, count: rows.length, total_cents: rows.reduce((s, r) => s + r.planned_amount_cents, 0) });
  } catch (err) {
    console.error('[books] reserve-budget save failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// Assessment-increase cap, sourced from the community's governing documents and
// cached in community_facts (the SSOT for community facts). The budget's
// assessment-rate control pre-fills its max-increase % from this. (Ed 2026-08-12.)
// ----------------------------------------------------------------------------
router.get('/assessment-cap', async (req, res) => {
  try {
    const { community_id, refresh } = req.query;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    const FACT_KEY = 'assessment_increase_cap_pct';
    if (!refresh) {
      const { data: fact, error: fErr } = await supabase.from('community_facts')
        .select('value, details, source_ref, review_note, needs_review, manual_override').eq('community_id', community_id).eq('key', FACT_KEY).maybeSingle();
      if (fErr) throw fErr;
      if (fact) {
        const capNum = parseFloat(String(fact.value).replace(/[^0-9.]/g, ''));
        return res.json({ cap_pct: Number.isFinite(capNum) ? capNum : null, no_cap: /no cap|no limit|unlimited/i.test(fact.value || ''), quote: fact.details || null, source: fact.source_ref || null, note: fact.review_note || null, amended: /amend|supersed|prior|original/i.test(fact.review_note || ''), needs_review: !!fact.needs_review, manual_override: !!fact.manual_override, cached: true, found: true });
      }
    }
    const { data: comm, error: cErr } = await supabase.from('communities').select('name').eq('id', community_id).maybeSingle();
    if (cErr) throw cErr;
    if (!comm) return res.status(404).json({ error: 'community_not_found' });
    const { getRelevantChunks } = require('../lib/hybrid_retrieval');
    const query = 'maximum annual increase cap on regular assessments the board may raise without a vote of the members percent';
    let chunks = '';
    try { chunks = await getRelevantChunks(query, comm.name); } catch (_) { /* retrieval optional */ }
    if (!chunks || !String(chunks).trim()) return res.json({ cap_pct: null, no_cap: false, found: false, note: 'No governing documents indexed to read.' });
    const prompt = `From the HOA governing-document excerpts below, find the CAP on how much the BOARD may increase the REGULAR annual assessment in a single year WITHOUT a vote of the members.

Return ONLY JSON, no preamble:
{ "found": true|false, "cap_pct": <number or null — the CONTROLLING cap>, "cap_basis": "percent|dollar|cpi|none", "no_cap": true|false, "amended": true|false, "prior_cap_pct": <number or null>, "effective_note": "e.g. '20% from Jan 1, 2001, amending the original 10%'", "over_cap_vote": "e.g. 'two-thirds (2/3) of each class' or null", "quote": "the exact sentence(s), verbatim from the excerpts, for the CONTROLLING provision", "citation": "document name + article/section" }

Rules:
- cap_pct is the PERCENT the board can raise regular assessments annually without owner approval. "shall not be increased by more than ten percent (10%)" -> 10.
- AMENDMENTS: declarations are often amended. If you find MORE THAN ONE increase cap (an original and a later/amended one, usually distinguished by an effective date like "From and after January 1, 2001"), the LATEST-dated provision CONTROLS — report it as cap_pct, set "amended": true, put the ORIGINAL percent in "prior_cap_pct", and explain the timeline in "effective_note". Do NOT silently pick one; surface both.
- Do NOT confuse an increase cap with unrelated percentages — interest on unpaid assessments (e.g. "10% per annum" on delinquencies) is NOT an increase cap.
- over_cap_vote: the member-approval threshold required to exceed the cap, if stated.
- If the cap is dollar- or CPI-based, set cap_basis and give cap_pct only if a percent is stated, else null.
- If the documents explicitly state NO limit, set no_cap true and found true.
- If the excerpts don't address a board increase cap, found false.
- quote must be verbatim from the excerpts, never paraphrased.

EXCERPTS:
${String(chunks).slice(0, 24000)}

Return ONLY the JSON.`;
    const resp = await _anthropic.messages.create({ model: aiRoute('accounting.assessment_cap'), max_tokens: 1200, messages: [{ role: 'user', content: prompt }] });
    const rawTxt = (resp.content || []).map((b) => b.text || '').join('').trim();
    console.log('[books] assessment-cap extracted:', rawTxt.slice(0, 400));
    let ex; try { ex = JSON.parse(rawTxt.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()); } catch (_) { ex = { found: false }; }
    if (ex.found) {
      const valueStr = ex.no_cap ? 'No cap (unlimited)' : (ex.cap_pct != null ? `${ex.cap_pct}%` : (ex.cap_basis || 'see quote'));
      const { error: upErr } = await supabase.from('community_facts').upsert({
        community_id, key: FACT_KEY, category: 'financial',
        label: 'Annual assessment increase cap (board, no member vote)',
        value: valueStr, details: ex.quote || null, source_ref: ex.citation || null,
        review_note: ex.effective_note || null,
        source_type: 'pulled_from', needs_review: true, last_updated_at: new Date().toISOString(),
      }, { onConflict: 'community_id,key' });
      if (upErr) console.warn('[books] assessment-cap cache write warning:', upErr.message);
    }
    res.json({ cap_pct: ex.cap_pct != null ? ex.cap_pct : null, no_cap: !!ex.no_cap, quote: ex.quote || null, source: ex.citation || null, found: !!ex.found, amended: !!ex.amended, prior_cap_pct: ex.prior_cap_pct != null ? ex.prior_cap_pct : null, note: ex.effective_note || null, over_cap_vote: ex.over_cap_vote || null, needs_review: true, cached: false });
  } catch (err) {
    console.error('[books] assessment-cap failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// Vendor SERVICE contracts — upload the signed PDF, extract the terms, store
// them structured in `vendor_contracts`, and let the living budget propose that
// line at the CONTRACTED amount + real escalation, with the PDF as evidence.
// Turns a flagged "below-approved" trend guess (e.g. Security $161k) into a
// green contract-verified number. (Ed 2026-08-11.)
// ============================================================================
const { extractVendorContract } = require('../lib/accounting/vendor_contract_extractor');

// Preview: extract terms + stash the PDF in storage; nothing committed yet.
router.post('/vendor-contracts/extract', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file_required' });
    const community_id = req.body.community_id;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    const extraction = await extractVendorContract(req.file.buffer, req.file.mimetype, req.file.originalname);
    const file_hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const ext = /\.(pdf|xlsx|xls|csv)$/i.exec(req.file.originalname || '');
    const file_path = `vendor-contracts/${community_id}/${file_hash}${ext ? ext[0].toLowerCase() : '.pdf'}`;
    const { error: upErr } = await supabase.storage.from('documents').upload(file_path, req.file.buffer, { contentType: req.file.mimetype || 'application/pdf', upsert: true });
    if (upErr) console.warn('[books] vendor-contract storage upload warning:', upErr.message);
    res.json({ extraction, file_path, file_hash, file_size_bytes: req.file.size, filename: req.file.originalname });
  } catch (err) {
    console.error('[books] vendor-contract extract failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Commit the confirmed contract.
router.post('/vendor-contracts', express.json({ limit: '512kb' }), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.community_id) return res.status(400).json({ error: 'community_id_required' });
    if (!b.vendor_name) return res.status(400).json({ error: 'vendor_name_required' });
    const { data: mc } = await supabase.from('management_companies').select('id').limit(1).maybeSingle();
    if (!mc) return res.status(500).json({ error: 'no_management_company' });
    // Best-effort vendor link by name.
    let vendor_id = null;
    try { const { data: v } = await supabase.from('vendors').select('id').ilike('name', b.vendor_name).limit(1).maybeSingle(); vendor_id = v ? v.id : null; } catch (_) { /* optional */ }
    const row = {
      management_company_id: mc.id, community_id: b.community_id, vendor_id, vendor_name_raw: b.vendor_name,
      service_category: b.service_category || 'other', service_description: b.service_description || null,
      total_amount: Number(b.total_amount) || null, annualized_amount: Number(b.annual_amount) || null,
      term_months: b.term_months != null ? parseInt(b.term_months, 10) : null,
      effective_date: b.effective_date || null, end_date: b.end_date || null,
      escalator_kind: b.escalator_kind || 'none', escalator_pct: b.escalator_pct != null ? Number(b.escalator_pct) : null,
      payment_terms: b.payment_terms || null, auto_renews: !!b.auto_renews,
      renewal_notice_days: b.renewal_notice_days != null ? parseInt(b.renewal_notice_days, 10) : null,
      file_path: b.file_path || null, file_hash: b.file_hash || null, file_size_bytes: b.file_size_bytes || null,
      extracted_data: b.extracted_data || null, extraction_model: aiExecuted(b.extracted_data, 'accounting.vendor_contract_extract'),
      extraction_confidence: b.extraction_confidence || null, status: 'active',
    };
    const { data: ins, error } = await supabase.from('vendor_contracts').insert(row).select('id').single();
    if (error) throw error;
    res.json({ id: ins.id, saved: true });
  } catch (err) {
    console.error('[books] vendor-contract save failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// List a community's vendor contracts (with a short-lived view link).
router.get('/vendor-contracts', async (req, res) => {
  try {
    const { community_id } = req.query;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    const { data, error } = await supabase.from('vendor_contracts')
      .select('id, vendor_name_raw, service_category, service_description, annualized_amount, escalator_kind, escalator_pct, effective_date, end_date, status, file_path')
      .eq('community_id', community_id).neq('status', 'superseded').order('annualized_amount', { ascending: false, nullsFirst: false });
    if (error) throw error;
    const rows = [];
    for (const c of (data || [])) {
      let url = null;
      if (c.file_path) { try { const { data: s } = await supabase.storage.from('documents').createSignedUrl(c.file_path, 3600); if (s) url = s.signedUrl; } catch (_) { /* optional */ } }
      rows.push({ ...c, view_url: url });
    }
    res.json({ contracts: rows });
  } catch (err) {
    console.error('[books] vendor-contracts list failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Delete a vendor contract (community-scoped).
router.delete('/vendor-contracts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const community_id = req.query.community_id;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    const { data: c, error: findErr } = await supabase.from('vendor_contracts').select('id, community_id, file_path').eq('id', id).maybeSingle();
    if (findErr) throw findErr;
    if (!c) return res.status(404).json({ error: 'contract_not_found' });
    if (c.community_id !== community_id) return res.status(403).json({ error: 'contract_belongs_to_a_different_community' });
    if (c.file_path) { try { await supabase.storage.from('documents').remove([c.file_path]); } catch (_) { /* optional */ } }
    const { error: delErr } = await supabase.from('vendor_contracts').delete().eq('id', id).eq('community_id', community_id);
    if (delErr) throw delErr;
    res.json({ deleted: true });
  } catch (err) {
    console.error('[books] vendor-contract delete failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /api/books/budgets/plan-seed  (Ed 2026-06-30 — budget PLANNING)
// Seed next year's budget from what actually happened — the CPA default, not a
// blank page. Returns every revenue/expense account with a prior-year actual
// and a suggested next-year amount (prior actual, optionally bumped a %). The
// planner grid renders these; staff adjust and Save as a draft budget (which
// then flows straight into Budget-vs-Actual and the board packet).
//
//   ?community_id= &fiscal_year=  (required — the year being planned)
//   ?basis=prior_actual | ytd_annualized   (default prior_actual; auto-falls
//          back to ytd_annualized when the prior full year has ~no data — the
//          common case for a community freshly migrated onto trustEd)
//   ?bump_pct=   (optional inflation bump applied to the suggestion)
// ----------------------------------------------------------------------------
router.get('/budgets/plan-seed', async (req, res) => {
  try {
    const { community_id, fiscal_year } = req.query;
    if (!community_id || !fiscal_year) return res.status(400).json({ error: 'community_id_and_fiscal_year_required' });
    const fy = parseInt(fiscal_year, 10);
    const bumpPct = Number(req.query.bump_pct || 0) || 0;
    let basis = req.query.basis === 'ytd_annualized' ? 'ytd_annualized' : 'prior_actual';

    const srcYear = fy - 1;
    let is = await incomeStatement({ community_id, period_start: `${srcYear}-01-01`, period_end: `${srcYear}-12-31` });
    let annualize = 1;
    let sourceLabel = `FY ${srcYear} actual`;

    // A prior year that is not available in trustEd (pre-history of a converted community) is
    // not a zero year: it is no basis at all, so the draft uses the annualized current year.
    const priorNA = yearNA(is);
    const priorTotal = priorNA ? null : Math.abs(ytdTot(is.totals, 'revenue_cents')) + Math.abs(ytdTot(is.totals, 'expenses_cents'));
    if (basis === 'ytd_annualized' || priorNA || priorTotal === 0) {
      // Annualize the current calendar year's YTD (months elapsed → 12).
      const today = new Date();
      const cy = today.getUTCFullYear();
      const monthsElapsed = today.getUTCMonth() + 1; // 1..12
      is = await incomeStatement({ community_id, period_start: `${cy}-01-01`, period_end: today.toISOString().slice(0, 10) });
      annualize = monthsElapsed > 0 ? 12 / monthsElapsed : 1;
      basis = 'ytd_annualized';
      sourceLabel = `${cy} YTD annualized (${monthsElapsed} mo → 12)${priorNA ? ` · FY ${srcYear} not available in TrustEd` : ''}`;
    }

    const rows = [];
    const push = (r, type) => {
      const prior = Math.round(ytdOf(r) * annualize);
      const suggested = Math.round(prior * (1 + bumpPct / 100));
      rows.push({
        account_id: r.account_id, account_number: r.account_number, account_name: r.account_name,
        account_type: type, fund_id: r.fund_id || null, fund_code: r.fund_code || null,
        prior_actual_cents: prior, suggested_annual_cents: suggested,
      });
    };
    (is.sections?.revenue || []).forEach((r) => push(r, 'revenue'));
    (is.sections?.expenses || []).forEach((r) => push(r, 'expense'));
    // The current year is never annualized (12 / months elapsed): when the seed is this
    // year, each account takes the working forecast's projection (applyWorkingForecast).
    // A seed year that has not ended (the current year) is not an actual year either.
    if (basis === 'ytd_annualized' || srcYear >= new Date().getUTCFullYear()) {
      const acc = new Map(rows.map((r) => [r.account_id, { account_id: r.account_id, forecast: r.prior_actual_cents }]));
      const fb = await applyWorkingForecast(community_id, fy, acc);
      if (fb.basis === 'working_forecast') {
        for (const r of rows) { const a = acc.get(r.account_id); r.prior_actual_cents = a.forecast; r.suggested_annual_cents = Math.round(a.forecast * (1 + bumpPct / 100)); r.fund_code = a.fund_code || r.fund_code; r.fund_type = a.fund_type || null; }
        basis = 'working_forecast'; sourceLabel = `${srcYear} forecast: ${fb.note}`;
      } else for (const r of rows) { const a = acc.get(r.account_id); r.fund_code = a.fund_code || r.fund_code; r.fund_type = a.fund_type || null; }
    }
    rows.sort((a, b) => String(a.account_number).localeCompare(String(b.account_number)));

    const sv = rows.filter((r) => r.account_type === 'revenue').reduce((s, r) => s + r.suggested_annual_cents, 0);
    const se = rows.filter((r) => r.account_type === 'expense').reduce((s, r) => s + r.suggested_annual_cents, 0);
    res.json({
      community_id, fiscal_year: fy, basis, bump_pct: bumpPct, source_label: sourceLabel,
      rows, suggested_totals: { revenue_cents: sv, expense_cents: se, net_income_cents: sv - se },
    });
  } catch (err) {
    console.error('[books] plan-seed failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /api/books/budgets/ai-plan?community_id=&fiscal_year=  (Ed 2026-08-10)
// AI-generated draft budget: reasons over 2-3 years of actuals + the current-year
// run-rate + known operating contracts, and proposes a next-year amount PER
// account with a one-line rationale — the CPA-quality first pass, not prior*bump.
// Returns the plan-seed row shape plus ai_suggested_cents + rationale, so the
// planner grid renders it and staff adjust + save (which flows into
// Budget-vs-Actual and the board packet).
router.get('/budgets/ai-plan', async (req, res) => {
  try {
    const { community_id, fiscal_year } = req.query;
    if (!community_id || !fiscal_year) return res.status(400).json({ error: 'community_id_and_fiscal_year_required' });
    const fy = parseInt(fiscal_year, 10);

    const isFor = (y) => incomeStatement({ community_id, period_start: `${y}-01-01`, period_end: `${y}-12-31` });
    const [is1, is2] = await Promise.all([isFor(fy - 1), isFor(fy - 2)]);
    const today = new Date(); const cy = today.getUTCFullYear(); const monthsElapsed = today.getUTCMonth() + 1;
    const isYtd = await incomeStatement({ community_id, period_start: `${cy}-01-01`, period_end: today.toISOString().slice(0, 10) });
    const annualize = monthsElapsed > 0 ? 12 / monthsElapsed : 1;

    const acc = new Map();
    const merge = (is, key, mult = 1) => {
      for (const type of ['revenue', 'expenses']) {
        for (const r of (is.sections?.[type] || [])) {
          let a = acc.get(r.account_id);
          if (!a) { a = { account_id: r.account_id, account_number: r.account_number, account_name: r.account_name, account_type: type === 'revenue' ? 'revenue' : 'expense', fund_id: r.fund_id || null, fund_code: r.fund_code || null, fy2: 0, fy1: 0, ytd_annualized: 0 }; acc.set(r.account_id, a); }
          a[key] = Math.round(ytdOf(r) * mult);
        }
      }
    };
    merge(is2, 'fy2'); merge(is1, 'fy1'); merge(isYtd, 'ytd_annualized', annualize);
    // A year not available in trustEd is null on every line (never an implied $0).
    for (const a of acc.values()) { if (yearNA(is2)) a.fy2 = null; if (yearNA(is1)) a.fy1 = null; }
    const rows = [...acc.values()].sort((a, b) => String(a.account_number).localeCompare(String(b.account_number)));
    if (!rows.length) return res.json({ community_id, fiscal_year: fy, rows: [], note: 'No revenue/expense history to plan from yet.' });

    let contracts = [];
    try {
      const { data: am } = await supabase.from('amenities')
        .select('name, management_annual_cost_cents, management_contract_end_date')
        .eq('community_id', community_id).gt('management_annual_cost_cents', 0);
      contracts = (am || []).map((x) => `${x.name}: $${((x.management_annual_cost_cents || 0) / 100).toLocaleString()}/yr operating contract${x.management_contract_end_date ? ` (through ${x.management_contract_end_date})` : ''}`);
    } catch (_) { /* amenity contracts optional */ }

    // Recurring vendor commitments per expense account (prior-year GL): the
    // concrete "this line is $X to vendor Y" signal so a proposal is grounded in
    // actual vendor relationships, not just a trend line. Reflects real contracts
    // by their run-rate even when no contract PDF is on file.
    const vendorByAcct = {};
    try {
      const { fetchAllQuery } = require('../lib/db/fetch_all');
      const jel = await fetchAllQuery(() => supabase.from('journal_entry_lines')
        .select('account_id, vendor_id, debit_cents, credit_cents, journal_entries!inner ( community_id, posting_date, status )')
        .eq('journal_entries.community_id', community_id)
        .gte('journal_entries.posting_date', `${fy - 1}-01-01`).lte('journal_entries.posting_date', `${fy - 1}-12-31`)
        .not('vendor_id', 'is', null), { orderBy: 'id' });
      const agg = {};
      for (const l of jel) { if (!l.vendor_id) continue; const net = Number(l.debit_cents || 0) - Number(l.credit_cents || 0); (agg[l.account_id] = agg[l.account_id] || {}); agg[l.account_id][l.vendor_id] = (agg[l.account_id][l.vendor_id] || 0) + net; }
      const vids = [...new Set(Object.values(agg).flatMap((v) => Object.keys(v)))];
      const vnames = {};
      for (let i = 0; i < vids.length; i += 300) { const { data } = await supabase.from('vendors').select('id, name').in('id', vids.slice(i, i + 300)); (data || []).forEach((v) => { vnames[v.id] = v.name; }); }
      for (const [aid, vmap] of Object.entries(agg)) {
        const top = Object.entries(vmap).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([vid, c]) => `${vnames[vid] || 'vendor'} $${Math.round(c / 100)}`);
        if (top.length) vendorByAcct[aid] = top.join(', ');
      }
    } catch (_) { /* vendor history optional */ }

    const d = (c) => (c === null ? 'n/a (not available in TrustEd)' : (Number(c || 0) / 100).toFixed(0));
    const table = rows.map((r) => `${r.account_number}\t${r.account_name}\t${r.account_type}\tFY${fy - 2}=$${d(r.fy2)}\tFY${fy - 1}=$${d(r.fy1)}\tYTD-annualized=$${d(r.ytd_annualized)}\trecurring vendors (FY${fy - 1}): ${vendorByAcct[r.account_id] || '—'}`).join('\n');
    const prompt = `You are a CPA preparing the FY ${fy} operating budget for a Texas HOA. For each account below, propose a next-year budget amount in whole dollars and a one-sentence rationale.

Rules:
- Base it on the 2-3 year trend AND the current-year run-rate; do not just copy last year.
- If an account clearly maps to a known operating contract (listed below), or its recurring-vendors column shows a steady annual vendor commitment, budget at that commitment (allowing a reasonable renewal increase) and name the vendor/contract in the rationale.
- Fixed obligations (insurance, management fee, utilities, reserve contribution) should reflect known/expected increases; discretionary lines can hold roughly flat unless the trend says otherwise.
- Round to sensible round numbers.
- Revenue accounts: budget assessment/other income realistically against the trend, not inflated.

Known operating contracts:
${contracts.length ? contracts.join('\n') : '(none on file)'}

Accounts (tab-separated: number, name, type, three history points):
${table}

Return ONLY a JSON array, one object per account, no prose:
[{"account_number":"5200","suggested_annual_dollars":12345,"rationale":"..."}]`;

    const resp = await _anthropic.messages.create({ model: aiRoute('accounting.vendor_contract_books'), max_tokens: 4000, messages: [{ role: 'user', content: prompt }] });
    let text = (resp.content && resp.content[0] && resp.content[0].text || '').trim();
    const mm = text.match(/\[[\s\S]*\]/); if (mm) text = mm[0];
    let ai;
    try { ai = JSON.parse(text); } catch (e) { return res.status(502).json({ error: 'ai_parse_failed', detail: text.slice(0, 300) }); }
    const byNum = new Map((ai || []).map((x) => [String(x.account_number), x]));

    const out = rows.map((r) => {
      const s = byNum.get(String(r.account_number));
      const ai_suggested_cents = (s && Number.isFinite(Number(s.suggested_annual_dollars))) ? Math.round(Number(s.suggested_annual_dollars) * 100) : (r.fy1 || r.ytd_annualized || 0);
      // Variance vs last year — flag any line that jumps materially so a big move
      // can't slip through unreviewed. Only meaningful once there's a prior figure.
      const variance_pct = r.fy1 ? Math.round(((ai_suggested_cents - r.fy1) / Math.abs(r.fy1)) * 100) : null;
      return {
        account_id: r.account_id, account_number: r.account_number, account_name: r.account_name,
        account_type: r.account_type, fund_id: r.fund_id, fund_code: r.fund_code,
        prior_actual_cents: r.fy1, fy2_actual_cents: r.fy2, ytd_annualized_cents: r.ytd_annualized,
        ai_suggested_cents, rationale: (s && s.rationale) || null,
        variance_pct, flag_large_variance: variance_pct != null && Math.abs(variance_pct) >= 15,
      };
    });
    const sv = out.filter((r) => r.account_type === 'revenue').reduce((s, r) => s + r.ai_suggested_cents, 0);
    const se = out.filter((r) => r.account_type === 'expense').reduce((s, r) => s + r.ai_suggested_cents, 0);
    res.json({ community_id, fiscal_year: fy, source_label: `Generated from FY${fy - 2}/FY${fy - 1} actuals + run-rate + contracts`, rows: out, contracts, suggested_totals: { revenue_cents: sv, expense_cents: se, net_income_cents: sv - se } });
  } catch (err) {
    console.error('[books] ai-plan failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /api/books/budgets/living-lines?community_id=&fiscal_year=  (Ed 2026-08-10)
// The differentiated budget: each account is a LIVING, SOURCED line, not a
// spreadsheet cell. Per line: last year's adopted budget, the current-year
// FORECAST (run-rate), the YTD ACTUAL, a data-derived proposed amount, the
// DERIVATION it was built from (a vendor commitment vs a spend/revenue trend), a
// confidence grade, and the vendor evidence. Everything traces to a source — the
// exact thing an exported spreadsheet severs. Deterministic (no model call), so
// it's auditable. The assessment math (revenue requirement / homes) rides along.
// The current-year forecast for the budget planner (Ed 2026-10-11): the working
// forecast's base-year projection (lib/forecast/working_forecast), account by account:
// a line recognized from a schedule (assessments, CLMA, prepaid insurance) = actual to
// date + the remaining scheduled recognition; a verified contract line = its contract;
// everything else = actual through the last closed month + the remaining approved
// budget. Never a straight-line annualization (12 / months elapsed overstated nothing
// and understated assessments: Canyon Gate showed $924,682.50 for $1,027,425.00).
// Each row also takes its ACCOUNT's fund, so a fund-specific view never mixes funds.
async function applyWorkingForecast(community_id, fy, acc, cutoff) {
  const ids = [...acc.keys()];
  if (ids.length) {
    const { data: coa, error } = await supabase.from('chart_of_accounts').select('id, fund_id, account_funds ( fund_code, fund_type )').in('id', ids);
    if (error) throw error;
    for (const c of coa || []) { const a = acc.get(c.id); if (a && c.account_funds) { a.fund_id = c.fund_id; a.fund_code = c.account_funds.fund_code; a.fund_type = c.account_funds.fund_type || null; } }
  }
  // No annualized fallback (Ed 2026-10-12): without a completed month, or if the working
  // forecast cannot be built, the forecast column is "not available" and says why.
  for (const a of acc.values()) a.forecast = null;
  if (!cutoff.as_of) return { basis: 'not_available', status: cutoff.status, note: cutoff.status === 'future' ? `${cutoff.base_year} has not started, so there is no ${cutoff.base_year} forecast yet.` : `No month of ${cutoff.base_year} is complete yet, so there is no ${cutoff.base_year} forecast yet.` };
  try {
    const D = require('../lib/forecast/working_forecast_data'); const W = require('../lib/forecast/working_forecast');
    const m = W.buildWorkingForecast(await D.loadWorkingForecastInput(supabase, { community_id, target_year: fy, as_of: cutoff.as_of }));
    const by = W.baseYearByAccount(m);
    // The ONE contract engine (Ed 2026-10-14): a line's contract amount is the working
    // forecast's (verified contract bound to the line, contractCostForYear), never a
    // vendor-name match. Kept per account for the proposed column.
    const LB = require('../lib/accounting/budget_line_basis');
    // The target year's amount and its basis per account come from the same model (one engine).
    for (const [aid, ls] of LB.forecastByAccount(m)) {
      const a = acc.get(aid); if (!a) continue;
      const c = ls.map(LB.contractFromForecastLine).filter(Boolean);
      if (c.length) a.wf_contract = c.length === 1 ? c[0] : { ...c[0], status: 'needs_review', note: `${c.length} contract lines in different funds; the contract amount is not applied.` };
      a.wf_final = ls.reduce((t, l) => t + Math.round(Number(l.final_cents) || 0), 0);
      a.wf_basis = LB.basisForSavedLine({ annual_amount_cents: a.wf_final }, ls, { base_year: m.base_year });
      a.wf_confidence = (([...ls].sort((x, y) => Math.abs(y.final_cents) - Math.abs(x.final_cents))[0] || {}).confidence || {}).final || null;
    }
    for (const a of acc.values()) {
      const f = by.get(a.account_id);
      if (!f) { a.forecast = a.ytd_actual || 0; a.forecast_detail = { method: 'actual_only', ytd_cents: a.ytd_actual || 0, remaining_cents: 0, explanation: `No ${cutoff.base_year} budget line: the forecast is the actual through ${cutoff.as_of}.`, data_flags: [] }; continue; }
      a.forecast = f.forecast_cents; a.forecast_ytd = f.ytd_cents;
      a.forecast_detail = { method: f.methods.join(' + '), actual_through: f.actual_through, ytd_cents: f.ytd_cents, remaining_cents: f.remaining_cents, remaining_period: f.remaining_period, explanation: f.explanations.join(' '), data_flags: f.data_flags, post_cutover: f.post_cutover, funds: f.funds };
    }
    return { basis: 'working_forecast', status: cutoff.status, as_of: cutoff.as_of, base_budget: m.base_budget || null,
      note: `${cutoff.base_year} Forecast = posted GL actual through ${cutoff.as_of} + each account's remaining ${cutoff.base_year} months by its method: the approved recognition schedule (assessments) or the remaining approved monthly budget. Interfund transfers count only when recorded. Never annualized.` };
  } catch (e) {
    console.warn('[books] living-lines working forecast failed:', e.message);
    return { basis: 'not_available', status: 'error', as_of: cutoff.as_of, note: `The ${cutoff.base_year} forecast could not be built (${e.message}). It is shown as not available rather than estimated.` };
  }
}

router.get('/budgets/living-lines', async (req, res) => {
  try {
    const { community_id, fiscal_year } = req.query;
    if (!community_id || !fiscal_year) return res.status(400).json({ error: 'community_id_and_fiscal_year_required' });
    const fy = parseInt(fiscal_year, 10);
    const { fetchAllQuery } = require('../lib/db/fetch_all');

    const isFor = (y) => incomeStatement({ community_id, period_start: `${y}-01-01`, period_end: `${y}-12-31` });
    const [is1, is2] = await Promise.all([isFor(fy - 1), isFor(fy - 2)]);
    const today = new Date(); const cy = today.getUTCFullYear(); const monthsElapsed = today.getUTCMonth() + 1;
    // ONE cutoff for "Actual YTD" and the forecast (Ed 2026-10-12): the last day of the base
    // year's last completed month. Actual YTD is posted GL activity of the BASE year (fy - 1)
    // through that date, from the statement engine, so actual + remaining = forecast.
    const W = require('../lib/forecast/working_forecast');
    const cutoff = W.baseYearCutoff({ now: today, target_year: fy });
    const ytdEnd = cutoff.as_of || (cutoff.status === 'no_completed_month' ? today.toISOString().slice(0, 10) : null);
    const isYtd = ytdEnd ? await incomeStatement({ community_id, period_start: `${fy - 1}-01-01`, period_end: ytdEnd }) : { sections: { revenue: [], expenses: [] }, totals: { ytd: { revenue_cents: 0, expenses_cents: 0 } } };

    // Base-year ADOPTED budget: the approved (or active) budget only, the same record the
    // working forecast and Budget vs Actual read. A draft is never shown as adopted.
    const priorBudget = {};
    const { data: pbs, error: pbErr } = await supabase.from('community_budgets').select('id, status, approved_at, updated_at').eq('community_id', community_id).eq('fiscal_year', fy - 1).in('status', ['approved', 'active']).order('approved_at', { ascending: false }).limit(5);
    if (pbErr) throw pbErr;
    const pb = (pbs || [])[0] || null;
    if (pb) { const { data: bl, error: blErr } = await supabase.from('budget_line_items').select('account_id, annual_amount_cents').eq('budget_id', pb.id).limit(5000); if (blErr) throw blErr; (bl || []).forEach((l) => { priorBudget[l.account_id] = (priorBudget[l.account_id] || 0) + (Number(l.annual_amount_cents) || 0); }); }
    // The SAVED budget for the year being planned: its amounts are the proposed column, exactly.
    const { data: svs, error: svErr } = await supabase.from('community_budgets').select('id, status, updated_at').eq('community_id', community_id).eq('fiscal_year', fy).order('updated_at', { ascending: false }).limit(5);
    if (svErr) throw svErr;
    const sv = (svs || [])[0] || null;
    let savedDraft = null;
    if (sv) {
      // With migration 521, each saved line also says WHY its amount is what it is.
      const LB = require('../lib/accounting/budget_line_basis');
      const sl = await LB.selectWithBasis((cols) => supabase.from('budget_line_items').select(cols).eq('budget_id', sv.id).limit(5000), 'account_id, annual_amount_cents');
      if (sl.error) throw sl.error;
      const lines = sl.data || [];
      // The source document behind a recorded basis (a contract, notice or quote): a short-lived link.
      const docIds = [...new Set(lines.map((l) => l.source_document_id).filter(Boolean))];
      const docUrl = {};
      if (docIds.length) {
        const { data: docs, error: dErr } = await supabase.from('library_documents').select('id, title, file_path').in('id', docIds);
        if (dErr) console.warn('[books] living-lines basis documents unavailable:', dErr.message);
        for (const d of docs || []) { let url = null; if (d.file_path) { try { const { data: s } = await supabase.storage.from('documents').createSignedUrl(d.file_path, 3600); url = (s && s.signedUrl) || null; } catch (_) { /* link optional */ } } docUrl[d.id] = { title: d.title || null, url }; }
      }
      for (const l of lines) if (l.source_document_id && docUrl[l.source_document_id]) l.source_document = docUrl[l.source_document_id];
      savedDraft = { id: sv.id, status: sv.status, updated_at: sv.updated_at, lines, basis_available: sl.basis_available };
    }

    const acc = new Map();
    const merge = (is, key, mult = 1) => {
      for (const type of ['revenue', 'expenses']) {
        for (const r of (is.sections?.[type] || [])) {
          let a = acc.get(r.account_id);
          if (!a) { a = { account_id: r.account_id, account_number: r.account_number, account_name: r.account_name, account_type: type === 'revenue' ? 'revenue' : 'expense', fund_id: r.fund_id || null, fund_code: r.fund_code || null, fy2: 0, fy1: 0, ytd_actual: 0, forecast: 0 }; acc.set(r.account_id, a); }
          // An account can carry activity in more than one fund: accumulate, never overwrite.
          if (key === 'ytd') a.ytd_actual += Math.round(ytdOf(r));
          else a[key] = (a[key] || 0) + Math.round(ytdOf(r));
        }
      }
    };
    merge(is2, 'fy2'); merge(is1, 'fy1'); merge(isYtd, 'ytd');
    for (const a of acc.values()) { if (yearNA(is2)) a.fy2 = null; if (yearNA(is1)) a.fy1 = null; }   // not available in trustEd: null, never $0
    // Include accounts that are BUDGETED but had no GL activity this year (e.g.
    // a reserve contribution transfer) — a budgeted line belongs in next year's
    // budget regardless of activity, and it would otherwise silently vanish.
    // ...and accounts in the SAVED draft for the planned year, so a saved amount is never dropped.
    const missingBudgeted = [...new Set([...Object.keys(priorBudget), ...((savedDraft && savedDraft.lines) || []).map((l) => l.account_id)])].filter((aid) => aid && !acc.has(aid));
    if (missingBudgeted.length) {
      const { data: metas, error: mErr } = await supabase.from('chart_of_accounts')
        .select('id, account_number, account_name, account_type, fund_id, account_funds ( fund_code, fund_type )')
        .in('id', missingBudgeted);
      if (mErr) throw mErr;
      for (const m of (metas || [])) {
        if (!['revenue', 'expense'].includes(m.account_type)) continue;
        acc.set(m.id, { account_id: m.id, account_number: m.account_number, account_name: m.account_name, account_type: m.account_type, fund_id: m.fund_id || null, fund_code: (m.account_funds && m.account_funds.fund_code) || null, fund_type: (m.account_funds && m.account_funds.fund_type) || null,
          // A prior year not available in trustEd (converted-community pre-history) is null, never $0,
          // exactly like the rows with activity above. A year that IS available and had no activity is a real 0.
          fy2: yearNA(is2) ? null : 0, fy1: yearNA(is1) ? null : 0, ytd_actual: 0, forecast: 0 });
      }
    }

    // After the budgeted-only accounts are in, so they get their fund and forecast too.
    const forecastBasis = await applyWorkingForecast(community_id, fy, acc, cutoff);

    // Vendor commitments per expense account (prior year) — the "built from" source.
    const vendorByAcct = {};
    try {
      const jel = await fetchAllQuery(() => supabase.from('journal_entry_lines')
        .select('account_id, vendor_id, debit_cents, credit_cents, journal_entries!inner ( community_id, posting_date, status )')
        .eq('journal_entries.community_id', community_id)
        .gte('journal_entries.posting_date', `${fy - 1}-01-01`).lte('journal_entries.posting_date', `${fy - 1}-12-31`)
        .not('vendor_id', 'is', null), { orderBy: 'id' });
      const agg = {};
      const mon = {};   // distinct months each vendor was paid on each account (recurring = a missing contract is worth flagging)
      for (const l of jel) { if (!l.vendor_id) continue; const net = Number(l.debit_cents || 0) - Number(l.credit_cents || 0); (agg[l.account_id] = agg[l.account_id] || {}); agg[l.account_id][l.vendor_id] = (agg[l.account_id][l.vendor_id] || 0) + net; const mk = `${l.account_id}|${l.vendor_id}`; (mon[mk] = mon[mk] || new Set()).add(String((l.journal_entries || {}).posting_date || '').slice(0, 7)); }
      const vids = [...new Set(Object.values(agg).flatMap((v) => Object.keys(v)))];
      const vmeta = {};
      for (let i = 0; i < vids.length; i += 300) { const { data } = await supabase.from('vendors').select('id, name').in('id', vids.slice(i, i + 300)); (data || []).forEach((v) => { vmeta[v.id] = v.name; }); }
      for (const [aid, vmap] of Object.entries(agg)) {
        const top = Object.entries(vmap).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([vid, c]) => ({ vendor_id: vid, name: vmeta[vid] || 'vendor', cents: Math.round(c), months: (mon[`${aid}|${vid}`] || new Set()).size }));
        if (top.length) vendorByAcct[aid] = top;
      }
    } catch (_) { /* optional */ }

    const usd0 = (c) => { const t = `$${Math.round(Math.abs(Number(c) || 0) / 100).toLocaleString('en-US')}`; return Number(c) < 0 ? `(${t})` : t; };   // whole dollars, negatives in parentheses
    // ONE ENGINE (Ed 2026-10-14): every line's suggested amount is the working forecast's final
    // amount for that account (lib/forecast/working_forecast.js, set by applyWorkingForecast):
    // contracts from their structured terms (verified or not; unverified ones are flagged), the
    // base year's actual + remaining approved budget, the recorded normalizations, the inflation
    // POLICY (an unconfirmed default is flagged) and any management override with its reason.
    // The planner adds no percentage of its own, matches no contract by vendor name, and never
    // silently substitutes an increase for a missing contract.
    const LB = require('../lib/accounting/budget_line_basis');
    const signedUrl = async (fp) => { if (!fp) return null; try { const { data: s } = await supabase.storage.from('documents').createSignedUrl(fp, 3600); return (s && s.signedUrl) || null; } catch (_) { return null; } };
    const contractByAccount = {};
    for (const a of acc.values()) if (a.wf_contract) contractByAccount[a.account_id] = { ...a.wf_contract, url: await signedUrl(a.wf_contract.file_path) };
    const SOURCE_OF = { contract: 'contract', assessment: 'assessment', transfer: 'transfer', board_project: 'capital_plan', discretionary: 'forecast', historical_forecast: 'forecast' };
    const rows = [...acc.values()].sort((a, b) => String(a.account_number).localeCompare(String(b.account_number))).map((a) => {
      const vendors = vendorByAcct[a.account_id] || [];
      let source_type; let confidence; let proposed_cents; let built_from; let evidence = []; let basis = null;
      const flags = [];
      const contract = contractByAccount[a.account_id] || null;
      const priorB = priorBudget[a.account_id] || 0;
      const isNonCash = /unrealized|realized gain|market value|investment gain|gain\s*\/\s*loss|gains?\s+(?:and|&|or)\s+loss|mark[- ]to[- ]market/i.test(a.account_name || '');
      const isReserveExpense = a.account_type === 'expense' && a.fund_type === 'reserve';
      if (isReserveExpense) {
        // Capital projects are nonrecurring (Ed 2026-10-11): a reserve expenditure is
        // budgeted only from an explicitly planned project (the Reserve Budget's project
        // list), never from prior-year spending, a run-rate or a forecast.
        source_type = 'capital_plan'; confidence = 'high'; proposed_cents = 0;
        built_from = `Reserve expenditures come only from planned capital projects. ${fy - 1} spending${a.forecast ? ` ($${(a.forecast / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} projected)` : ''} is history for reference and is not carried into ${fy}.`;
        basis = { amount_basis: 'board_project', amount_calc: 'Planned capital projects for this account (Reserve Budget).', needs_review: false, review_note: null };
      } else if (isNonCash) {
        // Non-cash market valuations (unrealized gains/losses) aren't budgeted:
        // they can't be assessed for or spent.
        source_type = 'excluded'; confidence = 'high'; proposed_cents = 0;
        built_from = 'Non-cash market valuation: not budgeted (it can\'t be assessed for or spent).';
      } else if (a.wf_final != null) {
        basis = a.wf_basis;
        proposed_cents = a.wf_final;
        source_type = SOURCE_OF[basis.amount_basis] || 'forecast';
        confidence = a.wf_confidence || 'unknown';
        built_from = LB.basisText(basis, { withReview: false }) || `${fy} working forecast`;
        if (contract && contract.url) evidence = [{ label: `${contract.vendor || 'Vendor'} contract${contract.unverified ? ' (not verified)' : ''}`, url: contract.url }];
        if (basis.needs_review) flags.push({ type: 'needs_review', severity: contract && contract.unverified ? 'high' : 'medium', msg: basis.review_note || 'Needs review.' });
      } else if (priorB !== 0) {
        // No forecast line (or no forecast yet): the adopted amount, unchanged and flagged. No percentage is assumed.
        source_type = 'prior_budget'; confidence = 'low'; proposed_cents = priorB;
        built_from = `FY${fy - 1} adopted budget ${usd0(priorB)}, carried unchanged: no ${fy} working-forecast line for this account. No percentage increase is assumed.`;
        basis = { amount_basis: 'historical_forecast', amount_calc: built_from, needs_review: true, review_note: forecastBasis.basis === 'working_forecast' ? 'Not in the working forecast.' : forecastBasis.note };
        flags.push({ type: 'needs_review', severity: 'medium', msg: `No working-forecast amount for this account; the ${fy - 1} adopted amount is carried unchanged. Confirm or enter the ${fy} amount.` });
      } else {
        source_type = 'estimate'; confidence = 'low'; proposed_cents = 0;
        built_from = 'No working-forecast line, prior budget or contract: enter a number.';
      }
      // A vendor paid on this line month after month with no contract bound: say so, never assume one.
      const recurring = vendors.filter((v) => v.months >= 3);
      if (a.account_type === 'expense' && !isReserveExpense && !contract && recurring.length) {
        flags.push({ type: 'contract_missing', severity: 'medium', msg: `No contract is bound to this line, but ${recurring.map((v) => `${v.name} (${usd0(v.cents)} over ${v.months} months)`).join(', ')} ${recurring.length === 1 ? 'was' : 'were'} paid here in ${fy - 1}. The amount is a forecast from history, not a contract. If there is a contract, attach and verify it on the working forecast and bind it to this line.` });
      }
      // A bound contract that does not price the line (two from one vendor, or no term covering the year): shown, never applied.
      if (contract && contract.status !== 'applied' && !isReserveExpense) {
        flags.push({ type: 'contract_unverified', severity: 'medium', msg: `${contract.note || `${contract.vendor || 'A contract'} is on file but does not price this line.`}${contract.contract_cost_cents != null ? ` It would be ${usd0(contract.contract_cost_cents)}.` : ''}` });
        if (contract.url) evidence = [...evidence, { label: `${contract.vendor || 'Vendor'} contract`, url: contract.url }];
      }

      return {
        account_id: a.account_id, account_number: a.account_number, account_name: a.account_name, account_type: a.account_type,
        fund_id: a.fund_id, fund_code: a.fund_code,
        prior_budget_cents: priorBudget[a.account_id] || 0,
        forecast_cents: a.forecast, forecast_detail: a.forecast_detail || null, fund_type: a.fund_type || null, actual_ytd_cents: a.ytd_actual, forecast_ytd_cents: a.forecast_ytd ?? null, fy1_actual_cents: a.fy1, fy2_actual_cents: a.fy2,
        proposed_cents, source_type, confidence, built_from, vendors, evidence, flags, suggested_basis: basis,
        contract: contract ? { status: contract.status, unverified: !!contract.unverified, vendor: contract.vendor, vendor_contract_id: contract.vendor_contract_id, source_document_id: contract.source_document_id, proposed_cents: contract.proposed_cents, contract_cost_cents: contract.contract_cost_cents } : null,
      };
    });

    // Configured interfund transfers (e.g. the Reserve contribution): the editor shows them as
    // a transfer out of the paying fund and into the receiving fund, never as revenue.
    try {
      const { transferConfig } = require('../lib/forecast/working_forecast_data');
      const [{ data: tf, error: tfErr }, { data: fl, error: flErr }] = await Promise.all([
        supabase.from('chart_of_accounts').select('id, fund_id, account_subtype, interfund_from_fund_id, interfund_to_fund_id').in('id', rows.map((r) => r.account_id)),
        supabase.from('account_funds').select('id, fund_code, fund_type').eq('community_id', community_id).limit(50),
      ]);
      if (tfErr || flErr) throw (tfErr || flErr);
      const byId = new Map((tf || []).map((a) => [a.id, a]));
      for (const r of rows) { const cfg = transferConfig(byId.get(r.account_id), fl || []); if (cfg.transfer) r.transfer = { from_fund_code: cfg.transfer.from_fund_code, from_fund_type: cfg.transfer.from_fund_type, to_fund_code: cfg.transfer.to_fund_code, to_fund_type: cfg.transfer.to_fund_type }; }
    } catch (e) { console.warn('[books] living-lines transfer config unavailable:', e.message); }

    const { count: homeCount } = await supabase.from('properties').select('id', { count: 'exact', head: true }).eq('community_id', community_id);
    // Proposed = the saved amounts, exactly, when a budget is saved for the year (server-side,
    // so the screen, the PDF and the tests read one rule). The suggestion rides along.
    const { applySavedDraft } = require('../lib/accounting/budget_merge');
    const shown = applySavedDraft(rows, savedDraft);
    // Actual YTD ties to the authoritative GL (the statement engine's income statement through
    // the same cutoff) and to the forecast engine's own actuals, account by account.
    const reconciliation = W.reconcileBaseYear(shown, isYtd.totals && isYtd.totals.ytd, { as_of: ytdEnd });
    const sum = (arr, k) => arr.reduce((s, r) => s + (r[k] || 0), 0);
    const rev = shown.filter((r) => r.account_type === 'revenue'); const exp = shown.filter((r) => r.account_type === 'expense');
    res.json({
      community_id, fiscal_year: fy, base_year: fy - 1, forecast_year: fy - 1, months_elapsed: monthsElapsed, cutoff, forecast_basis: forecastBasis, home_count: homeCount || 0, rows: shown,
      adopted_budget: pb ? { id: pb.id, fiscal_year: fy - 1, status: pb.status, approved_at: pb.approved_at || null } : null,
      saved_budget: savedDraft ? { id: savedDraft.id, fiscal_year: fy, status: savedDraft.status, updated_at: savedDraft.updated_at, lines: savedDraft.lines.length, basis_available: savedDraft.basis_available, basis_recorded: savedDraft.lines.filter((l) => l.amount_basis).length, needs_review: savedDraft.lines.filter((l) => l.needs_review).length } : null,
      reconciliation,
      totals: {
        revenue_proposed_cents: sum(rev, 'proposed_cents'), expense_proposed_cents: sum(exp, 'proposed_cents'),
        revenue_forecast_cents: sum(rev, 'forecast_cents'), expense_forecast_cents: sum(exp, 'forecast_cents'),
        net_proposed_cents: sum(rev, 'proposed_cents') - sum(exp, 'proposed_cents'),
      },
    });
  } catch (err) {
    console.error('[books] living-lines failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// Undeposited Funds workflow (Ed 2026-06-30)
// A received check posts Dr Undeposited Funds / Cr AR. It's NOT in the bank yet,
// so it's not a bank-rec item. This lists what's sitting in Undeposited Funds
// and lets staff "Mark deposited" — which posts Dr Cash / Cr Undeposited Funds
// once the deposit actually hits the bank. Accounts resolved by role (name),
// so it works across every community's chart numbering.
// ----------------------------------------------------------------------------
async function _undepositedAccount(community_id) {
  const { data } = await supabase.from('chart_of_accounts')
    .select('id, account_number, account_name, fund_id')
    .eq('community_id', community_id).eq('is_active', true).ilike('account_name', '%undeposited%').limit(1).maybeSingle();
  return data || null;
}

// GET /api/books/undeposited?community_id=  — receipts held in Undeposited Funds
router.get('/undeposited', async (req, res) => {
  try {
    const { community_id } = req.query;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    const undep = await _undepositedAccount(community_id);
    if (!undep) return res.json({ ok: true, undeposited_account: null, receipts: [], balance_cents: 0 });

    // All posted lines touching the undeposited account.
    const { data: lines } = await supabase.from('journal_entry_lines')
      .select('debit_cents, credit_cents, journal_entries!inner(id, reference, posting_date, description, status, source_module, source_reference, void_reversal_je_id)')
      .eq('account_id', undep.id).in('journal_entries.status', COUNTED_JE_STATUSES).limit(5000);
    const rows = (lines || []).filter((r) => countsInGl(r.journal_entries));
    const balance = rows.reduce((s, r) => s + (r.debit_cents || 0) - (r.credit_cents || 0), 0);

    // Receipts = debit entries (money into undeposited). A receipt is "deposited"
    // once a deposit entry (credit) references its JE reference.
    const depositedRefs = new Set(
      rows.filter((r) => (r.credit_cents || 0) > 0 && r.journal_entries.source_reference)
          .map((r) => r.journal_entries.source_reference)
    );
    const receipts = rows
      .filter((r) => (r.debit_cents || 0) > 0)
      .map((r) => ({
        je_id: r.journal_entries.id,
        reference: r.journal_entries.reference,
        date: r.journal_entries.posting_date,
        description: r.journal_entries.description,
        amount_cents: r.debit_cents,
        deposited: depositedRefs.has(r.journal_entries.reference),
      }))
      .filter((r) => !r.deposited);

    // Cash accounts staff can deposit into (asset accounts that aren't the undeposited holding one).
    const { data: cashAccts } = await supabase.from('chart_of_accounts')
      .select('id, account_number, account_name').eq('community_id', community_id).eq('is_active', true)
      .eq('account_type', 'asset').ilike('account_name', '%cash%').order('account_number');

    res.json({ ok: true, undeposited_account: undep, balance_cents: balance, receipts, cash_accounts: cashAccts || [] });
  } catch (err) {
    console.error('[books] undeposited list failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /api/books/undeposited/deposit  { community_id, receipt_je_id, cash_account_id, deposit_date }
// Posts Dr Cash / Cr Undeposited Funds for the receipt — the "it hit the bank" step.
router.post('/undeposited/deposit', express.json(), async (req, res) => {
  try {
    const { community_id, receipt_je_id, cash_account_id, deposit_date } = req.body || {};
    if (!community_id || !receipt_je_id || !cash_account_id) return res.status(400).json({ error: 'community_id_receipt_je_id_cash_account_id_required' });
    const undep = await _undepositedAccount(community_id);
    if (!undep) return res.status(400).json({ error: 'no_undeposited_funds_account' });

    // the receipt's undeposited debit amount
    const { data: recLines } = await supabase.from('journal_entry_lines')
      .select('debit_cents, journal_entries!inner(reference, community_id)')
      .eq('journal_entry_id', receipt_je_id).eq('account_id', undep.id);
    const rec = (recLines || [])[0];
    if (!rec || (rec.debit_cents || 0) <= 0) return res.status(400).json({ error: 'receipt_not_found_in_undeposited' });
    if (rec.journal_entries.community_id !== community_id) return res.status(400).json({ error: 'wrong_community' });
    const amount = rec.debit_cents;

    // guard: already deposited?
    const { data: existing } = await supabase.from('journal_entries')
      .select('id').eq('community_id', community_id).eq('source_reference', rec.journal_entries.reference).eq('source_module', 'bank_reconciliation').limit(1).maybeSingle();
    if (existing) return res.status(400).json({ error: 'already_deposited' });

    const { postJournalEntry } = require('../lib/accounting/posting');
    const je = await postJournalEntry({
      community_id, posting_date: deposit_date || new Date().toISOString().slice(0, 10),
      description: `Deposit of ${rec.journal_entries.reference} — undeposited funds to cash`,
      source_module: 'bank_reconciliation', source_reference: rec.journal_entries.reference,
      lines: [
        { account_id: cash_account_id, debit_cents: amount, credit_cents: 0, memo: 'deposit received in bank' },
        { account_id: undep.id, debit_cents: 0, credit_cents: amount, memo: `clears ${rec.journal_entries.reference}` },
      ],
    });
    res.json({ ok: true, deposit_reference: je.entry.reference, amount_cents: amount });
  } catch (err) {
    console.error('[books] deposit failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router, computeReserveSummary };
