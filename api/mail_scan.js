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
  "homeownerName": "the specific homeowner this mail is addressed to or about, if any (else empty)",
  "propertyAddress": "the property street address this mail concerns, if any (else empty)",
  "actions": [ { "text": "action, wrap the key phrase in <strong></strong>" } ]
}

Urgency: critical = legal demand/attorney/subpoena/lawsuit; high = government/tax/collections/NSF/financial with a deadline; normal = invoices, owner correspondence, insurance certs, board; discard = junk/marketing.
Routing: legal/critical -> Ed immediate; government/financial-with-deadline -> Ed same day; invoices -> Martha (AP) EOD; owner correspondence -> Community Manager EOD; insurance -> Martha EOD; board -> Community Manager EOD.
Always include a "Community" field (value "Unknown — review required" + unknown:true if you cannot tell). Extract 6-8 fields. conf: 90+ clearly readable, 70-89 inferred, 50-69 uncertain, <50 set unknown:true. Include 4-6 action items.
When the mail concerns a SPECIFIC homeowner or property (owner correspondence, a collections/legal notice about an owner, a violation, an ARC matter, an estoppel, a check from an owner), set homeownerName + propertyAddress so the scan can be filed onto that homeowner's record. Leave both empty for vendor invoices, government/regulatory, insurance, and general mail not tied to one owner.`;

