// ============================================================================
// lib/tax/w9_queue.js  (Issue #14, Ed 2026-10-02): the W-9 compliance queue
// ----------------------------------------------------------------------------
// One row per VENDOR (one W-9 covers a payee everywhere), expandable to the
// associations it is reportable at (each association is its own 1099 filer).
//
// DERIVED, NOT STORED. Every status here is computed from facts that already
// exist: the vendor's 477 fields (w9_on_file, tax_classification, exemption +
// provenance), its W-9 documents (vendor_documents), 2026 reportable payments,
// and open bills. A vendor drops off the queue by itself when the facts satisfy
// the rule; there is no queue table that could disagree with them.
//
// INFORMATIONAL. Nothing here blocks, delays or alters a payment.
//
// Candidates (a W-9 that may exist elsewhere, e.g. an emailed attachment) are
// SHOWN with provenance for a person to review. Nothing is attached, trusted or
// marked on file from detection.
// ============================================================================
const R = require('./info_reporting');
const RP = require('./reportable_payments');
const { fetchAll, fetchAllQuery } = require('../db/fetch_all');

const ACTIONS = {
  review: 'Classification/document review needed',
  government: 'Government exemption needs verification',
  internal: 'Provide Bedrock W-9',
  corporate: 'Corporate exemption candidate: verify W-9',
  candidate: 'W-9 candidate found: review',
  request: 'W-9 request needed',
};
const ACTION_ORDER = ['review', 'government', 'internal', 'corporate', 'candidate', 'request'];
const OPEN_STATUSES = ['awaiting_approval', 'on_hold', 'approved', 'partially_paid'];
const CORP_ONLY_EXEMPT = new Set(['services', 'rents', 'other_income']); // corporate exemption cannot cover the rest

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const STOP = new Set(['llc', 'inc', 'the', 'and', 'services', 'service', 'company', 'corp', 'dba', 'group', 'management', 'pllc', 'ltd']);
const tokens = (s) => norm(s).split(' ').filter((t) => t.length > 2 && !STOP.has(t));
const FREE_MAIL = /(^|\.)(gmail|yahoo|hotmail|outlook|aol|icloud|live|msn)\./;

// A current W-9 document awaiting a person: stored but not yet confirmed, or
// newer than the last confirmation (a replacement W-9 arrived).
function pendingReviewDoc(vendor, currentDoc) {
  if (!currentDoc) return null;
  if (!vendor.w9_on_file || !vendor.tax_classification) return currentDoc;
  const confirmed = vendor.w9_uploaded_at ? Date.parse(vendor.w9_uploaded_at) : 0;
  return Date.parse(currentDoc.uploaded_at || 0) > confirmed + 1000 ? currentDoc : null;
}

// Emailed attachments / unlinked secure-form W-9s that may be this vendor's.
// Confidence comes from STORED contact data, never from the name pattern of the
// vendor's legal form.
function candidatesFor(vendor, attachments) {
  const out = [];
  const vt = tokens(vendor.name);
  const emails = [vendor.email, vendor.contact_email, vendor.account_manager_email].filter(Boolean).map((e) => String(e).toLowerCase().trim());
  const domains = emails.map((e) => e.split('@')[1]).filter((d) => d && !FREE_MAIL.test(d + '.'));
  for (const a of attachments) {
    const from = String(a.sender_email || '').toLowerCase().trim();
    const fn = norm(a.filename);
    const hits = vt.filter((t) => fn.includes(t)).length;
    const nameHit = vt.length > 0 && hits >= Math.min(2, vt.length);
    const emailHit = !!from && emails.includes(from);
    const domHit = !!from && domains.some((d) => from.endsWith('@' + d));
    if (!(emailHit || domHit || nameHit)) continue;
    out.push({
      source: 'email_attachment', attachment_id: a.id, email_message_id: a.email_message_id,
      filename: a.filename, from: a.sender_email || null, received_at: a.created_at || null,
      confidence: emailHit ? 'medium' : domHit ? 'medium' : 'low',
      basis: emailHit ? "sender is the vendor's stored email" : domHit ? "sender's domain matches the vendor's stored email" : 'vendor name appears in the filename only',
    });
  }
  return out;
}

