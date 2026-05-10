// ============================================================================
// Vendor Master + Invoice Intake
// ----------------------------------------------------------------------------
// Endpoints under /api/vendors for:
//   - drop a vendor invoice PDF -> Claude parses -> fuzzy-match to existing
//     vendor (or create) -> save invoice + update vendor rollups
//   - vendor list / detail / update
//   - vendor document upload (contracts, COIs, W-9s)
//
// Per Ed's "selective by default" workflow: nothing pressures you to
// upload every invoice. Use this opportunistically — anomaly-triggered
// from Financial Review, or proactive seeding of the master.
//
// Builds on migration 009_vendor_master.sql.
// ============================================================================

const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const multer = require('multer');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

const router = express.Router();

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

// Normalize vendor name for fuzzy matching: lowercase, strip punctuation,
// collapse common business-suffix variants ("LLC", "Inc.", "L.L.C." -> "llc").
function normalizeVendorName(name) {
  if (!name) return '';
  let s = String(name).toLowerCase();
  s = s.replace(/[^a-z0-9 ]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  // Normalize common suffixes
  s = s.replace(/\b(l l c|llc|l\.l\.c\.)\b/g, 'llc');
  s = s.replace(/\b(inc|incorporated|inc\.|inc,)\b/g, 'inc');
  s = s.replace(/\b(co|company|co\.)\b/g, 'co');
  s = s.replace(/\b(ltd|limited)\b/g, 'ltd');
  return s;
}

// Token-set Jaccard similarity. 1.0 = identical token sets, 0.0 = no overlap.
function tokenJaccard(a, b) {
  const setA = new Set(normalizeVendorName(a).split(' ').filter(Boolean));
  const setB = new Set(normalizeVendorName(b).split(' ').filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

async function findOrCreateVendor({ name, dba, ein, address, phone, email, category }) {
  // Look up existing vendors for this management company; pick best fuzzy match.
  const { data: existing, error } = await supabase
    .from('vendors')
    .select('id, name, dba, ein')
    .eq('management_company_id', BEDROCK_MGMT_CO_ID)
    .eq('status', 'active');
  if (error) throw error;

  let bestMatch = null, bestScore = 0;
  for (const v of (existing || [])) {
    // EIN match short-circuits everything else.
    if (ein && v.ein && ein.replace(/\D/g, '') === v.ein.replace(/\D/g, '')) {
      return { vendor: v, was_created: false, match_method: 'ein_exact', match_score: 1.0 };
    }
    const nameScore = tokenJaccard(name, v.name);
    const dbaScore = dba && v.dba ? tokenJaccard(dba, v.dba) : 0;
    const score = Math.max(nameScore, dbaScore);
    if (score > bestScore) { bestScore = score; bestMatch = v; }
  }

  if (bestMatch && bestScore >= 0.65) {
    return { vendor: bestMatch, was_created: false, match_method: 'name_fuzzy', match_score: bestScore };
  }

  // Create new vendor.
  const { data: newVendor, error: insErr } = await supabase
    .from('vendors')
    .insert({
      management_company_id: BEDROCK_MGMT_CO_ID,
      name: (name || 'Unknown Vendor').trim(),
      dba: dba || null,
      ein: ein || null,
      address: address || null,
      phone: phone || null,
      email: email || null,
      category: category || null,
      status: 'active',
      first_seen_at: new Date().toISOString()
    })
    .select()
    .single();
  if (insErr) throw insErr;
  return { vendor: newVendor, was_created: true, match_method: 'created_new', match_score: bestScore };
}

// ============================================================================
// AI parse: vendor invoice PDF -> structured data
// ============================================================================
async function parseVendorInvoicePDF(pdfBuffer) {
  const promptText = `Extract structured data from this vendor invoice. Return ONLY a JSON object in this exact shape:

{
  "vendor_name": "<canonical legal name as it appears on the invoice, or null>",
  "vendor_dba": "<doing-business-as / common name if shown, or null>",
  "vendor_ein": "<EIN/TIN if shown, or null>",
  "vendor_address": "<vendor's street address, or null>",
  "vendor_phone": "<vendor phone if shown, or null>",
  "vendor_email": "<vendor email if shown, or null>",
  "vendor_category_guess": "<one of: landscaping | security | pool | janitorial | electrical | plumbing | hvac | legal | accounting | insurance | utilities | management | repair_general | other — your best guess from the line items>",
  "invoice_number": "<string or null>",
  "invoice_date": "<YYYY-MM-DD or null>",
  "service_period_start": "<YYYY-MM-DD or null>",
  "service_period_end": "<YYYY-MM-DD or null>",
  "due_date": "<YYYY-MM-DD or null>",
  "total_amount": <number or null>,
  "currency": "<USD or other>",
  "billed_to_name": "<who the invoice is billed to (likely the HOA association name), or null>",
  "line_items": [
    {"description": "<string>", "qty": <number or null>, "unit_price": <number or null>, "amount": <number or null>}
  ],
  "parse_confidence": "<high | medium | low — how confident you are the extraction is correct>",
  "notes": "<any concerns, unusual items, or things flagged for review>"
}

Rules:
- service_period_start and service_period_end represent when the work/service was actually performed (e.g., "service period: Feb 1-28, 2026"). Critical for accrual-aware GL matching.
- If service period isn't explicitly stated, leave both null. Don't guess.
- If invoice_date is the only date shown, use it for invoice_date and leave service period null.
- Numbers: use dollars (not cents). Convert any parentheses to negatives.
- For line items, include any tax/discount lines. Use null for fields not shown.
- Return ONLY the JSON. No markdown fences, no preamble.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: pdfBuffer.toString('base64')
          }
        },
        { type: 'text', text: promptText }
      ]
    }]
  });

  const rawText = (response.content[0] && response.content[0].text) || '';
  const cleanText = rawText.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleanText);
  } catch (e) {
    throw new Error(`AI returned non-JSON: ${cleanText.slice(0, 300)}`);
  }
  return { parsed, usage: response.usage };
}

// ============================================================================
// Endpoints
// ============================================================================

// GET /api/vendors  — list with rollups
router.get('/', async (req, res) => {
  try {
    const { community_id, q, category, status, limit } = req.query;
    let query = supabase
      .from('v_vendors_with_status')
      .select('*')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('last_invoice_at', { ascending: false, nullsFirst: false })
      .limit(Number(limit) || 200);
    if (status) query = query.eq('status', status);
    if (category) query = query.eq('category', category);
    if (q && q.trim()) {
      query = query.ilike('name', `%${q.trim()}%`);
    }
    const { data, error } = await query;
    if (error) throw error;

    let vendors = data || [];

    // Optional community filter: keep only vendors that have at least one invoice for this community.
    if (community_id) {
      const ids = vendors.map(v => v.id);
      if (ids.length > 0) {
        const { data: invByCommunity } = await supabase
          .from('invoices_received')
          .select('vendor_id')
          .eq('community_id', community_id)
          .in('vendor_id', ids);
        const allowed = new Set((invByCommunity || []).map(r => r.vendor_id));
        vendors = vendors.filter(v => allowed.has(v.id));
      } else {
        vendors = [];
      }
    }

    res.json({ vendors });
  } catch (err) {
    console.error('[vendors] list failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/vendors/:id  — vendor detail with recent invoices + documents
router.get('/:vendorId', async (req, res) => {
  const { vendorId } = req.params;
  try {
    const { data: vendor, error: vErr } = await supabase
      .from('vendors')
      .select('*')
      .eq('id', vendorId)
      .single();
    if (vErr || !vendor) return res.status(404).json({ error: 'Vendor not found' });

    const { data: invoices } = await supabase
      .from('invoices_received')
      .select('id, community_id, invoice_number, invoice_date, service_period_start, service_period_end, total_amount, status, gl_match_status, created_at, community:communities(name, vantaca_code)')
      .eq('vendor_id', vendorId)
      .order('invoice_date', { ascending: false, nullsFirst: false })
      .limit(50);

    const { data: documents } = await supabase
      .from('vendor_documents')
      .select('*')
      .eq('vendor_id', vendorId)
      .order('uploaded_at', { ascending: false });

    res.json({ vendor, invoices: invoices || [], documents: documents || [] });
  } catch (err) {
    console.error('[vendors] detail failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/vendors/:id  — update vendor fields
router.patch('/:vendorId', async (req, res) => {
  const { vendorId } = req.params;
  const allowed = ['name','dba','ein','address','phone','email','category','status','w9_on_file','notes'];
  const update = {};
  for (const k of allowed) if (k in (req.body || {})) update[k] = req.body[k];
  if (req.body && req.body.w9_on_file === true) update.w9_uploaded_at = new Date().toISOString();
  if (Object.keys(update).length === 0) return res.status(400).json({ error: 'no updatable fields supplied' });
  try {
    const { data, error } = await supabase
      .from('vendors')
      .update(update)
      .eq('id', vendorId)
      .select()
      .single();
    if (error) throw error;
    res.json({ vendor: data });
  } catch (err) {
    console.error('[vendors] PATCH failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/vendors/invoices/upload  — drop invoice PDF -> AI parse -> match/create vendor -> save invoice
//
// Dedup defense (real AP workflow gotcha — same invoice shouldn't get filed twice):
//   1. byte-level: if the EXACT same PDF bytes already exist for this mgmt co,
//      short-circuit before paying for a Claude call. Returns 409 with existing
//      invoice info; client can choose to force_insert (rare — only legit if
//      the same PDF is the source for two communities, which is unusual).
//   2. semantic: after parse, if (vendor_id, invoice_number) already exists,
//      return 409. Client can force_insert (rare — vendor reused a number).
//   3. soft signal (no invoice_number): same vendor + same total + same date
//      within 60 days -> warn. Returns 409 with warning level.
//
// force_insert=true in body bypasses checks. The DB-level partial unique
// index on (mgmt_co, vendor_id, invoice_number) is the final safety net for
// race conditions.
router.post('/invoices/upload', upload.single('pdf'), async (req, res) => {
  const t0 = Date.now();
  if (!req.file) return res.status(400).json({ error: 'No PDF uploaded (expected field "pdf")' });
  if (req.file.mimetype !== 'application/pdf') {
    return res.status(400).json({ error: `Unsupported file type: ${req.file.mimetype}` });
  }
  const { community_id, finding_id, category_hint, force_insert } = req.body || {};
  const forceInsert = force_insert === 'true' || force_insert === true;

  try {
    // ---- Layer 1: file-hash check (skip if force_insert) ----
    const fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    if (!forceInsert) {
      const { data: hashHit } = await supabase
        .from('invoices_received')
        .select('id, invoice_number, invoice_date, total_amount, file_name, vendor_id, vendor:vendors(name)')
        .eq('management_company_id', BEDROCK_MGMT_CO_ID)
        .eq('file_hash', fileHash)
        .limit(1)
        .maybeSingle();
      if (hashHit) {
        return res.status(409).json({
          duplicate: true,
          dup_reason: 'file_hash',
          message: 'Exact same PDF file is already on file. Skipping Claude parse — confirm if you really want a second copy.',
          existing_invoice: hashHit,
          new_file_name: req.file.originalname
        });
      }
    }

    // ---- Parse with Claude ----
    const { parsed, usage } = await parseVendorInvoicePDF(req.file.buffer);

    if (!parsed.vendor_name || !parsed.total_amount) {
      // Still create with whatever we have but flag low confidence.
      parsed.parse_confidence = 'low';
    }

    // ---- Find or create the vendor (no insert yet) ----
    const matchResult = await findOrCreateVendor({
      name: parsed.vendor_name || 'Unknown Vendor',
      dba: parsed.vendor_dba,
      ein: parsed.vendor_ein,
      address: parsed.vendor_address,
      phone: parsed.vendor_phone,
      email: parsed.vendor_email,
      category: parsed.vendor_category_guess || category_hint || null
    });

    // ---- Layer 2: semantic dup check on (vendor_id, invoice_number) ----
    if (!forceInsert && parsed.invoice_number) {
      const { data: numHit } = await supabase
        .from('invoices_received')
        .select('id, invoice_number, invoice_date, total_amount, file_name, vendor:vendors(name)')
        .eq('management_company_id', BEDROCK_MGMT_CO_ID)
        .eq('vendor_id', matchResult.vendor.id)
        .eq('invoice_number', parsed.invoice_number)
        .limit(1)
        .maybeSingle();
      if (numHit) {
        return res.status(409).json({
          duplicate: true,
          dup_reason: 'vendor_invoice_number',
          message: `Invoice #${parsed.invoice_number} from ${matchResult.vendor.name} is already on file. Confirm if this is a legitimate second copy.`,
          existing_invoice: numHit,
          parsed,
          vendor: matchResult.vendor,
          vendor_was_created: matchResult.was_created,
          vendor_match_method: matchResult.match_method,
          vendor_match_score: matchResult.match_score
        });
      }
    }

    // ---- Layer 3: soft dup signal (no invoice number, but same vendor+date+amount nearby) ----
    if (!forceInsert && !parsed.invoice_number && parsed.invoice_date && parsed.total_amount != null) {
      const dayLo = new Date(parsed.invoice_date); dayLo.setDate(dayLo.getDate() - 60);
      const dayHi = new Date(parsed.invoice_date); dayHi.setDate(dayHi.getDate() + 60);
      const { data: softHits } = await supabase
        .from('invoices_received')
        .select('id, invoice_number, invoice_date, total_amount, file_name')
        .eq('management_company_id', BEDROCK_MGMT_CO_ID)
        .eq('vendor_id', matchResult.vendor.id)
        .eq('total_amount', Number(parsed.total_amount))
        .gte('invoice_date', dayLo.toISOString().slice(0, 10))
        .lte('invoice_date', dayHi.toISOString().slice(0, 10))
        .limit(1);
      if (softHits && softHits.length > 0) {
        return res.status(409).json({
          duplicate: true,
          dup_reason: 'soft_amount_date',
          message: `Same vendor + same amount ($${Number(parsed.total_amount).toLocaleString()}) within 60 days of this date already exists. Likely duplicate.`,
          existing_invoice: softHits[0],
          parsed,
          vendor: matchResult.vendor,
          vendor_was_created: matchResult.was_created,
          vendor_match_method: matchResult.match_method,
          vendor_match_score: matchResult.match_score
        });
      }
    }

    // ---- Insert the invoice ----
    const { data: invoice, error: insErr } = await supabase
      .from('invoices_received')
      .insert({
        management_company_id: BEDROCK_MGMT_CO_ID,
        community_id: community_id || null,
        vendor_id: matchResult.vendor.id,
        invoice_number: parsed.invoice_number || null,
        invoice_date: parsed.invoice_date || null,
        service_period_start: parsed.service_period_start || null,
        service_period_end: parsed.service_period_end || null,
        due_date: parsed.due_date || null,
        total_amount: parsed.total_amount !== null && parsed.total_amount !== undefined ? Number(parsed.total_amount) : null,
        currency: parsed.currency || 'USD',
        line_items: parsed.line_items || [],
        raw_text: null,
        file_name: req.file.originalname,
        file_hash: fileHash,
        file_url: null,
        source: 'manual_upload',
        parsed_at: new Date().toISOString(),
        parser_model: 'claude-sonnet-4-6',
        parse_confidence: ['high','medium','low'].includes(parsed.parse_confidence) ? parsed.parse_confidence : 'medium',
        status: 'received',
        gl_match_status: 'unmatched',
        notes: parsed.notes || null
      })
      .select()
      .single();
    if (insErr) {
      // Catch unique-index violation gracefully (race condition between dup check and insert).
      if (insErr.code === '23505') {
        return res.status(409).json({
          duplicate: true,
          dup_reason: 'unique_constraint',
          message: 'Database refused as duplicate (race condition or pre-existing record).',
          db_error: insErr.message
        });
      }
      throw insErr;
    }

    // Trade-tape entry.
    await supabase.from('agent_runs').insert({
      management_company_id: BEDROCK_MGMT_CO_ID,
      community_id: community_id || null,
      module: 'vendors',
      endpoint: 'POST /api/vendors/invoices/upload',
      request_input: { file_name: req.file.originalname, file_size: req.file.size, file_hash: fileHash, finding_id: finding_id || null, force_insert: forceInsert },
      retrieved_context: { vendor_id: matchResult.vendor.id, was_new_vendor: matchResult.was_created },
      prompt: 'parseVendorInvoicePDF',
      model: 'claude-sonnet-4-6',
      response: { extracted: parsed, match_method: matchResult.match_method, match_score: matchResult.match_score, invoice_id: invoice.id },
      input_tokens: usage ? usage.input_tokens : null,
      output_tokens: usage ? usage.output_tokens : null,
      duration_ms: Date.now() - t0
    });

    res.json({
      invoice,
      vendor: matchResult.vendor,
      vendor_was_created: matchResult.was_created,
      vendor_match_method: matchResult.match_method,
      vendor_match_score: matchResult.match_score,
      extracted: parsed,
      duration_ms: Date.now() - t0
    });
  } catch (err) {
    console.error('[vendors] invoice upload failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/vendors/invoices/:invoiceId  — remove an invoice (e.g. duplicate)
// Vendor rollups recompute via the trusted_vendor_invoice_rollup trigger.
router.delete('/invoices/:invoiceId', async (req, res) => {
  const { invoiceId } = req.params;
  try {
    // Pull the row first so we can log what was deleted.
    const { data: existing } = await supabase
      .from('invoices_received')
      .select('id, vendor_id, invoice_number, invoice_date, total_amount, file_name')
      .eq('id', invoiceId)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();

    if (!existing) return res.status(404).json({ error: 'Invoice not found' });

    const { error: delErr } = await supabase
      .from('invoices_received')
      .delete()
      .eq('id', invoiceId)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID);
    if (delErr) throw delErr;

    // Audit: every delete goes on the trade tape.
    await supabase.from('agent_runs').insert({
      management_company_id: BEDROCK_MGMT_CO_ID,
      module: 'vendors',
      endpoint: 'DELETE /api/vendors/invoices/:id',
      request_input: { invoice_id: invoiceId, reason: req.body?.reason || null },
      retrieved_context: { deleted_record: existing },
      prompt: null,
      model: null,
      response: { ok: true },
      duration_ms: 0
    });

    res.json({ ok: true, deleted: existing });
  } catch (err) {
    console.error('[vendors] invoice delete failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/vendors/invoices  — list invoices, optional filters
router.get('/invoices/list', async (req, res) => {
  try {
    const { community_id, vendor_id, status, gl_match_status, limit } = req.query;
    let q = supabase
      .from('invoices_received')
      .select('*, vendor:vendors(name, category), community:communities(name, vantaca_code)')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('invoice_date', { ascending: false, nullsFirst: false })
      .limit(Number(limit) || 100);
    if (community_id) q = q.eq('community_id', community_id);
    if (vendor_id) q = q.eq('vendor_id', vendor_id);
    if (status) q = q.eq('status', status);
    if (gl_match_status) q = q.eq('gl_match_status', gl_match_status);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ invoices: data || [] });
  } catch (err) {
    console.error('[vendors] invoices list failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/vendors/invoices/:id  — single invoice detail
router.get('/invoices/:invoiceId', async (req, res) => {
  const { invoiceId } = req.params;
  try {
    const { data: invoice, error: iErr } = await supabase
      .from('invoices_received')
      .select('*, vendor:vendors(*), community:communities(name, vantaca_code, legal_name)')
      .eq('id', invoiceId)
      .single();
    if (iErr || !invoice) return res.status(404).json({ error: 'Invoice not found' });
    res.json({ invoice });
  } catch (err) {
    console.error('[vendors] invoice detail failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router };
