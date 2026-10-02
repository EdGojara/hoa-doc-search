// ============================================================================
// lib/tax/reportable_payments.js  (Issue #14): cumulative REPORTABLE payments
// ----------------------------------------------------------------------------
// Per vendor, per payer (community = the association that files the 1099),
// per calendar year (payment_date), per REPORTING CATEGORY. Counts ap_payments
// that are pending or completed, EXCLUDING payment-card payments (decided by the
// payment's own method: reported by the network on 1099-K). Each payment is
// split across the bills it paid (ap_payment_applications) by each bill's
// category (ap_invoices.tax_reporting_category, else the vendor default); a
// payment with no applications (historical imports) is the vendor default.
// Read-only. Tolerant of the schema before migration 477.
// ============================================================================
const { fetchAllQuery } = require('../db/fetch_all');
const { reportingChannel, categoryFor } = require('./info_reporting');

const VENDOR_BASE_COLS = 'id, name, kind, w9_on_file, tax_classification, is_legal_counsel, is_mud';
const VENDOR_TAX_COLS = 'id, name, kind, w9_on_file, tax_classification, is_legal_counsel, is_medical_provider, is_mud, tax_reporting_status, tax_exemption_basis, tax_exemption_source, tax_exemption_verified_by, tax_exemption_verified_at';
const MISSING_COL = /column .* does not exist|is_medical_provider|tax_reporting_status|tax_exemption_|tax_reporting_category/i;

async function loadVendorsForTax(supabase, vendorIds) {
  const ids = [...new Set((vendorIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  let { data, error } = await supabase.from('vendors').select(VENDOR_TAX_COLS).in('id', ids);
  // Before migration 477 adds the exemption columns, read the columns that exist:
  // every vendor is then "not verified exempt", the correct conservative state.
  if (error && MISSING_COL.test(String(error.message || ''))) ({ data, error } = await supabase.from('vendors').select(VENDOR_BASE_COLS).in('id', ids));
  if (error) throw Object.assign(new Error(`vendor tax status read failed: ${error.message}`), { code: 'tax_check_failed' });
  return new Map((data || []).map((v) => [v.id, v]));
}

// Bill categories (Map invoice id -> category or null). Empty before 477.
async function invoiceCategories(supabase, invoiceIds) {
  const ids = [...new Set((invoiceIds || []).filter(Boolean))];
  const out = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase.from('ap_invoices').select('id, tax_reporting_category').in('id', ids.slice(i, i + 200));
    if (error && MISSING_COL.test(String(error.message || ''))) return new Map();
    if (error) throw Object.assign(new Error(`bill category read failed: ${error.message}`), { code: 'tax_check_failed' });
    (data || []).forEach((r) => out.set(r.id, r.tax_reporting_category || null));
  }
  return out;
}

// -> Map key `${vendor_id}|${community_id}|${category}` -> cents
async function reportableTotals(supabase, { vendorIds, year, communityId = null }) {
  const ids = [...new Set((vendorIds || []).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  const pays = (await fetchAllQuery(() => {
    let q = supabase.from('ap_payments').select('id, vendor_id, community_id, amount_cents, payment_method, status, payment_date')
      .in('vendor_id', ids).in('status', ['pending', 'completed'])
      .gte('payment_date', `${year}-01-01`).lte('payment_date', `${year}-12-31`);
    if (communityId) q = q.eq('community_id', communityId);
    return q;
  }, { orderBy: 'id' })).filter((p) => reportingChannel(p.payment_method) === 'form_1099_nec_misc');
  if (!pays.length) return out;
  const apps = [];
  const pids = pays.map((p) => p.id);
  for (let i = 0; i < pids.length; i += 200) {
    const { data, error } = await supabase.from('ap_payment_applications').select('payment_id, invoice_id, applied_cents').in('payment_id', pids.slice(i, i + 200));
    if (error) throw Object.assign(new Error(`payment applications read failed: ${error.message}`), { code: 'tax_check_failed' });
    apps.push(...(data || []));
  }
  const cats = await invoiceCategories(supabase, apps.map((a) => a.invoice_id));
  const vendors = await loadVendorsForTax(supabase, ids);
  const byPay = new Map(); for (const a of apps) { if (!byPay.has(a.payment_id)) byPay.set(a.payment_id, []); byPay.get(a.payment_id).push(a); }
  const add = (k, c) => out.set(k, (out.get(k) || 0) + c);
  for (const p of pays) {
    const v = vendors.get(p.vendor_id);
    const key = (cat) => `${p.vendor_id}|${p.community_id}|${categoryFor(cat, v)}`;
    let rest = Number(p.amount_cents || 0);
    for (const a of (byPay.get(p.id) || [])) { const c = Math.min(Number(a.applied_cents || 0), rest); add(key(cats.get(a.invoice_id)), c); rest -= c; }
    if (rest > 0) add(key(null), rest);
  }
  return out;
}

// { [category]: cents } for one vendor at one association.
function totalsByCategory(totals, vendorId, communityId) {
  const o = {}; const pre = `${vendorId}|${communityId}|`;
  for (const [k, c] of totals) if (k.startsWith(pre)) o[k.slice(pre.length)] = c;
  return o;
}

module.exports = { reportableTotals, totalsByCategory, loadVendorsForTax, invoiceCategories, VENDOR_TAX_COLS };
