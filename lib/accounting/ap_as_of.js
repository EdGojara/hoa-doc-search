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
//   unpaid      total - payments applied with payment_date <= D, excluding payments
//               voided on/before D (a payment voided after D still paid it at D) > 0
//   re-posts    CONV-*-REPOST-* and CONV-*-RECLASS-* both set the effective date; a
//               neutralization "already in the source position" with no re-post is
//               carried as open AP from the conversion date (Ed 2026-10-12)
// ============================================================================

const day = (v) => (v ? String(v).slice(0, 10) : null);

function openApAsOf({ invoices, jesById, applications, paymentsById, asOf, cutoverDate = null }) {
  const neutralized = {}; // original JE id -> the neutralizing entry
  const repostDate = {};  // original JE id -> re-post posting_date
  for (const je of Object.values(jesById)) {
    if (/^CONV-.*-NEUT-/.test(je.reference || '') && je.reverses_je_id) neutralized[je.reverses_je_id] = je;
    // A conversion RECLASS (an accrual moved into AP at the cutover) re-posts the
    // invoice exactly as a REPOST does (Canyon Gate D&F 278002, Ed 2026-10-12).
    if (/^CONV-.*-(REPOST|RECLASS)-/.test(je.reference || '') && je.source_reference) repostDate[je.source_reference] = je.posting_date;
  }
  // "Already in the source position": the converted opening balance carries THIS
  // invoice as open AP at the conversion date (no second invoice exists), so it is
  // open from that date until paid (Canyon Gate A-Beautiful Pools, paid 9/28).
  const carriedFrom = (n) => {
    if (!n || !/already in the source position/i.test(n.description || '')) return null;
    const m = /^CONV-[A-Z0-9]+-(\d{4})(\d{2})(\d{2})-/.exec(n.reference || '');
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  };
  const paidByInvoice = {};
  for (const a of applications) {
    const p = paymentsById[a.payment_id];
    // A payment voided AFTER the as-of date still paid the invoice on that date.
    const voidedBy = p && p.status === 'voided' ? (day(p.void_date) || day(p.voided_at)) : null;
    if (!p || (p.status === 'voided' && (!voidedBy || voidedBy <= asOf)) || day(p.payment_date) > asOf) continue;
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
    else if (neutralized[je.id]) effective = repostDate[je.id] || carriedFrom(neutralized[je.id]);
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
  const jes = await pageAll(supabase, 'journal_entries', 'id, reference, posting_date, status, reverses_je_id, void_reversal_je_id, source_reference, description', (q) => q.eq('community_id', cid));
  const jesById = Object.fromEntries(jes.map((j) => [j.id, j]));
  const ids = invoices.map((i) => i.id);
  const applications = [];
  for (let i = 0; i < ids.length; i += 150) applications.push(...(await pageAll(supabase, 'ap_payment_applications', 'id, payment_id, invoice_id, applied_cents', (q) => q.in('invoice_id', ids.slice(i, i + 150)))));
  const payIds = [...new Set(applications.map((a) => a.payment_id))];
  const payments = [];
  for (let i = 0; i < payIds.length; i += 150) payments.push(...(await pageAll(supabase, 'ap_payments', 'id, payment_date, status, voided_at, posting_journal_entry_id', (q) => q.in('id', payIds.slice(i, i + 150)))));
  // A voided payment's void date is the posting date of its GL void reversal (else voided_at).
  for (const p of payments) { const pj = p.posting_journal_entry_id && jesById[p.posting_journal_entry_id]; const rv = pj && pj.void_reversal_je_id && jesById[pj.void_reversal_je_id]; p.void_date = rv ? rv.posting_date : null; }
  return openApAsOf({ invoices, jesById, applications, paymentsById: Object.fromEntries(payments.map((p) => [p.id, p])), asOf, cutoverDate: com.gl_cutover_date || null });
}

module.exports = { openApAsOf, loadOpenApAsOf };
