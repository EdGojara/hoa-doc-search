// ============================================================================
// lib/accounting/trial_balance_detail.js  (Ed 2026-09-28)
// ----------------------------------------------------------------------------
// Trial Balance drill-down: the exact posted journal-entry lines behind one
// Trial Balance row (account x fund), with opening balance, period debits and
// credits, a running balance, and a reconciliation to the row.
//
// ONE SOURCE OF TRUTH for "which lines count": it mirrors v_trial_balance
// (migration 453) exactly:
//   * a line counts when its entry is POSTED, or VOIDED with a reversal entry
//     (void_reversal_je_id set): the reversal is itself posted and nets it, so
//     both sides must be shown for the row to tie;
//   * a line belongs to the row's fund by COALESCE(line.fund_id, account.fund_id);
//   * the chart row must be active (the view filters coa.is_active).
// scopedTrialBalance() builds rows with the SAME code the detail uses, so a
// scoped TB and its drill-down can't disagree; with no dates it reproduces the
// view (proven against the real view in tests/sql/tb_drilldown_rehearsal.mjs).
//
// PERIOD SCOPE (optional start/end, YYYY-MM-DD):
//   balance-sheet accounts (asset, liability, equity): carry forward. Opening =
//     every counted line dated before `start`; period = start..end.
//   income/expense accounts (revenue, expense): the report period only. Opening
//     is 0; lines before `start` are out of scope.
//   No start: opening is 0 and the period is all history through `end`.
//   No end: through the latest posting.
// Signs: raw amounts are debit-positive (debits - credits). Each result also
// carries a "natural" figure in the account's normal-balance sign, labeled.
// ============================================================================
const BALANCE_SHEET = new Set(['asset', 'liability', 'equity']);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const num = (v) => Number(v || 0);

const counted = (je) => !!je && (je.status === 'posted' || (je.status === 'voided' && !!je.void_reversal_je_id));
const effectiveFund = (line, account) => line.fund_id || account.fund_id || null;
const lineOrder = (a, b) =>
  String(a.posting_date).localeCompare(String(b.posting_date))
  || String(a.reference || '').localeCompare(String(b.reference || ''))
  || String(a.journal_entry_id).localeCompare(String(b.journal_entry_id))
  || num(a.line_number) - num(b.line_number)
  || String(a.id).localeCompare(String(b.id));

function validateScope({ start = null, end = null } = {}) {
  if (start != null && start !== '' && !isDate(start)) return { error: 'start_invalid' };
  if (end != null && end !== '' && !isDate(end)) return { error: 'end_invalid' };
  if (start && end && start > end) return { error: 'start_after_end' };
  return { start: start || null, end: end || null };
}

// Flatten a journal_entry_lines row with its embedded journal_entries row.
function flatten(l) {
  const je = l.journal_entries || l.je || {};
  return {
    id: l.id, journal_entry_id: l.journal_entry_id, line_number: l.line_number, account_id: l.account_id, fund_id: l.fund_id || null,
    debit_cents: num(l.debit_cents), credit_cents: num(l.credit_cents), memo: l.memo || null,
    posting_date: je.posting_date, reference: je.reference, description: je.description || null, status: je.status,
    void_reversal_je_id: je.void_reversal_je_id || null, reverses_je_id: je.reverses_je_id || null,
    source_module: je.source_module || null, source_reference: je.source_reference || null,
    source_document_id: je.source_document_id || null, source_document_path: je.source_document_path || null,
    _je: je,
  };
}

// Split one account's lines into opening / period for a fund and scope.
function scopeAccountLines(account, rawLines, fundId, scope) {
  const bs = BALANCE_SHEET.has(account.account_type);
  const mine = rawLines.map((l) => (l.posting_date ? l : flatten(l)))
    .filter((l) => counted(l._je || l) && effectiveFund(l, account) === (fundId || null))
    .filter((l) => !scope.end || l.posting_date <= scope.end)
    .sort(lineOrder);
  const opening = scope.start && bs ? mine.filter((l) => l.posting_date < scope.start) : [];
  const period = scope.start ? mine.filter((l) => l.posting_date >= scope.start) : mine;
  return { bs, opening, period };
}

