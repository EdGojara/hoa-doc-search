// ============================================================================
// lib/onboarding/canonical.js  (Issue #15) — Stage 1: canonical staging model
// ----------------------------------------------------------------------------
// Provider adapters (Vantaca, CINC, C3, TOPS, AppFolio, QuickBooks,
// spreadsheets, unknown exports) all emit rows in THESE shapes. Core logic
// (controls, snapshot, preflight) only ever sees canonical rows, so no
// provider assumption leaks into it.
//
// Every row carries provenance: the artifact it came from (sha256), where in
// that artifact (page / line / row), and the raw source text. A row without
// provenance is refused. Amounts are integer cents; dates are ISO YYYY-MM-DD.
// ============================================================================

const DOMAINS = {
  // General ledger
  gl_account:         { required: ['account_code', 'account_name'], money: [] },
  gl_account_balance: { required: ['account_code', 'as_of'], money: ['beginning_cents', 'debit_cents', 'credit_cents', 'ending_cents'] },
  gl_transaction:     { required: ['account_code', 'date'], money: ['debit_cents', 'credit_cents'] },
  // Statements (printed report lines, used as source controls)
  statement_line:     { required: ['statement', 'label', 'as_of'], money: ['amount_cents'] },
  // Homeowner subledger
  property:           { required: ['source_property_key'], money: [] },
  owner:              { required: ['source_owner_key'], money: [] },
  ownership_period:   { required: ['source_property_key', 'source_owner_key'], money: [] },
  homeowner_account:  { required: ['source_account_key', 'as_of'], money: ['opening_cents', 'ending_cents'] },
  homeowner_txn:      { required: ['source_account_key', 'date'], money: ['charge_cents', 'payment_cents', 'balance_cents'] },
  ar_aging_account:   { required: ['source_account_key', 'as_of'], money: ['current_cents', 'over_30_cents', 'over_60_cents', 'over_90_cents', 'balance_cents'] },
  ar_aging_item:      { required: ['source_account_key', 'charge_type', 'as_of'], money: ['current_cents', 'over_30_cents', 'over_60_cents', 'over_90_cents', 'balance_cents'] },
  prepaid_credit:     { required: ['source_account_key', 'as_of'], money: ['amount_cents'] },
  // Payables / cash / vendors / assessments
  ap_open_item:       { required: ['source_vendor_key', 'as_of'], money: ['amount_cents'] },
  bank_balance:       { required: ['source_bank_key', 'as_of'], money: ['amount_cents'] },
  vendor:             { required: ['source_vendor_key'], money: [] },
  assessment_schedule:{ required: ['source_schedule_key'], money: ['amount_cents'] },
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function makeRow(domain, values, provenance) {
  const spec = DOMAINS[domain];
  if (!spec) throw new Error(`unknown canonical domain: ${domain}`);
  if (!provenance || !provenance.artifact_sha256 || !provenance.locator || provenance.raw === undefined) {
    throw new Error(`${domain}: provenance (artifact_sha256, locator, raw) is required on every canonical row`);
  }
  for (const k of spec.required) if (values[k] === undefined || values[k] === null || values[k] === '') throw new Error(`${domain}: ${k} required`);
  for (const k of spec.money) if (values[k] !== undefined && !Number.isInteger(values[k])) throw new Error(`${domain}: ${k} must be integer cents`);
  for (const k of ['as_of', 'date']) if (values[k] !== undefined && !ISO.test(values[k])) throw new Error(`${domain}: ${k} must be YYYY-MM-DD`);
  return Object.freeze({ domain, ...values, provenance: Object.freeze({ ...provenance }) });
}

// "M/D/YYYY" -> "YYYY-MM-DD" (strict).
function isoDate(mdy) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(mdy).trim());
  if (!m) throw new Error(`unreadable date: ${JSON.stringify(mdy)}`);
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

module.exports = { DOMAINS, makeRow, isoDate };
