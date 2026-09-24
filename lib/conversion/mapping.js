// ============================================================================
// lib/conversion/mapping.js
// ----------------------------------------------------------------------------
// EXACT-KEY mapping of normalized conversion rows to existing Trusted records.
// Deterministic lookups only. This module makes NO accounting, attribution or
// duplicate judgments: a row either resolves to exactly one record on its key,
// or it is captured as an exception with the reason. Deciding what to do with
// an exception belongs to Ed / ChatGPT, not to this code.
//
// Keys (exact after trim + case-fold + whitespace collapse, nothing fuzzier):
//   AR rows            ar_debits / ar_credits: vantaca_account_id -> properties.vantaca_account_id,
//                      and property_address (if given) must equal that property's street_address
//                      ar_former_owners: property_address -> properties.street_address (a former
//                      account is by definition not the lot's current account). Which tenure a
//                      former balance belongs to is NOT decided here.
//   AP rows            vendor_name -> vendors.name; gl_account -> chart_of_accounts.account_number
//   TB / July activity account_number -> chart_of_accounts.account_number; fund -> fund code
//   bank / outstanding gl_account_number -> active bank_accounts.gl_account_number
//                      bank_account_last4 (if given) must equal bank_accounts.account_last4
//   every file         its natural key must be unique within the file
// ============================================================================

const norm = (v) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ').toUpperCase();

function index(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = norm(keyFn(r));
    if (!k) continue;
    (m.get(k) || m.set(k, []).get(k)).push(r);
  }
  return m;
}

// Natural key per file: two rows with the same key are reported, never merged.
const NATURAL_KEYS = {
  ar_debits: (r) => [r.vantaca_account_id, r.charge_category, r.effective_date, r.source_row].join('|'),
  ar_credits: (r) => [r.vantaca_account_id, r.charge_category, r.effective_date, r.source_row].join('|'),
  ar_former_owners: (r) => [r.vantaca_account_id, r.charge_category, r.effective_date, r.source_row].join('|'),
  ap_open: (r) => [r.vendor_name, r.invoice_number].join('|'),
  gl_trial_balance: (r) => [r.account_number, r.fund].join('|'),
  bank_balances: (r) => r.gl_account_number,
  outstanding_items: (r) => [r.gl_account_number, r.item_type, r.check_number || '', r.item_date, r.amount, r.source_report].join('|'),
  july_gl_activity: (r) => (r.line_id ? r.line_id : null),
  control_totals: (r) => r.control_code,
  control_rules: (r) => r.rule_code,
};

/**
 * @param {object} inputs loadInputSet() result
 * @param {object} ref    { properties:[{id,street_address,vantaca_account_id}], vendors:[{id,name}],
 *                          coa:[{id,account_number}], funds:[{id,code}], bankAccounts:[{id,gl_account_number,account_last4,is_active}] }
 * @returns {{ mapped: object, exceptions: Array }}
 */
