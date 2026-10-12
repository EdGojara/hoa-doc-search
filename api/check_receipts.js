// ============================================================================
// api/check_receipts.js  (Ed 2026-10-12)  mounted at /api/check-receipts
// ----------------------------------------------------------------------------
// Homeowner check scanning, recording, deposit and reconciliation. Staff screen:
// Accounting -> Homeowners -> Check Receipts (public/check-receipts.js). The logic
// lives in lib/payments/check_receipts.js; this file is HTTP only.
//
// Gates: every write needs an identified staff user (requireActingUser) and records
// who did it. Reversing a recorded check (Return) is a controlled accounting entry
// and needs an admin (requireAdmin).
// ============================================================================
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { requireActingUser, actorDisplayName } = require('./_acting_user');
const { requireAdmin } = require('./_require_admin');
const CR = require('../lib/payments/check_receipts');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
// 40 MB per upload so a scanned multipage PDF fits; each check (page or image) is still held to
// 15 MB by the reader (lib fileFrom).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024, files: 60 } });
// Upload errors (too large, too many files) answer in plain language instead of a 500.
const uploading = (mw) => (req, res, next) => mw(req, res, (err) => {
  if (!err) return next();
  const msg = err.code === 'LIMIT_FILE_SIZE' ? 'That file is larger than 40 MB. Scan fewer checks per file.' : err.code === 'LIMIT_FILE_COUNT' ? 'Too many files at once (60 at most).' : 'The upload did not complete. Try again.';
  return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'too_large' : 'upload_failed', message: msg });
});

const who = (actor) => `${actorDisplayName(actor)}${actor && actor.email ? ` <${actor.email}>` : ''}`;
const STATUS = { community_not_operational: 409, invalid_input: 400, too_large: 400, bad_type: 400, conflict: 409, duplicate: 409, possible_duplicate: 409, blocked: 409, no_match: 404, commit_pending: 502 };
function fail(res, err, where) {
  const missing = /homeowner_check_(receipts|deposits)|post_check_receipt_payment|undeposited_funds/.test(String(err && err.message)) && /does not exist|schema cache|not find/i.test(String(err && err.message));
  if (missing) return res.status(503).json({ error: 'migration_514_required', message: 'Check scanning needs migration 514 (Documents -> Migration status).' });
  const code = STATUS[err && err.code];
  if (code) return res.status(code).json({ error: err.code, message: err.message, findings: err.findings, candidates: err.candidates });
  console.error(`[check-receipts] ${where} failed:`, err && err.message);
  return res.status(500).json({ error: safeErrorMessage(err) });
}
async function signed(path) {
  if (!path) return null;
  try { const { data } = await supabase.storage.from('documents').createSignedUrl(path, 900); return data ? data.signedUrl : null; } catch (_) { return null; }
}
async function withImages(rows) {
  const ids = [...new Set(rows.flatMap((r) => [r.front_document_id, r.back_document_id]).filter(Boolean))];
  if (!ids.length) return rows;
  const { data: docs, error } = await supabase.from('library_documents').select('id, file_path').in('id', ids);
  if (error) throw error;
  const P = Object.fromEntries((docs || []).map((d) => [d.id, d.file_path]));
  return Promise.all(rows.map(async (r) => ({ ...r, front_url: await signed(P[r.front_document_id]), back_url: await signed(P[r.back_document_id]) })));
}

// List (one association), newest first.
router.get('/', async (req, res) => {
  try {
    const { community_id, status } = req.query;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    let q = supabase.from('homeowner_check_receipts').select('id, status, exception_reason, check_number, amount_cents, check_date, received_date, payer_name, property_id, match_confidence, deposit_id, created_at, properties(street_address)')
      .eq('community_id', community_id).order('created_at', { ascending: false }).limit(500);
    if (status) q = q.in('status', String(status).split(','));
    const { data, error } = await q;
    if (error) throw error;
    const counts = {};
    for (const r of data || []) counts[r.status] = (counts[r.status] || 0) + 1;
    res.json({ receipts: data || [], counts, capped: (data || []).length === 500 });
  } catch (e) { fail(res, e, 'list'); }
});

// One homeowner account's checks (the receipt history on the homeowner account).
router.get('/property/:propertyId', async (req, res) => {
  try {
    const { data, error } = await supabase.from('homeowner_check_receipts').select('*').eq('property_id', req.params.propertyId).order('received_date', { ascending: false }).limit(200);
    if (error) throw error;
    res.json({ receipts: await withImages(data || []) });
  } catch (e) { fail(res, e, 'property'); }
});

