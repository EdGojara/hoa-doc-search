// ============================================================================
// lib/accounting/ap_as_of.js
// ----------------------------------------------------------------------------
// Point-in-time open AP: which vendor invoices were open ON a past date, and
// for how much. The AP aging used the invoice's CURRENT status and paid amount
// for any as_of date (as_of only moved the aging buckets), so a historical
// aging mixed in later payments, voids and invoices. That breaks a conversion
// cutoff: at LOPF's 7/31/2026 cutover, Trusted-native July invoices are
// neutralized in the GL and re-posted effective 8/1, so the 7/31 AP subledger
// must match the GL (only the converted Vantaca open AP).
//
// An invoice is open at date D when:
//   effective   its AP/GL effective date <= D. Effective date = posting date of
//               its GL entry; if a conversion neutralized that entry
//               (CONV-*-NEUT-*), the date of the conversion re-post
//               (CONV-*-REPOST-*); if neutralized with no re-post, never. With
//               no GL entry: invoice_date, but never before the community's
//               gl_cutover_date (a Trusted-native invoice dated before cutover
//               is post-cutover activity; the source system owns pre-cutover AP).
//   not voided  voided only on/before D counts: the void date is the posting
//               date of its GL void reversal (else voided_at).
//   unpaid      total - payments applied with payment_date <= D (non-voided) > 0
// ============================================================================

const day = (v) => (v ? String(v).slice(0, 10) : null);

function openApAsOf({ invoices, jesById, applications, paymentsById, asOf, cutoverDate = null }) {
  const neutralized = {}; // original JE id -> true
  const repostDate = {};  // original JE id -> re-post posting_date
  for (const je of Object.values(jesById)) {
    if (/^CONV-.*-NEUT-/.test(je.reference || '') && je.reverses_je_id) neutralized[je.reverses_je_id] = true;
    if (/^CONV-.*-REPOST-/.test(je.reference || '') && je.source_reference) repostDate[je.source_reference] = je.posting_date;
  }
  const paidByInvoice = {};
  for (const a of applications) {
    const p = paymentsById[a.payment_id];
    if (!p || p.status === 'voided' || day(p.payment_date) > asOf) continue;
    paidByInvoice[a.invoice_id] = (paidByInvoice[a.invoice_id] || 0) + Number(a.applied_cents || 0);
  }
  const rows = [];
  for (const inv of invoices) {
    // Reviewed as already in the converted books (mig 458): the certified
    // package carries it; it is never open AP in Trusted.
    if (inv.cutover_review === 'ALREADY_IN_CONVERTED_BOOKS') continue;
    const je = inv.posting_journal_entry_id ? jesById[inv.posting_journal_entry_id] : null;
    let effective;
    if (!je) {
      effective = day(inv.invoice_date);
      if (effective && cutoverDate && effective < cutoverDate) effective = cutoverDate;
    }
    else if (neutralized[je.id]) effective = repostDate[je.id] || null;
    else effective = day(je.posting_date);
    if (!effective || effective > asOf) continue;
    if (inv.status === 'voided') {
      const rev = je && je.void_reversal_je_id ? jesById[je.void_reversal_je_id] : null;
      const voidDate = rev ? day(rev.posting_date) : day(inv.voided_at);
      if (!voidDate || voidDate <= asOf) continue;
    }
    const balance = Number(inv.total_cents) - (paidByInvoice[inv.id] || 0);
    if (balance > 0) rows.push({ ...inv, effective_date: effective, balance_cents: balance });
  }
  return rows;
}

async function pageAll(supabase, table, cols, apply) {
  const out = [];
  for (let f = 0; ; f += 1000) {
    let q = supabase.from(table).select(cols).order('id').range(f, f + 999);
    if (apply) q = apply(q);
    const { data, error } = await q;
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function loadOpenApAsOf(supabase, cid, asOf, vendorId = null) {
  const invoices = await pageAll(supabase, 'ap_invoices',
    'id, vendor_id, vendor_invoice_number, invoice_date, due_date, total_cents, amount_paid_cents, status, voided_at, posting_journal_entry_id, cutover_review, vendors:vendor_id(name, category)',
    (q) => (vendorId ? q.eq('community_id', cid).eq('vendor_id', vendorId) : q.eq('community_id', cid)));
  const { data: com, error: cErr } = await supabase.from('communities').select('gl_cutover_date').eq('id', cid).single();
  if (cErr) throw cErr;
  const jes = await pageAll(supabase, 'journal_entries', 'id, reference, posting_date, status, reverses_je_id, void_reversal_je_id, source_reference', (q) => q.eq('community_id', cid));
  const jesById = Object.fromEntries(jes.map((j) => [j.id, j]));
  const ids = invoices.map((i) => i.id);
  const applications = [];
  for (let i = 0; i < ids.length; i += 150) applications.push(...(await pageAll(supabase, 'ap_payment_applications', 'id, payment_id, invoice_id, applied_cents', (q) => q.in('invoice_id', ids.slice(i, i + 150)))));
  const payIds = [...new Set(applications.map((a) => a.payment_id))];
  const payments = [];
  for (let i = 0; i < payIds.length; i += 150) payments.push(...(await pageAll(supabase, 'ap_payments', 'id, payment_date, status', (q) => q.in('id', payIds.slice(i, i + 150)))));
  return openApAsOf({ invoices, jesById, applications, paymentsById: Object.fromEntries(payments.map((p) => [p.id, p])), asOf, cutoverDate: com.gl_cutover_date || null });
}

module.exports = { openApAsOf, loadOpenApAsOf };