// Pure: the queue from already-loaded facts. Exported for tests.
function buildQueue(f) {
  const { year, vendors, totals, flaggedBills, w9Docs, attachments, ownEntityNames, communityNames, methods, unlinkedSecureForm } = f;
  const docsByVendor = new Map();
  for (const d of w9Docs) { if (!docsByVendor.has(d.vendor_id)) docsByVendor.set(d.vendor_id, []); docsByVendor.get(d.vendor_id).push(d); }
  const openByPair = new Map();
  for (const b of flaggedBills) { const k = b.vendor_id + '|' + b.community_id; if (!openByPair.has(k)) openByPair.set(k, []); openByPair.get(k).push(b); }

  // Which (vendor, association) pairs belong on the queue.
  const pairs = new Map(); // vendor_id -> Set(community_id)
  const addPair = (v, c) => { if (!pairs.has(v)) pairs.set(v, new Set()); pairs.get(v).add(c); };
  for (const k of openByPair.keys()) { const [v, c] = k.split('|'); addPair(v, c); }
  for (const [k, cents] of totals) {
    const [vid, cid, cat] = k.split('|'); const v = vendors.get(vid); if (!v) continue;
    const th = R.thresholdFor(year, cat).cents;
    if (th == null || cents < th) continue;
    if (!R.vendorReportability(v, cat).reportable || R.w9Satisfied(v)) continue;
    addPair(vid, cid);
  }
  // A received W-9 waiting for a person is work even below the threshold.
  for (const [vid, docs] of docsByVendor) {
    const v = vendors.get(vid); if (!v) continue;
    const cur = docs.find((d) => d.is_current !== false);
    if (pendingReviewDoc(v, cur) && !pairs.has(vid)) pairs.set(vid, new Set());
  }

  const rows = [];
  for (const [vid, comms] of pairs) {
    const v = vendors.get(vid); if (!v) continue;
    const docs = docsByVendor.get(vid) || [];
    const current = docs.find((d) => d.is_current !== false) || null;
    const pending = pendingReviewDoc(v, current);
    // For a vendor whose W-9 is under review, list every association it was paid at.
    if (pending) for (const k of totals.keys()) { const [kv, kc] = k.split('|'); if (kv === vid) comms.add(kc); }
    const associations = [...comms].map((cid) => {
      const byCat = RP.totalsByCategory(totals, vid, cid);
      const open = openByPair.get(vid + '|' + cid) || [];
      const openCents = open.reduce((s, b) => s + b.balance_cents, 0);
      return {
        community_id: cid, association: communityNames.get(cid) || null,
        reportable: Object.entries(byCat).map(([category, cents]) => {
          const t = R.thresholdFor(year, category).cents;
          return { category, cents, threshold_cents: t, over: t != null && cents >= t };
        }),
        reportable_cents: Object.values(byCat).reduce((s, x) => s + x, 0),
        open_flagged_bills: open.length, open_flagged_cents: openCents,
        open_statuses: [...new Set(open.map((b) => b.status))],
        autopay: open.some((b) => b.is_ach_autopay === true) || v.auto_pay_ach === true,
        payment_methods: methods.get(vid + '|' + cid) || {},
        crosses_on_payment: open.length > 0 && Object.entries(byCat).every(([c, x]) => { const t = R.thresholdFor(year, c).cents; return t == null || x < t; }),
      };
    }).sort((a, b) => b.reportable_cents - a.reportable_cents);

    const categories = new Set(associations.flatMap((a) => a.reportable.map((r) => r.category)));
    const corpClass = /corporation/i.test(v.tax_classification || '');
    const isOwnEntity = ownEntityNames.has(norm(v.name)); // display label only; never clears or exempts
    const cands = candidatesFor(v, attachments).concat((unlinkedSecureForm || []).filter((u) => u.vendor_id === vid));
    let key;
    if (pending || (v.w9_on_file && !v.tax_classification)) key = 'review';
    else if (v.is_mud === true) key = 'government';
    else if (isOwnEntity) key = 'internal';
    else if (corpClass && [...categories].every((c) => CORP_ONLY_EXEMPT.has(c))) key = 'corporate';
    else if (cands.length) key = 'candidate';
    else key = 'request';

    rows.push({
      vendor_id: vid, vendor: v.name, action_key: key, action: ACTIONS[key],
      w9: {
        on_file: !!v.w9_on_file, classification: v.tax_classification || null, status: v.tax_reporting_status || 'unknown',
        current_document: current ? { id: current.id, uploaded_at: current.uploaded_at, file_name: current.file_name, source: current.source || null } : null,
        pending_review: !!pending, history_count: docs.length,
      },
      flags: { legal_counsel: !!v.is_legal_counsel, medical: !!v.is_medical_provider, mud: !!v.is_mud, own_entity: isOwnEntity },
      name_clue: R.nameClue(v.name) || null,
      candidates: cands,
      associations,
      association_count: associations.length,
      reportable_cents: associations.reduce((s, a) => s + a.reportable_cents, 0),
      open_flagged_bills: associations.reduce((s, a) => s + a.open_flagged_bills, 0),
      open_flagged_cents: associations.reduce((s, a) => s + a.open_flagged_cents, 0),
    });
  }
  rows.sort((a, b) => ACTION_ORDER.indexOf(a.action_key) - ACTION_ORDER.indexOf(b.action_key)
    || (b.open_flagged_bills > 0) - (a.open_flagged_bills > 0) || b.reportable_cents - a.reportable_cents);

  const counts = {};
  for (const k of ACTION_ORDER) counts[k] = { action: ACTIONS[k], vendors: 0, associations: 0 };
  for (const r of rows) { counts[r.action_key].vendors++; counts[r.action_key].associations += r.association_count; }
  return {
    year, vendors: rows, counts,
    // Secure-form W-9s on a request with no vendor record: a person assigns them.
    unassigned_candidates: (unlinkedSecureForm || []).filter((u) => !u.vendor_id),
    totals: {
      vendors: rows.length,
      associations: rows.reduce((s, r) => s + r.association_count, 0),
      with_open_bills: rows.filter((r) => r.open_flagged_bills > 0).length,
      flagged_bills: rows.reduce((s, r) => s + r.open_flagged_bills, 0),
      flagged_cents: rows.reduce((s, r) => s + r.open_flagged_cents, 0),
      reportable_cents: rows.reduce((s, r) => s + r.reportable_cents, 0),
    },
  };
}

