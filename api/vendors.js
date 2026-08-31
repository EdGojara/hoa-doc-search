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
const { findDuplicates } = require('../lib/ap/dedup');

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

// ----------------------------------------------------------------------------
// SSOT bridge: the vendor page's "historical invoice" tool now writes/reads the
// canonical ap_invoices/ap_payments rail (migration 334). The frontend still
// speaks the old invoices_received field names, so every read maps an
// ap_invoices row back to that shape. One place to keep the two vocabularies in
// sync — do NOT scatter this mapping across handlers.
//   invoice_number        <- vendor_invoice_number
//   total_amount (dollars) <- total_cents / 100
//   gl_match_status        <- posting_journal_entry_id ? 'matched' : 'unmatched'
//   service_period_*, invoice_date, due_date, status, notes, community: pass-through
// ----------------------------------------------------------------------------
function apInvoiceToLegacy(row) {
  if (!row) return row;
  const centsToDollars = (c) => (c === null || c === undefined ? null : Number(c) / 100);
  const out = {
    id: row.id,
    community_id: row.community_id,
    vendor_id: row.vendor_id,
    invoice_number: row.vendor_invoice_number || null,
    invoice_date: row.invoice_date || null,
    due_date: row.due_date || null,
    service_period_start: row.service_period_start || null,
    service_period_end: row.service_period_end || null,
    total_amount: centsToDollars(row.total_cents),
    status: row.status || null,
    // gl_match_status is honest here: these historical uploads carry NO posting
    // journal entry (no accrual), so they read 'unmatched' — same as the old
    // invoices_received default. A future reconciliation that links a JE flips it.
    gl_match_status: row.posting_journal_entry_id ? 'matched' : 'unmatched',
    file_name: row.source_filename || null,
    notes: row.notes || null,
    created_at: row.created_at || null,
  };
  if (row.vendor) out.vendor = row.vendor;
  if (row.community) out.community = row.community;
  return out;
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

    // Optional community filter: keep only vendors that have at least one invoice
    // for this community (canonical rail — ap_invoices).
    if (community_id) {
      const ids = vendors.map(v => v.id);
      if (ids.length > 0) {
        const { data: invByCommunity, error: filtErr } = await supabase
          .from('ap_invoices')
          .select('vendor_id')
          .eq('community_id', community_id)
          .in('vendor_id', ids);
        if (filtErr) throw filtErr;
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

    // YTD spend + action flags (Ed 2026-08-31). A vendor-wide LIFETIME total is a
    // vanity number on an operational screen; what drives decisions is (a) spend
    // THIS calendar year — the 1099 threshold + budget basis — scoped to the
    // filtered community, and (b) whether the vendor needs something done (COI
    // expired/expiring, W-9 missing while over the $600 IRS threshold). Compute
    // both here, and sort the vendors that need action to the top.
    const year = new Date().getFullYear();
    const spend_scope = community_id ? 'community' : 'all';
    if (vendors.length) {
      const { fetchAllQuery } = require('../lib/db/fetch_all');
      const ids = vendors.map(v => v.id);
      const yearStart = `${year}-01-01`;
      // Cash-out rail (ap_payments), paginated (PostgREST 1000-row cap), scoped
      // to the selected community when one is filtered.
      const pays = await fetchAllQuery(() => {
        let pq = supabase.from('ap_payments')
          .select('vendor_id, amount_cents, payment_date, community_id')
          .in('vendor_id', ids)
          .gte('payment_date', yearStart);
        if (community_id) pq = pq.eq('community_id', community_id);
        return pq;
      }, { orderBy: 'payment_date' });
      const ytdByVendor = {};
      for (const p of pays) ytdByVendor[p.vendor_id] = (ytdByVendor[p.vendor_id] || 0) + Number(p.amount_cents || 0);

      vendors = vendors.map((v) => {
        const ytd = ytdByVendor[v.id] || 0;
        let coi_state = 'none';
        if (v.earliest_coi_expiry) {
          const days = Math.floor((new Date(v.earliest_coi_expiry) - new Date()) / 86400000);
          coi_state = days < 0 ? 'expired' : (days <= 30 ? 'expiring' : 'ok');
        }
        // Reportable, no W-9 on file, and paid at/over $600 this year.
        const needs_w9 = !!v.is_1099_vendor && !v.w9_received_date && !v.w9_on_file && ytd >= 60000;
        return { ...v, ytd_spend_cents: ytd, ytd_year: year, spend_scope, coi_state, needs_w9, has_action: coi_state === 'expired' || coi_state === 'expiring' || needs_w9 };
      });

      // Lead with what needs doing: expired COI, then W-9 owed, then expiring
      // COI, then everyone else — within each tier, biggest YTD spend first.
      const rank = (v) => (v.coi_state === 'expired' ? 0 : v.needs_w9 ? 1 : v.coi_state === 'expiring' ? 2 : 3);
      vendors.sort((a, b) => rank(a) - rank(b) || (b.ytd_spend_cents || 0) - (a.ytd_spend_cents || 0));
    }

    res.json({ vendors, ytd_year: year, spend_scope });
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

    const { data: invoices, error: invErr } = await supabase
      .from('ap_invoices')
      .select('id, community_id, vendor_invoice_number, invoice_date, due_date, service_period_start, service_period_end, total_cents, status, posting_journal_entry_id, source_filename, notes, created_at, community:communities(name, vantaca_code)')
      .eq('vendor_id', vendorId)
      .order('invoice_date', { ascending: false, nullsFirst: false })
      .limit(50);
    if (invErr) throw invErr;

    const { data: documents } = await supabase
      .from('vendor_documents')
      .select('*')
      .eq('vendor_id', vendorId)
      .order('uploaded_at', { ascending: false });

    // Payments — the CANONICAL cash-out rail (ap_payments), so the 360 shows what
    // actually left the bank, not just what was billed. (Ed 2026-08-01.)
    const { data: payments } = await supabase
      .from('ap_payments')
      .select('id, community_id, amount_cents, payment_date, payment_method, check_number, status, created_at, community:communities(name)')
      .eq('vendor_id', vendorId)
      .order('payment_date', { ascending: false, nullsFirst: false })
      .limit(50);

    // Historical invoices (invoices_received) — bills paid OUTSIDE the system,
    // kept for the record. Merged into the vendor's invoice history so the 360
    // shows EVERYTHING billed, not just the current AP rail. total_amount is
    // dollars here; normalize to cents for one display shape. (Ed 2026-08-01.)
    const { data: histInv } = await supabase
      .from('invoices_received')
      .select('id, community_id, invoice_number, invoice_date, total_amount, status, paid_date, community:communities(name)')
      .eq('vendor_id', vendorId)
      .order('invoice_date', { ascending: false, nullsFirst: false })
      .limit(100);

    // YTD + lifetime spend from ap_payments (cash-basis), AND a per-ASSOCIATION
    // breakdown — 1099 is per filer (each community is its own EIN), so spend is
    // never co-mingled across associations. Per-vendor is small; sum in JS.
    const yearStart = `${new Date().getFullYear()}-01-01`;
    let ytdCents = 0, lifeCents = 0;
    const byComm = {};
    try {
      const { data: allPays } = await supabase.from('ap_payments')
        .select('amount_cents, payment_date, community_id, community:communities(name)').eq('vendor_id', vendorId).limit(2000);
      for (const p of (allPays || [])) {
        const amt = Number(p.amount_cents || 0);
        const inYear = p.payment_date && String(p.payment_date) >= yearStart;
        lifeCents += amt; if (inYear) ytdCents += amt;
        const key = p.community_id || 'unassigned';
        if (!byComm[key]) byComm[key] = { community_id: p.community_id || null, community_name: (p.community && p.community.name) || 'Unassigned', ytd_cents: 0, lifetime_cents: 0 };
        byComm[key].lifetime_cents += amt; if (inYear) byComm[key].ytd_cents += amt;
      }
    } catch (_) { /* spend rollup best-effort */ }
    const spend_by_community = Object.values(byComm).sort((a, b) => b.lifetime_cents - a.lifetime_cents);

    // Proposals this vendor submitted (RFP responses) + correspondence linked to
    // them — the rest of the 360, all off canonical rails. (Ed 2026-08-01.)
    const { data: proposals } = await supabase
      .from('vendor_proposals')
      .select('id, proposal_date, service_category, total_amount, total_annual_amount, outcome, is_finalist, is_incumbent, filename, community, community_id, created_at')
      .eq('vendor_id', vendorId)
      .order('proposal_date', { ascending: false, nullsFirst: false })
      .limit(30);

    const { data: correspondence } = await supabase
      .from('email_messages')
      .select('id, subject, sender_email, direction, received_at, ai_summary, classification')
      .eq('resolved_vendor_id', vendorId)
      .order('received_at', { ascending: false })
      .limit(30);

    const historical_invoices = (histInv || []).map((h) => ({
      id: h.id, invoice_number: h.invoice_number, invoice_date: h.invoice_date,
      total_cents: Math.round(Number(h.total_amount || 0) * 100), status: h.status,
      paid_date: h.paid_date, community: h.community, source: 'historical',
    }));

    res.json({
      vendor,
      invoices: (invoices || []).map(apInvoiceToLegacy),
      historical_invoices,
      payments: payments || [],
      proposals: proposals || [],
      correspondence: correspondence || [],
      documents: documents || [],
      spend: { ytd_cents: ytdCents, lifetime_cents: lifeCents, year: new Date().getFullYear() },
      spend_by_community,
    });
  } catch (err) {
    console.error('[vendors] detail failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/vendors/:id  — update vendor fields
router.patch('/:vendorId', async (req, res) => {
  const { vendorId } = req.params;
  const allowed = ['name','dba','ein','address','phone','email','website','category','status','w9_on_file','notes',
                   'is_1099_vendor','tax_classification','tax_id','w9_received_date',
                   'is_mud','convenience_fee_cents','payment_terms_days','payee_name','auto_pay_ach',
                   // Contact person + remittance — single source of truth for who/where. (Ed 2026-08-01.)
                   'contact_name','contact_email','contact_phone',
                   'remit_address_line1','remit_address_line2','remit_city','remit_state','remit_zip'];
  const update = {};
  for (const k of allowed) if (k in (req.body || {})) update[k] = req.body[k];
  // A MUD vendor carries the standard $1 convenience fee unless a specific
  // amount was set alongside the flag. Turning the flag off clears the fee.
  if ('is_mud' in (req.body || {})) {
    if (req.body.is_mud === true && !('convenience_fee_cents' in (req.body || {}))) update.convenience_fee_cents = 100;
    if (req.body.is_mud === false && !('convenience_fee_cents' in (req.body || {}))) update.convenience_fee_cents = 0;
  }
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

// POST /api/vendors/invoices/upload  — drop a HISTORICAL (already-paid) vendor
// invoice PDF -> AI parse -> match/create vendor -> record on the CANONICAL rail.
//
// SSOT (migration 334): this is the vendor-page "build annual spend + 1099"
// tool. A historical bill is recorded as:
//   - one ap_invoice   (status='paid', fully paid) — the record the vendor page shows
//   - one ap_payment   (status='completed', cash-basis) — what the 1099 view sums
// NO GL accrual. These are already-paid history, not a new payable, so we do
// NOT route through lib/ap/intake.js autoIntake (which posts an accrual JE and
// queues for approval). We write the two rows directly.
//
// Dedup uses the ONE canonical detector (lib/ap/dedup findDuplicates), which
// reads ap_invoices — so this path and Emma's live AP path can finally see each
// other's bills (the whole point of the merge). Layers:
//   1. byte-level: exact same PDF for this community -> skip the AI call, 409.
//   2. vendor + normalized invoice # -> certain, 409.
//   3. vendor + amount + same/near date -> suspected, 409.
// force_insert=true bypasses the detector. The DB UNIQUE
// (community, vendor, vendor_invoice_number) is the final race-condition net.
//
// community_id is REQUIRED (ap_invoices.community_id is NOT NULL, and 1099 spend
// is per filer/community anyway) — 400 if missing.
router.post('/invoices/upload', upload.single('pdf'), async (req, res) => {
  const t0 = Date.now();
  if (!req.file) return res.status(400).json({ error: 'No PDF uploaded (expected field "pdf")' });
  if (req.file.mimetype !== 'application/pdf') {
    return res.status(400).json({ error: `Unsupported file type: ${req.file.mimetype}` });
  }
  const { community_id, finding_id, category_hint, force_insert } = req.body || {};
  const forceInsert = force_insert === 'true' || force_insert === true;
  if (!community_id) {
    return res.status(400).json({ error: 'Pick a community before uploading — a historical invoice is recorded per community (1099 spend is filed per community).' });
  }

  // Shape an ap_invoices dup row back into what the vendor-page frontend expects.
  const dupExisting = (inv, vendorName) => ({
    id: inv.id,
    invoice_number: inv.vendor_invoice_number || null,
    invoice_date: inv.invoice_date || null,
    total_amount: inv.total_cents != null ? Number(inv.total_cents) / 100 : null,
    vendor: vendorName ? { name: vendorName } : undefined,
  });

  try {
    // ---- Layer 1: byte-identical file already on the canonical rail (skip AI) ----
    const fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    if (!forceInsert) {
      const { data: hashHit, error: hashErr } = await supabase
        .from('ap_invoices')
        .select('id, vendor_invoice_number, invoice_date, total_cents, vendor:vendors(name)')
        .eq('community_id', community_id)
        .eq('file_sha256', fileHash)
        .neq('status', 'voided')
        .limit(1)
        .maybeSingle();
      if (hashErr) throw hashErr;
      if (hashHit) {
        return res.status(409).json({
          duplicate: true,
          dup_reason: 'file_hash',
          message: 'Exact same PDF file is already on file. Skipping the AI parse — confirm if you really want a second copy.',
          existing_invoice: dupExisting(hashHit, hashHit.vendor?.name),
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

    // ---- Validate before persisting (extract -> validate -> render) ----
    // total must be a positive amount (ap_invoices.total_cents CHECK > 0).
    const totalCents = (parsed.total_amount !== null && parsed.total_amount !== undefined)
      ? Math.round(Number(parsed.total_amount) * 100) : null;
    if (!totalCents || totalCents <= 0) {
      return res.status(400).json({
        error: 'Could not read a positive invoice total from this PDF. Re-check the file or enter the invoice manually.',
        diagnostic: { extracted_total: parsed.total_amount ?? null, parse_confidence: parsed.parse_confidence || null }
      });
    }
    // invoice_date is NOT NULL on ap_invoices. Fall back to the paid date, then reject.
    const paidDateInput = (req.body && req.body.paid_date) || parsed.paid_date || null;
    const invoiceDate = parsed.invoice_date || paidDateInput || null;
    if (!invoiceDate) {
      return res.status(400).json({
        error: 'Could not read an invoice date (or a paid date) from this PDF. Enter a paid date in the Historical Invoices box and retry.',
        diagnostic: { extracted_invoice_date: parsed.invoice_date ?? null, paid_date: paidDateInput }
      });
    }
    // Cash-basis payment date drives the 1099 year. Prefer the explicit paid date;
    // fall back to the invoice date and flag it estimated (matches migration 334).
    const paymentDate = paidDateInput || invoiceDate;
    const dateEstimated = !paidDateInput;

    // ---- Dedup on the canonical rail (unless force) ----
    if (!forceInsert) {
      const dup = await findDuplicates(supabase, {
        communityId: community_id,
        vendorId: matchResult.vendor.id,
        invoiceNumber: parsed.invoice_number || null,
        totalCents,
        invoiceDate,
        fileSha256: fileHash,
        accountNumber: null,
        servicePeriodStart: parsed.service_period_start || null,
        servicePeriodEnd: parsed.service_period_end || null,
      });
      if (dup.verdict !== 'unique' && dup.matches.length) {
        const top = dup.matches[0];
        const dupReason = /same file/i.test(top.reason) ? 'file_hash'
          : /invoice #|account/i.test(top.reason) ? 'vendor_invoice_number'
          : 'soft_amount_date';
        return res.status(409).json({
          duplicate: true,
          dup_reason: dupReason,
          message: `${top.reason}. ${top.confidence === 'certain' ? 'This looks like the same bill.' : 'Likely a duplicate.'} Confirm if it is a legitimate second copy.`,
          existing_invoice: dupExisting(top.invoice, matchResult.vendor.name),
          parsed,
          vendor: matchResult.vendor,
          vendor_was_created: matchResult.was_created,
          vendor_match_method: matchResult.match_method,
          vendor_match_score: matchResult.match_score
        });
      }
    }

    // ---- Insert the canonical ap_invoice (status='paid', fully settled) ----
    const { data: invoice, error: insErr } = await supabase
      .from('ap_invoices')
      .insert({
        community_id,
        vendor_id: matchResult.vendor.id,
        vendor_invoice_number: parsed.invoice_number || null,
        invoice_date: invoiceDate,
        due_date: parsed.due_date || null,
        service_period_start: parsed.service_period_start || null,
        service_period_end: parsed.service_period_end || null,
        subtotal_cents: totalCents,
        tax_cents: 0,
        total_cents: totalCents,
        amount_paid_cents: totalCents,     // historical = already fully paid
        status: 'paid',
        paid_at: paymentDate,
        // NO posting_journal_entry_id — historical paid record, not a new accrual.
        source_filename: req.file.originalname,
        file_sha256: fileHash,
        intake_method: 'manual_upload',
        intake_source_ref: finding_id || null,
        dedup_status: 'unique',
        auto_coded: false,
        notes: parsed.notes || null
      })
      .select()
      .single();
    if (insErr) {
      // Unique-index violation (community, vendor, invoice#) — race with the dup check.
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

    // ---- Insert the matching cash-basis ap_payment (what 1099 sums) ----
    // notes prefix 'hist-import:' makes v_vendor_annual_spend count it as
    // historical spend; the '(date estimated...)' marker matches migration 334
    // so the spend view flags estimated dates the same way.
    const paymentNotes = 'hist-import:vendor_upload:' + invoice.id
      + (dateEstimated ? ' (date estimated from invoice_date)' : '')
      + (parsed.invoice_number ? ' inv#' + parsed.invoice_number : '');
    const { data: payment, error: payErr } = await supabase
      .from('ap_payments')
      .insert({
        community_id,
        vendor_id: matchResult.vendor.id,
        payment_date: paymentDate,
        amount_cents: totalCents,
        payment_method: 'other',
        status: 'completed',
        notes: paymentNotes
      })
      .select('id')
      .single();
    if (payErr) {
      // Compensating delete — never leave a paid ap_invoice with no payment (it
      // would show as a bill but never count toward 1099 spend).
      await supabase.from('ap_invoices').delete().eq('id', invoice.id);
      throw payErr;
    }

    // Trade-tape entry.
    await supabase.from('agent_runs').insert({
      management_company_id: BEDROCK_MGMT_CO_ID,
      community_id,
      module: 'vendors',
      endpoint: 'POST /api/vendors/invoices/upload',
      request_input: { file_name: req.file.originalname, file_size: req.file.size, file_hash: fileHash, finding_id: finding_id || null, force_insert: forceInsert },
      retrieved_context: { vendor_id: matchResult.vendor.id, was_new_vendor: matchResult.was_created },
      prompt: 'parseVendorInvoicePDF',
      model: 'claude-sonnet-4-6',
      response: { extracted: parsed, match_method: matchResult.match_method, match_score: matchResult.match_score, ap_invoice_id: invoice.id, ap_payment_id: payment.id },
      input_tokens: usage ? usage.input_tokens : null,
      output_tokens: usage ? usage.output_tokens : null,
      duration_ms: Date.now() - t0
    });

    res.json({
      invoice: apInvoiceToLegacy(invoice),
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

// DELETE /api/vendors/invoices/:invoiceId  — remove a historical invoice (e.g.
// a duplicate). Deletes the canonical ap_invoice AND its linked cash-basis
// ap_payment (the 'hist-import:vendor_upload:<id>' row) so the 1099/spend total
// drops by the same amount — never orphan a payment when its invoice is gone.
router.delete('/invoices/:invoiceId', async (req, res) => {
  const { invoiceId } = req.params;
  try {
    // Pull the row first so we can log what was deleted.
    const { data: existing, error: exErr } = await supabase
      .from('ap_invoices')
      .select('id, vendor_id, community_id, vendor_invoice_number, invoice_date, total_cents, source_filename')
      .eq('id', invoiceId)
      .maybeSingle();
    if (exErr) throw exErr;
    if (!existing) return res.status(404).json({ error: 'Invoice not found' });

    // Remove the paired historical payment first (spend view reads ap_payments).
    // Keyed on the exact marker this upload path writes.
    const { data: paysDeleted, error: payDelErr } = await supabase
      .from('ap_payments')
      .delete()
      .eq('community_id', existing.community_id)
      .eq('vendor_id', existing.vendor_id)
      .like('notes', 'hist-import:vendor_upload:' + invoiceId + '%')
      .select('id');
    if (payDelErr) throw payDelErr;

    const { error: delErr } = await supabase
      .from('ap_invoices')
      .delete()
      .eq('id', invoiceId);
    if (delErr) throw delErr;

    // Audit: every delete goes on the trade tape.
    await supabase.from('agent_runs').insert({
      management_company_id: BEDROCK_MGMT_CO_ID,
      community_id: existing.community_id,
      module: 'vendors',
      endpoint: 'DELETE /api/vendors/invoices/:id',
      request_input: { invoice_id: invoiceId, reason: req.body?.reason || null },
      retrieved_context: { deleted_record: existing, deleted_payment_ids: (paysDeleted || []).map(p => p.id) },
      prompt: null,
      model: null,
      response: { ok: true },
      duration_ms: 0
    });

    res.json({ ok: true, deleted: apInvoiceToLegacy(existing), deleted_payment_count: (paysDeleted || []).length });
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
      .from('ap_invoices')
      .select('id, community_id, vendor_id, vendor_invoice_number, invoice_date, due_date, service_period_start, service_period_end, total_cents, status, posting_journal_entry_id, source_filename, notes, created_at, vendor:vendors(name, category), community:communities(name, vantaca_code)')
      .order('invoice_date', { ascending: false, nullsFirst: false })
      .limit(Number(limit) || 100);
    if (community_id) q = q.eq('community_id', community_id);
    if (vendor_id) q = q.eq('vendor_id', vendor_id);
    if (status) q = q.eq('status', status);
    // gl_match_status is a derived (not stored) field on ap_invoices — 'matched'
    // means a posting JE is linked. Translate the filter to the underlying column.
    if (gl_match_status === 'matched') q = q.not('posting_journal_entry_id', 'is', null);
    else if (gl_match_status === 'unmatched') q = q.is('posting_journal_entry_id', null);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ invoices: (data || []).map(apInvoiceToLegacy) });
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
      .from('ap_invoices')
      .select('id, community_id, vendor_id, vendor_invoice_number, invoice_date, due_date, service_period_start, service_period_end, total_cents, status, posting_journal_entry_id, source_filename, notes, created_at, vendor:vendors(*), community:communities(name, vantaca_code, legal_name)')
      .eq('id', invoiceId)
      .single();
    if (iErr || !invoice) return res.status(404).json({ error: 'Invoice not found' });
    res.json({ invoice: apInvoiceToLegacy(invoice) });
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

// A vendor has ONE current W-9; a genuinely different upload (new TIN, name, or
// classification) supersedes the old one but KEEPS it as history. A re-upload of
// the same W-9 (identical file, or same substantive fields) is a no-op dedup.
function w9ContentHash(parsed) {
  if (!parsed) return null;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const tin = String(parsed.tin || '').replace(/[^0-9]/g, '');
  if (!tin && !parsed.legal_name) return null; // nothing substantive to key on
  return crypto.createHash('sha256')
    .update([norm(parsed.legal_name), tin, norm(parsed.tax_classification)].join('|'))
    .digest('hex');
}

// ----------------------------------------------------------------------------
// POST /api/vendors/:vendorId/w9  — upload the vendor's W-9 (drag/click).
// Dedups exact + same-content re-uploads; versions genuinely different ones
// (prior W-9 kept as history). AI-reads the tax classification + TIN and
// SUGGESTS the 1099 flag (operator can override the toggle).
// ----------------------------------------------------------------------------
router.post('/:vendorId/w9', upload.single('pdf'), async (req, res) => {
  const { vendorId } = req.params;
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF uploaded (expected field "pdf").' });
    if (req.file.mimetype !== 'application/pdf') return res.status(400).json({ error: `Unsupported file type: ${req.file.mimetype}` });

    const { data: vendor } = await supabase.from('vendors').select('id, ein, tax_id').eq('id', vendorId).maybeSingle();
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    const fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');

    // Existing W-9s for this vendor (for dedup + supersede).
    const { data: priorW9s } = await supabase.from('vendor_documents')
      .select('id, file_hash, content_hash, is_current, uploaded_at')
      .eq('vendor_id', vendorId).eq('doc_type', 'w9');
    const priors = priorW9s || [];

    // Dedup 1: byte-identical file already on file.
    if (priors.some(d => d.file_hash && d.file_hash === fileHash)) {
      return res.json({ ok: true, duplicate: true, reason: 'identical_file', message: 'That exact W-9 is already on file — nothing changed.' });
    }

    // Read the W-9 (degrades gracefully — the doc still files if parse fails).
    const { extractW9 } = require('../lib/vendors/w9_extract');
    let ex = { parsed: null, suggested_1099: true, degraded: true };
    try { ex = await extractW9(req.file.buffer); } catch (e) { console.warn('[vendors] W-9 parse failed (non-fatal):', e.message); }
    const contentHash = w9ContentHash(ex.parsed);

    // Dedup 2: same substantive content (a re-scan of the same W-9) -> no-op.
    if (contentHash && priors.some(d => d.content_hash && d.content_hash === contentHash)) {
      return res.json({ ok: true, duplicate: true, reason: 'same_content', message: 'A W-9 with the same name, TIN, and classification is already on file — kept the existing one.' });
    }

    // Store the PDF (audit trail). Non-fatal on storage failure.
    let storagePath = null;
    try {
      const safe = (req.file.originalname || 'w9.pdf').replace(/[^a-zA-Z0-9._\-]/g, '_');
      storagePath = `vendor_w9/${vendorId}/${fileHash.slice(0, 16)}_${safe}`;
      await supabase.storage.from('documents').upload(storagePath, req.file.buffer, { contentType: 'application/pdf', upsert: true });
    } catch (e) { console.warn('[vendors] W-9 storage upload failed (non-fatal):', e.message); storagePath = null; }

    // Supersede the current W-9 (keep it as history), then file the new one as current.
    const hadPriorCurrent = priors.some(d => d.is_current);
    if (hadPriorCurrent) {
      await supabase.from('vendor_documents')
        .update({ is_current: false, superseded_at: new Date().toISOString() })
        .eq('vendor_id', vendorId).eq('doc_type', 'w9').eq('is_current', true);
    }

    const today = new Date().toISOString().slice(0, 10);
    const { data: doc, error: docErr } = await supabase.from('vendor_documents').insert({
      vendor_id: vendorId, doc_type: 'w9',
      file_name: req.file.originalname || 'W-9.pdf', file_url: storagePath,
      effective_date: today, is_current: true, file_hash: fileHash, content_hash: contentHash,
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

    res.json({ ok: true, document: doc, vendor: updated, parsed: ex.parsed, suggested_1099: ex.suggested_1099, degraded: ex.degraded, replaced_prior: hadPriorCurrent });
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
      supabase.from('vendor_documents').select('id, vendor_id, uploaded_at').eq('doc_type', 'w9').eq('is_current', true).in('vendor_id', vendorIds).order('uploaded_at', { ascending: false }),
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

    // One-click 1099 worklist: ?format=csv downloads the year's spend with W-9 /
    // over-threshold status, ready for the filing. (Ed 2026-08-01.)
    if (String(req.query.format || '').toLowerCase() === 'csv') {
      const only1099 = String(req.query.only_1099 || '') === '1';
      const rowsOut = only1099 ? out.filter((r) => r.is_1099_vendor || r.over_threshold) : out;
      const cell = (s) => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
      const header = ['Vendor', 'TIN', 'Tax classification', 'Community', 'Year', 'Total paid', 'Payments', '1099 vendor', 'W-9 on file', 'Over $600', 'Needs W-9'];
      const lines = [header.map(cell).join(',')];
      for (const r of rowsOut) {
        lines.push([r.vendor_name, r.tax_id, r.tax_classification, r.community_name, r.year, (r.total_cents / 100).toFixed(2), r.payment_count, r.is_1099_vendor ? 'Yes' : 'No', r.w9_on_file ? 'Yes' : 'No', r.over_threshold ? 'Yes' : 'No', r.needs_w9 ? 'Yes' : 'No'].map(cell).join(','));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="1099-vendor-spend-${year}.csv"`);
      return res.send(lines.join('\r\n'));
    }

    res.json({ year, threshold_cents: CENTS_1099_THRESHOLD, rows: out });
  } catch (err) {
    console.error('[vendors] spend report failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router };