const sum = (rows, k) => rows.reduce((s, r) => s + num(r[k]), 0);

/**
 * Detail for one TB row.
 * @param {object} p.account  chart_of_accounts row (id, account_number, account_name, account_type, normal_balance, fund_id)
 * @param {Array}  p.lines    journal_entry_lines rows for the account, each with embedded journal_entries
 * @param {string|null} p.fundId  the row's fund (null = no fund)
 */
function buildDetail({ account, lines, fundId = null, start = null, end = null, page = 1, pageSize = 100 }) {
  const scope = validateScope({ start, end });
  if (scope.error) return scope;
  const { bs, opening, period } = scopeAccountLines(account, lines, fundId, scope);
  const sign = account.normal_balance === 'credit' ? -1 : 1;
  const openingDebits = sum(opening, 'debit_cents'), openingCredits = sum(opening, 'credit_cents');
  const periodDebits = sum(period, 'debit_cents'), periodCredits = sum(period, 'credit_cents');
  const openingNet = openingDebits - openingCredits;
  const endingNet = openingNet + periodDebits - periodCredits;
  // Running balance over the WHOLE period (so it is correct on every page).
  let run = openingNet;
  const withRunning = period.map((l) => {
    run += l.debit_cents - l.credit_cents;
    return {
      line_id: l.id, journal_entry_id: l.journal_entry_id, posting_date: l.posting_date, reference: l.reference,
      description: l.description, memo: l.memo, source_module: l.source_module, source_reference: l.source_reference,
      source_document_id: l.source_document_id, source_document_path: l.source_document_path,
      entry_status: l.status === 'voided' ? 'voided_with_reversal' : 'posted', reverses_je_id: l.reverses_je_id,
      debit_cents: l.debit_cents, credit_cents: l.credit_cents,
      running_balance_cents: run, running_natural_cents: run * sign,
    };
  });
  const size = Math.min(Math.max(parseInt(pageSize, 10) || 100, 1), 500);
  const pages = Math.max(1, Math.ceil(withRunning.length / size));
  const pg = Math.min(Math.max(parseInt(page, 10) || 1, 1), pages);
  return {
    account: { id: account.id, account_number: account.account_number, account_name: account.account_name, account_type: account.account_type, normal_balance: account.normal_balance },
    fund_id: fundId || null,
    scope: { start: scope.start, end: scope.end, carries_forward: bs,
      rule: bs ? 'Balance-sheet account: opening carries forward every entry before the period.' : 'Income/expense account: only the report period counts; opening is zero.' },
    opening: { debits_cents: openingDebits, credits_cents: openingCredits, net_cents: openingNet, natural_cents: openingNet * sign },
    period: { debits_cents: periodDebits, credits_cents: periodCredits, line_count: period.length },
    ending: { net_cents: endingNet, natural_cents: endingNet * sign },
    sign_convention: account.normal_balance === 'credit'
      ? 'Normal credit balance: shown as credits minus debits (a positive figure is a credit balance).'
      : 'Normal debit balance: shown as debits minus credits (a positive figure is a debit balance).',
    tb_row: { total_debits_cents: openingDebits + periodDebits, total_credits_cents: openingCredits + periodCredits, balance_cents: endingNet },
    lines: withRunning.slice((pg - 1) * size, pg * size),
    page: pg, page_size: size, pages, total_lines: withRunning.length,
  };
}

/**
 * Trial balance rows for a scope, built with the SAME counting/scope code as the
 * detail. With no dates this reproduces v_trial_balance's debits/credits.
 * Rows only for (account, fund) pairs with activity in scope, plus every active
 * account's home fund at zero (as the view's LEFT JOIN yields).
 */
