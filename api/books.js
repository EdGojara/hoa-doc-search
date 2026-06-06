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
const { createClient } = require('@supabase/supabase-js');
const { postJournalEntry, voidJournalEntry } = require('../lib/accounting/posting');
const { onboardCommunityToGL, openInitialPeriods } = require('../lib/accounting/coa_template');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
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

module.exports = { router };