const must = (r, what) => { if (r.error) throw Object.assign(new Error(`${what} read failed: ${r.error.message}`), { code: 'w9_queue_read_failed' }); return r.data || []; };

// Loads the facts and builds the queue. Every fact is read ONCE (no per-vendor
// or per-association queries), all reads are paginated and error-checked, and
// independent reads run in parallel:
//   wave 1  communities, vendors (contact + tax fields), the year's payments,
//           open bills, W-9 documents, emailed W-9 candidates, secure-form W-9s,
//           management companies
//   wave 2  reportable totals from the preloaded payments (payment applications
//           + bill categories), and the open bills' categories
//   wave 3  the W-9 flag on open bills (projectBills with the loaded facts: the
//           same code the Payables queue and check run use, no extra reads)
async function loadW9Queue(supabase, { year = new Date().getFullYear() } = {}) {
  const [comms, vrows, taxV, paysAll, open, w9Docs, attachments, sf, own] = await Promise.all([
    fetchAll(supabase, 'communities', { select: RP.COMMUNITY_SCOPE_COLS }),
    fetchAll(supabase, 'vendors', { select: 'id, name, email, contact_email, account_manager_email, auto_pay_ach, w9_uploaded_at' }),
    RP.loadAllVendorsForTax(supabase),
    fetchAllQuery(() => supabase.from('ap_payments').select('id, vendor_id, community_id, amount_cents, payment_method, status, payment_date')
      .gte('payment_date', `${year}-01-01`).lte('payment_date', `${year}-12-31`).in('status', ['pending', 'completed']), { orderBy: 'id' }),
    fetchAllQuery(() => supabase.from('ap_invoices').select('id, vendor_id, community_id, total_cents, amount_paid_cents, status, is_ach_autopay')
      .in('status', OPEN_STATUSES), { orderBy: 'id' }),
    fetchAllQuery(() => supabase.from('vendor_documents').select('*').eq('doc_type', 'w9'), { orderBy: 'id' }),
    supabase.from('email_attachments').select('id, email_message_id, sender_email, filename, created_at')
      .or('filename.ilike.%w-9%,filename.ilike.%w9%,filename.ilike.%w_9%,filename.ilike.%taxpayer%').order('created_at', { ascending: false }).limit(500)
      .then((r) => must(r, 'email attachments')),
    // Secure-form W-9s that never reached vendor_documents (submitted before the
    // canonical-path fix, or on a request with no vendor) are shown as candidates.
    supabase.from('vendor_ach_requests').select('id, vendor_id, vendor_name, w9_doc_name, w9_doc_path, submitted_at, status')
      .not('w9_doc_path', 'is', null).order('submitted_at', { ascending: false }).limit(500).then((r) => must(r, 'secure-form W-9s')),
    supabase.from('management_companies').select('name').then((r) => must(r, 'management companies')),
  ]);

  const communityNames = new Map(comms.map((c) => [c.id, c.name]));
  const outside = RP.outsideFromRows(comms); // books elsewhere + demo tenants
  // (w9_uploaded_at = the last time a person confirmed the W-9; the pending-review test.)
  const vendors = new Map(vrows.map((v) => [v.id, { ...(taxV.get(v.id) || {}), ...v }]));

  const pays = paysAll.filter((p) => !outside.has(p.community_id));
  const methods = new Map();
  for (const p of pays) { const k = p.vendor_id + '|' + p.community_id; const m = methods.get(k) || {}; const pm = p.payment_method || 'unknown'; m[pm] = (m[pm] || 0) + 1; methods.set(k, m); }
  const paidVendorIds = [...new Set(pays.map((p) => p.vendor_id).filter(Boolean))];

  const bills = open.filter((b) => !outside.has(b.community_id))
    .map((b) => ({ ...b, balance_cents: (b.total_cents || 0) - (b.amount_paid_cents || 0) })).filter((b) => b.balance_cents > 0 && b.vendor_id);
  const billVendorIds = [...new Set(bills.map((b) => b.vendor_id))];

  const [totals, billCats] = await Promise.all([
    RP.reportableTotals(supabase, { vendorIds: [...new Set(paidVendorIds.concat(billVendorIds))], year, excluded: outside, payments: paysAll, vendors: taxV }),
    RP.invoiceCategories(supabase, bills.map((b) => b.id)),
  ]);

  // Open bills -> the same W-9 flag the Payables queue and check run show.
  const { projectBills, FLAG } = require('./payment_gate');
  const proj = await projectBills(supabase, bills.map((b) => ({ id: b.id, vendor_id: b.vendor_id, community_id: b.community_id, balance_cents: b.balance_cents })),
    { initiation: 'approve', payment_date: `${year}-12-31`, context: { outside, vendors: taxV, totals, categories: billCats } });
  const flaggedBills = bills.filter((b) => { const e = proj.get(b.id); return e && FLAG.has(e.decision); });

  const linked = new Set(w9Docs.map((d) => d.file_url).filter(Boolean));
  const unlinkedSecureForm = sf.filter((s) => !linked.has(s.w9_doc_path)).map((s) => ({
    source: 'secure_form', vendor_ach_request_id: s.id, vendor_id: s.vendor_id, filename: s.w9_doc_name, from: 'secure W-9 form',
    received_at: s.submitted_at, confidence: s.vendor_id ? 'high' : 'unassigned', basis: s.vendor_id ? 'submitted through the secure link created for this vendor' : 'secure-form W-9 on a request with no vendor record',
  }));

  return buildQueue({
    year, vendors, totals, flaggedBills, w9Docs, attachments, communityNames, methods, unlinkedSecureForm,
    ownEntityNames: new Set(own.map((m) => norm(m.name)).flatMap((n) => [n, norm(n + ' llc')])),
  });
}

module.exports = { loadW9Queue, buildQueue, candidatesFor, pendingReviewDoc, ACTIONS, ACTION_ORDER };
