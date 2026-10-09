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

async function readAll(read, table, select, apply, orderBy = 'id') {
  const out = [];
  for (let from = 0; from < 200000; from += PAGE) {
    let q = read.from(table).select(select);
    q = apply(q).order(orderBy, { ascending: true }).range(from, from + PAGE - 1);
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
async function loadConversionContext(read, communityId, { cutoff } = {}) {
  if (!read || !read.__readOnly) throw new Error('loadConversionContext needs the read-only client (write_gate.readOnlyClient)');
  if (!communityId) throw new Error('community_id required');
  const byCommunity = (q) => q.eq('community_id', communityId);
  const { data: com, error: comErr } = await read.from('communities').select('id, management_company_id, gl_cutover_date').eq('id', communityId);
  if (comErr) throw new Error(`communities: ${comErr.message}`);
  if (!com || com.length !== 1) throw new Error(`community ${communityId} not found`);
  const accounts = await readAll(read, 'chart_of_accounts', 'id, account_number, fund_id, vantaca_account_number', byCommunity);
  const funds = (await readAll(read, 'account_funds', 'id, fund_code', byCommunity)).map((f) => ({ id: f.id, code: f.fund_code }));
  const properties = await readAll(read, 'properties', 'id, vantaca_account_id, street_address, trusted_account_number', byCommunity);
  const tenures = await readAll(read, 'ownership_tenures', 'id, property_id, kind, start_date, end_date, origin', byCommunity);
  const vendors = com[0].management_company_id ? await readAll(read, 'vendors', 'id, name, dba, is_active, auto_pay_ach', (q) => q.eq('management_company_id', com[0].management_company_id)) : [];
  const periods = await readAll(read, 'accounting_periods', 'id, period_start, period_end, status', byCommunity);
  const builder = cutoff ? await loadBuilderContext(read, communityId, { cutoff, tenures }) : null;
  return { accounts, funds, properties, tenures, vendors, periods, builder, management_company_id: com[0].management_company_id || null,
    gl_cutover_date: com[0].gl_cutover_date ? String(com[0].gl_cutover_date).slice(0, 10) : null };
}

// Builder assessment context (GitHub #96), all from configuration: the community's builder
// assessment program (builder_assessment_programs), its annual assessment and assessment year
// (community_assessment_rates homeowner row), its builder rule (transfer_proration_builders +
// company names), the owner names on each open owner tenure, and the assessment-year ledger rows
// in the legacy (committed) homeowner-ledger batches through the cutoff. Loaded apart from
// loadTrustedActivity so the bridge's Trusted fingerprint never changes. Null when the community
// has no active program or no builder rule.
async function loadBuilderContext(read, communityId, { cutoff, tenures }) {
  const byCommunity = (q) => q.eq('community_id', communityId);
  const programs = await readAll(read, 'builder_assessment_programs', 'community_id, active, builder_rate_pct, homeowner_rate_pct, ar_account_number, income_account_number, deferral_account_number, deferral_release, accrual_cadence_months, accrual_activated_at',
    (q) => byCommunity(q).eq('active', true), 'community_id');   // keyed by community: no id column
  if (!programs.length) return null;
  const rules = await readAll(read, 'transfer_proration_builders', 'community_id, builder_company_id, active', (q) => byCommunity(q).eq('active', true), 'builder_company_id');   // composite key: no id column
  if (!rules.length) return null;
  const companies = await readAll(read, 'builder_companies', 'id, company_name', (q) => q.in('id', rules.map((r) => r.builder_company_id)));
  const rates = await readAll(read, 'community_assessment_rates', 'id, owner_class, annual_amount_cents, fiscal_year_end_mmdd', (q) => byCommunity(q).eq('owner_class', 'homeowner'));
  const rate = rates[0] || null;
  const { assessmentYear } = require('./builder_positions');
  const yearStart = assessmentYear((rate && rate.fiscal_year_end_mmdd) || '12-31', String(cutoff).slice(0, 10)).year_start;
  const open = (tenures || []).filter((t) => (t.kind || 'owner') === 'owner' && !t.end_date).map((t) => t.id);
  const owners = [];
  for (let i = 0; i < open.length; i += 100) {
    const rows = await readAll(read, 'property_ownerships', 'id, tenure_id, contact_id', (q) => q.in('tenure_id', open.slice(i, i + 100)));
    const cids = [...new Set(rows.map((r) => r.contact_id).filter(Boolean))]; const names = new Map();
    for (let j = 0; j < cids.length; j += 100) for (const c of await readAll(read, 'contacts', 'id, full_name', (q) => q.in('id', cids.slice(j, j + 100)))) names.set(c.id, c.full_name);
    for (const r of rows) owners.push({ tenure_id: r.tenure_id, full_name: names.get(r.contact_id) || null });
  }
  const batches = await readAll(read, 'transaction_upload_batches', 'id, status', byCommunity);
  const committed = batches.filter((b) => b.status === 'committed').map((b) => b.id);
  const rows = [];
  for (let i = 0; i < committed.length; i += 50) rows.push(...await readAll(read, 'homeowner_transactions', 'id, source_batch_id, property_id, tenure_id, vantaca_account_id, transaction_date, description, txn_type, charge_category, amount_cents',
    (q) => q.in('source_batch_id', committed.slice(i, i + 50)).gte('transaction_date', yearStart).lte('transaction_date', cutoff)));
  return { builders: companies.map((c) => ({ id: c.id, company_name: c.company_name })), owners,
    program: programs[0], rate,
    legacy_rows: rows, annual_rows: rows };
}

// The books AFTER an executed conversion, for the post-proof stage (read-only, paginated).
async function loadPostProofData(read, communityId, { execution_id, ar_uploaded_by, batch_id = null }) {
  if (!read || !read.__readOnly) throw new Error('loadPostProofData needs the read-only client (write_gate.readOnlyClient)');
  const byCommunity = (q) => q.eq('community_id', communityId);
  const journal_entries = await readAll(read, 'journal_entries', 'id, reference, posting_date, status, source_module, period_id, total_debits_cents, total_credits_cents, void_reversal_je_id, notes, superseded_by_conversion, created_at', byCommunity);
  const ids = journal_entries.map((j) => j.id); const journal_entry_lines = [];
  for (let i = 0; i < ids.length; i += 100) journal_entry_lines.push(...await readAll(read, 'journal_entry_lines', 'id, journal_entry_id, account_id, debit_cents, credit_cents', (q) => q.in('journal_entry_id', ids.slice(i, i + 100))));
  const accounts = await readAll(read, 'chart_of_accounts', 'id, account_number', byCommunity);
  const upload_batches = await readAll(read, 'transaction_upload_batches', 'id, status, uploaded_by, row_count, replaced_by_batch_id', byCommunity);
  const conv = upload_batches.filter((b) => b.uploaded_by === ar_uploaded_by);
  const conversion_rows = conv.length === 1 ? await readAll(read, 'homeowner_transactions', 'id, property_id, tenure_id, vantaca_account_id, txn_type, amount_cents, transaction_date, raw_row_jsonb', (q) => q.eq('source_batch_id', conv[0].id)) : [];
  const ap_invoices = await readAll(read, 'ap_invoices', 'id, vendor_invoice_number, total_cents, status, posting_journal_entry_id, notes', byCommunity);
  const properties = await readAll(read, 'properties', 'id, vantaca_account_id', byCommunity);
  const credits = conversion_rows.filter((r) => r.txn_type === 'credit').map((r) => r.id);
  const current_owner_ledger_ids = credits.length ? (await readAll(read, 'v_current_owner_ledger', 'id', (q) => q.in('id', credits))).map((r) => r.id) : [];
  const { data: com, error: comErr } = await read.from('communities').select('gl_cutover_date').eq('id', communityId);
  if (comErr) throw new Error(`communities: ${comErr.message}`);
  const execution_writes = await readAll(read, 'onboarding_execution_writes', 'id, table_name, write_kind, row_id', (q) => q.eq('execution_id', execution_id));
  const canonical_counts = {};
  for (const t of ['cd_parties', 'cd_ownerships', 'cd_addresses', 'cd_contact_methods', 'cd_occupancies', 'cd_evidence']) {
    const { count, error } = await read.from(t).select('*', { count: 'exact', head: true }).eq('community_id', communityId);
    canonical_counts[t] = error ? null : count;
  }
  // GitHub #96: what the conversion wrote for builder lots, the deferral schedule, the reconciling items.
  const builder_coverage = batch_id ? await readAll(read, 'builder_assessment_coverage', 'id, tenure_id, covered_from, covered_through, amount_cents, status, journal_entry_id', (q) => q.eq('conversion_batch_id', batch_id)) : [];
  const recognition_schedules = batch_id ? await readAll(read, 'recognition_schedules', 'id, status, recognize_amount_cents, term_months, start_month, balance_account_number', (q) => byCommunity(q).eq('source_type', 'conversion_balance').eq('source_id', batch_id)) : [];
  const reconciling_items = batch_id ? await readAll(read, 'conversion_reconciling_items', 'id, kind, item_key, amount_cents, status', (q) => q.eq('batch_id', batch_id)) : [];
  return { journal_entries, journal_entry_lines, accounts, upload_batches, conversion_rows, ap_invoices, properties, current_owner_ledger_ids,
    gl_cutover_date: com && com[0] ? com[0].gl_cutover_date : null, execution_writes, canonical_counts, builder_coverage, recognition_schedules, reconciling_items };
}

module.exports = { loadTrustedActivity, loadConversionContext, loadBuilderContext, loadPostProofData, SELECT };
