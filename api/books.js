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
const { postJournalEntry, voidJournalEntry, editJournalEntry } = require('../lib/accounting/posting');
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
// RESERVES — accounting view over the existing reserve engine + the GL
//   current reserve balance  = the reserve-fund cash account balance (GL)
//   expected reserve expenses = the active study's funding plan for the year
//   components due this year  = reserve_components scheduled for replacement
// Reads the canonical reserve tables; no parallel data. Graceful when a
// community has no study loaded yet (everything study-driven returns null).
// ============================================================================
router.get('/reserve-summary', async (req, res) => {
  try {
    const { community_id } = req.query;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    const year = Number(req.query.year) || new Date().getUTCFullYear();
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

    res.json({
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
    });
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
          .select('account_id, debit_cents, credit_cents, journal_entries!inner(posting_date, status)')
          .in('account_id', ids)
          .eq('journal_entries.status', 'posted')
          .gte('journal_entries.posting_date', start)
          .lte('journal_entries.posting_date', end)
          .order('id', { ascending: true })
          .range(f, f + 999);
        if (error) throw error;
        (jl || []).forEach((row) => {
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

    const priorTotal = Math.abs((is.totals?.ytd?.revenue_cents || 0)) + Math.abs((is.totals?.ytd?.expenses_cents || 0));
    if (basis === 'ytd_annualized' || priorTotal === 0) {
      // Annualize the current calendar year's YTD (months elapsed → 12).
      const today = new Date();
      const cy = today.getUTCFullYear();
      const monthsElapsed = today.getUTCMonth() + 1; // 1..12
      is = await incomeStatement({ community_id, period_start: `${cy}-01-01`, period_end: today.toISOString().slice(0, 10) });
      annualize = monthsElapsed > 0 ? 12 / monthsElapsed : 1;
      basis = 'ytd_annualized';
      sourceLabel = `${cy} YTD annualized (${monthsElapsed} mo → 12)`;
    }

    const rows = [];
    const push = (r, type) => {
      const prior = Math.round((r.ytd_amount_cents || 0) * annualize);
      const suggested = Math.round(prior * (1 + bumpPct / 100));
      rows.push({
        account_id: r.account_id, account_number: r.account_number, account_name: r.account_name,
        account_type: type, fund_id: r.fund_id || null, fund_code: r.fund_code || null,
        prior_actual_cents: prior, suggested_annual_cents: suggested,
      });
    };
    (is.sections?.revenue || []).forEach((r) => push(r, 'revenue'));
    (is.sections?.expenses || []).forEach((r) => push(r, 'expense'));
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
      .select('debit_cents, credit_cents, journal_entries!inner(id, reference, posting_date, description, status, source_module, source_reference)')
      .eq('account_id', undep.id).eq('journal_entries.status', 'posted').limit(5000);
    const rows = lines || [];
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

module.exports = { router };
