// ============================================================================
// lib/ap/duplicate_vendors.js  (Ed 2026-09-08)
// ----------------------------------------------------------------------------
// Duplicate ACTIVE vendor records are the recurring silent blocker in AP: when
// intake finds two+ records matching a bill's vendor it won't guess, so the bill
// falls to the exception queue and sits. S&L Solutions had 2, Versatex had 4 —
// the $82,640 Versatex bill was stuck behind them.
//
// This finds groups of active vendors that normalize to the SAME name so they can
// be merged BEFORE they block an invoice, instead of cleaning up after. Merge =
// move the dupes' invoices onto one canonical record and deactivate the rest
// (resolveVendor ignores inactive, the designed dedup — see lib/ap/intake.js).
// ============================================================================
const { normName } = require('./intake');

// Reimbursement payees (a board member paid back) are keyed on person name and
// legitimately repeat across communities — never treat them as vendor dupes.
async function findDuplicateVendorGroups(supabase, { managementCompanyId } = {}) {
  let q = supabase.from('vendors')
    .select('id, name, dba, kind, is_active, remit_address_line1, remit_city, created_at')
    .neq('is_active', false);
  if (managementCompanyId) q = q.eq('management_company_id', managementCompanyId);
  const { data: vendors, error } = await q.limit(5000);
  if (error) throw error;
  const real = (vendors || []).filter((v) => v.kind !== 'reimbursement' && v.name);

  const byNorm = new Map();
  for (const v of real) {
    const n = normName(v.name);
    if (!n) continue;
    if (!byNorm.has(n)) byNorm.set(n, []);
    byNorm.get(n).push(v);
  }

  const groups = [];
  for (const [n, vs] of byNorm) {
    if (vs.length < 2) continue; // only actual duplicates
    const members = [];
    for (const v of vs) {
      const { count } = await supabase.from('ap_invoices').select('id', { count: 'exact', head: true }).eq('vendor_id', v.id);
      members.push({ id: v.id, name: v.name, invoice_count: count || 0, has_address: !!(v.remit_address_line1 || v.remit_city), created_at: v.created_at });
    }
    // Canonical = the record most worth keeping: has a mailable address first,
    // then the most invoice history, then the oldest record.
    members.sort((a, b) => (Number(b.has_address) - Number(a.has_address))
      || (b.invoice_count - a.invoice_count)
      || (new Date(a.created_at || 0) - new Date(b.created_at || 0)));
    groups.push({ norm: n, name: vs[0].name, count: members.length, vendors: members, suggested_primary_id: members[0].id });
  }
  return groups.sort((a, b) => b.count - a.count);
}

async function mergeVendorGroup(supabase, { primaryId, dupeIds, resolvedBy }) {
  if (!primaryId || !Array.isArray(dupeIds) || !dupeIds.length) throw new Error('primary_and_dupes_required');
  if (dupeIds.includes(primaryId)) throw new Error('primary_cannot_be_a_dupe');
  let moved = 0;
  for (const d of dupeIds) {
    const { data } = await supabase.from('ap_invoices').update({ vendor_id: primaryId }).eq('vendor_id', d).select('id');
    moved += (data || []).length;
    // repoint any open intake exceptions' suggested vendor too
    try { await supabase.from('ap_intake_exceptions').update({ suggested_vendor_id: primaryId }).eq('suggested_vendor_id', d); } catch (_) {}
  }
  await supabase.from('vendors')
    .update({ is_active: false, notes: `Merged duplicate into ${primaryId} (${resolvedBy || 'staff'} ${new Date().toISOString().slice(0, 10)})` })
    .in('id', dupeIds);
  return { moved, deactivated: dupeIds.length };
}

module.exports = { findDuplicateVendorGroups, mergeVendorGroup };
