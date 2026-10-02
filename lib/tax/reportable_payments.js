// ============================================================================
// lib/tax/reportable_payments.js  (Issue #14): cumulative REPORTABLE payments
// ----------------------------------------------------------------------------
// Per vendor, per payer (community = the association that files the 1099),
// per calendar year (payment_date). Counts ap_payments that are pending or
// completed, EXCLUDING payment-card payments (reported by the network on
// 1099-K). Historical imports live in ap_payments too, so they count. Read-only.
// ============================================================================
const { fetchAllQuery } = require('../db/fetch_all');
const { reportingChannel } = require('./info_reporting');

// -> Map key `${vendor_id}|${community_id}` -> cents
async function reportableTotals(supabase, { vendorIds, year, communityId = null }) {
  const ids = [...new Set((vendorIds || []).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  const rows = await fetchAllQuery(() => {
    let q = supabase.from('ap_payments').select('id, vendor_id, community_id, amount_cents, payment_method, status, payment_date')
      .in('vendor_id', ids).in('status', ['pending', 'completed'])
      .gte('payment_date', `${year}-01-01`).lte('payment_date', `${year}-12-31`);
    if (communityId) q = q.eq('community_id', communityId);
    return q;
  }, { orderBy: 'id' });
  for (const p of rows) {
    if (reportingChannel(p.payment_method) !== 'form_1099_nec_misc') continue;
    const k = `${p.vendor_id}|${p.community_id}`;
    out.set(k, (out.get(k) || 0) + Number(p.amount_cents || 0));
  }
  return out;
}

// The vendor fields the rule reads.
const VENDOR_BASE_COLS = 'id, name, kind, w9_on_file, tax_classification, is_legal_counsel, is_mud';
const VENDOR_TAX_COLS ='id, name, kind, w9_on_file, tax_classification, is_legal_counsel, is_medical_provider, is_mud, tax_reporting_status, tax_exemption_basis, tax_exemption_source, tax_exemption_verified_by, tax_exemption_verified_at';

async function loadVendorsForTax(supabase, vendorIds) {
  const ids = [...new Set((vendorIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  let { data, error } = await supabase.from('vendors').select(VENDOR_TAX_COLS).in('id', ids);
  // Before migration 477 adds the exemption columns, read the columns that exist:
  // every vendor is then "not verified exempt", which is the correct conservative
  // state (no exemption can exist without its provenance columns).
  if (error && /column .* does not exist|is_medical_provider|tax_reporting_status|tax_exemption_/i.test(String(error.message || ''))) {
    ({ data, error } = await supabase.from('vendors').select(VENDOR_BASE_COLS).in('id', ids));
  }
  if (error) throw Object.assign(new Error(`vendor tax status read failed: ${error.message}`), { code: 'tax_check_failed' });
  return new Map((data || []).map((v) => [v.id, v]));
}

module.exports = { reportableTotals, loadVendorsForTax, VENDOR_TAX_COLS };
