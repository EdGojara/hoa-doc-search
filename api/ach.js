// ============================================================================
// api/ach.js  (Ed 2026-09-16) — Secure vendor ACH enrollment links
// ----------------------------------------------------------------------------
// A vendor enters banking details into an HTTPS form reached by a one-time
// link, instead of emailing them (kills the business-email-compromise vector
// and looks organized). See migration 429.
//
// Route groups:
//   ADMIN  (requireAdmin) : create a link, list requests (MASKED), cancel.
//   OWNER  (requireOwner) : reveal the full account number, mark verified.
//   PUBLIC (token only)   : the vendor's form GET context + POST submission.
//
// SECURITY NOTES:
//   * Token: 256-bit random; only its SHA-256 hash is stored.
//   * Full account number is returned ONLY by the owner-gated /reveal route,
//     logged when revealed. Every other surface returns last4 only.
//   * Public routes are unauthenticated by design (the vendor has no login);
//     the unguessable single-use token IS the credential. They must be listed
//     in server.js's staff-gate public allowlist.
//   * A form link is single-use: submit only works while status = 'sent'.
//   * "verified" (a human call-back to a known number) is a SEPARATE step and
//     the intended gate before any payment is processed. The form reduces the
//     email-interception risk; it does not by itself prove the vendor's identity.
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { requireAdmin, requireOwner } = require('./_require_admin');
const { safeErrorMessage } = require('./_safe_error');
const { newToken, hashToken, achLink } = require('../lib/ach/token');
const { renderAchAuthorizationPdf } = require('../lib/ach/authorization_pdf');
const crypto = require('crypto');
const multer = require('multer');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';
const DOCS_BUCKET = 'documents'; // same private, server-gated bucket the document library uses

// Accept a supporting file (voided check / signed ACH form) and a W-9: images
// or PDF, <= 10MB each.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 2 },
});
const OK_UPLOAD_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/heic', 'image/webp']);

const SAFE_COLS = 'id, community_id, vendor_id, vendor_name, contact_name, contact_email, status, expires_at, account_holder_name, bank_name, account_type, account_number_last4, signer_name, signer_title, signed_at, authorization_agreed, supporting_doc_name, w9_doc_name, authorization_pdf_path, library_document_id, submitted_at, verified_by, verified_at, verification_notes, created_by, created_at, updated_at';

const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || '').trim());
const digits = (s) => String(s || '').replace(/\D/g, '');

// ABA routing checksum (9 digits, 3-7-1 weighting).
function validRouting(raw) {
  const d = digits(raw);
  if (d.length !== 9) return false;
  const n = d.split('').map(Number);
  const sum = 3 * (n[0] + n[3] + n[6]) + 7 * (n[1] + n[4] + n[7]) + (n[2] + n[5] + n[8]);
  return sum % 10 === 0 && sum > 0;
}

// Mark a row expired if past its window (label only; the guard is the status check).
async function expireIfNeeded(row) {
  if (row && row.status === 'sent' && row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    await supabase.from('vendor_ach_requests').update({ status: 'expired' }).eq('id', row.id).eq('status', 'sent');
    return { ...row, status: 'expired' };
  }
  return row;
}

