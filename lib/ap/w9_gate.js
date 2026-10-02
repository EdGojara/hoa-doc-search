// ============================================================================
// lib/ap/w9_gate.js  (Issue #14, Ed 2026-10-01): no W-9, no approval, no payment
// ----------------------------------------------------------------------------
// A payee that is not exempt and has no W-9 on file (vendors.w9_on_file) cannot
// be approved (manager key or admin release) or paid (check run, check, ACH or
// card recorded, early prepay). This is enforced on the SERVER at every path,
// so changing a status or skipping the UI cannot get around it; `on_hold` alone
// was only a label.
//
// Exempt ONLY from data already on the vendor record, never from the name:
//   * is_mud = true   -> a government utility district (MUD); not a W-9 payee.
// Nothing else is exempt today: tax_classification is set only by reading a
// W-9 (lib/vendors/w9_extract.js), so it cannot exempt a vendor that has none.
// There is NO override. No approved override policy exists; one is proposed on
// Issue #14 for Ed's decision rather than invented here.
//
// Historical records are not touched: the gate only refuses NEW approvals and
// payments. Voiding a check (which reduces what was paid) is not gated.
// ============================================================================

// Pure: may this vendor be approved / paid? -> { ok, reason, exempt }
function w9Status(vendor) {
  if (!vendor) return { ok: false, reason: 'no vendor on the bill' };
  if (vendor.w9_on_file === true) return { ok: true, reason: null, exempt: null };
  if (vendor.is_mud === true) return { ok: true, reason: null, exempt: 'government utility district (MUD)' };
  return { ok: false, reason: `${vendor.name || 'This vendor'} has no W-9 on file` };
}

const BLOCK_DETAIL = (names) => `W-9 required: ${names.join(', ')} ${names.length === 1 ? 'has' : 'have'} no W-9 on file. Get the vendor's W-9 and upload it on the vendor record (Vendors → the vendor → W-9), then approve or pay. This cannot be bypassed by changing the bill's status.`;

// Load the vendors behind these invoice ids and refuse if any is blocked.
// Throws { code: 'w9_required', detail, blocked: [{ invoice_id, vendor_id, vendor_name }] }.
async function assertW9Cleared(supabase, invoiceIds) {
  const ids = [...new Set((invoiceIds || []).filter(Boolean))];
  if (!ids.length) return { ok: true };
  const { data: invs, error } = await supabase.from('ap_invoices').select('id, vendor_id').in('id', ids);
  if (error) throw Object.assign(new Error(`W-9 check failed: ${error.message}`), { code: 'w9_check_failed' });
  const vids = [...new Set((invs || []).map((i) => i.vendor_id).filter(Boolean))];
  const vendors = new Map();
  if (vids.length) {
    const { data: vs, error: ve } = await supabase.from('vendors').select('id, name, w9_on_file, is_mud').in('id', vids);
    if (ve) throw Object.assign(new Error(`W-9 check failed: ${ve.message}`), { code: 'w9_check_failed' });
    (vs || []).forEach((v) => vendors.set(v.id, v));
  }
  const blocked = [];
  for (const id of ids) {
    const inv = (invs || []).find((i) => i.id === id);
    const v = inv && inv.vendor_id ? vendors.get(inv.vendor_id) : null;
    const st = w9Status(v);
    if (!st.ok) blocked.push({ invoice_id: id, vendor_id: inv ? inv.vendor_id : null, vendor_name: (v && v.name) || null, reason: st.reason });
  }
  if (blocked.length) {
    const names = [...new Set(blocked.map((b) => b.vendor_name || 'a bill with no vendor'))];
    throw Object.assign(new Error(`w9_required: ${BLOCK_DETAIL(names)}`), { code: 'w9_required', detail: BLOCK_DETAIL(names), blocked });
  }
  return { ok: true };
}

module.exports = { w9Status, assertW9Cleared, BLOCK_DETAIL };
