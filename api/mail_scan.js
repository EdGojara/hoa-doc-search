// ============================================================================
// api/mail_scan.js — Physical Mail Scan intake (Ed 2026-07-01)
// ----------------------------------------------------------------------------
// The server-backed version of Ed's Mail Scan prototype. Staff drop a scanned
// PDF/image of physical mail; Claude classifies it (type, urgency, fields,
// routing, summary, actions) and we file the scan + classification. This is
// the physical-mail sibling of the email Intake tab (api/email_intake.js) and
// operationalizes the "open → scan → classify → route → log same day" row of
// the BAM Operations Standard.
//
// WHY server-side: the prototype called api.anthropic.com DIRECTLY from the
// browser, which exposes the API key to anyone viewing the page. All
// classification runs here so the key never leaves the server.
//
//   POST /api/mail-scan/classify   (multipart file)      -> classification JSON
//   POST /api/mail-scan/log        (multipart file+meta) -> file scan + record
//
// v1 files the scan into library_documents (category 'scanned_mail') with the
// classification metadata. Phase 2: auto-route into AP (invoices), DRV (owner/
// legal), and the interactions system-of-record per the routing matrix.
// ============================================================================

const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const { safeErrorMessage } = require('./_safe_error');
const { createWorkItem } = require('./work_items');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const router = express.Router();

const MODEL = 'claude-sonnet-4-6';                     // matches api/email_intake.js
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

const CLASSIFY_PROMPT = `You are a mail classification system for Bedrock Association Management (BAM), a Texas HOA management company (~7 communities, ~3,500 homes). Communities include Canyon Gate at Cinco Ranch, Waterview Estates, Lakes of Pine Forest, August Meadows, Quail Ridge, Still Creek Ranch, Eaglewood.

Analyze this scanned mail document and extract the information. Respond ONLY with a valid JSON object — no preamble, no markdown.

{
  "type": "Legal / Attorney | Vendor Invoice | Homeowner Correspondence | Government / Regulatory | Insurance | Collections / Financial | Board Correspondence | Junk / Marketing | Other",
  "typeEmoji": "single emoji",
  "urgency": "critical | high | normal | discard",
  "bannerTitle": "one-line what-to-do headline",
  "bannerText": "1-2 sentence instruction per the BAM Operations Standard",
  "fields": [ { "label": "string", "value": "string", "conf": 0-100, "unknown": boolean } ],
  "routing": { "owner": "Ed | Martha | Celina | Alicia | Lori | Community Manager", "sla": "string", "system": "which trustEd module/file to log in" },
  "summary": "2-4 sentence plain-English summary",
  "actions": [ { "text": "action, wrap the key phrase in <strong></strong>" } ]
}

Urgency: critical = legal demand/attorney/subpoena/lawsuit; high = government/tax/collections/NSF/financial with a deadline; normal = invoices, owner correspondence, insurance certs, board; discard = junk/marketing.
Routing: legal/critical -> Ed immediate; government/financial-with-deadline -> Ed same day; invoices -> Martha (AP) EOD; owner correspondence -> Community Manager EOD; insurance -> Martha EOD; board -> Community Manager EOD.
Always include a "Community" field (value "Unknown — review required" + unknown:true if you cannot tell). Extract 6-8 fields. conf: 90+ clearly readable, 70-89 inferred, 50-69 uncertain, <50 set unknown:true. Include 4-6 action items.`;

