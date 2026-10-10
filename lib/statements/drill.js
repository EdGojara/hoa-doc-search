// ============================================================================
// lib/statements/drill.js  (Ed 2026-10-09, month-end close PR C)
// ----------------------------------------------------------------------------
// Drill-down from a statement line to the record behind it, READ-ONLY:
//   category  -> its GL accounts            (the model's drill.accounts list)
//   account   -> transactions               drillAccount(): the journal lines in
//                the statement's own scope, totalled, and checked against the
//                number clicked (they must tie)
//   entry     -> source                     drillEntry(): the bill, payment,
//                check, homeowner charge / payment, reversal, documents
//                (lib/accounting/je_transaction_summary.js)
// Balance sheet: every line through the as-of date. Income statement: the
// period's ACTIVITY by the one rule (lib/accounting/statement_periods.js), so a
// month never shows the conversion opening carryforward and the list always
// adds up to the statement figure.
// ============================================================================

const tbd = require('../accounting/trial_balance_detail');
const SP = require('../accounting/statement_periods');
const { ORIGIN_LABEL, summarizeJournalEntry } = require('../accounting/je_transaction_summary');

const NOFUND = '__nofund__';
const natural = (type, d, c) => (type === 'asset' || type === 'expense' ? d - c : c - d);

async function drillAccount(supabase, { community_id, kind, account_id, fund_id = null, as_of = null, period_start = null, period_end = null }) {
  const account = await tbd.loadAccount(supabase, community_id, account_id);
  if (!account) throw Object.assign(new Error('account_not_found'), { code: 'not_found' });
  const fund = fund_id && fund_id !== NOFUND ? fund_id : null;
  const raw = (await tbd.loadAccountLines(supabase, community_id, account_id)).map(tbd.flatten)
    .filter((l) => tbd.counted(l._je) && tbd.effectiveFund(l, account) === fund);
  let lines, coverage = null;
  if (kind === 'balance_sheet') {
    if (!as_of) throw Object.assign(new Error('as_of_required'), { code: 'invalid_input' });
    lines = raw.filter((l) => l.posting_date <= as_of);
  } else {
    if (!period_start || !period_end) throw Object.assign(new Error('period_required'), { code: 'invalid_input' });
    const { data: coa, error } = await supabase.from('chart_of_accounts').select('id, account_type').eq('community_id', community_id).limit(5000);
    if (error) throw error;
    const windows = await SP.loadWindows(supabase, community_id, new Map((coa || []).map((a) => [a.id, a.account_type])));
    const shaped = raw.map((l) => ({ ...l, journal_entries: { posting_date: l.posting_date, source_module: l.source_module } }));
    const sel = SP.selectActivity(shaped, windows, period_start, period_end);
    lines = sel.lines; coverage = sel.coverage;
  }
  lines.sort((a, b) => String(a.posting_date).localeCompare(String(b.posting_date)) || String(a.reference || '').localeCompare(String(b.reference || '')));
  const transactions = lines.map((l) => ({
    journal_entry_id: l.journal_entry_id, reference: l.reference, posting_date: l.posting_date,
    description: l.description || l.memo || '', memo: l.memo || null,
    source_module: l.source_module, origin: ORIGIN_LABEL[l.source_module] || l.source_module || 'Journal entry',
    amount_cents: natural(account.account_type, l.debit_cents, l.credit_cents),
    is_opening_carryforward: l.source_module === SP.OPENING_MODULE,
    document: l.source_document_path ? { path: l.source_document_path, id: l.source_document_id } : null,
  }));
  const total = transactions.reduce((t, x) => t + x.amount_cents, 0);
  const out = {
    account: { id: account.id, number: account.account_number, name: account.account_name, type: account.account_type },
    fund_id: fund, scope: kind === 'balance_sheet' ? { as_of } : { period_start, period_end },
    coverage, transactions, total_cents: total,
  };
  // Cash accounts: the bank statements behind the balance (evidence).
  if (account.account_type === 'asset') {
    const { data: banks } = await supabase.from('bank_accounts').select('id, account_nickname, account_last4').eq('community_id', community_id).eq('gl_account_number', account.account_number).limit(10);
    if (banks && banks.length) {
      const { data: imps } = await supabase.from('bank_statement_imports').select('id, bank_account_id, statement_period_start, statement_period_end, ending_balance_cents, source_filename, status')
        .in('bank_account_id', banks.map((b) => b.id)).lte('statement_period_start', as_of || period_end).order('statement_period_end', { ascending: false }).limit(6);
      out.bank_evidence = { accounts: banks, statements: imps || [] };
    }
  }
  return out;
}

// Transaction -> source record(s). The entry must belong to the community.
async function drillEntry(supabase, { community_id, journal_entry_id }) {
  const { data: je, error } = await supabase.from('journal_entries').select('id, community_id').eq('id', journal_entry_id).maybeSingle();
  if (error) throw error;
  if (!je || je.community_id !== community_id) throw Object.assign(new Error('entry_not_found'), { code: 'not_found' });
  return summarizeJournalEntry(supabase, journal_entry_id);
}

// Every account line of a model, scoped like its drill-down: the CSV detail.
async function detailRows(supabase, model) {
  const out = [];
  const seen = new Set();
  for (const sec of model.sections) for (const g of sec.groups) for (const l of g.lines) {
    const k = `${l.account_id}|${l.fund_id || ''}`; if (seen.has(k)) continue; seen.add(k);
    const d = model.kind === 'balance_sheet'
      ? await drillAccount(supabase, { community_id: model.community.id, kind: 'balance_sheet', account_id: l.account_id, fund_id: l.fund_id, as_of: model.period.as_of })
      : await drillAccount(supabase, { community_id: model.community.id, kind: 'income_budget', account_id: l.account_id, fund_id: l.fund_id, period_start: model.period.year_start, period_end: model.period.period_end });
    for (const t of d.transactions) out.push({ section: sec.label, category: g.label, account_number: l.account_number, account_name: l.account_name, fund: l.fund_code || '', ...t });
  }
  return out;
}

module.exports = { drillAccount, drillEntry, detailRows, NOFUND };