// Resolve a scan's addressee (homeowner name + property address from the
// classification) to a contact/property so the scan can be filed onto the
// homeowner's record. Address-first (the property is the anchor), then the
// owner. Returns nulls when it can't place it — the caller just skips linking.
async function resolveScanAddressee({ homeownerName, propertyAddress, communityId }, sb) {
  let property_id = null, contact_id = null, community_id = communityId || null;
  if (propertyAddress) {
    const num = (String(propertyAddress).match(/^\s*(\d{2,6})/) || [])[1];
    const street = String(propertyAddress).replace(/^\s*\d+\s*/, '').replace(/,.*$/, '').trim().split(/\s+/).slice(0, 2).join(' ');
    if (street) {
      let pick = null;
      // Anchor on the house number so we don't pull an arbitrary slice of a
      // long street (29 "Cape Clover" homes) and miss the exact one.
      if (num) {
        let q = sb.from('properties').select('id, street_address, community_id').ilike('street_address', `${num} ${street}%`);
        if (community_id) q = q.eq('community_id', community_id);
        const { data } = await q.limit(3);
        pick = (data || []).find((p) => p.street_address.trim().startsWith(num)) || (data && data.length === 1 ? data[0] : null);
      }
      if (!pick) { // fallback: unique street match with no reliable number
        let q = sb.from('properties').select('id, street_address, community_id').ilike('street_address', `%${street}%`);
        if (community_id) q = q.eq('community_id', community_id);
        const { data } = await q.limit(50);
        const hits = (data || []).filter((p) => (num ? p.street_address.trim().startsWith(num) : true));
        if (hits.length === 1) pick = hits[0];
      }
      if (pick) { property_id = pick.id; community_id = community_id || pick.community_id; }
    }
  }
  if (property_id) {
    const { data: owns } = await sb.from('property_ownerships').select('contact_id, contacts(full_name)').eq('property_id', property_id).is('end_date', null);
    if (homeownerName && owns && owns.length) {
      const last = String(homeownerName).trim().split(/\s+/).pop().toLowerCase();
      const m = owns.find((o) => o.contacts && String(o.contacts.full_name || '').toLowerCase().includes(last));
      contact_id = m ? m.contact_id : owns[0].contact_id;
    } else if (owns && owns.length) contact_id = owns[0].contact_id;
  } else if (homeownerName) {
    const last = String(homeownerName).trim().split(/\s+/).pop();
    if (last && last.length >= 3) {
      const { data: cs } = await sb.from('contacts').select('id').ilike('full_name', `%${last}%`).limit(5);
      if (cs && cs.length === 1) contact_id = cs[0].id;
    }
  }
  return { property_id, contact_id, community_id };
}

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
      uploaded_at: new Date().toISOString(),
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

    // Link to the homeowner it's about: resolve the addressee and log a row in
    // the canonical interactions ledger (inbound received mail) so the scan
    // shows on that homeowner's 360, with a pointer back to the stored PDF.
    // Best-effort — never fails the filing.
    let linked = null;
    try {
      const cls = meta.classification || {};
      const homeownerName = cls.homeownerName || meta.homeownerName || '';
      const propertyAddress = cls.propertyAddress || meta.propertyAddress || '';
      if (homeownerName || propertyAddress) {
        const r = await resolveScanAddressee({ homeownerName, propertyAddress, communityId: meta.community_id }, supabase);
        if (r.contact_id || r.property_id) {
          const { data: ix } = await supabase.from('interactions').insert({
            type: 'letter_other', direction: 'inbound',
            contact_id: r.contact_id || null, property_id: r.property_id || null, community_id: r.community_id || meta.community_id || null,
            subject: meta.subject || `Scanned mail — ${meta.type || 'mail'}`,
            content: meta.summary || null,
            source: 'manual', notes: 'Physical mail scan',
            attachments: [{ type: 'scanned_mail', library_document_id: doc.id }],
            received_at: new Date().toISOString(),
          }).select('id').single();
          linked = { interaction_id: ix ? ix.id : null, contact_id: r.contact_id, property_id: r.property_id };
        }
      }
    } catch (e) { console.warn('[mail-scan] addressee link skipped:', e.message); }

    res.json({ ok: true, library_document_id: doc.id, work_item_id: workItemId, linked, record_ref: `ML-${Date.now().toString().slice(-6)}` });
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
      .select('id, title, file_name_original, page_count, uploaded_at, extraction_notes, communities:community_id(name)')
      .eq('category', 'scanned_mail').order('uploaded_at', { ascending: false }).limit(lim);
    if (error) throw error;
    const items = (data || []).map((d) => {
      let classification = null;
      try { if (d.extraction_notes && d.extraction_notes.trim().startsWith('{')) classification = JSON.parse(d.extraction_notes); } catch (_) {}
      return {
        id: d.id, title: d.title, filename: d.file_name_original, pages: d.page_count,
        filed_at: d.uploaded_at, community: d.communities ? d.communities.name : null, classification,
      };
    });
    res.json({ items });
  } catch (err) {
    console.error('[mail-scan] recent failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// --- GET /archive — the filing cabinet: ALL filed scanned mail, filterable ---
// Every logged scan lands in library_documents(category='scanned_mail'); this is
// the browse/search surface over that. Urgency + type live inside the
// classification JSON (extraction_notes), not columns, so we fetch the matching
// set (category + community + date window, hard-capped) and filter/facet/paginate
// in JS. Mail is intrinsically low-volume; the 3000 cap holds for years. If mail
// volume ever climbs, promote urgency/type to real columns and filter in SQL.
router.get('/archive', async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    const communityId = req.query.community_id || null;
    const typeF = (req.query.type || '').trim().toLowerCase();
    const urgencyF = (req.query.urgency || '').trim().toLowerCase();
    const days = parseInt(req.query.days, 10) || 0;   // 0 = all time
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    let query = supabase.from('library_documents')
      .select('id, title, file_name_original, page_count, uploaded_at, extraction_notes, community_id, communities:community_id(name)')
      .eq('category', 'scanned_mail').order('uploaded_at', { ascending: false }).limit(3000);
    if (communityId) query = query.eq('community_id', communityId);
    if (days > 0) query = query.gte('uploaded_at', new Date(Date.now() - days * 864e5).toISOString());
    const { data, error } = await query;
    if (error) throw error;

    // Parse classification + normalize into a flat row.
    let rows = (data || []).map((d) => {
      let c = null;
      try { if (d.extraction_notes && d.extraction_notes.trim().startsWith('{')) c = JSON.parse(d.extraction_notes); } catch (_) {}
      const urgency = (c && c.urgency) || 'normal';
      const type = (c && c.type) || 'Unclassified';
      return {
        id: d.id, title: d.title, filename: d.file_name_original, pages: d.page_count,
        filed_at: d.uploaded_at, community: d.communities ? d.communities.name : null,
        community_id: d.community_id, type, urgency,
        summary: (c && c.summary) || null, routing_owner: (c && (c.routing_owner || (c.routing && c.routing.owner))) || null,
        classification: c,
      };
    });

    // Communities facet (distinct present) — for the filter dropdown.
    const commMap = {};
    rows.forEach((r) => { if (r.community_id) commMap[r.community_id] = { id: r.community_id, name: r.community || '—', count: (commMap[r.community_id] ? commMap[r.community_id].count : 0) + 1 }; });

    // Apply text/type/urgency filters in JS.
    if (typeF) rows = rows.filter((r) => (r.type || '').toLowerCase().includes(typeF));
    if (urgencyF) rows = rows.filter((r) => (r.urgency || '').toLowerCase() === urgencyF);
    if (q) rows = rows.filter((r) => [r.title, r.filename, r.summary, r.type, r.community].filter(Boolean).join(' ').toLowerCase().includes(q));

    // Facets on the filtered set — real counts for the summary tiles.
    const facets = { critical: 0, high: 0, normal: 0, low: 0 };
    const typeCounts = {};
    rows.forEach((r) => { if (facets[r.urgency] != null) facets[r.urgency]++; typeCounts[r.type] = (typeCounts[r.type] || 0) + 1; });

    const total = rows.length;
    const page = rows.slice(offset, offset + limit);

    // Attach work-item status for the current page (bounded ≤ limit ids).
    const ids = page.map((r) => r.id);
    if (ids.length) {
      const { data: wis } = await supabase.from('work_items')
        .select('library_document_id, status, assigned_to, sla_due_at')
        .in('library_document_id', ids);
      const byDoc = {};
      (wis || []).forEach((w) => { if (!byDoc[w.library_document_id]) byDoc[w.library_document_id] = w; });
      page.forEach((r) => { const w = byDoc[r.id]; if (w) r.work = { status: w.status, owner: w.assigned_to, due_at: w.sla_due_at }; });
    }

    res.json({
      items: page, total, offset, limit,
      facets, type_counts: typeCounts,
      communities: Object.values(commMap).sort((a, b) => b.count - a.count),
    });
  } catch (err) {
    console.error('[mail-scan] archive failed:', err.message);
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