router.get('/deposits', async (req, res) => {
  try {
    const { community_id } = req.query;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    const { data, error } = await supabase.from('homeowner_check_deposits').select('*, journal_entries(reference)').eq('community_id', community_id).order('deposit_date', { ascending: false }).limit(200);
    if (error) throw error;
    res.json({ deposits: data || [] });
  } catch (e) { fail(res, e, 'deposits'); }
});

router.get('/deposits/:id/bank-lines', async (req, res) => {
  try {
    const { data: dep, error } = await supabase.from('homeowner_check_deposits').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    res.json({ candidates: await CR.bankLineCandidates(supabase, dep) });
  } catch (e) { fail(res, e, 'bank-lines'); }
});

router.get('/:id', async (req, res) => {
  try {
    const { data: rc, error } = await supabase.from('homeowner_check_receipts').select('*, properties(street_address, trusted_account_number), journal_entries!homeowner_check_receipts_journal_entry_id_fkey(reference)').eq('id', req.params.id).single();
    if (error) throw error;
    const [full] = await withImages([rc]);
    let preview = null;
    if (rc.status === 'matched') { try { preview = await CR.previewRecording(supabase, rc.id); } catch (e) { preview = { error: e.message }; } }
    const findings = ['scanned', 'matched', 'exception'].includes(rc.status) ? await CR.findDuplicates(supabase, rc) : rc.duplicate_findings;
    res.json({ receipt: full, preview, duplicate_findings: findings });
  } catch (e) { fail(res, e, 'detail'); }
});

// Scan checks. Field 'files': any number of check images or PDFs; a scanned multipage PDF is one
// check per page. Front only by default (a back can be attached later, POST /:id/back). Legacy
// fields 'front' / 'back' (same order) still work. Reads, matches and checks duplicates only:
// NOTHING is posted here. Recording is a separate staff action (POST /:id/record).
function summarize(r) {
  const cand = (r.match_candidates || []).find((c) => c.property_id === r.property_id) || (r.match_candidates || [])[0] || null;
  return { receipt_id: r.id, status: r.status, exception_reason: r.exception_reason, check_number: r.check_number, amount_cents: r.amount_cents, check_date: r.check_date,
    payer_name: r.payer_name, proposed: cand ? { property_id: cand.property_id, street_address: cand.street_address, owner_names: cand.owner_names || [], confidence: r.property_id ? r.match_confidence : cand.confidence, chosen: !!r.property_id } : null,
    duplicate_findings: (r.duplicate_findings || []).map((d) => ({ severity: d.severity, detail: d.detail })) };
}
router.post('/scan', uploading(upload.fields([{ name: 'files', maxCount: 30 }, { name: 'front', maxCount: 30 }, { name: 'back', maxCount: 30 }])), async (req, res) => {
  try {
    const actor = await requireActingUser(req, res); if (!actor) return;
    const communityId = req.body.community_id;
    if (!communityId) return res.status(400).json({ error: 'community_id_required' });
    const files = [...((req.files && req.files.files) || []), ...((req.files && req.files.front) || [])];
    const backs = (req.files && req.files.back) || [];
    if (!files.length) return res.status(400).json({ error: 'file_required', message: 'Add at least one check image or PDF.' });
    const scanBatchId = req.body.scan_batch_id && /^[0-9a-f-]{36}$/i.test(req.body.scan_batch_id) ? req.body.scan_batch_id : crypto.randomUUID();
    const results = [];
    for (let i = 0; i < files.length; i++) {
      let pages;
      try { pages = await CR.splitUpload(files[i]); }
      catch (e) { results.push({ file: files[i].originalname, error: e.message }); continue; }
      for (const pg of pages) {
        const label = { file: files[i].originalname, page: pg.page || null, pages: pg.pages || null };
        try {
          const r = await CR.intakeCheck(supabase, { communityId, front: pg, back: pages.length === 1 ? (backs[i] || null) : null, scanBatchId, actor: who(actor) });
          results.push({ ...label, ...(r.receipt ? summarize(r.receipt) : { duplicate: true, receipt_id: r.receipt_id || null, status: r.status || null, detail: r.detail }) });
        } catch (e) {
          if (/migration|does not exist|schema cache/i.test(e.message)) return fail(res, e, 'scan');
          results.push({ ...label, error: e.code === 'extract_failed' ? 'This check could not be read. Rescan it and try again.' : e.message });
        }
      }
    }
    res.json({ scan_batch_id: scanBatchId, results });
  } catch (e) { fail(res, e, 'scan'); }
});

