// ============================================================================
// lib/ap/vendor_status.js  (Ed 2026-07-08)
// ----------------------------------------------------------------------------
// The AP picture for one vendor, so Emma can answer "where's my payment?" from
// real ledger data instead of guessing. Returns their open invoices (and where
// each sits) and recent payments (check # + date), plus a helper to find a
// specific invoice the vendor named. Emma NEVER promises a pay date the data
// doesn't support — see emma_reply.js.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const { normInvoiceNo } = require('./dedup');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const STATUS_PLAIN = {
  awaiting_approval: 'received and in review (not yet approved for payment)',
  approved: 'approved and scheduled for an upcoming check run',
  partially_paid: 'partially paid',
  paid: 'paid',
  on_hold: 'on hold pending review',
  disputed: 'in dispute',
  voided: 'voided',
};

async function vendorApStatus(vendorId) {
  if (!vendorId) return { hasData: false, open: [], recent_payments: [] };

  const { data: open } = await supabase.from('ap_invoices')
    .select('id, vendor_invoice_number, invoice_date, due_date, total_cents, amount_paid_cents, status, community:community_id(name)')
    .eq('vendor_id', vendorId)
    .in('status', ['awaiting_approval', 'approved', 'partially_paid', 'on_hold', 'disputed'])
    .order('invoice_date', { ascending: false }).limit(50);

  const { data: pays } = await supabase.from('ap_payments')
    .select('check_number, amount_cents, payment_date, payment_method, status')
    .eq('vendor_id', vendorId).neq('status', 'voided')
    .order('payment_date', { ascending: false }).limit(20);

  return { hasData: true, open: open || [], recent_payments: pays || [] };
}

// Find a specific invoice the vendor named (by their invoice number).
async function findVendorInvoice(vendorId, numberText) {
  if (!vendorId || !numberText) return null;
  const target = normInvoiceNo(numberText);
  if (!target) return null;
  const { data } = await supabase.from('ap_invoices')
    .select('id, vendor_invoice_number, invoice_date, due_date, total_cents, amount_paid_cents, status, community:community_id(name)')
    .eq('vendor_id', vendorId).order('invoice_date', { ascending: false }).limit(200);
  return (data || []).find((r) => normInvoiceNo(r.vendor_invoice_number) === target) || null;
}

module.exports = { vendorApStatus, findVendorInvoice, STATUS_PLAIN };
