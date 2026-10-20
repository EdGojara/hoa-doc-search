// ============================================================================
// lib/ar/ledger_line.js — how one owner-ledger row reads on a staff screen (PURE)
// ----------------------------------------------------------------------------
// One rule for every surface that lists an owner's transactions (Homeowner 360's
// "Balance & recent activity", its AI recap). The row's own description is what
// the owner sees on statements and the portal, so staff see the same words:
// "Legal Fees - Collections: Payment processing (Attorney Inv. 283101)", never a
// bare "charge". Only a row with no description falls back to its category.
//
// Scar (Ed 2026-10-20): Homeowner 360 rendered txn_type, so after migration 538
// corrected the five legal chargeback descriptions, staff still saw "charge
// $1,008.00" with no description or invoice number.
// Served to the browser at /app/ledger-line.js. Tested in tests/test_ledger_line.js.
// ============================================================================
(function (root) {
  'use strict';

  var CATEGORY_LABEL = {
    attorney_fee: 'Legal Fees - Collections', attorney_fee_other: 'Legal Fees - DRV Enforcement',
    assessment: 'Assessment', late_fee: 'Late fee', interest: 'Interest', fine: 'Fine', admin_fee: 'Administrative fee',
    collection_fee: 'Collection fee', payment: 'Payment', adjustment: 'Adjustment', credit: 'Credit',
  };

  function words(s) { return String(s).replace(/_/g, ' ').replace(/^\w/, function (c) { return c.toUpperCase(); }); }

  // The label staff see for a ledger row: its description, else its category, else its type.
  function label(t) {
    t = t || {};
    var d = String(t.description == null ? '' : t.description).replace(/\s+/g, ' ').trim();
    if (d) return d;
    if (t.charge_category) return CATEGORY_LABEL[t.charge_category] || words(t.charge_category);
    if (t.txn_type) return CATEGORY_LABEL[t.txn_type] || words(t.txn_type);
    return 'Transaction';
  }

  var api = { label: label, CATEGORY_LABEL: CATEGORY_LABEL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LedgerLine = api;
})(typeof window !== 'undefined' ? window : this);
