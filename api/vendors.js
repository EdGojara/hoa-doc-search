// ============================================================================
// Vendor Master + Invoice Intake
// ----------------------------------------------------------------------------
// Endpoints under /api/vendors for:
//   - drop a vendor invoice PDF -> the AI parses -> fuzzy-match to existing
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

    // Attach the 1099 flag (not on v_vendors_with_status) so the master list
    // can show the 1099 column without a per-row query.
    if (vendors.length) {
      const { data: flags } = await supabase.from('vendors')
        .select('id, is_1099_vendor, w9_received_date, tax_classification')
        .in('id', vendors.map(v => v.id));
      const byId = Object.fromEntries((flags || []).map(f => [f.id, f]));
      vendors = vendors.map(v => ({ ...v, ...(byId[v.id] || {}) }));
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
  const allowed = ['name','dba','ein','address','phone','email','category','status','w9_on_file','notes',
                   'is_1099_vendor','tax_classification','tax_id','w9_received_date'];
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
//      short-circuit before paying for a the AI call. Returns 409 with existing
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
          message: 'Exact same PDF file is already on file. Skipping the AI parse — confirm if you really want a second copy.',
          existing_invoice: hashHit,
          new_file_name: req.file.originalname
        });
      }
    }

    // ---- Parse with the AI ----
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
        // Cash-basis paid date (drives the 1099/spend year). Batch value from the
        // Historical Invoices box; the AI's read is the fallback. NULL -> the
        // spend view falls back to invoice_date (flagged estimated).
        paid_date: (req.body && req.body.paid_date) || parsed.paid_date || null,
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

// ============================================================================
// RFP / BID COMPARISON ENGINE
// ----------------------------------------------------------------------------
// Endpoints that power the transparency-by-design bid evaluation workflow:
//
//   POST   /api/vendors/rfps                            — create RFP envelope
//   GET    /api/vendors/rfps                            — list (community/status filters)
//   GET    /api/vendors/rfps/:id                        — RFP + all bids detail
//   POST   /api/vendors/rfps/:id/proposals              — upload + extract a bid PDF
//   PATCH  /api/vendors/proposals/:id                   — finalist / eliminate / reset
//   GET    /api/vendors/rfps/:id/decision-log           — audit trail
//
// Encode-Ed lens: the workflow makes it structurally impossible to ship a
// recommendation without the trail of eliminations + reasons. The PATCH
// endpoint writes to rfp_decision_log on every state change; the board memo
// generator (Phase 5) renders that log as the appendix.
// ============================================================================

// Storage bucket for proposal PDFs. Reuses the 'documents' bucket the rest
// of trustEd already uses (nominations photos, library docs, etc.).
const PROPOSALS_BUCKET = 'documents';

