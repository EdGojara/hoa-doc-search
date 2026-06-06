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

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { postJournalEntry, voidJournalEntry } = require('../lib/accounting/posting');
const { onboardCommunityToGL, openInitialPeriods } = require('../lib/accounting/coa_template');
const { balanceSheet, incomeStatement, equityStatement, budgetVsActual } = require('../lib/accounting/financial_statements');
const { extractBudget } = require('../lib/accounting/budget_pdf_extractor');
const { safeErrorMessage } = require('./_safe_error');

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

router.post('/periods/:id/close', express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const { user_id } = req.body || {};
    const { data, error } = await supabase
      .from('accounting_periods').update({
        status: 'closed',
        closed_at: new Date().toISOString(),
        closed_by_user_id: user_id || null,
      }).eq('id', id).select('*').single();
    if (error) throw error;
    res.json({ period: data });
  } catch (err) {
    console.error('[books] close period failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/periods/:id/reopen', express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const { user_id, reason } = req.body || {};
    if (!reason) return res.status(400).json({ error: 'reason_required_for_audit' });
    const { data, error } = await supabase
      .from('accounting_periods').update({
        status: 'reopened',
        reopened_at: new Date().toISOString(),
        reopened_by_user_id: user_id || null,
        reopened_reason: reason,
      }).eq('id', id).select('*').single();
    if (error) throw error;
    res.json({ period: data });
  } catch (err) {
    console.error('[books] reopen period failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// Journal entries
// ---------------------------------------------------------------------------
router.post('/journal-entries', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const result = await postJournalEntry(req.body || {});
    res.json(result);
  } catch (err) {
    if (err.code === 'unbalanced' || err.code === 'invalid_input' || err.code === 'period_closed') {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    console.error('[books] post JE failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
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

router.post('/journal-entries/:id/void', express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const { void_reason, reversal_date, posted_by_user_id } = req.body || {};
    const result = await voidJournalEntry({
      journal_entry_id: id, void_reason, reversal_date, posted_by_user_id,
    });
    res.json(result);
  } catch (err) {
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
    const result = await budgetVsActual({ community_id, period_end, fund_id });
    res.json(result);
  } catch (err) {
    if (err.code === 'invalid_input') return res.status(400).json({ error: err.message });
    console.error('[books] budget-vs-actual failed:', err);
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

router.get('/budgets/:id', async (req, res) => {
  try {
    const { id } = req.params;
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

// Upload a budget PDF — Claude binary extract, return preview (not yet saved)
router.post('/budgets/preview-pdf', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file_required' });
    const extracted = await extractBudget(req.file.buffer, req.file.mimetype, req.file.originalname);
    res.json({
      extraction: extracted,
      filename: req.file.originalname,
      sha256: crypto.createHash('sha256').update(req.file.buffer).digest('hex'),
      file_size_bytes: req.file.size,
    });
  } catch (err) {
    console.error('[books] budget pdf extract failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Commit an extracted budget — operator confirms mapping after preview.
// Body: { community_id, fiscal_year, status, source_filename, line_items: [{account_id, annual_amount_cents, monthly_amounts_cents}], notes }
router.post('/budgets', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const { community_id, fiscal_year, status = 'draft', source_filename, line_items, notes, approved_by_user_id } = req.body || {};
    if (!community_id || !fiscal_year) return res.status(400).json({ error: 'community_id_and_fiscal_year_required' });
    if (!Array.isArray(line_items) || line_items.length === 0) return res.status(400).json({ error: 'line_items_required' });

    // Upsert the budget header
    const { data: existing } = await supabase
      .from('community_budgets')
      .select('id').eq('community_id', community_id).eq('fiscal_year', fiscal_year).maybeSingle();

    let budgetId;
    if (existing) {
      const { error } = await supabase.from('community_budgets').update({
        status,
        source_filename: source_filename || null,
        notes: notes || null,
        approved_at: status === 'approved' ? new Date().toISOString() : null,
        approved_by_user_id: approved_by_user_id || null,
      }).eq('id', existing.id);
      if (error) throw error;
      budgetId = existing.id;
      // Wipe existing lines for clean upsert
      await supabase.from('budget_line_items').delete().eq('budget_id', budgetId);
    } else {
      const { data: ins, error } = await supabase.from('community_budgets').insert({
        community_id, fiscal_year, status,
        source_filename: source_filename || null,
        notes: notes || null,
        approved_at: status === 'approved' ? new Date().toISOString() : null,
        approved_by_user_id: approved_by_user_id || null,
      }).select('id').single();
      if (error) throw error;
      budgetId = ins.id;
    }

    // Insert line items
    const rows = line_items.map((li) => {
      let monthly = Array.isArray(li.monthly_amounts_cents) ? li.monthly_amounts_cents.map((n) => Number(n) || 0) : [];
      if (monthly.length !== 12) {
        const annual = Number(li.annual_amount_cents) || 0;
        const each = Math.floor(annual / 12);
        monthly = Array(12).fill(each);
        monthly[11] += annual - each * 12;
      }
      return {
        budget_id: budgetId,
        account_id: li.account_id,
        fund_id: li.fund_id || null,
        annual_amount_cents: Number(li.annual_amount_cents) || 0,
        monthly_amounts_cents: monthly,
        notes: li.notes || null,
      };
    });
    if (rows.length > 0) {
      const { error: lnErr } = await supabase.from('budget_line_items').insert(rows);
      if (lnErr) throw lnErr;
    }

    const { data: budget } = await supabase.from('community_budgets').select('*').eq('id', budgetId).maybeSingle();
    res.json({ budget, line_items_count: rows.length });
  } catch (err) {
    console.error('[books] save budget failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