// ---------------------------------------------------------------------------
// ADMIN — create a secure enrollment link
// ---------------------------------------------------------------------------
router.post('/requests', express.json({ limit: '16kb' }), async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const b = req.body || {};
    const vendor_name = String(b.vendor_name || '').trim();
    if (!vendor_name) return res.status(400).json({ error: 'vendor_name_required' });
    const contact_email = String(b.contact_email || '').trim();
    if (contact_email && !isEmail(contact_email)) return res.status(400).json({ error: 'invalid_contact_email' });
    const ttlDays = Math.min(Math.max(parseInt(b.ttl_days, 10) || 14, 1), 30); // 1..30 days, default 14

    // Verify a client-supplied community belongs to us before trusting it.
    let community_id = b.community_id || null;
    if (community_id) {
      const { data: c, error: cErr } = await supabase.from('communities')
        .select('id').eq('id', community_id).eq('management_company_id', BEDROCK_MGMT_CO_ID).maybeSingle();
      if (cErr) throw cErr;
      if (!c) return res.status(400).json({ error: 'unknown_community' });
    }

    const raw = newToken();
    const { data, error } = await supabase.from('vendor_ach_requests').insert({
      management_company_id: BEDROCK_MGMT_CO_ID,
      community_id,
      vendor_id: b.vendor_id || null,
      vendor_name,
      contact_name: b.contact_name ? String(b.contact_name).trim() : null,
      contact_email: contact_email || null,
      token_hash: hashToken(raw),
      status: 'sent',
      expires_at: new Date(Date.now() + ttlDays * 86400000).toISOString(),
      created_by: admin.email || 'staff',
    }).select(SAFE_COLS).single();
    if (error) throw error;

    const link = achLink(raw, process.env.TRUSTED_URL || (req.protocol + '://' + req.get('host')));
    // The raw token is returned exactly ONCE, here, so staff can send the link.
    res.json({ ok: true, request: data, link });
  } catch (err) {
    console.error('[ach] create request failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ADMIN — list (MASKED: last4 only, never the full number)
router.get('/requests', async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    let q = supabase.from('vendor_ach_requests').select(SAFE_COLS).order('created_at', { ascending: false }).limit(500);
    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);
    if (req.query.status) q = q.eq('status', req.query.status);
    const { data, error } = await q;
    if (error) throw error;
    // Best-effort lazy-expire on read so stale "sent" rows show correctly.
    const rows = await Promise.all((data || []).map((r) => expireIfNeeded(r)));
    res.json({ requests: rows });
  } catch (err) {
    console.error('[ach] list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ADMIN — cancel/revoke a link
router.post('/requests/:id/cancel', express.json(), async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const { data, error } = await supabase.from('vendor_ach_requests')
      .update({ status: 'cancelled' }).eq('id', req.params.id).in('status', ['sent', 'submitted'])
      .select('id, status').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(409).json({ error: 'not_cancellable' });
    res.json({ ok: true, status: data.status });
  } catch (err) {
    console.error('[ach] cancel failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// OWNER — reveal the full banking details for processing (logged)
router.get('/requests/:id/reveal', async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    const { data, error } = await supabase.from('vendor_ach_requests')
      .select('id, vendor_name, status, account_holder_name, bank_name, account_type, routing_number, account_number_full, submitted_at, verified_at')
      .eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'not_found' });
    // Audit: who revealed which vendor's full banking details, and when.
    console.log(`[ach][AUDIT] full banking revealed: request=${data.id} vendor="${data.vendor_name}" by=${owner.email} at=${new Date().toISOString()}`);
    res.json({ banking: data });
  } catch (err) {
    console.error('[ach] reveal failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// OWNER — mark verified after a call-back to a KNOWN number (the payment gate)
router.post('/requests/:id/verify', express.json(), async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    const notes = String((req.body || {}).notes || '').trim();
    if (!notes) return res.status(400).json({ error: 'verification_notes_required' }); // force a real note (how it was confirmed)
    const { data, error } = await supabase.from('vendor_ach_requests')
      .update({ status: 'verified', verified_by: owner.email || 'owner', verified_at: new Date().toISOString(), verification_notes: notes })
      .eq('id', req.params.id).eq('status', 'submitted').select('id, status').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(409).json({ error: 'not_verifiable' }); // must be 'submitted'
    res.json({ ok: true, status: data.status });
  } catch (err) {
    console.error('[ach] verify failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ADMIN — communities for the create-link picker (id + name only, scoped to us)
router.get('/communities', async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const { data, error } = await supabase.from('communities')
      .select('id, name, management_status').eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('name', { ascending: true });
    if (error) throw error;
    res.json({ communities: data || [] });
  } catch (err) {
    console.error('[ach] communities failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// PUBLIC (token only) — the vendor's form. No login. Listed in server.js
// staff-gate allowlist. Returns SAFE context only, never banking data.
// ---------------------------------------------------------------------------
async function loadByToken(token) {
  const { data, error } = await supabase.from('vendor_ach_requests')
    .select('id, vendor_name, community_id, status, expires_at')
    .eq('token_hash', hashToken(token)).maybeSingle();
  if (error) throw error;
  return data;
}

router.get('/form/:token', async (req, res) => {
  try {
    let row = await loadByToken(req.params.token);
    if (!row) return res.status(404).json({ error: 'invalid_link' });
    row = await expireIfNeeded(row);
    let community_name = null;
    if (row.community_id) {
      const { data: c } = await supabase.from('communities').select('name, legal_name').eq('id', row.community_id).maybeSingle();
      community_name = c ? (c.legal_name || c.name) : null;
    }
    res.json({
      vendor_name: row.vendor_name,
      community_name,
      requested_by: 'Bedrock Association Management',
      status: row.status,
      usable: row.status === 'sent',
    });
  } catch (err) {
    console.error('[ach] form context failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/form/:token', upload.fields([{ name: 'document', maxCount: 1 }, { name: 'w9', maxCount: 1 }]), async (req, res) => {
  try {
    let row = await loadByToken(req.params.token);
    if (!row) return res.status(404).json({ error: 'invalid_link' });
    row = await expireIfNeeded(row);
    if (row.status !== 'sent') {
      const msg = row.status === 'submitted' ? 'This form was already submitted.'
        : row.status === 'expired' ? 'This link has expired. Please ask for a new one.'
        : row.status === 'cancelled' ? 'This link is no longer active.'
        : 'This link cannot be used.';
      return res.status(409).json({ error: msg });
    }

    const b = req.body || {}; // multer parses text fields as strings
    const account_holder_name = String(b.account_holder_name || '').trim();
    const bank_name = String(b.bank_name || '').trim();
    const account_type = String(b.account_type || '').trim().toLowerCase();
    const routing = digits(b.routing_number);
    const account = digits(b.account_number);
    const confirm = digits(b.confirm_account_number);
    const signer_name = String(b.signer_name || '').trim();
    const signer_title = String(b.signer_title || '').trim() || null;
    const agreed = b.authorization_agreed === true || b.authorization_agreed === 'true' || b.authorization_agreed === 'on' || b.authorization_agreed === '1';

    if (!account_holder_name) return res.status(400).json({ error: 'Account holder name is required.' });
    if (!bank_name) return res.status(400).json({ error: 'Bank name is required.' });
    if (!['checking', 'savings'].includes(account_type)) return res.status(400).json({ error: 'Select an account type.' });
    if (!validRouting(routing)) return res.status(400).json({ error: 'That routing number is not valid. Please check the 9 digits.' });
    if (account.length < 4 || account.length > 17) return res.status(400).json({ error: 'Account number should be 4 to 17 digits.' });
    if (account !== confirm) return res.status(400).json({ error: 'The account numbers do not match.' });
    if (!signer_name) return res.status(400).json({ error: 'Please type your full name to sign.' });
    if (!agreed) return res.status(400).json({ error: 'Please check the authorization box to sign.' });
    const supportFile = req.files && req.files.document && req.files.document[0];
    const w9File = req.files && req.files.w9 && req.files.w9[0];
    for (const f of [supportFile, w9File]) {
      if (f && !OK_UPLOAD_MIME.has(String(f.mimetype || '').toLowerCase())) {
        return res.status(400).json({ error: 'Uploads must be a PDF or an image (a voided check and a W-9 work well).' });
      }
    }

    const now = new Date().toISOString();
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || null;
    const ua = String(req.headers['user-agent'] || '').slice(0, 250);

    // Community name for the authorization document.
    let community_name = null;
    if (row.community_id) {
      const { data: c } = await supabase.from('communities').select('name, legal_name').eq('id', row.community_id).maybeSingle();
      community_name = c ? (c.legal_name || c.name) : null;
    }

    const base = `${BEDROCK_MGMT_CO_ID}/${row.community_id || 'unassigned'}/vendor_ach`;
    // 1) Generate + store the signed authorization PDF (the retained record).
    let authorization_pdf_path = null;
    try {
      const pdf = await renderAchAuthorizationPdf({
        vendor_name: row.vendor_name, community_name,
        account_holder_name, bank_name, account_type,
        routing_number: routing, account_number_full: account,
        signer_name, signer_title, signed_at: now, submitted_at: now, submitter_ip: ip, signer_user_agent: ua,
      });
      authorization_pdf_path = `${base}/${row.id}-authorization.pdf`;
      const up = await supabase.storage.from(DOCS_BUCKET).upload(authorization_pdf_path, pdf, { contentType: 'application/pdf', upsert: true });
      if (up.error) { console.warn('[ach] auth pdf upload failed:', up.error.message); authorization_pdf_path = null; }
    } catch (e) { console.warn('[ach] auth pdf render failed:', e.message); }

    const extFor = (m) => ({ 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/heic': 'heic', 'image/webp': 'webp' })[String(m).toLowerCase()] || 'bin';

    // 2) Store the optional supporting upload (voided check / their signed form).
    let supporting_doc_path = null, supporting_doc_name = null, supporting_doc_mime = null;
    if (supportFile) {
      const ext = extFor(supportFile.mimetype);
      supporting_doc_path = `${base}/${row.id}-support.${ext}`;
      supporting_doc_name = String(supportFile.originalname || `support.${ext}`).slice(0, 180);
      supporting_doc_mime = supportFile.mimetype;
      const su = await supabase.storage.from(DOCS_BUCKET).upload(supporting_doc_path, supportFile.buffer, { contentType: supportFile.mimetype, upsert: true });
      if (su.error) { console.warn('[ach] support upload failed:', su.error.message); supporting_doc_path = null; }
    }

    // 2b) Store the optional W-9 and file it to the library as a 'w9' record.
    let w9_doc_path = null, w9_doc_name = null, w9_doc_mime = null, w9_library_document_id = null;
    if (w9File) {
      const ext = extFor(w9File.mimetype);
      w9_doc_path = `${base}/${row.id}-w9.${ext}`;
      w9_doc_name = String(w9File.originalname || `W-9.${ext}`).slice(0, 180);
      w9_doc_mime = w9File.mimetype;
      const wu = await supabase.storage.from(DOCS_BUCKET).upload(w9_doc_path, w9File.buffer, { contentType: w9File.mimetype, upsert: true });
      if (wu.error) { console.warn('[ach] w9 upload failed:', wu.error.message); w9_doc_path = null; }
      else {
        try {
          const wId = crypto.randomUUID();
          const { data: wdoc, error: wErr } = await supabase.from('library_documents').insert({
            id: wId, management_company_id: BEDROCK_MGMT_CO_ID, community_id: row.community_id || null,
            category: 'w9', status: 'current',
            title: `W-9 - ${row.vendor_name}`,
            file_name_original: w9_doc_name, file_name_normalized: `w9-${row.id}.${ext}`,
            file_path: w9_doc_path,
          }).select('id').single();
          if (wErr) console.warn('[ach] w9 library filing skipped:', wErr.message);
          else w9_library_document_id = wdoc.id;
        } catch (e) { console.warn('[ach] w9 library filing failed:', e.message); }
      }
    }

    // 3) File the authorization into the community document library (best-effort;
    //    never blocks the submission). Category 'vendor_contract' is canonical.
    let library_document_id = null;
    if (authorization_pdf_path) {
      try {
        const docId = crypto.randomUUID();
        const { data: doc, error: dErr } = await supabase.from('library_documents').insert({
          id: docId, management_company_id: BEDROCK_MGMT_CO_ID, community_id: row.community_id || null,
          category: 'vendor_contract', status: 'current',
          title: `ACH Authorization - ${row.vendor_name}`,
          file_name_original: `ACH Authorization - ${row.vendor_name}.pdf`,
          file_name_normalized: `ach-authorization-${row.id}.pdf`,
          file_path: authorization_pdf_path,
        }).select('id').single();
        if (dErr) console.warn('[ach] library filing skipped:', dErr.message);
        else library_document_id = doc.id;
      } catch (e) { console.warn('[ach] library filing failed:', e.message); }
    }

    // 4) Persist submission + e-sign attribution. Re-check status to avoid a double-submit race.
    const { error } = await supabase.from('vendor_ach_requests').update({
      account_holder_name, bank_name, account_type,
      routing_number: routing, account_number_full: account, account_number_last4: account.slice(-4),
      signer_name, signer_title, authorization_agreed: true, signed_at: now, signer_user_agent: ua,
      supporting_doc_path, supporting_doc_name, supporting_doc_mime,
      w9_doc_path, w9_doc_name, w9_doc_mime, w9_library_document_id,
      authorization_pdf_path, library_document_id,
      submitted_at: now, submitter_ip: ip, status: 'submitted',
    }).eq('id', row.id).eq('status', 'sent');
    if (error) throw error;

    console.log(`[ach] submission received: request=${row.id} vendor="${row.vendor_name}" signer="${signer_name}" upload=${!!supporting_doc_path}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[ach] submit failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// OWNER — download a stored doc (authorization PDF or the vendor's upload). Both
// contain full banking details, so owner-gated + short-lived signed URL, logged.
router.get('/requests/:id/doc', async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    const which = String(req.query.which || 'authorization');
    const col = which === 'support' ? 'supporting_doc_path' : (which === 'w9' ? 'w9_doc_path' : 'authorization_pdf_path');
    const { data, error } = await supabase.from('vendor_ach_requests').select(`id, vendor_name, ${col}`).eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!data || !data[col]) return res.status(404).json({ error: 'not_found' });
    const { data: signed, error: sErr } = await supabase.storage.from(DOCS_BUCKET).createSignedUrl(data[col], 60);
    if (sErr) throw sErr;
    console.log(`[ach][AUDIT] doc downloaded: request=${data.id} which=${which} by=${owner.email} at=${new Date().toISOString()}`);
    res.json({ url: signed.signedUrl });
  } catch (err) {
    console.error('[ach] doc download failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