// --- POST /classify -------------------------------------------------------
router.post('/classify', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file_required' });
    const b64 = req.file.buffer.toString('base64');
    const isPdf = (req.file.mimetype || '').includes('pdf');
    const media = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
      : { type: 'image', source: { type: 'base64', media_type: req.file.mimetype || 'image/jpeg', data: b64 } };

    const r = await anthropic.messages.create({
      model: MODEL, max_tokens: 1500,
      messages: [{ role: 'user', content: [media, { type: 'text', text: CLASSIFY_PROMPT }] }],
    });
    const raw = (r.content || []).map((c) => c.text || '').join('').replace(/```json|```/g, '').trim();
    console.log('[mail-scan] classify raw (first 400):', raw.slice(0, 400));
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { return res.status(422).json({ error: 'classify_parse_failed', raw_excerpt: raw.slice(0, 500) }); }

    // resolve community from the extracted "Community" field
    let community = null;
    const commName = (parsed.fields || []).find((f) => /community/i.test(f.label || ''))?.value;
    if (commName && !/unknown/i.test(commName)) {
      const { data } = await supabase.from('communities').select('id, name').ilike('name', `%${commName}%`).limit(1).maybeSingle();
      community = data || null;
    }

    // duplicate check — same file already filed?
    const sha = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const { data: dup } = await supabase.from('library_documents').select('id, title, created_at').eq('file_hash', sha).maybeSingle();

    res.json({
      classification: parsed,
      community,
      file_hash: sha,
      already_on_file: dup ? { id: dup.id, title: dup.title, at: dup.created_at } : null,
      raw_extracted: raw.slice(0, 600),
    });
  } catch (err) {
    console.error('[mail-scan] classify failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// --- POST /log — file the scan + classification (system of record) --------
router.post('/log', upload.single('file'), async (req, res) => {
  try {
    let meta = {};
    try { meta = JSON.parse(req.body.meta || '{}'); } catch (_) { meta = {}; }
    if (!req.file) return res.status(400).json({ error: 'file_required' });

    const sha = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const { data: existing } = await supabase.from('library_documents').select('id').eq('file_hash', sha).maybeSingle();
    if (existing) return res.json({ ok: true, library_document_id: existing.id, deduped: true });

    const safe = (req.file.originalname || 'mail.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `mail-scan/${meta.community_id || 'unrouted'}/${sha.slice(0, 12)}-${safe}`;
    const { error: upErr } = await supabase.storage.from('documents').upload(storagePath, req.file.buffer, { contentType: req.file.mimetype || 'application/pdf', upsert: true });
    if (upErr && !/already exists/i.test(upErr.message)) throw upErr;

    let mgmtCoId = BEDROCK_MGMT_CO_ID;
    if (meta.community_id) {
      const { data: comm } = await supabase.from('communities').select('management_company_id').eq('id', meta.community_id).maybeSingle();
      if (comm && comm.management_company_id) mgmtCoId = comm.management_company_id;
    }
    const { data: doc, error: dErr } = await supabase.from('library_documents').insert({
      management_company_id: mgmtCoId,
      community_id: meta.community_id || null,
      category: 'scanned_mail',
      title: meta.subject || `Scanned mail — ${meta.type || 'unclassified'}`,
      file_name_original: req.file.originalname || null,
      file_path: storagePath, file_hash: sha, file_size_bytes: req.file.size,
      extraction_model: MODEL,
      // Store the full classification JSON so the queue can re-display a filed
      // scan without re-classifying; falls back to a human summary line.
      extraction_notes: meta.classification
        ? JSON.stringify(meta.classification).slice(0, 60000)
        : [meta.type && `Type: ${meta.type}`, meta.urgency && `Urgency: ${meta.urgency}`,
          meta.routing_owner && `Route: ${meta.routing_owner}`, meta.summary].filter(Boolean).join(' · ').slice(0, 2000),
      created_by_mgmt_company: 'Bedrock',
      source_origin: 'mail_scan',
    }).select('id').single();
    if (dErr) throw dErr;

    // Drop it onto the Status board so it can't sit on a desk. Safe helper —
    // returns null (won't fail the filing) if work_items isn't live yet.
    const workItemId = await createWorkItem({
      community_id: meta.community_id || null, source_type: 'mail_scan',
      item_type: (meta.type || '').toLowerCase().includes('invoice') ? 'invoice' : undefined,
      urgency: meta.urgency, title: meta.subject || `Scanned mail — ${meta.type || 'unclassified'}`,
      summary: meta.summary || null, assigned_to: meta.routing_owner || null,
      library_document_id: doc.id, created_by: 'mail_scan',
    });

    res.json({ ok: true, library_document_id: doc.id, work_item_id: workItemId, record_ref: `ML-${Date.now().toString().slice(-6)}` });
  } catch (err) {
    console.error('[mail-scan] log failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// --- GET /recent — real "today's queue": actually-filed scanned mail --------
router.get('/recent', async (req, res) => {
  try {
    const lim = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    const { data, error } = await supabase.from('library_documents')
      .select('id, title, file_name_original, page_count, created_at, extraction_notes, communities:community_id(name)')
      .eq('category', 'scanned_mail').order('created_at', { ascending: false }).limit(lim);
    if (error) throw error;
    const items = (data || []).map((d) => {
      let classification = null;
      try { if (d.extraction_notes && d.extraction_notes.trim().startsWith('{')) classification = JSON.parse(d.extraction_notes); } catch (_) {}
      return {
        id: d.id, title: d.title, filename: d.file_name_original, pages: d.page_count,
        filed_at: d.created_at, community: d.communities ? d.communities.name : null, classification,
      };
    });
    res.json({ items });
  } catch (err) {
    console.error('[mail-scan] recent failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// --- GET /file/:id — signed URL to view the stored scan PDF -----------------
router.get('/file/:id', async (req, res) => {
  try {
    const { data: doc } = await supabase.from('library_documents').select('file_path').eq('id', req.params.id).maybeSingle();
    if (!doc || !doc.file_path) return res.status(404).json({ error: 'not_found' });
    const { data: signed, error } = await supabase.storage.from('documents').createSignedUrl(doc.file_path, 3600);
    if (error) throw error;
    res.json({ url: signed.signedUrl });
  } catch (err) {
    console.error('[mail-scan] file failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
