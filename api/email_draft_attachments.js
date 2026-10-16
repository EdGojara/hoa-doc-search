// ============================================================================
// api/email_draft_attachments.js  (Ed 2026-10-16)
// ----------------------------------------------------------------------------
// Review a queued draft's attachments from the Draft Queue BEFORE Send.
// Mounted inside api/email_drafts.js, so the paths are:
//
//   GET    /api/email-drafts/:id/attachments/:index            the stored bytes
//            ?download=1  forces a download instead of inline display
//            Headers: X-Attachment-SHA256, X-Attachment-Size, X-Attachment-Name
//   DELETE /api/email-drafts/:id/attachments/:index            remove from the draft
//   POST   /api/email-drafts/:id/attachments/:index/replace    multipart "file"
//
// The bytes served are the stored file /send attaches (the same loader,
// lib/email/queued_attachments.js), never a regenerated copy. Storage paths and
// buckets are never returned, and there are no public or signed URLs: the
// browser fetches through this authenticated, same-origin endpoint.
//
// ACCESS. Every route needs a signed-in staff user (Bearer session). When the
// per-draft rule (lib/email/draft_access.js, PR #215) is present, it is applied
// to every action here exactly as on the other Draft Queue routes; before it
// lands, main's rule applies (any signed-in staff user, behind the global gate).
// Remove and Replace also require the draft to still be unsent.
// ============================================================================
'use strict';

const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { getAuthedUser } = require('./_require_admin');
const DAT = require('../lib/email/queued_attachments');

let DA = null;
try { DA = require('../lib/email/draft_access'); } catch (_) { /* PR #215 not merged yet */ }

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: DAT.MAX_UPLOAD_BYTES, files: 1 } });

function safe(err) { try { return require('./_safe_error').safeErrorMessage(err); } catch (_) { return 'Something went wrong'; } }
const DRAFT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Signed-in user, then the draft, then the per-draft rule. Sends the refusal
// and returns null when not allowed.
async function loadForAction(req, res, action) {
  const u = req.user || await getAuthedUser(req);
  if (!u) { res.status(403).json({ error: 'sign_in_required', detail: 'Sign in to work with drafts.' }); return null; }
  req.user = u;
  if (!DRAFT_ID_RE.test(String(req.params.id || ''))) { res.status(404).json({ error: 'not_found' }); return null; }
  const { data, error } = await supabase.from('outbound_email_drafts').select('*').eq('id', req.params.id).maybeSingle();
  if (error) throw error;
  if (DA) { if (!DA.guard(req, res, u, data, action)) return null; }
  else if (!data) { res.status(404).json({ error: 'not_found' }); return null; }
  return data;
}

function pickIndex(req, res, draft) {
  const raw = String(req.params.index || '');
  const i = /^\d{1,3}$/.test(raw) ? Number(raw) : -1;
  const arr = DAT.list(draft);
  if (i < 0 || i >= arr.length || !arr[i]) { res.status(404).json({ error: 'attachment_not_found', detail: 'That attachment is no longer on this draft. Reload the draft.' }); return -1; }
  return i;
}

// The client says which file it means (the name it is showing). A mismatch means
// the list changed underneath it (another tab, a teammate), so refuse instead
// of removing or replacing the wrong file.
function expectMatches(req, res, a) {
  const expect = req.body && req.body.expect_name;
  if (expect == null || String(expect) !== String(a.name || 'attachment')) {
    res.status(409).json({ error: 'attachment_changed', detail: 'The attachments on this draft changed. Reload the draft and try again.' });
    return false;
  }
  return true;
}

function requireUnsent(res, draft) {
  if (draft.status === 'draft') return true;
  res.status(409).json({ error: 'not_editable', detail: 'This draft was already sent or discarded.' });
  return false;
}

async function saveAttachments(draftId, next) {
  const { data, error } = await supabase.from('outbound_email_drafts')
    .update({ attachments: next }).eq('id', draftId).eq('status', 'draft').select('id').maybeSingle();
  if (error) throw error;
  return !!data;
}

async function deleteIfDraftOwned(draftId, a) {
  if (!DAT.isDraftOwned(draftId, a)) return;
  const { error } = await supabase.storage.from(a.bucket || DAT.DEFAULT_BUCKET).remove([a.storage_path]);
  if (error) console.warn('[email_draft_attachments] old file not removed:', JSON.stringify({ draft_id: draftId, reason: error.message }));
}

