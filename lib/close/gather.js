// ============================================================================
// lib/close/gather.js  (Ed 2026-10-09: month-end close, PR A)
// ----------------------------------------------------------------------------
// Reads, from the books, everything the checklist (lib/close/controls.js)
// evaluates. Read-only. Reuses the platform's existing single sources rather
// than re-deriving them:
//   ledger integrity + fingerprint  close_ledger_facts()  (migration 502, SQL)
//   AR tie to 1300 / 2400           computeArAging        (api/gl.js, PR #98)
//   open AP as of a date            loadOpenApAsOf        (lib/accounting/ap_as_of.js)
//   recognition due vs posted       recognitionStatus     (lib/accounting/recognition_schedule.js)
//   onboarding gate                 canProduceBoardFinancials (lib/community/lifecycle.js)
//   counted-entry rule              trial_balance_detail.counted (je_status.js)
// Every query destructures `error` and throws: a failed read must never look
// like "nothing found" (CLAUDE.md).
// ============================================================================
const { fetchAll, fetchAllQuery } = require('../db/fetch_all');

const must = (r, what) => { if (r.error) { const e = new Error(`${what}: ${r.error.message}`); e.code = r.error.code; throw e; } return r.data; };
const monthStart = (iso) => `${String(iso).slice(0, 7)}-01`;
const addMonths = (iso, n) => { const d = new Date(`${monthStart(iso)}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
const lastDay = (iso) => { const d = new Date(`${monthStart(iso)}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d.toISOString().slice(0, 10); };

// GL balance (debit-positive) of every account with this number, counted entries
// dated on/before asOf. null when the community has no such account.
async function glBalanceAsOf(supabase, cid, accountNumber, asOf) {
  const tbd = require('../accounting/trial_balance_detail');
  const accts = must(await supabase.from('chart_of_accounts').select('id').eq('community_id', cid).eq('account_number', accountNumber), 'chart_of_accounts');
  if (!accts.length) return null;
  let bal = 0;
  for (const a of accts) {
    for (const l of await tbd.loadAccountLines(supabase, cid, a.id)) {
      const x = tbd.flatten(l);
      if (!tbd.counted(x) || String(x.posting_date || '').slice(0, 10) > asOf) continue;
      bal += Number(x.debit_cents || 0) - Number(x.credit_cents || 0);
    }
  }
  return bal;
}

// Counted lines of the community dated in [from, to] for the given account ids.
async function linesInRange(supabase, cid, accountIds, from, to) {
  const tbd = require('../accounting/trial_balance_detail');
  const out = [];
  for (let i = 0; i < accountIds.length; i += 100) {
    const chunk = accountIds.slice(i, i + 100);
    out.push(...await fetchAllQuery(() => supabase.from('journal_entry_lines')
      .select('id, account_id, debit_cents, credit_cents, journal_entries!inner(community_id, posting_date, status, void_reversal_je_id, source_module)')
      .in('account_id', chunk).eq('journal_entries.community_id', cid)
      .gte('journal_entries.posting_date', from).lte('journal_entries.posting_date', to)));
  }
  return out.filter((l) => tbd.counted(tbd.flatten(l)));
}

async function gatherBank(supabase, cid, per) {
  const accounts = await fetchAll(supabase, 'bank_accounts', { select: 'id, account_nickname, bank_name, account_last4, account_type, gl_account_number, is_active', filters: { community_id: cid } });
  const statements = await fetchAllQuery(() => supabase.from('bank_statement_imports')
    .select('id, bank_account_id, statement_period_start, statement_period_end, status').eq('community_id', cid)
    .gte('statement_period_end', per.period_start).lte('statement_period_end', per.period_end));
  const recs = await fetchAllQuery(() => supabase.from('bank_reconciliations')
    .select('id, bank_account_id, period_start, period_end, status, difference_cents, gl_ending_balance_cents, bank_ending_balance_cents, outstanding_checks_total_cents, deposits_in_transit_total_cents, updated_at')
    .eq('community_id', cid).gte('period_end', per.period_start).lte('period_end', per.period_end));
  const recIds = recs.map((r) => r.id);
  const recItems = [];
  for (let i = 0; i < recIds.length; i += 100) {
    recItems.push(...await fetchAllQuery(() => supabase.from('bank_reconciliation_items')
      .select('id, reconciliation_id, category, amount_cents, date_ref, description, check_number').in('reconciliation_id', recIds.slice(i, i + 100))));
  }
  const glBalances = {};
  for (const n of [...new Set(accounts.filter((a) => a.is_active !== false && a.gl_account_number).map((a) => a.gl_account_number))]) {
    glBalances[n] = await glBalanceAsOf(supabase, cid, n, per.period_end);
  }
  return { accounts, statements, recs, rec_items: recItems, gl_balances: glBalances };
}

async function gatherAr(supabase, cid, per) {
  try {
    const gl = require('../../api/gl');
    const a = await gl.computeArAging(cid, per.period_end);
    // Former owners' credits sit in 2400, or in 2410 Refunds Payable where the
    // conversion routed them (lib/onboarding/snapshot.js), so owner credit detail
    // ties to 2400 + 2410 together (Canyon Gate 9/30: 7,432.61 + 4,707.28 =
    // 9,189.05 + 2,950.84). The per-account split is PR A2.
    const former = a.former_owner_ledger || [];
    const g2410 = await glBalanceAsOf(supabase, cid, '2410', per.period_end);
    return { as_of: a.as_of, reconciliation: a.reconciliation, aging_total_cents: a.summary && a.summary.total_cents, ar_source: a.ar_source,
      former_credit_cents: former.filter((r) => Number(r.balance_cents) < 0).reduce((x, r) => x - Number(r.balance_cents), 0),
      former_credit_count: former.filter((r) => Number(r.balance_cents) < 0).length,
      gl_2410_cents: g2410 == null ? null : -g2410 };
  } catch (e) {
    return { error: e.message };
  }
}

async function gatherAp(supabase, cid, per) {
  const { loadOpenApAsOf } = require('../accounting/ap_as_of');
  const openRows = await loadOpenApAsOf(supabase, cid, per.period_end);
  let apNo = null; let glAp = null;
  for (const n of ['20100', '2000']) {
    const b = await glBalanceAsOf(supabase, cid, n, per.period_end);
    if (b != null) { apNo = n; glAp = -b; break; }
  }
  const held = must(await supabase.from('ap_invoices')
    .select('id, vendor_invoice_number, invoice_date, total_cents, status, needs_review, vendors:vendor_id(name)')
    .eq('community_id', cid).lte('invoice_date', per.period_end)
    .or('status.in.(on_hold,disputed),and(needs_review.eq.true,status.not.in.(voided,paid))').order('invoice_date').limit(500), 'ap_invoices held');
  return { open_rows: openRows, gl_ap_cents: glAp, ap_account_number: apNo,
    held: held.map((h) => ({ ...h, vendor: h.vendors && h.vendors.name, status: h.needs_review && !['on_hold', 'disputed'].includes(h.status) ? 'needs_review' : h.status })) };
}

async function gatherRecognition(supabase, cid, per) {
  const { recognitionStatus } = require('../accounting/recognition_schedule');
  const { isPrepaidAccount } = require('../accounting/prepaid_amortization');
  const schedules = await fetchAll(supabase, 'recognition_schedules', { select: 'id, description, schedule_type, balance_account_number, recognize_amount_cents, status', filters: { community_id: cid } });
  const active = schedules.filter((s) => s.status === 'active');
  const out = [];
  for (const s of active) {
    const periods = await fetchAll(supabase, 'recognition_schedule_periods', { select: 'period_month, scheduled_cents', filters: { schedule_id: s.id } });
    const postings = await fetchAll(supabase, 'recognition_postings', { select: 'period_month, amount_cents, kind, reversed_by_posting_id', filters: { schedule_id: s.id } });
    const status = recognitionStatus({ total_cents: s.recognize_amount_cents, periods,
      postings: postings.map((p) => ({ ...p, reversed: !!p.reversed_by_posting_id })), as_of_month: monthStart(per.period_end) });
    out.push({ ...s, status });
  }
  // Balance accounts that need a schedule: those any schedule draws down, prepaid
  // assets, and deferred/unearned liabilities. Owner credits (2400) and refunds
  // payable (2410) are homeowner subledgers, tied in AR, not schedules.
  const coa = await fetchAll(supabase, 'chart_of_accounts', { select: 'id, account_number, account_name, account_type, is_active', filters: { community_id: cid } });
  const scheduled = new Set(schedules.map((s) => s.balance_account_number));
  const candidates = coa.filter((a) => a.is_active !== false && !['2400', '2410'].includes(a.account_number)
    && (scheduled.has(a.account_number) || isPrepaidAccount(a) || (a.account_type === 'liability' && /deferred|unearned/i.test(a.account_name || ''))));
  const nums = [...new Set(candidates.map((a) => a.account_number))];
  const balanceAccounts = [];
  for (const n of nums) {
    const a = candidates.find((x) => x.account_number === n);
    const raw = await glBalanceAsOf(supabase, cid, n, per.period_end);
    balanceAccounts.push({ account_number: n, account_name: a.account_name, gl_balance_cents: raw == null ? 0 : (a.account_type === 'asset' ? raw : -raw),
      has_schedule: active.some((s) => s.balance_account_number === n) });
  }
  return { schedules: out, balance_accounts: balanceAccounts };
}

async function gatherConversion(supabase, cid) {
  const { canProduceBoardFinancials } = require('../community/lifecycle');
  const gate = await canProduceBoardFinancials(cid);
  const r = await supabase.from('conversion_reconciling_items').select('id, kind, account_number, amount_cents, item_key').eq('community_id', cid).eq('status', 'open').order('id').limit(500);
  let items = [];
  if (r.error) { if (!/does not exist|schema cache/i.test(r.error.message)) throw new Error(`conversion_reconciling_items: ${r.error.message}`); }
  else items = r.data || [];
  return { gate, open_items: items };
}

async function gatherSources(supabase, cid, per, requirements) {
  // Homeowner feed.
  const ht = await supabase.from('homeowner_transactions').select('id', { count: 'exact', head: true }).eq('community_id', cid);
  if (ht.error) throw new Error(`homeowner_transactions: ${ht.error.message}`);
  const batches = await fetchAll(supabase, 'transaction_upload_batches', { select: 'id, period_label, as_of_date, source_format, status, max_transaction_date', filters: { community_id: cid } });
  const hoReq = requirements.find((r) => r.source_key === 'homeowner_feed' && r.required !== false);
  const mode = hoReq && hoReq.config && hoReq.config.mode === 'native' ? 'native' : 'import';
  let assessmentRevenue = 0; let receipts = 0;
  if (mode === 'native') {
    const coa = await fetchAll(supabase, 'chart_of_accounts', { select: 'id, account_name, account_type', filters: { community_id: cid } });
    const rev = coa.filter((a) => a.account_type === 'revenue' && /assessment/i.test(a.account_name || '')).map((a) => a.id);
    // The month's own activity only: never the conversion opening YTD carryforward (lib/accounting/statement_periods.js).
    const { isOpeningLine } = require('../accounting/statement_periods');
    for (const l of await linesInRange(supabase, cid, rev, per.period_start, per.period_end)) { if (isOpeningLine(l)) continue; assessmentRevenue += Number(l.credit_cents || 0) - Number(l.debit_cents || 0); }
    const r = await supabase.from('journal_entries').select('id', { count: 'exact', head: true }).eq('community_id', cid).eq('source_module', 'payment_intake')
      .eq('status', 'posted').gte('posting_date', per.period_start).lte('posting_date', per.period_end);
    if (r.error) throw new Error(`journal_entries receipts: ${r.error.message}`);
    receipts = r.count || 0;
  }
  // AP feed: bills received but not booked.
  const ex = await fetchAllQuery(() => supabase.from('ap_intake_exceptions')
    .select('id, vendor_name, invoice_number, invoice_date, total_cents, reason, status').eq('community_id', cid).eq('status', 'pending'));
  const apExceptions = ex.filter((x) => !x.invoice_date || String(x.invoice_date) <= per.period_end);
  // Recurring vendors: invoiced in each of the three prior months, none dated in this month.
  const from = addMonths(per.period_start, -3);
  const inv = await fetchAllQuery(() => supabase.from('ap_invoices').select('id, vendor_id, invoice_date, status, vendors:vendor_id(name)')
    .eq('community_id', cid).gte('invoice_date', from).lte('invoice_date', per.period_end));
  const byVendor = {};
  for (const i of inv.filter((x) => x.status !== 'voided')) {
    const v = (byVendor[i.vendor_id] = byVendor[i.vendor_id] || { vendor_id: i.vendor_id, vendor: i.vendors && i.vendors.name, months: new Set() });
    v.months.add(String(i.invoice_date).slice(0, 7));
  }
  const prior = [1, 2, 3].map((k) => addMonths(per.period_start, -k).slice(0, 7));
  const thisM = String(per.period_start).slice(0, 7);
  const recurringGaps = Object.values(byVendor).filter((v) => prior.every((m) => v.months.has(m)) && !v.months.has(thisM))
    .map((v) => ({ vendor_id: v.vendor_id, vendor: v.vendor || 'vendor' })).sort((a, b) => a.vendor.localeCompare(b.vendor));
  const otherEvidence = await fetchAll(supabase, 'period_close_evidence', { select: 'id, requirement_id, document_ref, provided_by, provided_at', filters: { period_id: per.id } });
  return {
    requirements,
    homeowner: { applies: (ht.count || 0) > 0, batches, mode, assessment_revenue_cents: assessmentRevenue, receipt_entries: receipts },
    ap_exceptions: apExceptions, recurring_gaps: recurringGaps, other_evidence: otherEvidence,
  };
}

/** Everything the checklist needs for one community and month. */
async function gatherCloseInput(supabase, cid, periodId) {
  const community = must(await supabase.from('communities').select('id, name, gl_cutover_date, books_of_record, is_demo').eq('id', cid).single(), 'communities');
  const per = must(await supabase.from('accounting_periods').select('id, community_id, fiscal_year, period_number, period_type, period_start, period_end, status').eq('id', periodId).eq('community_id', cid).single(), 'accounting_periods');
  if (per.period_type && per.period_type !== 'monthly') throw Object.assign(new Error('month-end close runs on monthly periods only'), { code: 'not_monthly' });
  const facts = must(await supabase.rpc('close_ledger_facts', { p_community: cid, p_period: periodId }), 'close_ledger_facts');
  const requirements = await fetchAll(supabase, 'close_source_requirements', { select: 'id, source_key, label, required, config, set_reason', filters: { community_id: cid } });
  const [bank, ar, ap, recognition, conversion, sources] = await Promise.all([
    gatherBank(supabase, cid, per), gatherAr(supabase, cid, per), gatherAp(supabase, cid, per),
    gatherRecognition(supabase, cid, per), gatherConversion(supabase, cid), gatherSources(supabase, cid, per, requirements),
  ]);
  return { community, period: per, facts, bank, ar, ap, recognition, conversion, sources };
}

module.exports = { gatherCloseInput, glBalanceAsOf, lastDay, monthStart, addMonths,
  _parts: { gatherBank, gatherAr, gatherAp, gatherRecognition, gatherConversion, gatherSources } };
