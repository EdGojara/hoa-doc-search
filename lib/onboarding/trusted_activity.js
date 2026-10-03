// ============================================================================
// lib/onboarding/trusted_activity.js  (Issue #15 Milestone 4) — read-only loader
// ----------------------------------------------------------------------------
// Loads the candidate Trusted FINANCIAL records for one community, for the
// activity bridge. It is handed a READ-ONLY client (write_gate.readOnlyClient):
// any insert / update / upsert / delete / rpc / storage write throws before a
// request is sent, so the bridge cannot change Trusted even by mistake.
//
// Financial records only: journal entries (+ lines), AP invoices and payments,
// AR charges and payments, card/ACH payments, homeowner ledger rows. ACC,
// violation and certification history is never read.
// Every read is community-scoped, ordered and paginated (no 1,000-row cap).
// ============================================================================
const PAGE = 1000;

async function readAll(read, table, select, apply) {
  const out = [];
  for (let from = 0; from < 200000; from += PAGE) {
    let q = read.from(table).select(select);
    q = apply(q).order('id', { ascending: true }).range(from, from + PAGE - 1);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < PAGE) return out;
  }
  throw new Error(`${table}: more than 200,000 rows; refusing to load unbounded`);
}

const SELECT = {
  journal_entries: 'id, posting_date, source_module, source_reference, reference, description, status, total_debits_cents, total_credits_cents, reverses_je_id, void_reversal_je_id, superseded_at, superseded_reason, created_at, updated_at',
  journal_entry_lines: 'id, journal_entry_id, account_id, debit_cents, credit_cents, property_id, vendor_id',
  ap_invoices: 'id, vendor_id, vendor_invoice_number, invoice_date, total_cents, status, posting_journal_entry_id, voided_at, created_at, updated_at',
  ap_payments: 'id, vendor_id, payment_date, amount_cents, payment_method, check_number, posting_journal_entry_id, status, voided_at, created_at, updated_at',
  ar_charges: 'id, property_id, charge_date, original_amount_cents, status, source_module, source_reference, posting_journal_entry_id, created_at, updated_at',
  ar_payments: 'id, property_id, payment_date, amount_cents, source, source_reference, status, posting_journal_entry_id, created_at, updated_at',
  payments: 'id, property_id, amount_cents, status, livemode, paid_at, journal_entry_id, homeowner_txn_id, created_at, updated_at',
  homeowner_transactions: 'id, source_batch_id, vantaca_account_id, property_id, transaction_date, txn_type, amount_cents, created_at',
};

async function loadTrustedActivity(read, communityId) {
  if (!read || !read.__readOnly) throw new Error('loadTrustedActivity needs the read-only client (write_gate.readOnlyClient)');
  if (!communityId) throw new Error('community_id required');
  const byCommunity = (q) => q.eq('community_id', communityId);
  const t = {};
  for (const table of ['journal_entries', 'ap_invoices', 'ap_payments', 'ar_charges', 'ar_payments', 'payments', 'homeowner_transactions']) t[table] = await readAll(read, table, SELECT[table], byCommunity);
  const jeIds = t.journal_entries.map((j) => j.id);
  t.journal_entry_lines = [];
  for (let i = 0; i < jeIds.length; i += 100) t.journal_entry_lines.push(...await readAll(read, 'journal_entry_lines', SELECT.journal_entry_lines, (q) => q.in('journal_entry_id', jeIds.slice(i, i + 100))));
  const accounts = await readAll(read, 'chart_of_accounts', 'id, account_number', byCommunity);
  const properties = await readAll(read, 'properties', 'id, vantaca_account_id', byCommunity);
  const acctById = new Map(accounts.map((a) => [a.id, a.account_number]));
  const vacctByProp = new Map(properties.map((p) => [p.id, p.vantaca_account_id]));
  return { trusted: t, accountNumber: (id) => acctById.get(id) || null, accountOfProperty: (id) => vacctByProp.get(id) || null };
}

module.exports = { loadTrustedActivity, SELECT };