// GET /:id/attachments/:index — the exact stored bytes.
router.get('/:id/attachments/:index', async (req, res) => {
  try {
    const d = await loadForAction(req, res, 'open');
    if (!d) return;
    const i = pickIndex(req, res, d);
    if (i < 0) return;
    const r = await DAT.load(supabase, DAT.list(d)[i]);
    if (!r.ok) {
      console.warn('[email_draft_attachments] stored file unreadable:', JSON.stringify({ draft_id: d.id, index: i, reason: r.reason }));
      return res.status(404).json({ error: 'attachment_unavailable', detail: 'This attachment could not be read from storage, so it would not go out. Replace or remove it before sending.' });
    }
    const inline = DAT.canInline(r.mime) && req.query.download !== '1';
    res.set({
      'Content-Type': r.mime,
      'Content-Length': String(r.size),
      'Content-Disposition': DAT.contentDisposition(r.name, inline),
      'X-Attachment-SHA256': r.sha256,
      'X-Attachment-Size': String(r.size),
      'X-Attachment-Name': encodeURIComponent(r.name),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
    });
    res.end(r.buffer);
  } catch (err) {
    console.error('[email_draft_attachments] open failed:', err.message);
    res.status(500).json({ error: safe(err) });
  }
});

// DELETE /:id/attachments/:index — take the file off the draft. A shared stored
// document (an RFP PDF) is only unlinked; a file uploaded here by Replace is deleted.
router.delete('/:id/attachments/:index', express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const d = await loadForAction(req, res, 'edit');
    if (!d || !requireUnsent(res, d)) return;
    const i = pickIndex(req, res, d);
    if (i < 0) return;
    const arr = DAT.list(d);
    if (!expectMatches(req, res, arr[i])) return;
    const next = arr.filter((_, k) => k !== i);
    if (!(await saveAttachments(d.id, next))) return res.status(409).json({ error: 'not_editable', detail: 'This draft was already sent or discarded.' });
    await deleteIfDraftOwned(d.id, arr[i]);
    res.json({ ok: true, attachments: next.map((a, k) => DAT.describe(a, k)) });
  } catch (err) {
    console.error('[email_draft_attachments] remove failed:', err.message);
    res.status(500).json({ error: safe(err) });
  }
});

// POST /:id/attachments/:index/replace — upload a new file in that slot.
router.post('/:id/attachments/:index/replace', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'file_too_large', detail: `That file is over ${Math.round(DAT.MAX_UPLOAD_BYTES / 1048576)} MB.` });
    console.warn('[email_draft_attachments] upload rejected:', err.message);
    return res.status(400).json({ error: 'upload_failed', detail: 'The file could not be uploaded. Try again.' });
  });
}, async (req, res) => {
  let newPath = null;
  try {
    const d = await loadForAction(req, res, 'edit');
    if (!d || !requireUnsent(res, d)) return;
    const i = pickIndex(req, res, d);
    if (i < 0) return;
    const arr = DAT.list(d);
    if (!expectMatches(req, res, arr[i])) return;
    const f = req.file;
    if (!f || !f.buffer || !f.buffer.length) return res.status(400).json({ error: 'file_required', detail: 'Choose a file to replace it with.' });
    // multer hands the filename over as latin1; restore UTF-8 names.
    const name = Buffer.from(String(f.originalname || 'attachment'), 'latin1').toString('utf8');
    const mime = DAT.mimeOf({ name, mime: f.mimetype });
    newPath = DAT.storagePathFor(d.id, name);
    const { error: upErr } = await supabase.storage.from(DAT.DEFAULT_BUCKET).upload(newPath, f.buffer, { contentType: mime, upsert: false });
    if (upErr) { newPath = null; throw upErr; }
    const entry = { storage_path: newPath, bucket: DAT.DEFAULT_BUCKET, name, mime, size: f.buffer.length, sha256: DAT.sha256(f.buffer), replaced_at: new Date().toISOString(), replaced_by: (req.user && (req.user.email || req.user.full_name)) || null };
    const nextArr = arr.map((a, k) => (k === i ? entry : a));
    if (!(await saveAttachments(d.id, nextArr))) {
      await supabase.storage.from(DAT.DEFAULT_BUCKET).remove([newPath]);
      newPath = null;
      return res.status(409).json({ error: 'not_editable', detail: 'This draft was already sent or discarded.' });
    }
    newPath = null;
    await deleteIfDraftOwned(d.id, arr[i]);
    res.json({ ok: true, attachments: nextArr.map((a, k) => DAT.describe(a, k)), replaced: DAT.describe(entry, i), sha256: entry.sha256 });
  } catch (err) {
    // The new file was stored but the draft was not updated: do not leave it orphaned.
    if (newPath) { try { await supabase.storage.from(DAT.DEFAULT_BUCKET).remove([newPath]); } catch (_) {} }
    console.error('[email_draft_attachments] replace failed:', err.message);
    res.status(500).json({ error: safe(err) });
  }
});

module.exports = router;
