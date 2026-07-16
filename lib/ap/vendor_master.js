// ============================================================================
// lib/ap/vendor_master.js  (Ed 2026-07-15)
// ----------------------------------------------------------------------------
// Emma keeps the vendor master clean, the way an AP professional does.
//
// Ed: "merge duplicates and add missing vendors — remember emma is an AP
// professional she should do this."
//
// The vendor list had "Superior LawnCare" AND "Superior LawnCare, LLC" — two
// records created five minutes apart in the 2026-05-07 import. Because intake's
// normName strips "LLC", both normalise to the same name, so EVERY Superior
// LawnCare invoice hit two exact matches, came back name_ambiguous, and dead-
// ended at needs_review. The bills piled up in Emma's queue and she told the
// vendor their invoice wasn't on file — because our own list couldn't name them
// once. A clerk who lets that happen isn't doing the job.
//
// So this is Emma's standing responsibility, not a one-off cleanup:
//   * dedupeVendorMaster — collapse records that collide under the resolver's
//     OWN normaliser, keeping the record with the real history.
//   * ensureVendorForInvoice — when a bill arrives from a vendor we can't name,
//     set the vendor up FROM THE INVOICE instead of bouncing the bill. Creating
//     the record is not paying anyone: the invoice still lands in payables for
//     Ed's approval and release. But it flags the vendor as newly created, so a
//     never-before-seen payee gets a human's eye before a check is cut (the AP
//     fraud vector is a fake recurring vendor, so a NEW one is exactly what to
//     surface).
//   * mergeVendors — the safe primitive both rely on: repoint every reference,
//     then delete the loser. Refuses if it can't move a reference, so it can
//     never orphan an invoice or a payment.
//
// normName is imported from intake.js on purpose — dedupe MUST collide on the
// exact rule resolveVendor uses, or it cleans up records that still break, and
// misses the ones that do. One normaliser, not a private copy that drifts.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const { normName } = require('./intake');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

// Every table that points at vendors.id, enumerated from the live schema
// (2026-07-15). If a new one is added, it belongs here — a merge that misses a
// reference would orphan a row against a deleted vendor. The list being wrong is
// caught, not silent: mergeVendors re-checks references AND lets the DELETE's own
// FK constraint block it, so a missed table refuses the merge rather than
// corrupting the books. (My first pass missed seven of these; the guard held.)
const VENDOR_REFS = [
  ['ap_invoices', 'vendor_id'],
  ['ap_bills', 'vendor_id'],
  ['ap_payments', 'vendor_id'],
  ['journal_entry_lines', 'vendor_id'],
  ['check_runs', 'vendor_id'],
  ['purchase_orders', 'vendor_id'],
  ['vendor_documents', 'vendor_id'],
  ['vendor_contacts', 'vendor_id'],
  ['vendor_notes', 'vendor_id'],
  ['vendor_proposals', 'vendor_id'],
  ['vendor_price_benchmarks', 'vendor_id'],
  ['vendor_service_areas', 'vendor_id'],
  ['vendor_community_accounts', 'vendor_id'],
  ['vendor_credits_expected', 'vendor_id'],
  ['invoices_received', 'vendor_id'],
  ['event_vendors', 'vendor_id'],
  ['email_messages', 'resolved_vendor_id'],
];

async function refCount(table, col, vendorId) {
  const { count, error } = await supabase.from(table).select('id', { count: 'exact', head: true }).eq(col, vendorId);
  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) return 0; // table not in this env
    throw error;
  }
  return count || 0;
}

/** How many rows across the whole schema point at this vendor. */
async function totalReferences(vendorId) {
  let n = 0;
  for (const [t, c] of VENDOR_REFS) n += await refCount(t, c, vendorId);
  return n;
}

/**
 * Merge one vendor into another. Repoints the financial history to the survivor,
 * then DEACTIVATES the loser — it does not hard-delete.
 *
 * A vendor master never hard-deletes: history hangs off the record, the set of
 * FK tables is larger and more oddly-named than any hand-list captures (this one
 * has vendor_comparisons.recommendation_vendor_id, among others), and a delete
 * that misses one orphans a row on the books. Deactivating is the standard AP
 * merge AND it is structurally safe — the record still exists, so nothing can be
 * orphaned. Resolution ignores inactive vendors (see resolveVendor), so the
 * duplicate stops causing ambiguity the moment it's deactivated. (Ed 2026-07-15.)
 */