function mapInputs(inputs, ref) {
  const exceptions = [];
  const mapped = {};
  const ex = (kind, row, code, detail) => exceptions.push({ file: kind, line: row._line, code, detail });

  const propsByAcct = index(ref.properties, (p) => p.vantaca_account_id);
  const propsByAddr = index(ref.properties, (p) => p.street_address);
  const vendorsByName = index(ref.vendors, (v) => v.name);
  const coaByNum = index(ref.coa, (a) => a.account_number);
  const fundsByCode = index(ref.funds, (f) => f.code);
  const banksByGl = index(ref.bankAccounts.filter((b) => b.is_active), (b) => b.gl_account_number);

  const one = (idx, key) => {
    const hits = idx.get(norm(key)) || [];
    return hits.length === 1 ? { hit: hits[0] } : { count: hits.length };
  };

  for (const [kind, f] of Object.entries(inputs.files)) {
    if (!f.header_ok) continue; // header problems are exceptions from the validator; no row can be read
    // natural-key uniqueness
    const keyFn = NATURAL_KEYS[kind];
    if (keyFn) {
      const seen = new Map();
      for (const r of f.rows) {
        if (r._errors.length) continue;
        const k = keyFn(r);
        if (k == null) continue;
        if (seen.has(k)) ex(kind, r, 'DUPLICATE_ROW_KEY', `same key as line ${seen.get(k)}: ${k}`);
        else seen.set(k, r._line);
      }
    }
    mapped[kind] = f.rows.map((r) => {
      const m = { _line: r._line };
      if (r._errors.length) { m.skipped = 'format_exception'; return m; } // already an exception
      if (kind === 'ar_former_owners') {
        if (!r.property_address) ex(kind, r, 'FORMER_NO_ADDRESS', `former account ${r.vantaca_account_id} has no property_address`);
        else {
          const p = one(propsByAddr, r.property_address);
          if (p.hit) m.property_id = p.hit.id; else ex(kind, r, p.count ? 'ADDRESS_ON_MULTIPLE_PROPERTIES' : 'ADDRESS_NOT_ON_ANY_PROPERTY', `property_address "${r.property_address}" matches ${p.count} Trusted properties exactly`);
        }
      }
      if (kind === 'ar_debits' || kind === 'ar_credits') {
        const p = one(propsByAcct, r.vantaca_account_id);
        if (!p.hit) ex(kind, r, p.count ? 'ACCOUNT_ON_MULTIPLE_PROPERTIES' : 'ACCOUNT_NOT_ON_ANY_PROPERTY', `vantaca_account_id ${r.vantaca_account_id} matches ${p.count} Trusted properties`);
        else {
          m.property_id = p.hit.id;
          if (r.property_address && norm(r.property_address) !== norm(p.hit.street_address)) ex(kind, r, 'ADDRESS_NOT_EXACT', `file "${r.property_address}" vs Trusted "${p.hit.street_address}"`);
        }
      }
      if (kind === 'ap_open') {
        const v = one(vendorsByName, r.vendor_name);
        if (v.hit) m.vendor_id = v.hit.id; else ex(kind, r, v.count ? 'VENDOR_NAME_AMBIGUOUS' : 'VENDOR_NOT_FOUND', `vendor_name "${r.vendor_name}" matches ${v.count} Trusted vendors`);
        const a = one(coaByNum, r.gl_account);
        if (a.hit) m.account_id = a.hit.id; else ex(kind, r, 'GL_ACCOUNT_NOT_FOUND', `gl_account ${r.gl_account}`);
      }
      if (kind === 'gl_trial_balance' || kind === 'july_gl_activity') {
        const a = one(coaByNum, r.account_number);
        if (a.hit) m.account_id = a.hit.id; else ex(kind, r, 'GL_ACCOUNT_NOT_FOUND', `account_number ${r.account_number}`);
        if (r.fund) {
          const fd = one(fundsByCode, r.fund);
          if (fd.hit) m.fund_id = fd.hit.id; else ex(kind, r, 'FUND_NOT_FOUND', `fund ${r.fund}`);
        }
      }
      if (kind === 'bank_balances' || kind === 'outstanding_items') {
        const b = one(banksByGl, r.gl_account_number);
        if (!b.hit) ex(kind, r, b.count ? 'BANK_ACCOUNT_AMBIGUOUS' : 'BANK_ACCOUNT_NOT_FOUND', `gl_account_number ${r.gl_account_number} matches ${b.count} active bank accounts`);
        else {
          m.bank_account_id = b.hit.id;
          if (r.bank_account_last4 && norm(r.bank_account_last4) !== norm(b.hit.account_last4)) ex(kind, r, 'BANK_LAST4_NOT_EXACT', `file ..${r.bank_account_last4} vs Trusted ..${b.hit.account_last4}`);
        }
      }
      return m;
    });
  }
  return { mapped, exceptions };
}

module.exports = { mapInputs, NATURAL_KEYS, norm };
