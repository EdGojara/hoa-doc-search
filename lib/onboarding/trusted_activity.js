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
  const payIds = t.ap_payments.map((p) => p.id); const apApplications = [];
  for (let i = 0; i < payIds.length; i += 100) apApplications.push(...await readAll(read, 'ap_payment_applications', 'id, payment_id, invoice_id, applied_cents', (q) => q.in('payment_id', payIds.slice(i, i + 100))));
  const accounts = await readAll(read, 'chart_of_accounts', 'id, account_number', byCommunity);
  const properties = await readAll(read, 'properties', 'id, vantaca_account_id', byCommunity);
  const acctById = new Map(accounts.map((a) => [a.id, a.account_number]));
  const vacctByProp = new Map(properties.map((p) => [p.id, p.vantaca_account_id]));
  return { trusted: t, apApplications, accountNumber: (id) => acctById.get(id) || null, accountOfProperty: (id) => vacctByProp.get(id) || null };
}

// The reference data a conversion preflight needs to name exact targets (M5):
// accounts with their funds, properties (lot address + current source account),
// owner tenures, the management company's vendors, the current GL cutover date,
// the accounting periods (every proposed entry must land in an open one).
// Same read-only client, same paginated reads.
async function loadConversionContext(read, communityId) {
  if (!read || !read.__readOnly) throw new Error('loadConversionContext needs the read-only client (write_gate.readOnlyClient)');
  if (!communityId) throw new Error('community_id required');
  const byCommunity = (q) => q.eq('community_id', communityId);
  const { data: com, error: comErr } = await read.from('communities').select('id, management_company_id, gl_cutover_date').eq('id', communityId);
  if (comErr) throw new Error(`communities: ${comErr.message}`);
  if (!com || com.length !== 1) throw new Error(`community ${communityId} not found`);
  const accounts = await readAll(read, 'chart_of_accounts', 'id, account_number, fund_id, vantaca_account_number', byCommunity);
  const funds = (await readAll(read, 'account_funds', 'id, fund_code', byCommunity)).map((f) => ({ id: f.id, code: f.fund_code }));
  const properties = await readAll(read, 'properties', 'id, vantaca_account_id, street_address', byCommunity);
  const tenures = await readAll(read, 'ownership_tenures', 'id, property_id, kind, start_date, end_date', byCommunity);
  const vendors = com[0].management_company_id ? await readAll(read, 'vendors', 'id, name', (q) => q.eq('management_company_id', com[0].management_company_id)) : [];
  const periods = await readAll(read, 'accounting_periods', 'id, period_start, period_end, status', byCommunity);
  return { accounts, funds, properties, tenures, vendors, periods, management_company_id: com[0].management_company_id || null,
    gl_cutover_date: com[0].gl_cutover_date ? String(com[0].gl_cutover_date).slice(0, 10) : null };
}

module.exports = { loadTrustedActivity, loadConversionContext, SELECT };