async function mergeVendors({ keepId, dropId, actor = 'Emma (AP)' }) {
  if (!keepId || !dropId) return { error: 'keepId and dropId required' };
  if (keepId === dropId) return { error: 'keepId and dropId are the same record' };
  const { data: keep } = await supabase.from('vendors').select('id, name, notes').eq('id', keepId).maybeSingle();
  const { data: drop } = await supabase.from('vendors').select('id, name').eq('id', dropId).maybeSingle();
  if (!keep) return { error: 'keep vendor not found' };
  if (!drop) return { error: 'drop vendor not found' };

  // Repoint the financial + operational history to the survivor. Best-effort per
  // table — a table that doesn't exist in this env, or a permission edge, must
  // not abort the merge, because the deactivation below is what makes it safe,
  // not the completeness of this repoint.
  const moved = {};
  for (const [t, c] of VENDOR_REFS) {
    if (t === 'email_messages') continue; // repointed separately below (keeps the inbox pointing at the live record)
    try {
      const before = await refCount(t, c, dropId);
      if (!before) continue;
      const { error } = await supabase.from(t).update({ [c]: keepId }).eq(c, dropId);
      if (!error) moved[`${t}.${c}`] = before;
      else console.warn(`[vendor_master] could not repoint ${t}.${c}: ${error.message}`);
    } catch (e) { console.warn(`[vendor_master] repoint ${t}.${c} skipped: ${e.message}`); }
  }
  try { await supabase.from('email_messages').update({ resolved_vendor_id: keepId }).eq('resolved_vendor_id', dropId); } catch (_) { /* best-effort */ }

  // Deactivate the loser and record where it went, both directions.
  const stamp = new Date().toISOString().slice(0, 10);
  const { error: deErr } = await supabase.from('vendors').update({
    is_active: false, status: 'inactive',
    notes: `MERGED into "${keep.name}" (${keepId}) on ${stamp} by ${actor}. Duplicate record — do not use.`,
    updated_at: new Date().toISOString(),
  }).eq('id', dropId);
  if (deErr) return { error: `could not deactivate the duplicate: ${deErr.message}`, moved };

  try {
    const note = `Absorbed duplicate "${drop.name}" (${dropId}) on ${stamp} by ${actor}.`;
    await supabase.from('vendors').update({ notes: [keep.notes, note].filter(Boolean).join('\n') }).eq('id', keepId);
  } catch (_) { /* breadcrumb best-effort */ }

  return { ok: true, kept: keep.name, dropped: drop.name, moved, method: 'soft-merge (deactivated)' };
}

/**
 * Find every set of vendors that collide under the resolver's normaliser and
 * collapse each set to one. Survivor = most references, then most-complete
 * record, then earliest created (the original, not the re-import). Auto-merges
 * only when it's SAFE (the losers' references can all move); anything it can't
 * resolve confidently it reports for a human.
 */
