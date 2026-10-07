// ============================================================================
// api/ap_intake.js  (Ed 2026-07-08) — mounted at /api/ap-intake
// ----------------------------------------------------------------------------
// Emma's AP invoice intake. Every channel funnels through here so duplicates
// are caught no matter how a bill arrives (email, upload, or physical scan).
//
//   POST /ingest            drop/receive a PDF -> extract + dedup PREVIEW (no DB write)
//   POST /commit            operator-confirmed vendor+community -> load to ap_invoices
//   GET  /queue             review queue: awaiting_approval + suspected-duplicate holds
//   POST /:id/confirm-unique     clear a suspected-duplicate hold -> awaiting_approval
//   POST /:id/confirm-duplicate  void a suspected/confirmed duplicate
//   GET  /vendors?q=        vendor search for the picker
//   GET  /communities       community list for the picker
// Admin-only (owner beta).
// ============================================================================
const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { stageInvoice, resolveVendor, resolveCommunity, commitInvoice } = require('../lib/ap/intake');
const { findDuplicates } = require('../lib/ap/dedup');
const { requireAdmin, requireStaff } = require('./_require_admin');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const router = express.Router();

// POST /ingest — extract + dedup preview. No DB write; operator confirms on /commit.
router.post('/ingest', upload.single('pdf'), async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF uploaded (field "pdf").' });
    if (req.file.mimetype !== 'application/pdf') return res.status(400).json({ error: `Unsupported type: ${req.file.mimetype}` });

    const { extracted, sha256, storagePath } = await stageInvoice(req.file.buffer, req.file.originalname);
    extracted._filename = req.file.originalname || null;

    const v = await resolveVendor({ name: extracted.vendor_name, email: extracted.vendor_email });
    const bodyCommunity = req.body && req.body.community_id;
    let community = null, communityCandidates = [];
    if (bodyCommunity) { const { data } = await supabase.from('communities').select('id, name').eq('id', bodyCommunity).maybeSingle(); community = data || null; }
    else { const c = await resolveCommunity(extracted.community_hint); community = c.community; communityCandidates = c.candidates; }

    // Dedup preview only when we can key it (needs vendor + community).
    let dedup = { verdict: 'unknown', matches: [] };
    if (v.vendor && community) {
      dedup = await findDuplicates(supabase, {
        communityId: community.id, vendorId: v.vendor.id, invoiceNumber: extracted.invoice_number,
        totalCents: extracted.total_cents, invoiceDate: extracted.invoice_date, fileSha256: sha256,
      });
      // hydrate match display names
      for (const m of dedup.matches) m.invoice.vendor_name = v.vendor.name;
    }

    res.json({
      ok: true, extracted, sha256, storage_path: storagePath,
      vendor: v.vendor, vendor_candidates: v.candidates, vendor_match_method: v.method,
      community, community_candidates: communityCandidates,
      dedup,
      complete: !!(v.vendor && community && extracted.total_cents > 0 && extracted.invoice_date && extracted.looks_like_invoice),
    });
  } catch (err) {
    console.error('[ap_intake] ingest failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /commit — write to ap_invoices (with the dedup re-check inside).
router.post('/commit', express.json({ limit: '2mb' }), async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const b = req.body || {};
    if (!b.extracted || !b.vendor_id || !b.community_id) return res.status(400).json({ error: 'extracted, vendor_id and community_id are required.' });
    const result = await commitInvoice({
      extracted: b.extracted, vendorId: b.vendor_id, communityId: b.community_id,
      sha256: b.sha256 || null, storagePath: b.storage_path || null,
      intakeMethod: b.intake_method || 'manual_upload', sourceRef: b.source_ref || null,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[ap_intake] commit failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /queue — awaiting approval + suspected-duplicate holds.
router.get('/queue', async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const { data, error } = await supabase.from('ap_invoices')
      .select('id, vendor_id, amount_paid_cents, vendor_invoice_number, invoice_date, due_date, total_cents, status, dedup_status, duplicate_of_invoice_id, source_storage_path, intake_method, notes, received_at, community_id, vendor:vendor_id(name), community:community_id(name)')
      .in('status', ['awaiting_approval', 'on_hold'])
      .order('received_at', { ascending: false }).limit(300);
    if (error) throw error;
    const rows = data || [];
    // W-9 compliance flag per bill (Issue #14): informational, never blocks.
    try {
      const flags = await require('../lib/tax/payment_gate').projectBills(supabase, rows.map((r) => ({ id: r.id, vendor_id: r.vendor_id, community_id: r.community_id, balance_cents: (r.total_cents || 0) - (r.amount_paid_cents || 0) })), { initiation: 'approve' });
      const FLAG = require('../lib/tax/payment_gate').FLAG;
      for (const r of rows) { const ev = flags.get(r.id); if (ev && FLAG.has(ev.decision)) { r.w9_needed = true; r.w9_reason = ev.reason; } }
    } catch (e) { console.error('[ap_intake] W-9 flags skipped (queue shown without them):', e.message); }
    res.json({
      ok: true,
      suspected: rows.filter((r) => r.dedup_status === 'suspected_duplicate'),
      queue: rows.filter((r) => r.dedup_status !== 'suspected_duplicate'),
    });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /:id/invoice-file — open the stored invoice PDF for a payable. Redirects
// to a short-lived signed URL from the 'documents' bucket. This is how you get
// from a vendor payable back to the actual bill.
router.get('/:id/invoice-file', async (req, res) => {
  // Viewing the source bill is a read every AP staffer needs — not admin-only.
  const staff = await requireStaff(req, res); if (!staff) return;
  try {
    const { data: inv } = await supabase.from('ap_invoices').select('source_storage_path').eq('id', req.params.id).maybeSingle();
    if (!inv || !inv.source_storage_path) return res.status(404).json({ error: 'no_invoice_file' });
    const { data, error } = await supabase.storage.from('documents').createSignedUrl(inv.source_storage_path, 60 * 60);
    if (error || !data || !data.signedUrl) return res.status(404).json({ error: 'file_not_found' });
    // Return the signed URL (don't redirect) — the admin gate needs the Bearer
    // token, which a plain <a href> navigation can't carry. The frontend fetches
    // this with the authed fetch, then opens the (public, short-lived) URL. Fall
    // back to a redirect for a direct/authed GET. (Ed 2026-07-14.)
    if (/application\/json/.test(req.headers.accept || '') || req.query.json) return res.json({ url: data.signedUrl });
    res.redirect(data.signedUrl);
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// POST /:id/confirm-unique — it's NOT a duplicate; release the hold.
router.post('/:id/confirm-unique', express.json(), async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const { error } = await supabase.from('ap_invoices')
      .update({ status: 'awaiting_approval', dedup_status: 'unique', duplicate_of_invoice_id: null })
      .eq('id', req.params.id).eq('dedup_status', 'suspected_duplicate');
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// POST /:id/confirm-duplicate — void it as a confirmed duplicate.
router.post('/:id/confirm-duplicate', express.json(), async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const { error } = await supabase.from('ap_invoices')
      .update({ status: 'voided', dedup_status: 'confirmed_duplicate', voided_at: new Date().toISOString(), voided_reason: 'Confirmed duplicate' })
      .eq('id', req.params.id).neq('status', 'paid');
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// GET /vendors?q= — picker search.
router.get('/vendors', async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    let q = supabase.from('vendors').select('id, name, dba, email').order('name').limit(50);
    if (req.query.q) q = q.ilike('name', `%${req.query.q}%`);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ ok: true, vendors: data || [] });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// GET /communities — picker.
router.get('/communities', async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const { data, error } = await supabase.from('communities').select('id, name').order('name').limit(500);
    if (error) throw error;
    res.json({ ok: true, communities: data || [] });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ---- Intake exceptions: emailed bills Emma captured but couldn't auto-file ----
// The straggler list, so they clear from ONE place in Payables instead of Emma's
// inbox. Resolve = supply the missing community/vendor -> promote to a payable.

// GET /exceptions — pending stragglers.
router.get('/exceptions', async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const { listExceptions } = require('../lib/ap/intake_exceptions');
    const items = await listExceptions({ limit: 200 });
    res.json({ ok: true, exceptions: items });
  } catch (err) { console.error('[ap_intake] list exceptions failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// GET /stragglers — bill emails to Emma with no outcome for 24h+ (Issue #14).
router.get('/stragglers', async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const hours = Math.max(1, Math.min(720, Number(req.query.hours) || 24));
    const list = await require('../lib/ap/stragglers').findStragglers(supabase, { olderThanHours: hours });
    res.json({ ok: true, hours, count: list.length, stragglers: list });
  } catch (err) { console.error('[ap_intake] stragglers failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// POST /exceptions/:id/resolve — { community_id?, vendor_id?, vendor_name?,
// invoice_date?, total_cents?, account_id? } -> load to Payables. The date/total
// finish a bill that printed none (no_date / no_total); account_id codes it to
// that account on THIS community's chart. Who entered them is the signed-in admin.
router.post('/exceptions/:id/resolve', express.json({ limit: '8kb' }), async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const b = req.body || {};
    const { promoteException } = require('../lib/ap/intake_exceptions');
    const out = await promoteException(req.params.id, { communityId: b.community_id || null, vendorId: b.vendor_id || null, vendorName: b.vendor_name || null,
      invoiceDate: b.invoice_date || null, totalCents: b.total_cents != null && b.total_cents !== '' ? Number(b.total_cents) : null, accountId: b.account_id || null,
      resolvedBy: admin.full_name || 'staff' });
    if (!out.ok) return res.status(out.error === 'not_found' ? 404 : 400).json(out);
    res.json(out);
  } catch (err) { console.error('[ap_intake] resolve exception failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// POST /exceptions/:id/resolve-reimbursement — { community_id, reimbursee_name,
// amount_cents, account_id } -> a reimbursement payable awaiting approval, with
// the original receipt PDF kept on it (Issue #3).
router.post('/exceptions/:id/resolve-reimbursement', express.json({ limit: '8kb' }), async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const b = req.body || {};
    const { promoteReimbursementException } = require('../lib/ap/intake_exceptions');
    const out = await promoteReimbursementException(req.params.id, {
      communityId: b.community_id || null, reimburseeName: b.reimbursee_name || null,
      amountCents: Number(b.amount_cents), accountId: b.account_id || null, resolvedBy: admin.full_name || 'staff',
    });
    if (!out.ok) return res.status(out.error === 'not_found' ? 404 : 400).json(out);
    res.json(out);
  } catch (err) { console.error('[ap_intake] resolve reimbursement failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// POST /exceptions/:id/dismiss — not a bill / handled elsewhere.
router.post('/exceptions/:id/dismiss', express.json(), async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const { dismissException } = require('../lib/ap/intake_exceptions');
    const out = await dismissException(req.params.id, { by: admin.full_name || 'staff', notes: (req.body && req.body.notes) || null });
    if (!out.ok) return res.status(404).json(out);
    res.json(out);
  } catch (err) { console.error('[ap_intake] dismiss exception failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ---- Duplicate vendors: the recurring silent blocker -----------------------
// Two+ ACTIVE records for the same vendor make intake refuse to guess, so bills
// pile up as exceptions. Surface them so they're merged BEFORE they block a bill.

// GET /duplicate-vendors — groups of active vendors with the same normalized name.
router.get('/duplicate-vendors', async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const { findDuplicateVendorGroups } = require('../lib/ap/duplicate_vendors');
    const groups = await findDuplicateVendorGroups(supabase);
    res.json({ ok: true, groups });
  } catch (err) { console.error('[ap_intake] duplicate-vendors failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// POST /duplicate-vendors/merge — { primary_id, dupe_ids:[] } -> consolidate.
router.post('/duplicate-vendors/merge', express.json(), async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const b = req.body || {};
    const { mergeVendorGroup } = require('../lib/ap/duplicate_vendors');
    const out = await mergeVendorGroup(supabase, { primaryId: b.primary_id, dupeIds: b.dupe_ids || [], resolvedBy: admin.full_name || 'staff' });
    res.json({ ok: true, ...out });
  } catch (err) { console.error('[ap_intake] merge vendors failed:', err.message); res.status(400).json({ error: safeErrorMessage(err) }); }
});

// POST /sweep-inbox — one-time: pull vendor bills already sitting in Emma's inbox
// into Payables (or the exceptions list) using the PDF we archived at ingest, so
// the existing backlog clears the same way new mail now does. Idempotent per
// email (source ref / sha dedup downstream). (Ed 2026-08-01 — "empty the inbox".)
// Issue #14: reads every bill format and records one outcome per email.
router.post('/sweep-inbox', express.json(), async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const { intakeBillEmail } = require('../lib/ap/email_bill_intake');
    // Vendor mail still showing in Emma's queue, with an attachment, no community.
    const { data: emails, error: qe } = await supabase.from('email_messages')
      .select('id, mailbox, graph_id, subject, sender_name, sender_email, community_id, resolved_vendor_id, extracted, body_full, body_preview, classification')
      .eq('persona', 'emma').eq('direction', 'inbound').eq('has_attachments', true)
      .in('triage_status', ['new', 'needs_review', 'linked']).limit(200);
    if (qe) throw qe;
    let filed = 0, exceptioned = 0, skipped = 0, handled = 0;
    for (const m of (emails || [])) {
      if (m.extracted && m.extracted.follow_up) { skipped += 1; continue; } // a chase needs a reply, not filing
      // The one shared path (lib/ap/email_bill_intake.js): every bill format, the
      // same autoIntake + duplicate guards, one recorded outcome (Issue #14).
      const out = await intakeBillEmail(m);
      if (out.skipped) { skipped += 1; continue; } // nothing recoverable: the straggler report shows it
      filed += out.results.filter((r) => r.outcome === 'loaded' || r.outcome === 'held_suspected_duplicate').length;
      exceptioned += out.exceptionIds.length;
      if (out.decision.handled && !out.recordError) handled += 1; else skipped += 1;
    }
    res.json({ ok: true, scanned: (emails || []).length, filed, exceptioned, handled, skipped });
  } catch (err) { console.error('[ap_intake] sweep failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// GET /exceptions/:id/file — open the archived bill PDF for an exception.
router.get('/exceptions/:id/file', async (req, res) => {
  const staff = await requireStaff(req, res); if (!staff) return;
  try {
    const { data: exc } = await supabase.from('ap_intake_exceptions').select('storage_path').eq('id', req.params.id).maybeSingle();
    if (!exc || !exc.storage_path) return res.status(404).json({ error: 'no_file' });
    const { data, error } = await supabase.storage.from('documents').createSignedUrl(exc.storage_path, 60 * 60);
    if (error || !data || !data.signedUrl) return res.status(404).json({ error: 'file_not_found' });
    if (/application\/json/.test(req.headers.accept || '') || req.query.json) return res.json({ url: data.signedUrl });
    res.redirect(data.signedUrl);
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

module.exports = { router };
