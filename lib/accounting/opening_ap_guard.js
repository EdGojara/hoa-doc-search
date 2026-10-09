// ============================================================================
// lib/accounting/opening_ap_guard.js  (Ed 2026-10-09)
// ----------------------------------------------------------------------------
// CONVERSION OPENING AP IS A LIABILITY CARRIED THROUGH THE CUTOFF, NOT A
// PAYMENT INSTRUCTION.
//
// Scar: the Canyon Gate conversion (CONV-CGACR-20260731, executed 2026-10-07)
// wrote the 12 invoices open on Vantaca's 7/31 AP aging as 'approved', unpaid,
// not ACH. The check queue lists every approved bill with a balance, so all 12
// ($7,992.75) appeared in Bills ready to pay, pre-ticked, one click from print.
// Nine of them ($2,134.19: CINCO MUD 8 and Gexa, auto-drafted vendors) had
// already been paid by ACH in March-May; Vantaca simply never closed them.
// Lakes of Pine Forest (1) and Quail Ridge (2) had the same exposure.
//
// RULE: an opening AP invoice can be paid only after a person records an
// explicit clearance (opening_ap_payment_clearances, migration 504): it was
// really outstanding at the cutoff, it has not been settled since, and how it
// is to be paid. Until then every payment path refuses it:
//   - Bills ready to pay hides it (listPayableInvoices) and says how many are held;
//   - a check run that includes it is refused before any check number is
//     reserved (createCheckRun);
//   - recordPayment refuses it (the chokepoint behind checks, mark-paid, /payments).
// Nothing here changes the invoice: the liability stays exactly as converted.
//
// PROVENANCE (durable, never the notes text): the invoice's posting entry is a
// conversion opening entry (journal_entries.source_module = 'opening_entry',
// CONV-<code>-OPEN-<fund>), OR the conversion's own write log names it
// (onboarding_execution_writes, write_kind 'ap_opening_invoice'). The opening
// entry covers every conversion so far, including Lakes of Pine Forest, which
// executed before the write log existed.
//
// FAIL CLOSED: a provenance read that errors throws (no list, no run, no
// payment); a clearance read that errors, or a missing clearance table (before
// 504 is applied), means "nothing is cleared", so opening AP stays held.
// ============================================================================

const OPENING_JE_MODULE = 'opening_entry';
const CLEARANCE_TABLE = 'opening_ap_payment_clearances';
const CHUNK = 200;

function chunks(arr) { const out = []; for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK)); return out; }
const missingTable = (e) => !!e && (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|could not find the table/i.test(e.message || ''));

// invoices: [{ id, posting_journal_entry_id }]
// -> Map(invoice_id -> { invoice_id, reference, provenance }) of the HELD ones
//    (opening AP without a standing clearance). Throws if provenance can't be read.
async function openingApHolds(supabase, invoices) {
  const list = (invoices || []).filter((i) => i && i.id);
  const held = new Map();
  if (!list.length) return held;

  // 1. Opening-entry provenance
  const jeIds = [...new Set(list.map((i) => i.posting_journal_entry_id).filter(Boolean))];
  const openingJe = new Map();
  for (const part of chunks(jeIds)) {
    const { data, error } = await supabase.from('journal_entries').select('id, reference, source_module').in('id', part);
    if (error) throw Object.assign(new Error(`opening AP guard: could not read posting entries (${error.message})`), { code: 'opening_ap_guard_unavailable' });
    for (const je of data || []) if (je.source_module === OPENING_JE_MODULE) openingJe.set(je.id, je.reference || null);
  }
  // 2. Conversion write-log provenance
  const logged = new Set();
  for (const part of chunks(list.map((i) => i.id))) {
    const { data, error } = await supabase.from('onboarding_execution_writes').select('row_id')
      .eq('table_name', 'ap_invoices').eq('write_kind', 'ap_opening_invoice').in('row_id', part);
    if (error) throw Object.assign(new Error(`opening AP guard: could not read the conversion write log (${error.message})`), { code: 'opening_ap_guard_unavailable' });
    for (const r of data || []) logged.add(r.row_id);
  }
  const opening = list.filter((i) => openingJe.has(i.posting_journal_entry_id) || logged.has(i.id));
  if (!opening.length) return held;

  // 3. Standing clearances (latest decision per invoice wins)
  const cleared = new Set();
  try {
    for (const part of chunks(opening.map((i) => i.id))) {
      const { data, error } = await supabase.from(CLEARANCE_TABLE).select('invoice_id, decision, created_at')
        .in('invoice_id', part).order('created_at', { ascending: true });
      if (error) {
        if (missingTable(error)) console.warn('[opening_ap_guard] clearance table not present (migration 504 not applied): every opening AP invoice stays held');
        else console.error('[opening_ap_guard] clearance read failed; every opening AP invoice stays held:', error.message);
        cleared.clear();
        break;
      }
      const latest = new Map();
      for (const r of data || []) latest.set(r.invoice_id, r.decision);
      for (const [id, d] of latest) if (d === 'cleared_for_payment') cleared.add(id);
    }
  } catch (e) {
    console.error('[opening_ap_guard] clearance read threw; every opening AP invoice stays held:', e.message);
    cleared.clear();
  }

  for (const i of opening) {
    if (cleared.has(i.id)) continue;
    held.set(i.id, {
      invoice_id: i.id,
      reference: openingJe.get(i.posting_journal_entry_id) || null,
      provenance: openingJe.has(i.posting_journal_entry_id) ? 'opening_entry' : 'conversion_write_log',
    });
  }
  return held;
}

// Refuse a payment that touches any held opening AP invoice. invoices may be
// ids or rows; rows missing posting_journal_entry_id are re-read.
async function assertNoHeldOpeningAp(supabase, invoices) {
  const rows = (invoices || []).filter(Boolean).map((x) => (typeof x === 'string' ? { id: x } : x));
  const need = rows.filter((r) => !('posting_journal_entry_id' in r)).map((r) => r.id);
  const byId = new Map(rows.filter((r) => 'posting_journal_entry_id' in r).map((r) => [r.id, r]));
  for (const part of chunks(need)) {
    const { data, error } = await supabase.from('ap_invoices').select('id, vendor_invoice_number, posting_journal_entry_id').in('id', part);
    if (error) throw Object.assign(new Error(`opening AP guard: could not read the invoices (${error.message})`), { code: 'opening_ap_guard_unavailable' });
    for (const r of data || []) byId.set(r.id, r);
  }
  const held = await openingApHolds(supabase, [...byId.values()]);
  if (!held.size) return;
  const names = [...held.keys()].map((id) => { const r = byId.get(id) || {}; return r.vendor_invoice_number || `invoice ${String(id).slice(0, 8)}`; });
  throw Object.assign(
    new Error(`Conversion opening AP is held from payment until it is reviewed and cleared: ${names.join(', ')}. It is a liability carried through the cutover, not a payment instruction; confirm it was still owed at the cutoff, has not been paid since, and how it is paid, then clear it for payment.`),
    { code: 'opening_ap_not_cleared', invoices: [...held.values()] },
  );
}

module.exports = { openingApHolds, assertNoHeldOpeningAp, OPENING_JE_MODULE, CLEARANCE_TABLE };