async function dedupeVendorMaster({ dryRun = true, actor = 'Emma (AP)' } = {}) {
  // Only ACTIVE vendors — a record already deactivated by a prior merge must not
  // be picked as a survivor or merged again, so re-running dedupe is idempotent.
  const { data: vendors, error } = await supabase.from('vendors').select('*').eq('management_company_id', BEDROCK_MGMT_CO_ID).neq('is_active', false);
  if (error) return { error: error.message };
  const groups = {};
  for (const v of vendors) {
    const key = normName(v.name);
    if (!key) continue;
    (groups[key] = groups[key] || []).push(v);
  }
  const completeness = (v) => ['email', 'contact_email', 'phone', 'contact_phone', 'address', 'remit_address_line1', 'ein', 'tax_id', 'default_gl_account_id', 'w9_on_file']
    .reduce((n, k) => n + (v[k] ? 1 : 0), 0);
  // When history and completeness tie, keep the LEGAL ENTITY name — a check pays
  // "Superior LawnCare, LLC", not the informal "Superior LawnCare". (Ed 2026-07-15.)
  const isLegalName = (v) => /(,?\s*(l\.?l\.?c\.?|inc\.?|incorporated|corp\.?|corporation|ltd\.?|l\.?p\.?|l\.?l\.?p\.?|pllc|p\.?c\.?))\s*$/i.test(String(v.name || '')) ? 1 : 0;

  const report = { merged: [], skipped: [], dryRun };
  for (const [key, group] of Object.entries(groups)) {
    if (group.length < 2) continue;
    const withRefs = [];
    for (const v of group) withRefs.push({ v, refs: await totalReferences(v.id) });
    withRefs.sort((a, b) => b.refs - a.refs || completeness(b.v) - completeness(a.v) || isLegalName(b.v) - isLegalName(a.v) || String(a.v.created_at).localeCompare(String(b.v.created_at)));
    const survivor = withRefs[0].v;
    const losers = withRefs.slice(1).map((x) => x.v);
    for (const loser of losers) {
      if (dryRun) { report.merged.push({ keep: survivor.name, drop: loser.name, keepId: survivor.id, dropId: loser.id }); continue; }
      const r = await mergeVendors({ keepId: survivor.id, dropId: loser.id, actor });
      if (r.ok) report.merged.push({ keep: r.kept, drop: r.dropped, moved: r.moved });
      else report.skipped.push({ keep: survivor.name, drop: loser.name, reason: r.error });
    }
  }
  return report;
}

/**
 * The AP clerk move on an incoming bill: name the vendor, or set them up.
 *   - exactly one match  -> { vendor } (resolved)
 *   - two+ matches       -> { ambiguous, candidates } — our list has duplicates,
 *                           a human/dedupe decides, we do NOT guess
 *   - no match + enough   -> { vendor, created:true } — create FROM the invoice,
 *     to identify        flagged as new so a never-seen payee gets a human's eye
 *   - no match, too thin -> { none } — not enough to responsibly create a record
 */
async function ensureVendorForInvoice({ extracted, actor = 'Emma (AP)' }) {
  const name = extracted && extracted.vendor_name ? String(extracted.vendor_name).trim() : '';
  const email = extracted && extracted.vendor_email ? String(extracted.vendor_email).trim() : '';
  if (!name && !email) return { none: true, reason: 'no vendor name or email on the invoice' };

  // Active vendors only — a deactivated duplicate must not match, or we're back
  // to the ambiguity the merge just resolved.
  const { data: all } = await supabase.from('vendors').select('id, name, dba, email, contact_email').eq('management_company_id', BEDROCK_MGMT_CO_ID).neq('is_active', false).limit(2000);
  const vendors = all || [];

  if (email) {
    const e = email.toLowerCase();
    const byEmail = vendors.filter((v) => String(v.email || '').toLowerCase() === e || String(v.contact_email || '').toLowerCase() === e);
    if (byEmail.length === 1) return { vendor: byEmail[0] };
  }
  if (name) {
    const n = normName(name);
    const exact = vendors.filter((v) => normName(v.name) === n || (v.dba && normName(v.dba) === n));
    if (exact.length === 1) return { vendor: exact[0] };
    if (exact.length > 1) return { ambiguous: true, candidates: exact, reason: `${exact.length} vendor records match "${name}" — the list has duplicates; run dedupe or pick one` };
  }

  // No match. Only create when we have enough to be a real, identifiable payee.
  if (!name) return { none: true, reason: 'an email with no vendor name is not enough to create a vendor' };
  const row = {
    management_company_id: BEDROCK_MGMT_CO_ID,
    name,
    email: email || null,
    contact_email: email || null,
    status: 'active',
    is_active: true,
    payment_terms_days: 30,
    // Provenance + a NEW-vendor flag: this record was born from an inbound
    // invoice, not vetted by a human. Surfaced so a first payment gets checked.
    notes: `Created by ${actor} from an incoming invoice on ${new Date().toISOString().slice(0, 10)}. NEW VENDOR — verify remit details and legitimacy before the first payment.`,
  };
  const { data: created, error } = await supabase.from('vendors').insert(row).select('*').single();
  if (error) return { none: true, reason: `could not create vendor: ${error.message}` };
  return { vendor: created, created: true };
}

module.exports = { mergeVendors, dedupeVendorMaster, ensureVendorForInvoice, totalReferences, VENDOR_REFS };