// AI extraction prompt template — landscape-aware but generally applicable.
// Always sends PDF binary per CLAUDE.md; logs raw response; returns
// raw_extracted for debug. Sonnet 4.5 per CLAUDE.md model conventions.
async function extractBidFromPDF(buffer, hintCategory) {
  const prompt = `You are reading a vendor bid / proposal for an HOA community service contract.

Service category context: ${hintCategory || 'unknown'}

Extract the bid into this JSON shape — return ONLY valid JSON, no prose:

{
  "company_name": "Full legal name of the bidding company",
  "company_dba": "DBA / trade name if different from legal name, else null",
  "submitter_name": "Person who signed/submitted the bid",
  "submitter_email": "Email address shown on bid",
  "submitter_phone": "Phone shown on bid",
  "proposal_date": "Date of the proposal in YYYY-MM-DD format, or null",
  "term_months": "Length of proposed term in months (12 = annual), or null",
  "total_annual_amount": "Total ANNUAL contract value in USD (number, not string). For monthly recurring, multiply by 12. Capture the headline price the vendor is asking. null if no clear annual figure.",
  "pricing_breakdown": [
    { "item": "What the price line is for", "amount": 0, "frequency": "monthly|per_event|annual|one_time|hourly" }
  ],
  "scope_items": [
    {
      "name": "Name of the scope item (e.g., 'Mowing', 'Edging', 'Mulch installation', 'Pruning', 'Seasonal color rotation')",
      "included": true,
      "frequency": "weekly|biweekly|monthly|quarterly|annually|seasonal|as_needed|null",
      "notes": "Any qualifier — '28 cuts/yr', 'turf only', 'common areas + median strip', etc."
    }
  ],
  "explicitly_excluded": ["List of items the bid SAYS it does not include — important for apples-to-apples scope comparison"],
  "insurance_policies": [
    { "type": "GL|workers_comp|auto|umbrella|professional", "limit_per_occurrence": 0, "aggregate_limit": 0, "carrier": "Insurance carrier name", "expires_at": "YYYY-MM-DD or null" }
  ],
  "license_numbers": ["Any state licenses, irrigator licenses, applicator licenses, etc."],
  "references": [
    { "community_or_client": "Name of reference", "contact": "Reference contact", "phone": "Phone", "years_served": "How long they've been serving this client" }
  ],
  "warranty_terms": "Any warranty / guarantee language verbatim, or null",
  "escalator_clause": "Year-over-year price escalation if mentioned (e.g., 'CPI + 1%', '3% annual', 'none')",
  "crew_size_or_capacity": "Stated crew size or stated capacity (e.g., '3-man crew', '60 properties under management')",
  "site_visit_completed": true,
  "extraction_confidence": "high|medium|low",
  "extraction_notes": "Any ambiguities — '2 prices given (28-cut and 32-cut), captured 32-cut', 'no insurance certificate attached', 'no signature', etc.",
  "raw_text_samples": {
    "pricing": "Verbatim snippet near the headline price",
    "scope": "Verbatim snippet describing scope",
    "insurance": "Verbatim snippet near insurance disclosure (if any)"
  }
}

IMPORTANT:
- If a field is unclear or absent, set it to null (not made up).
- For total_annual_amount: if pricing is "per cut" or "per event", do your best to annualize using stated frequency. If you can't reliably annualize, set total_annual_amount=null and note in extraction_notes.
- Capture every scope line you see, even if the bid lists exclusions — that's important for the comparison matrix.
- Set extraction_confidence="low" if the PDF is scanned/handwritten/illegible, or if you had to guess on multiple critical fields.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') }
        },
        { type: 'text', text: prompt }
      ]
    }]
  });

  const raw = response.content?.[0]?.text || '';
  console.log('[rfp-extract] Claude returned:', raw.slice(0, 500) + (raw.length > 500 ? '...' : ''));

  // Strip markdown code fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }

  let extracted = null;
  try {
    extracted = JSON.parse(cleaned);
  } catch (parseErr) {
    console.warn('[rfp-extract] JSON parse failed:', parseErr.message);
    // Return a sentinel so the caller still gets the raw text + can surface to operator
    extracted = { _parse_error: parseErr.message, _raw_text_sample: raw.slice(0, 1000) };
  }

  return { extracted, raw, usage: response.usage };
}

// ----------------------------------------------------------------------------
// POST /api/vendors/rfps — create RFP envelope
// Body: { community_id, service_category, title?, due_date? }
// ----------------------------------------------------------------------------
router.post('/rfps', express.json(), async (req, res) => {
  try {
    const { community_id, service_category, title, due_date } = req.body || {};
    if (!community_id) return res.status(400).json({ error: 'community_id required' });
    if (!service_category) return res.status(400).json({ error: 'service_category required' });

    const { data, error } = await supabase
      .from('bid_requests')
      .insert({
        management_company_id: BEDROCK_MGMT_CO_ID,
        community_id,
        service_category,
        title: title || `${service_category} RFP — ${new Date().toISOString().slice(0,10)}`,
        status: 'collecting',
        due_date: due_date || null
      })
      .select()
      .single();
    if (error) throw error;
    res.json({ rfp: data });
  } catch (err) {
    console.error('[vendors] rfp create failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/vendors/rfps — list RFPs (community/status filters)
// ----------------------------------------------------------------------------
router.get('/rfps', async (req, res) => {
  try {
    let q = supabase
      .from('bid_requests')
      .select('*, community:communities(id, name)')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('created_at', { ascending: false })
      .limit(200);
    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);
    if (req.query.status) q = q.eq('status', req.query.status);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ rfps: data || [] });
  } catch (err) {
    console.error('[vendors] rfp list failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/vendors/rfps/:id — RFP + all proposals + audit log
// ----------------------------------------------------------------------------
router.get('/rfps/:id', async (req, res) => {
  try {
    const { data: rfp, error: rErr } = await supabase
      .from('bid_requests')
      .select('*, community:communities(id, name, city, state, zip)')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (rErr) throw rErr;
    if (!rfp) return res.status(404).json({ error: 'RFP not found' });

    const { data: proposals } = await supabase
      .from('vendor_proposals')
      .select('*')
      .eq('bid_request_id', req.params.id)
      .order('total_annual_amount', { ascending: true, nullsFirst: false });

    const { data: log } = await supabase
      .from('rfp_decision_log')
      .select('*')
      .eq('bid_request_id', req.params.id)
      .order('created_at', { ascending: true });

    res.json({ rfp, proposals: proposals || [], decision_log: log || [] });
  } catch (err) {
    console.error('[vendors] rfp detail failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/vendors/rfps/:id/proposals — upload + AI-extract a bid PDF
// multipart/form-data with file field 'file'
// ----------------------------------------------------------------------------
router.post('/rfps/:id/proposals', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file_required' });

    // Load the parent RFP for community + service_category context
    const { data: rfp, error: rErr } = await supabase
      .from('bid_requests')
      .select('id, community_id, service_category')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (rErr) throw rErr;
    if (!rfp) return res.status(404).json({ error: 'RFP not found' });

    const buffer = req.file.buffer;
    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');

    // Dedup check — if the same byte-identical PDF was uploaded under this
    // RFP already, bail with the existing row so operator doesn't end up
    // with two copies of the same bid.
    const { data: existing } = await supabase
      .from('vendor_proposals')
      .select('id, proposer_company_name, total_annual_amount')
      .eq('bid_request_id', rfp.id)
      .eq('file_hash', fileHash)
      .maybeSingle();
    if (existing) {
      return res.json({
        proposal: existing,
        duplicate: true,
        message: 'This file was already uploaded to this RFP. Returning the existing proposal.'
      });
    }

    // Upload to Supabase Storage
    const safeName = (req.file.originalname || 'bid.pdf').replace(/[^A-Za-z0-9._-]/g, '_');
    const storagePath = `rfps/${rfp.id}/${fileHash.slice(0, 12)}_${safeName}`;
    const { error: uploadErr } = await supabase.storage
      .from(PROPOSALS_BUCKET)
      .upload(storagePath, buffer, {
        contentType: 'application/pdf',
        upsert: false
      });
    if (uploadErr && !uploadErr.message?.includes('already exists')) {
      throw uploadErr;
    }

    // AI extraction
    let extracted = null;
    let rawExtraction = '';
    let extractionUsage = null;
    try {
      const result = await extractBidFromPDF(buffer, rfp.service_category);
      extracted = result.extracted;
      rawExtraction = result.raw;
      extractionUsage = result.usage;
    } catch (extractErr) {
      console.error('[rfp-extract] Claude call failed:', extractErr.message);
      extracted = { _extract_error: extractErr.message };
    }

    // Insert the proposal row
    const { data: proposal, error: insErr } = await supabase
      .from('vendor_proposals')
      .insert({
        management_company_id: BEDROCK_MGMT_CO_ID,
        community_id: rfp.community_id,
        service_category: rfp.service_category,
        bid_request_id: rfp.id,
        proposer_company_name: extracted?.company_name || null,
        total_annual_amount: typeof extracted?.total_annual_amount === 'number' ? extracted.total_annual_amount : null,
        term_months: typeof extracted?.term_months === 'number' ? extracted.term_months : null,
        extracted_data: extracted,
        file_path: storagePath,
        file_hash: fileHash,
        file_size_bytes: buffer.length,
        outcome: 'pending',
        is_finalist: false
      })
      .select()
      .single();
    if (insErr) throw insErr;

    res.json({
      proposal,
      extracted,
      raw_extracted: rawExtraction.slice(0, 5000), // truncate for response size
      usage: extractionUsage,
      diagnostic: {
        file_hash: fileHash,
        file_size_bytes: buffer.length,
        storage_path: storagePath,
        extraction_confidence: extracted?.extraction_confidence || 'unknown'
      }
    });
  } catch (err) {
    console.error('[vendors] proposal upload failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// PATCH /api/vendors/proposals/:id — finalist / eliminate / reset
// Body: { action: 'mark_finalist' | 'eliminate' | 'reset', reason?, operator }
// Writes audit row to rfp_decision_log on every change.
// Enforces max 3 finalists per RFP (HTTP 409 if exceeded).
// ----------------------------------------------------------------------------
router.patch('/proposals/:id', express.json(), async (req, res) => {
  try {
    const { action, reason, operator } = req.body || {};
    if (!['mark_finalist', 'eliminate', 'reset'].includes(action)) {
      return res.status(400).json({ error: 'action must be mark_finalist | eliminate | reset' });
    }
    if (!operator || !String(operator).trim()) {
      return res.status(400).json({ error: 'operator required (your name for audit trail)' });
    }
    if (action === 'eliminate' && (!reason || !String(reason).trim())) {
      return res.status(400).json({ error: 'reason required when eliminating a bid — operator must record why' });
    }

    // Load current state for before/after snapshot
    const { data: before, error: bErr } = await supabase
      .from('vendor_proposals')
      .select('id, bid_request_id, is_finalist, eliminated_at, eliminated_by, eliminated_reason, outcome')
      .eq('id', req.params.id)
      .single();
    if (bErr || !before) return res.status(404).json({ error: 'Proposal not found' });

    let patch = { updated_at: new Date().toISOString() };

    if (action === 'mark_finalist') {
      // Count current finalists in this RFP
      const { count: finalistCount } = await supabase
        .from('vendor_proposals')
        .select('*', { count: 'exact', head: true })
        .eq('bid_request_id', before.bid_request_id)
        .eq('is_finalist', true);
      if ((finalistCount || 0) >= 3 && !before.is_finalist) {
        return res.status(409).json({
          error: `Already 3 finalists marked for this RFP. Eliminate or reset one before adding another.`,
          finalist_count: finalistCount
        });
      }
      patch.is_finalist = true;
      patch.eliminated_at = null;
      patch.eliminated_by = null;
      patch.eliminated_reason = null;
      patch.outcome = 'pending'; // back under consideration
    } else if (action === 'eliminate') {
      patch.is_finalist = false;
      patch.eliminated_at = new Date().toISOString();
      patch.eliminated_by = operator;
      patch.eliminated_reason = reason;
      patch.outcome = 'lost';
      patch.outcome_decided_at = new Date().toISOString();
      patch.outcome_notes = reason;
    } else if (action === 'reset') {
      patch.is_finalist = false;
      patch.eliminated_at = null;
      patch.eliminated_by = null;
      patch.eliminated_reason = null;
      patch.outcome = 'pending';
      patch.outcome_decided_at = null;
      patch.outcome_notes = null;
    }

    const { data: after, error: uErr } = await supabase
      .from('vendor_proposals')
      .update(patch)
      .eq('id', req.params.id)
      .select()
      .single();
    if (uErr) throw uErr;

    // Audit trail — immutable record of the decision
    await supabase.from('rfp_decision_log').insert({
      bid_request_id: before.bid_request_id,
      proposal_id: req.params.id,
      action,
      reason: reason || null,
      operator,
      before_state: {
        is_finalist: before.is_finalist,
        eliminated_at: before.eliminated_at,
        eliminated_reason: before.eliminated_reason,
        outcome: before.outcome
      },
      after_state: {
        is_finalist: after.is_finalist,
        eliminated_at: after.eliminated_at,
        eliminated_reason: after.eliminated_reason,
        outcome: after.outcome
      }
    });

    res.json({ proposal: after });
  } catch (err) {
    console.error('[vendors] proposal PATCH failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/vendors/benchmarks
// ----------------------------------------------------------------------------
// INTERNAL USE ONLY — Bedrock portfolio benchmark intelligence. Aggregates
// every historical bid in a service category across the management
// company's communities to compute percentile distribution (min, p25,
// median, p75, max, mean) plus by-year breakdown.
//
// Used by the RFP comparison UI to show "this bid is at p65 of our
// portfolio for landscape maintenance" — operator gets pricing intel at
// decision time. This data MUST NOT leak to boards, homeowners, or
// vendors. The board memo PDF (lib/vendors/board_memo.js) deliberately
// excludes benchmark data — only the formal recommendation + cut list
// makes it onto the customer-facing artifact.
//
// Query: ?service_category=landscape_maintenance [&exclude_rfp_id=<uuid>]
// The exclude_rfp_id param prevents the current RFP's own bids from
// biasing the historical benchmark (don't compare your bids against
// themselves — apples-to-apples means comparing against PRIOR portfolio
// experience, not the bids you're evaluating right now).
// ----------------------------------------------------------------------------
router.get('/benchmarks', async (req, res) => {
  try {
    const category = (req.query.service_category || '').trim();
    if (!category) return res.status(400).json({ error: 'service_category required' });
    const excludeRfpId = (req.query.exclude_rfp_id || '').trim() || null;

    // Pull every annualized bid in this category for this management co.
    // Filter out the current RFP's bids if requested — keeps "your bid vs
    // PRIOR portfolio history" honest. Limit isn't a concern at portfolio
    // scale today (low hundreds at most); revisit when an individual
    // category has 10k+ historical bids.
    let q = supabase
      .from('vendor_proposals')
      .select('id, bid_request_id, total_annual_amount, proposal_date, created_at, community_id')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .eq('service_category', category)
      .not('total_annual_amount', 'is', null);
    const { data: rows, error } = await q;
    if (error) throw error;

    const eligible = (rows || []).filter((r) => {
      if (excludeRfpId && r.bid_request_id === excludeRfpId) return false;
      const n = Number(r.total_annual_amount);
      return Number.isFinite(n) && n > 0;
    });

    if (eligible.length < 3) {
      // Below threshold for meaningful percentiles — return shape but
      // flag insufficient_data so UI doesn't render misleading badges.
      return res.json({
        internal_only: true,
        warning: 'INTERNAL USE ONLY — Bedrock portfolio data. Do not share with vendors, boards, or homeowners.',
        service_category: category,
        total_bids: eligible.length,
        insufficient_data: true,
        message: `Only ${eligible.length} historical bids in this category — benchmark needs ≥3 to compute percentiles. Run a few more RFPs through the system and this signal sharpens.`
      });
    }

    // Sort ascending, compute percentiles + descriptive stats
    const amounts = eligible.map((r) => Number(r.total_annual_amount)).sort((a, b) => a - b);
    const pct = (p) => {
      const idx = (amounts.length - 1) * p;
      const lo = Math.floor(idx);
      const hi = Math.ceil(idx);
      if (lo === hi) return amounts[lo];
      const w = idx - lo;
      return amounts[lo] * (1 - w) + amounts[hi] * w;
    };
    const mean = amounts.reduce((s, n) => s + n, 0) / amounts.length;
    const uniqueCommunities = new Set(eligible.map((r) => r.community_id).filter(Boolean)).size;

    // Per-year breakdown for the trend chart (last 5 years)
    const byYear = {};
    for (const r of eligible) {
      const dt = new Date(r.proposal_date || r.created_at);
      if (isNaN(dt)) continue;
      const y = dt.getFullYear();
      if (!byYear[y]) byYear[y] = [];
      byYear[y].push(Number(r.total_annual_amount));
    }
    const byYearStats = Object.entries(byYear)
      .map(([year, vals]) => {
        vals.sort((a, b) => a - b);
        const median = vals.length % 2
          ? vals[Math.floor(vals.length / 2)]
          : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2;
        return { year: Number(year), bid_count: vals.length, median };
      })
      .sort((a, b) => a.year - b.year);

    res.json({
      internal_only: true,
      warning: 'INTERNAL USE ONLY — Bedrock portfolio data. Do not share with vendors, boards, or homeowners.',
      service_category: category,
      total_bids: eligible.length,
      unique_communities: uniqueCommunities,
      stats: {
        min: amounts[0],
        p25: pct(0.25),
        median: pct(0.5),
        p75: pct(0.75),
        max: amounts[amounts.length - 1],
        mean
      },
      by_year: byYearStats
    });
  } catch (err) {
    console.error('[vendors/benchmarks]', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/vendors/rfps/:id/decision-log — audit trail for this RFP
// ----------------------------------------------------------------------------
router.get('/rfps/:id/decision-log', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rfp_decision_log')
      .select('*')
      .eq('bid_request_id', req.params.id)
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ log: data || [] });
  } catch (err) {
    console.error('[vendors] decision log fetch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/vendors/:vendorId/w9  — upload the vendor's W-9 (drag/click).
// Stores the PDF, files it as a vendor_document(doc_type='w9'), flips w9_on_file,
// and AI-reads it to capture the tax classification + TIN and SUGGEST the 1099
// flag (operator can still override the toggle).
// ----------------------------------------------------------------------------
router.post('/:vendorId/w9', upload.single('pdf'), async (req, res) => {
  const { vendorId } = req.params;
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF uploaded (expected field "pdf").' });
    if (req.file.mimetype !== 'application/pdf') return res.status(400).json({ error: `Unsupported file type: ${req.file.mimetype}` });

    const { data: vendor } = await supabase.from('vendors').select('id, ein, tax_id').eq('id', vendorId).maybeSingle();
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    // Store the PDF (audit trail). Non-fatal on storage failure.
    let storagePath = null;
    try {
      const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex').slice(0, 16);
      const safe = (req.file.originalname || 'w9.pdf').replace(/[^a-zA-Z0-9._\-]/g, '_');
      storagePath = `vendor_w9/${vendorId}/${hash}_${safe}`;
      await supabase.storage.from('documents').upload(storagePath, req.file.buffer, { contentType: 'application/pdf', upsert: true });
    } catch (e) { console.warn('[vendors] W-9 storage upload failed (non-fatal):', e.message); storagePath = null; }

    // Read the W-9 (degrades gracefully — the doc still files if parse fails).
    const { extractW9 } = require('../lib/vendors/w9_extract');
    let ex = { parsed: null, suggested_1099: true, degraded: true };
    try { ex = await extractW9(req.file.buffer); } catch (e) { console.warn('[vendors] W-9 parse failed (non-fatal):', e.message); }

    const today = new Date().toISOString().slice(0, 10);
    const { data: doc, error: docErr } = await supabase.from('vendor_documents').insert({
      vendor_id: vendorId, doc_type: 'w9',
      file_name: req.file.originalname || 'W-9.pdf', file_url: storagePath,
      effective_date: today,
      notes: ex.parsed ? `${ex.parsed.tax_classification}${ex.parsed.tin ? ' · TIN on file' : ''}` : 'W-9 (not auto-read)',
    }).select().single();
    if (docErr) throw docErr;

    // Flip w9_on_file + capture tax fields + set the SUGGESTED 1099 flag.
    const vUpdate = { w9_on_file: true, w9_uploaded_at: new Date().toISOString(), w9_received_date: today };
    if (ex.parsed) {
      vUpdate.tax_classification = ex.parsed.tax_classification;
      if (ex.parsed.tin) vUpdate.tax_id = ex.parsed.tin;
      if (ex.parsed.tin && ex.parsed.tin_type === 'ein' && !vendor.ein) vUpdate.ein = ex.parsed.tin;
      vUpdate.is_1099_vendor = ex.suggested_1099;
    }
    const { data: updated, error: upErr } = await supabase.from('vendors').update(vUpdate).eq('id', vendorId).select().single();
    if (upErr) throw upErr;

    res.json({ ok: true, document: doc, vendor: updated, parsed: ex.parsed, suggested_1099: ex.suggested_1099, degraded: ex.degraded });
  } catch (err) {
    console.error('[vendors] W-9 upload failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/vendors/documents/:docId/file  — open a stored vendor document
// (W-9, contract, COI). Redirects to a short-lived signed URL. Bucket 'documents'.
router.get('/documents/:docId/file', async (req, res) => {
  try {
    const { data: doc } = await supabase.from('vendor_documents').select('file_url').eq('id', req.params.docId).maybeSingle();
    if (!doc || !doc.file_url) return res.status(404).json({ error: 'document_not_found' });
    const { data, error } = await supabase.storage.from('documents').createSignedUrl(String(doc.file_url), 60 * 60);
    if (error || !data || !data.signedUrl) return res.status(404).json({ error: 'file_not_found' });
    res.redirect(data.signedUrl);
  } catch (err) {
    console.error('[vendors] document file failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/vendors/spend?year=&community_id=  — annual spend per vendor x
// community (both rails: historical uploads + Emma-paid), keyed on the CASH
// paid date, with the 1099 flag + W-9 status. Drives the spend report AND the
// 1099 file (the frontend filters to >= $600 for the 1099 view). 1099 is per
// filer (community/EIN), so rows stay per (vendor x community).
const CENTS_1099_THRESHOLD = 60000; // $600
router.get('/spend', async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    let q = supabase.from('v_vendor_annual_spend').select('*').eq('paid_year', year);
    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);
    const { data: spendRows, error } = await q;
    if (error) throw error;
    const rows = spendRows || [];
    if (!rows.length) return res.json({ year, threshold_cents: CENTS_1099_THRESHOLD, rows: [] });

    const vendorIds = [...new Set(rows.map(r => r.vendor_id).filter(Boolean))];
    const communityIds = [...new Set(rows.map(r => r.community_id).filter(Boolean))];

    const [{ data: vendors }, { data: comms }, { data: w9docs }] = await Promise.all([
      supabase.from('vendors').select('id, name, is_1099_vendor, w9_on_file, tax_id, tax_classification').in('id', vendorIds),
      communityIds.length ? supabase.from('communities').select('id, name').in('id', communityIds) : Promise.resolve({ data: [] }),
      supabase.from('vendor_documents').select('id, vendor_id, uploaded_at').eq('doc_type', 'w9').in('vendor_id', vendorIds).order('uploaded_at', { ascending: false }),
    ]);
    const vById = Object.fromEntries((vendors || []).map(v => [v.id, v]));
    const cById = Object.fromEntries((comms || []).map(c => [c.id, c.name]));
    const w9ById = {}; for (const d of (w9docs || [])) if (!w9ById[d.vendor_id]) w9ById[d.vendor_id] = d.id; // latest per vendor

    const out = rows.map(r => {
      const v = vById[r.vendor_id] || {};
      const total = Number(r.total_cents) || 0;
      return {
        vendor_id: r.vendor_id,
        vendor_name: v.name || '(unknown vendor)',
        community_id: r.community_id,
        community_name: r.community_id ? (cById[r.community_id] || '(unknown)') : 'Unassigned',
        year,
        total_cents: total,
        historical_cents: Number(r.historical_cents) || 0,
        current_cents: Number(r.current_cents) || 0,
        payment_count: Number(r.payment_count) || 0,
        has_estimated_dates: !!r.has_estimated_dates,
        is_1099_vendor: !!v.is_1099_vendor,
        w9_on_file: !!v.w9_on_file,
        w9_doc_id: w9ById[r.vendor_id] || null,
        tax_id: v.tax_id || null,
        tax_classification: v.tax_classification || null,
        over_threshold: total >= CENTS_1099_THRESHOLD,
        needs_w9: !!v.is_1099_vendor && !v.w9_on_file,
      };
    }).sort((a, b) => b.total_cents - a.total_cents);

    res.json({ year, threshold_cents: CENTS_1099_THRESHOLD, rows: out });
  } catch (err) {
    console.error('[vendors] spend report failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router };
