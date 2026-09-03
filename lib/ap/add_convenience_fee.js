// ============================================================================
// lib/ap/add_convenience_fee.js  (Ed 2026-09-03)
// ----------------------------------------------------------------------------
// Manually add the (usually $1) convenience fee to an EXISTING invoice, so staff
// can fix one the auto path missed WITHOUT waiting — and so a backfill can sweep
// the payables queue. ONE code path, shared by the AP button and the backfill
// script, so the two can't drift.
//
// What it does:
//   - bumps the invoice total (+ subtotal when tracked) by the fee
//   - folds the fee into the largest line so lines still sum to the total
//   - appends an auditable note naming who added it
//   - if the invoice already ACCRUED to the GL (posting_journal_entry_id) and is
//     coded, posts a small SUPPLEMENTAL accrual for the delta
//     (Dr coded expense / Cr A/P) — never reverses/reposts the whole entry
//   - IDEMPOTENT: refuses if the invoice already carries a convenience fee, so a
//     double-click or a re-run can't add it twice
//
// The auto path (lib/ap/convenience_fee.js) applies the fee at intake from the
// vendor's is_mud / convenience_fee_cents setting; this is the manual sibling
// for after-the-fact corrections. (Ed 2026-09-03.)
// ============================================================================

const FEE_MARKER = /convenience fee/i;

async function findApAccount(supabase, communityId) {
  for (const num of ['20100', '2000']) {
    const { data } = await supabase.from('chart_of_accounts').select('id')
      .eq('community_id', communityId).eq('account_number', num).eq('is_active', true).maybeSingle();
    if (data) return data;
  }
  const { data } = await supabase.from('chart_of_accounts').select('id')
    .eq('community_id', communityId).ilike('account_name', '%accounts payable%').eq('is_active', true).limit(1).maybeSingle();
  return data || null;
}

async function addConvenienceFeeToInvoice(supabase, { invoiceId, amountCents, by }) {
  const { data: inv, error } = await supabase.from('ap_invoices')
    .select('id, community_id, vendor_id, total_cents, subtotal_cents, status, notes, posting_journal_entry_id, coded_gl_account_id, invoice_date, vendor_invoice_number')
    .eq('id', invoiceId).maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!inv) return { ok: false, error: 'not_found' };
  if (['voided', 'paid'].includes(inv.status)) return { ok: false, error: 'invoice_' + inv.status };
  if (inv.notes && FEE_MARKER.test(inv.notes)) return { ok: true, already: true, total_cents: inv.total_cents };

  // fee: explicit amount wins, else the vendor's configured fee, else $1.
  let fee = Number(amountCents) || 0;
  if (!fee && inv.vendor_id) {
    const { data: v } = await supabase.from('vendors').select('convenience_fee_cents').eq('id', inv.vendor_id).maybeSingle();
    fee = Number(v && v.convenience_fee_cents) || 0;
  }
  if (!fee) fee = 100;

  const newTotal = Number(inv.total_cents || 0) + fee;
  const who = (by && String(by).trim()) || 'staff';
  const stamp = new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago' });
  const note = `${inv.notes ? inv.notes.trim() + ' — ' : ''}Added $${(fee / 100).toFixed(2)} convenience fee (manual adjustment by ${who} on ${stamp}).`;

  const patch = { total_cents: newTotal, notes: note, updated_at: new Date().toISOString() };
  if (Number(inv.subtotal_cents) > 0) patch.subtotal_cents = Number(inv.subtotal_cents) + fee;
  const { error: uErr } = await supabase.from('ap_invoices').update(patch).eq('id', inv.id);
  if (uErr) return { ok: false, error: uErr.message };

  // Fold into the largest line so the lines still sum to the (new) total.
  try {
    const { data: lines } = await supabase.from('ap_invoice_lines')
      .select('id, amount_cents').eq('invoice_id', inv.id).order('amount_cents', { ascending: false }).limit(1);
    if (lines && lines.length) {
      await supabase.from('ap_invoice_lines').update({ amount_cents: Number(lines[0].amount_cents || 0) + fee }).eq('id', lines[0].id);
    }
  } catch (_) { /* line display only; the GL delta is handled below */ }

  // If the bill already accrued, post the delta as its own small entry so the
  // books move with the total. Uncoded/unposted bills accrue the new total when
  // they're posted, so nothing to do there.
  let jePosted = false;
  if (inv.posting_journal_entry_id && inv.coded_gl_account_id) {
    try {
      const ap = await findApAccount(supabase, inv.community_id);
      if (!ap) return { ok: true, total_cents: newTotal, fee, je_warning: 'no A/P account for community — fee recorded on the invoice but not accrued' };
      const { postJournalEntry } = require('../accounting/posting');
      await postJournalEntry({
        community_id: inv.community_id,
        posting_date: String(inv.invoice_date || new Date().toISOString()).slice(0, 10),
        description: `Convenience fee — ${inv.vendor_invoice_number || 'invoice'}`,
        source_module: 'ap_invoice', source_reference: `convfee:${inv.id}`,
        notes: `$${(fee / 100).toFixed(2)} convenience fee adjustment`,
        lines: [
          { account_id: inv.coded_gl_account_id, debit_cents: fee, credit_cents: 0, memo: 'Convenience fee', vendor_id: inv.vendor_id },
          { account_id: ap.id, debit_cents: 0, credit_cents: fee, memo: 'AP — convenience fee', vendor_id: inv.vendor_id },
        ],
      });
      jePosted = true;
    } catch (e) {
      return { ok: true, total_cents: newTotal, fee, je_warning: e.message };
    }
  }
  return { ok: true, total_cents: newTotal, fee, je_posted: jePosted };
}

module.exports = { addConvenienceFeeToInvoice };