// Attach the back of a check later (deposit documentation, a dispute, a returned check).
// Evidence only: never changes the receipt's status or any posting.
router.post('/:id/back', uploading(upload.single('back')), async (req, res) => {
  try {
    const actor = await requireActingUser(req, res); if (!actor) return;
    res.json({ receipt: await CR.attachBack(supabase, req.params.id, { back: req.file, actor: who(actor) }) });
  } catch (e) { fail(res, e, 'attach back'); }
});

router.post('/:id/confirm', express.json(), async (req, res) => {
  try {
    const actor = await requireActingUser(req, res); if (!actor) return;
    const b = req.body || {};
    const receipt = await CR.confirmMatch(supabase, req.params.id, { fields: b.fields || {}, property_id: b.property_id || null, tenure_id: b.tenure_id || null, note: b.note || null, actor: who(actor) });
    res.json({ receipt });
  } catch (e) { fail(res, e, 'confirm'); }
});

router.post('/:id/record', express.json(), async (req, res) => {
  try {
    const actor = await requireActingUser(req, res); if (!actor) return;
    res.json(await CR.recordReceipt(supabase, req.params.id, { actor: who(actor), overrideNote: (req.body || {}).override_note || null }));
  } catch (e) { fail(res, e, 'record'); }
});

router.post('/:id/void', express.json(), async (req, res) => {
  try {
    const actor = await requireActingUser(req, res); if (!actor) return;
    res.json({ receipt: await CR.voidReceipt(supabase, req.params.id, { reason: (req.body || {}).reason, actor: who(actor) }) });
  } catch (e) { fail(res, e, 'void'); }
});

router.post('/:id/return', express.json(), async (req, res) => {
  try {
    const admin = await requireAdmin(req, res); if (!admin) return;
    const actor = await requireActingUser(req, res); if (!actor) return;
    const b = req.body || {};
    res.json(await CR.returnReceipt(supabase, req.params.id, { returnDate: b.return_date, reason: b.reason, actor: who(actor) }));
  } catch (e) { fail(res, e, 'return'); }
});

// Record the bank's remote-deposit confirmation for recorded checks (optional evidence file).
router.post('/deposits', uploading(upload.single('evidence')), async (req, res) => {
  try {
    const actor = await requireActingUser(req, res); if (!actor) return;
    const b = req.body || {};
    const receiptIds = Array.isArray(b.receipt_ids) ? b.receipt_ids : String(b.receipt_ids || '').split(',').map((s) => s.trim()).filter(Boolean);
    let evidenceId = null;
    if (req.file) {
      const sha = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
      const path = `homeowner-checks/${b.community_id}/deposit-${sha.slice(0, 16)}-${String(req.file.originalname || 'confirmation').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const { error: ue } = await supabase.storage.from('documents').upload(path, req.file.buffer, { contentType: req.file.mimetype || 'application/octet-stream', upsert: false });
      if (ue && !/exists/i.test(ue.message)) throw ue;
      const { data: comm, error: ce } = await supabase.from('communities').select('management_company_id').eq('id', b.community_id).single();
      if (ce) throw ce;
      const { data: doc, error: de } = await supabase.from('library_documents').insert({ management_company_id: comm.management_company_id, community_id: b.community_id, category: 'homeowner_deposit_confirmation',
        title: `Deposit confirmation ${b.bank_reference || ''}`.trim(), file_name_original: req.file.originalname || null, file_path: path, file_hash: sha, file_size_bytes: req.file.size, created_by_mgmt_company: 'Bedrock', source_origin: 'library', uploaded_at: new Date().toISOString() }).select('id').single();
      if (de) throw de;
      evidenceId = doc.id;
    }
    const bankTotal = b.bank_total_cents === undefined || b.bank_total_cents === '' ? null : Number(b.bank_total_cents);
    res.json(await CR.createDeposit(supabase, { communityId: b.community_id, receiptIds, depositDate: b.deposit_date, bankReference: b.bank_reference, bankTotalCents: bankTotal, evidenceDocumentId: evidenceId, actor: who(actor) }));
  } catch (e) { fail(res, e, 'deposit'); }
});

router.post('/deposits/:id/reconcile', express.json(), async (req, res) => {
  try {
    const actor = await requireActingUser(req, res); if (!actor) return;
    res.json(await CR.reconcileDeposit(supabase, req.params.id, { bankTransactionId: (req.body || {}).bank_transaction_id || null, actor: who(actor) }));
  } catch (e) { fail(res, e, 'reconcile'); }
});

module.exports = router;