function scopedTrialBalance({ accounts, lines, funds = [], start = null, end = null }) {
  const scope = validateScope({ start, end });
  if (scope.error) return scope;
  const fundById = new Map(funds.map((f) => [f.id, f]));
  const byAccount = new Map();
  for (const l of lines) { const f = l.posting_date ? l : flatten(l); (byAccount.get(f.account_id) || byAccount.set(f.account_id, []).get(f.account_id)).push(f); }
  const rows = [];
  for (const a of accounts.filter((x) => x.is_active !== false)) {
    const acctLines = (byAccount.get(a.id) || []).filter((l) => counted(l._je || l));
    const fundsHere = new Set(acctLines.map((l) => effectiveFund(l, a)));
    if (!fundsHere.size) fundsHere.add(a.fund_id || null);
    for (const fid of fundsHere) {
      const d = buildDetail({ account: a, lines: acctLines, fundId: fid, start: scope.start, end: scope.end, pageSize: 1 });
      const f = fundById.get(fid) || {};
      rows.push({ account_id: a.id, account_number: a.account_number, account_name: a.account_name, account_type: a.account_type, normal_balance: a.normal_balance,
        fund_id: fid, fund_code: f.fund_code || null, fund_name: f.fund_name || null,
        total_debits_cents: d.tb_row.total_debits_cents, total_credits_cents: d.tb_row.total_credits_cents, balance_cents: d.tb_row.balance_cents });
    }
  }
  rows.sort((x, y) => String(x.account_number).localeCompare(String(y.account_number), undefined, { numeric: true }) || String(x.fund_code || '').localeCompare(String(y.fund_code || '')));
  const totals = rows.reduce((t, r) => ({ debits: t.debits + r.total_debits_cents, credits: t.credits + r.total_credits_cents }), { debits: 0, credits: 0 });
  return { rows, totals, balanced: totals.debits === totals.credits, scope };
}

// ---- DB loaders (read-only) -------------------------------------------------
const LINE_SELECT = 'id, journal_entry_id, line_number, account_id, fund_id, debit_cents, credit_cents, memo, journal_entries!inner(id, community_id, posting_date, reference, description, status, void_reversal_je_id, reverses_je_id, source_module, source_reference, source_document_id, source_document_path)';

async function loadAccountLines(supabase, communityId, accountId) {
  const { fetchAllQuery } = require('../db/fetch_all');
  return fetchAllQuery(() => supabase.from('journal_entry_lines').select(LINE_SELECT)
    .eq('account_id', accountId).eq('journal_entries.community_id', communityId));
}

async function loadAccount(supabase, communityId, accountId) {
  const { data, error } = await supabase.from('chart_of_accounts')
    .select('id, community_id, account_number, account_name, account_type, normal_balance, fund_id, is_active').eq('id', accountId).eq('community_id', communityId).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function loadCommunityTrialBalanceInputs(supabase, communityId) {
  const { fetchAll, fetchAllQuery } = require('../db/fetch_all');
  const accounts = await fetchAll(supabase, 'chart_of_accounts', { select: 'id, account_number, account_name, account_type, normal_balance, fund_id, is_active', filters: { community_id: communityId } });
  const funds = await fetchAll(supabase, 'account_funds', { select: 'id, fund_code, fund_name', filters: { community_id: communityId } });
  const ids = accounts.map((a) => a.id);
  const lines = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    lines.push(...await fetchAllQuery(() => supabase.from('journal_entry_lines').select(LINE_SELECT).in('account_id', chunk).eq('journal_entries.community_id', communityId)));
  }
  return { accounts, funds, lines };
}

module.exports = { buildDetail, scopedTrialBalance, validateScope, counted, effectiveFund, flatten, loadAccountLines, loadAccount, loadCommunityTrialBalanceInputs, BALANCE_SHEET };
