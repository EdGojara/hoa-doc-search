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
      .select('id, vendor_invoice_number, invoice_date, due_date, total_cents, status, dedup_status, duplicate_of_invoice_id, source_storage_path, intake_method, notes, received_at, vendor:vendor_id(name), community:community_id(name)')
      .in('status', ['awaiting_approval', 'on_hold'])
      .order('received_at', { ascending: false }).limit(300);
    if (error) throw error;
    const rows = data || [];
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

// POST /exceptions/:id/resolve — { community_id?, vendor_id? } -> load to Payables.
router.post('/exceptions/:id/resolve', express.json(), async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const b = req.body || {};
    const { promoteException } = require('../lib/ap/intake_exceptions');
    const out = await promoteException(req.params.id, { communityId: b.community_id || null, vendorId: b.vendor_id || null, vendorName: b.vendor_name || null, resolvedBy: admin.full_name || 'staff' });
    if (!out.ok) return res.status(out.error === 'not_found' ? 404 : 400).json(out);
    res.json(out);
  } catch (err) { console.error('[ap_intake] resolve exception failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
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

// POST /sweep-inbox — one-time: pull vendor bills already sitting in Emma's inbox
// into Payables (or the exceptions list) using the PDF we archived at ingest, so
// the existing backlog clears the same way new mail now does. Idempotent per
// email (source ref / sha dedup downstream). (Ed 2026-08-01 — "empty the inbox".)
router.post('/sweep-inbox', express.json(), async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const { autoIntake } = require('../lib/ap/intake');
    const { recordException } = require('../lib/ap/intake_exceptions');
    // Vendor mail still showing in Emma's queue, with an attachment, no community.
    const { data: emails } = await supabase.from('email_messages')
      .select('id, mailbox, graph_id, subject, sender_name, sender_email, community_id, resolved_vendor_id, extracted, body_full, body_preview')
      .eq('persona', 'emma').eq('direction', 'inbound').eq('has_attachments', true)
      .in('triage_status', ['new', 'needs_review', 'linked']).limit(200);
    let filed = 0, exceptioned = 0, skipped = 0, handled = 0;
    for (const m of (emails || [])) {
      if (m.extracted && m.extracted.follow_up) { skipped += 1; continue; } // a chase needs a reply, not filing
      // Prefer the archived PDF (the live message may be stale); fall back to Graph.
      let pdfs = [];
      try {
        const { data: arch } = await supabase.from('email_attachments').select('filename, storage_path, mime').eq('email_message_id', m.id);
        for (const a of (arch || [])) {
          if (!/pdf/i.test(a.mime || '') && !/\.pdf$/i.test(a.filename || '')) continue;
          const { data: blob } = await supabase.storage.from('documents').download(a.storage_path);
          if (blob) pdfs.push({ filename: a.filename || 'invoice.pdf', buffer: Buffer.from(await blob.arrayBuffer()) });
        }
      } catch (_) {}
      if (!pdfs.length && m.graph_id) {
        try { const { fetchAttachmentBuffers } = require('../lib/email/graph_attachments'); pdfs = await fetchAttachmentBuffers(m.mailbox, m.graph_id); } catch (_) {}
      }
      if (!pdfs.length) { skipped += 1; continue; } // no recoverable PDF (pre-archiver + stale) — leave it
      const srcRef = `email:${m.graph_id || m.id}`;
      let did = false;
      for (const pdf of pdfs) {
        const out = await autoIntake({ buffer: pdf.buffer, filename: pdf.filename, intakeMethod: 'email', sourceRef: srcRef, communityId: m.community_id || null, vendorIdHint: m.resolved_vendor_id || null, achHintText: `${m.subject || ''} ${m.body_full || m.body_preview || ''}`, staffNote: m.body_full || m.body_preview || '', staffSenderEmail: m.sender_email || '' });
        if (out && (out.outcome === 'loaded' || out.outcome === 'held_suspected_duplicate')) { filed += 1; did = true; }
        else if (out && out.outcome === 'needs_review') { const r = await recordException({ emailMessageId: m.id, sourceRef: srcRef, reason: out.reason, extracted: out.extracted || {}, storagePath: out.storage_path, sha256: out.sha256, communityId: m.community_id || null }); if (r.ok) { exceptioned += 1; did = true; } }
      }
      if (did) { try { await supabase.from('email_messages').update({ triage_status: 'handled' }).eq('id', m.id); handled += 1; } catch (_) {} }
      else skipped += 1;
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
