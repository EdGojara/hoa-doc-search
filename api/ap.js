// ============================================================================
// Accounts Payable API
// ----------------------------------------------------------------------------
// Mounted at /api/ap.
//
// Phase 1 surface (this ship):
//   POST   /invoices/upload         multipart PDF -> extract -> auto-code -> JE post -> queue
//   POST   /invoices                manual JSON entry (for testing or non-PDF sources)
//   GET    /invoices                list with filters (status, vendor, due range)
//   GET    /invoices/:id            detail + lines + approval history + source PDF
//   PATCH  /invoices/:id            edit lines / re-code GL / amount adjust
//   POST   /invoices/:id/approve    transition to approved
//   POST   /invoices/:id/void       void with reason (creates offsetting JE)
//   POST   /payments                record a payment (one payment, many invoices)
//   GET    /aging?community_id      portfolio AP aging summary
//
// Auto-coding: vendor.default_gl_account_id → vendor.category mapping →
// description keywords. Confidence-gated. Low-confidence routes to
// 'needs_review' status; operator picks GL before approval.
// ============================================================================

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const { createInvoice, attachSourceAndRecode, approveInvoice, recordPayment, autoCodeGlAccount } = require('../lib/accounting/ap_engine');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const router = express.Router();

// ---------------------------------------------------------------------------
// Invoice extraction prompt — Claude binary PDF read
// ---------------------------------------------------------------------------
const INVOICE_EXTRACTION_PROMPT = `You are reading a vendor invoice PDF for an HOA management company. Extract the structured invoice data.

Return ONLY valid JSON, no preamble, no markdown fences:

{
  "vendor_name":            "string — vendor's legal name from header",
  "vendor_address_line1":   "string or empty",
  "vendor_address_line2":   "string or empty",
  "vendor_city":            "string or empty",
  "vendor_state":           "string or empty",
  "vendor_zip":             "string or empty",
  "vendor_phone":           "string or empty",
  "vendor_email":           "string or empty",

  "bill_to_name":           "string — bill-to name as printed (often 'Community Name C/O Bedrock')",
  "ship_to_name":           "string or empty",

  "vendor_invoice_number":  "string — invoice number as printed",
  "invoice_date":           "YYYY-MM-DD",
  "due_date":               "YYYY-MM-DD or empty",
  "terms":                  "string — 'Net 30', 'Due on Receipt', etc.",
  "account_manager":        "string — vendor-side account manager / contact name",

  "lines": [
    {
      "description":        "string — full line item description",
      "quantity":           <number — default 1 if not shown>,
      "unit_price_cents":   <integer or null>,
      "amount_cents":       <integer — line total in cents>,
      "is_taxable":         <boolean — true if line has tax indicator like 'T'>
    }
  ],

  "subtotal_cents":         <integer in cents>,
  "tax_cents":              <integer in cents — total sales tax>,
  "total_cents":            <integer in cents — balance due>,

  "suggested_category":     "landscaping | pool | janitorial | security | utilities_electric | utilities_water | utilities_gas | utilities_trash | insurance | management | legal | audit_tax | repairs | supplies | other — best guess from vendor name + line items",

  "warnings": ["string"]
}

CRITICAL:
- All money values are INTEGER CENTS. "$440.00" → 44000. "$36.30" → 3630. "$476.30" → 47630. Never strings, never decimals.
- vendor_invoice_number: capture exactly as printed (e.g. "34529").
- For 'Bedrock Association Management' as the bill-to: the COMMUNITY is whatever is BEFORE 'C/O Bedrock Association Management' (e.g. "Quail Ridge C/O Bedrock Association Management" → community is "Quail Ridge").
- suggested_category: based on vendor name AND line items. If the vendor is "Superior LawnCare" and lines say "Landscaping Maintenance", category is "landscaping".
- warnings: anomalies like 'total doesn't tie' or 'partial payment shown' or 'vendor address differs from remit-to'.

Return ONLY the JSON.`;

async function extractInvoice(pdfBuffer) {
  const t0 = Date.now();
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
        { type: 'text', text: INVOICE_EXTRACTION_PROMPT },
      ],
    }],
  });
  const raw = (response.content || []).map((b) => b.text || '').join('').trim();
  console.log('[ap.extract] raw first 1000:', raw.slice(0, 1000));
  let parsed;
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Invoice extraction returned malformed JSON: ${e.message}`);
  }
  // Coerce money fields
  const coerceM = (v) => {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Math.round(v);
    const n = Number(String(v).replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? Math.round(n) : null;
  };
  parsed.subtotal_cents = coerceM(parsed.subtotal_cents) ?? 0;
  parsed.tax_cents = coerceM(parsed.tax_cents) ?? 0;
  parsed.total_cents = coerceM(parsed.total_cents) ?? 0;
  parsed.lines = (parsed.lines || []).map((ln) => ({
    description: ln.description || '',
    quantity: Number(ln.quantity) || 1,
    unit_price_cents: coerceM(ln.unit_price_cents),
    amount_cents: coerceM(ln.amount_cents) ?? 0,
    is_taxable: !!ln.is_taxable,
  }));
  parsed.warnings = parsed.warnings || [];
  return { ...parsed, duration_ms: Date.now() - t0 };
}

// Match the bill_to_name to a community in trustEd
async function matchCommunity(bill_to_name) {
  if (!bill_to_name) return null;
  // Strip "C/O Bedrock Association Management" and similar suffixes
  let name = String(bill_to_name).replace(/c\/o\s+bedrock.*$/i, '').trim();
  name = name.replace(/\s+(homeowners?\s+association|hoa|owners?\s+association|association)$/i, '').trim();
  if (!name) return null;
  // Try exact case-insensitive
  const { data: exact } = await supabase.from('communities')
    .select('id, name, slug').ilike('name', name).limit(1).maybeSingle();
  if (exact) return exact;
  // Try substring
  const { data: subs } = await supabase.from('communities')
    .select('id, name, slug').ilike('name', `%${name}%`).limit(1);
  return subs?.[0] || null;
}

// Find or create vendor by name (vendors are MGMT-CO level, shared across
// all communities — Superior LawnCare is ONE vendor row even if it services
// both Quail Ridge AND August Meadows. Year-end 1099 prep groups by vendor
// across the portfolio, which is why vendors aren't community-scoped.)
async function findOrCreateVendor({ vendor_name, vendor_email, vendor_phone, suggested_category, vendor_addr }) {
  if (!vendor_name) return null;
  // Try existing vendor by mgmt-co + name (case-insensitive)
  const { data: existing } = await supabase.from('vendors')
    .select('*')
    .eq('management_company_id', BEDROCK_MGMT_CO_ID)
    .ilike('name', vendor_name)
    .maybeSingle();
  if (existing) return { vendor: existing, created: false };
  // Create new — mgmt-co level, no community_id
  const { data: created, error } = await supabase.from('vendors').insert({
    management_company_id: BEDROCK_MGMT_CO_ID,
    name: vendor_name,
    category: suggested_category || null,
    is_active: true,
    is_1099_vendor: false,
    payment_terms_days: 30,
    account_manager_email: vendor_email || null,
    account_manager_phone: vendor_phone || null,
    remit_address_line1: vendor_addr?.line1 || null,
    remit_city: vendor_addr?.city || null,
    remit_state: vendor_addr?.state || null,
    remit_zip: vendor_addr?.zip || null,
  }).select('*').single();
  if (error) {
    console.warn('[ap.vendor.create] failed:', error.message);
    return null;
  }
  return { vendor: created, created: true };
}

// ---------------------------------------------------------------------------
// POST /api/ap/invoices/upload — the main intake endpoint
// ---------------------------------------------------------------------------
router.post('/invoices/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'pdf_required' });
    if (req.file.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: 'must_be_pdf' });
    }

    const overrideCommunityId = req.body?.community_id || null;
    const postedByUserId = req.body?.posted_by_user_id || null;
    const fileBuffer = req.file.buffer;

    // 1. Store PDF in storage + library_documents for audit
    const sha = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    const safeName = (req.file.originalname || 'invoice.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `ap-invoices/${sha.slice(0, 12)}-${safeName}`;
    try {
      await supabase.storage.from('documents').upload(storagePath, fileBuffer, {
        contentType: 'application/pdf', upsert: false,
      });
    } catch (_) { /* non-fatal — may already exist */ }

    // 2. Extract via Claude
    const extracted = await extractInvoice(fileBuffer);

    // 3. Match community (use override if provided)
    let community = null;
    if (overrideCommunityId) {
      const { data } = await supabase.from('communities').select('id, name').eq('id', overrideCommunityId).maybeSingle();
      community = data;
    } else {
      community = await matchCommunity(extracted.bill_to_name);
    }
    if (!community) {
      return res.json({
        status: 'needs_community',
        message: 'Could not match a community — please supply community_id and resubmit.',
        extraction: extracted,
      });
    }

    // 4. Insert library_documents row — RETENTION: the invoice stays on file and
    //    links to the bill via source_document_id. Correct schema columns +
    //    required management_company_id (the prior insert used wrong column names
    //    and omitted mgmt co, so it silently never archived).
    const { data: commFull } = await supabase.from('communities').select('management_company_id').eq('id', community.id).maybeSingle();
    const { data: libDoc, error: libErr } = await supabase.from('library_documents').insert({
      management_company_id: commFull ? commFull.management_company_id : null,
      community_id: community.id,
      category: 'vendor_invoice',
      title: `AP Invoice — ${extracted.vendor_name} #${extracted.vendor_invoice_number || ''}`.trim(),
      file_name_original: req.file.originalname || null,
      file_name_normalized: `${(community.name || '').trim()} - Vendor Invoice - ${extracted.vendor_name} - ${extracted.vendor_invoice_number || extracted.invoice_date || ''}.pdf`.replace(/\s+/g, ' '),
      file_path: storagePath,
      file_hash: sha,
      file_size_bytes: req.file.size,
      created_by_mgmt_company: 'Bedrock',
    }).select('id').single();
    if (libErr) console.warn('[ap] library_documents retention insert failed:', libErr.message);

    // 5. Find/create vendor — mgmt-co-level, NOT community-scoped
    const vendorResult = await findOrCreateVendor({
      vendor_name: extracted.vendor_name,
      vendor_email: extracted.vendor_email,
      vendor_phone: extracted.vendor_phone,
      suggested_category: extracted.suggested_category,
      vendor_addr: {
        line1: extracted.vendor_address_line1,
        city: extracted.vendor_city,
        state: extracted.vendor_state,
        zip: extracted.vendor_zip,
      },
    });
    if (!vendorResult) {
      return res.json({
        status: 'vendor_create_failed',
        extraction: extracted,
        source_document_id: libDoc?.id,
      });
    }

    // 6. Create the invoice via the engine — auto-codes + posts JE
    try {
      const result = await createInvoice({
        community_id: community.id,
        vendor_id: vendorResult.vendor.id,
        vendor_name: vendorResult.vendor.name,
        vendor_invoice_number: extracted.vendor_invoice_number,
        invoice_date: extracted.invoice_date,
        due_date: extracted.due_date,
        terms: extracted.terms,
        subtotal_cents: extracted.subtotal_cents,
        tax_cents: extracted.tax_cents,
        total_cents: extracted.total_cents,
        source_document_id: libDoc?.id || null,
        source_filename: req.file.originalname || null,
        lines: extracted.lines.map((ln) => ({
          description: ln.description,
          quantity: ln.quantity,
          unit_price_cents: ln.unit_price_cents,
          amount_cents: ln.amount_cents,
          is_taxable: ln.is_taxable,
          tax_amount_cents: 0,  // line-level tax not separated by extractor; total tax sits at header
        })),
        notes: null,
        posted_by_user_id: postedByUserId,
      });
      res.json({
        status: 'ok',
        community,
        vendor: vendorResult.vendor,
        vendor_created: vendorResult.created,
        invoice: result.invoice,
        lines: result.lines,
        auto_coded: result.auto_coded,
        coding_confidence: result.coding_confidence,
        warnings: extracted.warnings,
        source_document_id: libDoc?.id,
      });
    } catch (e) {
      // Duplicate (UNIQUE on community_id + vendor_id + vendor_invoice_number)?
      if (e.message && /duplicate key|unique/i.test(e.message)) {
        return res.status(409).json({
          status: 'duplicate_invoice',
          message: `Invoice ${extracted.vendor_invoice_number} from ${extracted.vendor_name} already exists for this community.`,
          extraction: extracted,
        });
      }
      throw e;
    }
  } catch (err) {
    console.error('[ap] invoice upload failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/ap/invoices/:id/attach-pdf — attach a source PDF to an EXISTING bill
// and re-run extraction + coding. For bills whose invoice arrived without the
// attachment (email "click to download" link), so intake made the header but no
// lines. This does NOT create a new invoice — it fills in the one that exists.
// ---------------------------------------------------------------------------
router.post('/invoices/:id/attach-pdf', upload.single('pdf'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: 'pdf_required' });
    if (req.file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'must_be_pdf' });

    const { data: inv } = await supabase.from('ap_invoices')
      .select('*, vendors(name), communities(id, name, management_company_id)')
      .eq('id', id).maybeSingle();
    if (!inv) return res.status(404).json({ error: 'not_found' });
    if (inv.status === 'voided') return res.status(400).json({ error: 'voided' });
    if (inv.posting_journal_entry_id) {
      return res.status(409).json({
        error: 'already_posted',
        detail: 'This bill\'s accrual is already on the books. Re-attaching and replacing its lines would desync the ledger — change the coding from the invoice detail instead.',
      });
    }

    const fileBuffer = req.file.buffer;
    const postedByUserId = req.body?.posted_by_user_id || null;

    // 1. Store PDF in storage + library_documents (same retention path as upload)
    const sha = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    const safeName = (req.file.originalname || 'invoice.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `ap-invoices/${sha.slice(0, 12)}-${safeName}`;
    try {
      await supabase.storage.from('documents').upload(storagePath, fileBuffer, {
        contentType: 'application/pdf', upsert: false,
      });
    } catch (_) { /* non-fatal — may already exist */ }

    // 2. Extract via Claude
    const extracted = await extractInvoice(fileBuffer);
    if (!extracted || !Array.isArray(extracted.lines) || extracted.lines.length === 0) {
      return res.status(422).json({
        error: 'no_lines_extracted',
        detail: 'Could not read any line items from that PDF. Confirm it is the actual invoice (not a cover page or remittance stub).',
        extraction: extracted || null,
      });
    }

    // 3. Retention row — links the PDF to the bill via source_document_id
    const commMgmt = inv.communities ? inv.communities.management_company_id : null;
    const { data: libDoc, error: libErr } = await supabase.from('library_documents').insert({
      management_company_id: commMgmt,
      community_id: inv.community_id,
      category: 'vendor_invoice',
      title: `AP Invoice — ${(inv.vendors && inv.vendors.name) || inv.vendor_name} #${inv.vendor_invoice_number || ''}`.trim(),
      file_name_original: req.file.originalname || null,
      file_name_normalized: `${((inv.communities && inv.communities.name) || '').trim()} - Vendor Invoice - ${(inv.vendors && inv.vendors.name) || inv.vendor_name} - ${inv.vendor_invoice_number || inv.invoice_date || ''}.pdf`.replace(/\s+/g, ' '),
      file_path: storagePath,
      file_hash: sha,
      file_size_bytes: req.file.size,
      created_by_mgmt_company: 'Bedrock',
    }).select('id').single();
    if (libErr) console.warn('[ap] attach-pdf library_documents insert failed:', libErr.message);

    // 4. Attach lines to the existing bill + code + post (engine enforces
    //    not-already-posted and total reconciliation).
    const result = await attachSourceAndRecode({
      invoice_id: id,
      source_document_id: libDoc?.id || null,
      source_filename: req.file.originalname || null,
      source_storage_path: storagePath,
      posted_by_user_id: postedByUserId,
      lines: extracted.lines.map((ln) => ({
        description: ln.description,
        quantity: ln.quantity,
        unit_price_cents: ln.unit_price_cents,
        amount_cents: ln.amount_cents,
        is_taxable: ln.is_taxable,
        tax_amount_cents: 0,
      })),
    });

    res.json({
      status: 'ok',
      invoice: result.invoice,
      lines: result.lines,
      auto_coded: result.auto_coded,
      coding_confidence: result.coding_confidence,
      posted: !!result.posting_journal_entry_id,
      total_mismatch: result.total_mismatch,
      warning: result.warning,
      extraction_warnings: extracted.warnings || [],
      source_document_id: libDoc?.id || null,
    });
  } catch (err) {
    if (err.code === 'invalid_input' || err.code === 'invalid_state') {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    console.error('[ap] attach-pdf failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/ap/invoices — manual JSON entry
// ---------------------------------------------------------------------------
router.post('/invoices', express.json(), async (req, res) => {
  try {
    const result = await createInvoice(req.body || {});
    res.json(result);
  } catch (err) {
    if (err.code === 'invalid_input' || err.code === 'invalid_state' || err.code === 'period_closed') {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    console.error('[ap] create invoice failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/ap/invoices — list
// ---------------------------------------------------------------------------
router.get('/invoices', async (req, res) => {
  try {
    const { community_id, vendor_id, status, due_before, limit = '100' } = req.query;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    // Approvals ride along so the list can show WHO approved in the status —
    // "Awaiting Approval" doesn't tell you whether it's waiting on a manager or
    // on Ed. (Ed 2026-07-15.)
    let q = supabase.from('ap_invoices')
      .select('*, vendors(name, category), ap_invoice_approvals(action, user_name, created_at)')
      .eq('community_id', community_id)
      .order('due_date', { ascending: true, nullsFirst: false })
      .limit(Math.min(parseInt(limit, 10) || 100, 500));
    if (vendor_id) q = q.eq('vendor_id', vendor_id);
    if (status) q = q.eq('status', status);
    if (due_before) q = q.lte('due_date', due_before);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ invoices: data || [] });
  } catch (err) {
    console.error('[ap] list invoices failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /manager-queue — "what is waiting on ME, across every community."
//
// Ed: "where is the manager review button". It was on staff screens, but the AP
// queue is community-scoped and nothing computed the approval path outside the
// detail modal — so a manager had to open every bill in all seven communities
// to find the four that needed them. Nobody does that, so nothing ever got
// approved and every bill fell through to "release anyway". A control nobody is
// routed to isn't a control. This is the route. (Ed 2026-07-15.)
router.get('/manager-queue', async (req, res) => {
  try {
    const { data: invs, error } = await supabase.from('ap_invoices')
      .select('id, community_id, vendor_id, vendor_invoice_number, invoice_date, due_date, total_cents, approval_path, approval_path_reason, approval_path_why, coded_gl_account_id, posting_journal_entry_id, vendors(name), communities(name), ap_invoice_approvals(action, user_name, created_at)')
      .eq('status', 'awaiting_approval')
      .order('due_date', { ascending: true, nullsFirst: false })
      .limit(500);
    if (error) throw error;

    // Credits are a LIVE overlay, never baked into the stored path: a credit
    // recorded today must hold a bill that was stored as 'release' last week.
    // One query for every open credit beats one per invoice.
    const { data: credits } = await supabase.from('vendor_credits_expected')
      .select('id, community_id, vendor_id, vendor_name, reason, expected_cents')
      .eq('status', 'expected');
    const creditFor = (inv) => (credits || []).filter((c) => c.community_id === inv.community_id
      && (c.vendor_id ? c.vendor_id === inv.vendor_id
        : (c.vendor_name && inv.vendors && String(inv.vendors.name || '').toLowerCase().includes(String(c.vendor_name).toLowerCase().slice(0, 12)))));

    const { approvalPath } = require('../lib/ap/approval_policy');
    const out = [];
    for (const inv of (invs || [])) {
      if ((inv.ap_invoice_approvals || []).some((a) => a.action === 'approved')) continue; // a manager already vouched
      const open = creditFor(inv);
      let path = inv.approval_path;
      let reason = inv.approval_path_reason;
      let why = inv.approval_path_why;
      let creditHold = false;
      if (open.length) {
        // A credit outranks the stored verdict, always.
        const p = approvalPath(null, open);
        path = 'manager_review'; reason = p.reason; why = p.why; creditHold = true;
      } else if (!path) {
        // Never routed (pre-migration bill, or the intake decision failed).
        // Unrouted fails toward MORE scrutiny, not less.
        path = 'manager_review';
        reason = 'This bill was never routed — no approval path was recorded for it. A manager confirms it before release.';
        why = 'no approval path on record';
      }
      if (path !== 'manager_review') continue;
      out.push({
        id: inv.id, community_id: inv.community_id, community: inv.communities && inv.communities.name,
        vendor: (inv.vendors && inv.vendors.name) || null, vendor_invoice_number: inv.vendor_invoice_number,
        invoice_date: inv.invoice_date, due_date: inv.due_date, total_cents: inv.total_cents,
        reason, why, credit_hold: creditHold,
        coded: !!inv.coded_gl_account_id, posted: !!inv.posting_journal_entry_id,
      });
    }
    res.json({ ok: true, count: out.length, invoices: out });
  } catch (err) { console.error('[ap] manager-queue failed:', err); res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.get('/invoices/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [{ data: invoice }, { data: lines }, { data: approvals }] = await Promise.all([
      // coded_account: "✓ coded" without naming the account is useless — you
      // can't confirm a coding you can't see. (Ed 2026-07-15.)
      supabase.from('ap_invoices').select('*, vendors(name, category, payee_name, remit_address_line1, remit_city, remit_state, remit_zip), coded_account:coded_gl_account_id(account_number, account_name, account_type)').eq('id', id).maybeSingle(),
      supabase.from('ap_invoice_lines').select('*, chart_of_accounts(account_number, account_name)').eq('invoice_id', id).order('line_number'),
      supabase.from('ap_invoice_approvals').select('*').eq('invoice_id', id).order('created_at'),
    ]);
    if (!invoice) return res.status(404).json({ error: 'not_found' });
    // What IS this bill, per the community's own books? A recurring landscaping
    // charge and a first-time $11k invoice are different risks — say which this
    // is, and flag it when a recurring bill isn't like the others. (Ed 2026-07-15.)
    let recurrence = null;
    try {
      const { getRecurrenceProfile } = require('../lib/ap/recurring');
      recurrence = await getRecurrenceProfile({
        vendorId: invoice.vendor_id || null,
        vendorName: (invoice.vendors && invoice.vendors.name) || invoice.vendor_name || null,
        communityId: invoice.community_id,
        totalCents: invoice.total_cents,
      });
    } catch (e) { console.warn('[ap] recurrence profile skipped:', e.message); }
    // Does this vendor owe this community a credit? Asked HERE, at the moment of
    // payment, because that's the only moment it can still stop the money.
    let openCredits = [];
    try {
      const { openCreditsFor } = require('../lib/ap/vendor_credits');
      openCredits = await openCreditsFor({
        communityId: invoice.community_id, vendorId: invoice.vendor_id || null,
        vendorName: (invoice.vendors && invoice.vendors.name) || invoice.vendor_name || null,
      });
    } catch (e) { console.warn('[ap] open credits lookup skipped:', e.message); }
    // ...and did the vendor already APPLY it, right there on the bill? Telling Ed
    // to chase a credit that's on the invoice in front of him is how a control
    // gets ignored. (Ed 2026-07-15.)
    let appliedCredit = null;
    try {
      const { detectAppliedCredits } = require('../lib/ap/credit_match');
      const r = detectAppliedCredits(lines || [], openCredits);
      if (r.applied) appliedCredit = r;
    } catch (e) { console.warn('[ap] applied-credit check skipped:', e.message); }
    // Which approval path: consistent + recurring -> Ed releases directly;
    // anything else (or an owed credit) -> a manager vouches first. (Ed 2026-07-15.)
    let policy = null;
    try { policy = require('../lib/ap/approval_policy').approvalPath(recurrence, openCredits); }
    catch (e) { console.warn('[ap] approval policy skipped:', e.message); }
    res.json({ invoice, lines: lines || [], approvals: approvals || [], recurrence, policy, open_credits: openCredits, applied_credit: appliedCredit });
  } catch (err) {
    console.error('[ap] invoice detail failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /invoices/:id/approve — TWO-KEY approval (Ed 2026-07-15).
//   Key 1 (manager: staff/assistant) — attests the bill is legitimate. Records
//     WHO and WHEN. Does NOT release money.
//   Key 2 (admin: Ed) — releases it for payment. Requires key 1 first, so one
//     person can never both vouch for a bill and pay it. That separation IS the
//     control; the rest is bookkeeping.
//
// The approver is taken from the SESSION, never req.body. This endpoint used to
// accept user_id/user_name from the request body, so "who approved" was whatever
// the client claimed — a forgeable audit trail makes a two-key control theater.
router.post('/invoices/:id/approve', express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const { resolveUserRole } = require('./users');
    const ctx = await resolveUserRole(req);
    if (!ctx || !ctx.supabaseUserId) return res.status(401).json({ error: 'sign_in_required', detail: 'Sign in to approve invoices.' });
    if (ctx.user && ctx.user.is_active === false) return res.status(403).json({ error: 'account_deactivated' });
    const userId = (ctx.user && ctx.user.id) || null;
    const userName = (ctx.user && (ctx.user.full_name || ctx.user.email)) || 'staff';
    const isAdmin = ctx.role === 'admin';
    const notes = (req.body || {}).notes || null;

    const { data: inv } = await supabase.from('ap_invoices').select('id, status, total_cents, posting_journal_entry_id').eq('id', id).maybeSingle();
    if (!inv) return res.status(404).json({ error: 'not_found' });
    if (inv.status === 'voided') return res.status(400).json({ error: 'voided', detail: 'This invoice was voided.' });
    if (!inv.posting_journal_entry_id) return res.status(400).json({ error: 'not_coded', detail: 'Code the expense account first — an uncoded bill has no journal entry to approve.' });

    const { data: prior } = await supabase.from('ap_invoice_approvals')
      .select('action, user_id, user_name, created_at').eq('invoice_id', id).order('created_at');
    const mgr = (prior || []).find((a) => a.action === 'approved');

    // ---- Key 1: manager ----
    if (!isAdmin) {
      if (mgr) return res.json({ ok: true, stage: 'manager_approved', already: true, manager: mgr });
      if (String((req.body || {}).decision || '').toLowerCase() === 'no') {
        await supabase.from('ap_invoice_approvals').insert({ invoice_id: id, action: 'rejected', user_id: userId, user_name: userName, amount_at_time_cents: inv.total_cents, notes });
        await supabase.from('ap_invoices').update({ status: 'disputed' }).eq('id', id);
        return res.json({ ok: true, stage: 'manager_rejected', by: userName });
      }
      await supabase.from('ap_invoice_approvals').insert({ invoice_id: id, action: 'approved', user_id: userId, user_name: userName, amount_at_time_cents: inv.total_cents, notes });
      return res.json({ ok: true, stage: 'manager_approved', by: userName, at: new Date().toISOString() });
    }

    // ---- Key 2: admin release ----
    // Ed releases every payment before a check is cut or an ACH goes out. He CAN
    // release without a manager approval — but WHY that was fine differs, and the
    // audit note has to say which:
    //   * recurring + consistent  -> the light path is the DESIGNED route, not a
    //                                deviation. Record the reason it qualified.
    //   * one-off / not consistent -> this IS a deviation from the two-key path.
    //                                Record it plainly as one.
    // A trail that says "released without manager approval" on a routine
    // landscaping bill is noise; a trail that says nothing on a $11k one-off is
    // a lie. (Ed 2026-07-15.)
    const solo = !mgr;
    let policy = null;
    if (solo) {
      try {
        const { getRecurrenceProfile } = require('../lib/ap/recurring');
        const { data: full } = await supabase.from('ap_invoices').select('vendor_id, community_id, total_cents, vendors(name)').eq('id', id).maybeSingle();
        const rec = await getRecurrenceProfile({
          vendorId: full && full.vendor_id, vendorName: full && full.vendors && full.vendors.name,
          communityId: full && full.community_id, totalCents: full && full.total_cents,
        });
        policy = require('../lib/ap/approval_policy').approvalPath(rec);
      } catch (e) { console.warn('[ap] release policy note skipped:', e.message); }
    }
    const soloNote = policy && policy.path === 'release'
      ? `Released by admin on the light path — ${policy.why}.`
      : `Released by admin WITHOUT a manager approval${policy ? ` — ${policy.why}` : ''}.`;
    const finalNotes = solo ? [notes, soloNote].filter(Boolean).join(' — ') : notes;
    const result = await approveInvoice({ invoice_id: id, user_id: userId, user_name: userName, notes: finalNotes, action: 'released_for_payment' });
    return res.json({
      ...result, stage: 'released_for_payment', by: userName,
      manager_approved_by: mgr ? (mgr.user_name || null) : null,
      solo_release: solo, path: policy ? policy.path : null,
    });
  } catch (err) {
    if (err.code === 'invalid_input' || err.code === 'invalid_state' || err.code === 'not_found') {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    console.error('[ap] approve invoice failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /invoices/:id/void — discard a duplicate / erroneous invoice (vendor sent
// another copy). Reverses the AP accrual with an offsetting entry (never a hard
// delete) and marks it voided, so it drops out of payables and never hits a check
// run. Cannot void something already paid. (Ed 2026-07-14.)
router.post('/invoices/:id/void', express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const { data: inv } = await supabase.from('ap_invoices').select('*').eq('id', id).maybeSingle();
    if (!inv) return res.status(404).json({ error: 'not_found' });
    if (inv.status === 'voided') return res.json({ ok: true, already_voided: true });
    if (inv.status === 'paid' || (inv.amount_paid_cents || 0) > 0) return res.status(400).json({ error: 'cannot_void_paid', detail: 'A payment is recorded on this invoice — void the payment first.' });
    const reason = String((req.body || {}).reason || 'Duplicate / discarded').slice(0, 200);
    if (inv.posting_journal_entry_id) {
      try { const { voidJournalEntry } = require('../lib/accounting/posting'); await voidJournalEntry({ journal_entry_id: inv.posting_journal_entry_id, void_reason: `AP invoice voided: ${reason}` }); }
      catch (e) { console.warn('[ap] void accrual reversal failed:', e.message); }
    }
    await supabase.from('ap_invoices').update({ status: 'voided', voided_at: new Date().toISOString(), voided_reason: reason }).eq('id', id);
    res.json({ ok: true });
  } catch (err) { console.error('[ap] void failed:', err); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// POST /invoices/:id/mark-paid — the bill was ALREADY PAID outside a check run
// (ACH, debit/credit card, wire). Records the payment (Dr AP / Cr Cash) so the
// expense + cash post and the payable clears — it never shows in a check run and
// no check is cut. (Ed 2026-07-14.)
router.post('/invoices/:id/mark-paid', express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const method = ['ach', 'credit_card', 'wire', 'cash', 'other'].includes((req.body || {}).method) ? req.body.method : 'ach';
    const { data: inv } = await supabase.from('ap_invoices').select('*').eq('id', id).maybeSingle();
    if (!inv) return res.status(404).json({ error: 'not_found' });
    if (inv.status === 'voided') return res.status(400).json({ error: 'voided', detail: 'This invoice was voided.' });
    const owed = (inv.total_cents || 0) - (inv.amount_paid_cents || 0);
    if (owed <= 0) return res.status(400).json({ error: 'nothing_due', detail: 'This invoice is already fully paid.' });
    // Staff can override the amount when a credit/debit adjusts what was actually
    // paid (e.g. a vendor credit reduces the check). Defaults to the full owed.
    const override = Number((req.body || {}).amount_cents);
    const amt = Number.isInteger(override) && override > 0 ? override : owed;
    const result = await recordPayment({
      community_id: inv.community_id, vendor_id: inv.vendor_id, amount_cents: amt,
      payment_date: (req.body || {}).payment_date || new Date().toISOString().slice(0, 10),
      payment_method: method, applications: [{ invoice_id: id, applied_cents: amt }],
      notes: `Already paid via ${method} (recorded, not check-printed)${amt !== owed ? ` — adjusted from ${(owed / 100).toFixed(2)}` : ''}`,
    });
    res.json({ ok: true, method, amount_cents: amt, ...result });
  } catch (err) {
    if (err.code === 'invalid_input' || err.code === 'invalid_state') return res.status(400).json({ error: err.message, code: err.code });
    console.error('[ap] mark-paid failed:', err); res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /invoices/:id/code — manually set (or change) the GL expense account when
// auto-coding didn't (no learned vendor mapping). Posts the accrual (Dr expense /
// Cr AP) so the bill is real, re-coding voids the prior accrual first, and teaches
// the vendor->GL map so it auto-codes next time. (Ed 2026-07-14.)
// POST /invoices/:id/change-community — move a bill to the right association
// when the platform (or the operator) put it on the wrong one. Clears the GL
// coding (it was on the old community's chart) so it re-codes, and LEARNS the
// account/vendor -> community map so the next one self-resolves. Blocks if the
// bill already posted a JE (void + re-enter instead). (Ed 2026-07-20.)
router.post('/invoices/:id/change-community', express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const community_id = (req.body || {}).community_id;
    const reviewed_by = (req.body || {}).reviewed_by || 'staff';
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    const { data: inv } = await supabase.from('ap_invoices')
      .select('id, community_id, vendor_id, account_number, posting_journal_entry_id').eq('id', id).maybeSingle();
    if (!inv) return res.status(404).json({ error: 'not_found' });
    if (inv.posting_journal_entry_id) return res.status(409).json({ error: 'already_posted', detail: 'This bill already posted to the GL under the current association. Void it, then re-enter under the right one.' });
    if (inv.community_id === community_id) return res.json({ ok: true, unchanged: true });
    const { data, error } = await supabase.from('ap_invoices')
      .update({ community_id, coded_gl_account_id: null, updated_at: new Date().toISOString() })
      .eq('id', id).select('id, community_id').maybeSingle();
    if (error) throw error;
    try {
      const { learnMapping } = require('../lib/ap/vendor_community');
      await learnMapping({ accountNumber: inv.account_number, vendorId: inv.vendor_id, communityId: community_id, taughtByName: reviewed_by });
    } catch (e) { console.warn('[ap] learn on change-community skipped:', e.message); }
    res.json({ ok: true, invoice: data });
  } catch (err) { console.error('[ap] change-community failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post('/invoices/:id/code', express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const gl_account_id = (req.body || {}).gl_account_id;
    const reason = String(((req.body || {}).reason) || '').trim();
    if (!gl_account_id) return res.status(400).json({ error: 'gl_account_id_required' });
    const { data: inv } = await supabase.from('ap_invoices').select('*, vendors(name)').eq('id', id).maybeSingle();
    if (!inv) return res.status(404).json({ error: 'not_found' });
    if (inv.status === 'voided') return res.status(400).json({ error: 'voided' });
    const { data: acct } = await supabase.from('chart_of_accounts')
      .select('id, account_number, account_name').eq('id', gl_account_id).eq('community_id', inv.community_id).maybeSingle();
    if (!acct) return res.status(400).json({ error: 'invalid_account', detail: 'That account is not on this community\'s chart.' });
    if (inv.coded_gl_account_id === gl_account_id) return res.json({ ok: true, unchanged: true, gl_account: `${acct.account_number} ${acct.account_name}`, posting_journal_entry_id: inv.posting_journal_entry_id, posted: !!inv.posting_journal_entry_id });

    // FIRST coding is routine. CHANGING a coding whose accrual is already on the
    // books is the exception (Ed 2026-07-15): it reverses a posted journal entry
    // and posts a replacement, so it must carry a name and a reason. Without
    // this, the one action that rewrites the ledger is the only one that leaves
    // no trace on the invoice.
    // A SPLIT bill's truth is its lines. Invoice-level coding would collapse four
    // real accounts into one and re-post the whole $11k as a single lump — the
    // exact thing we just stopped doing. Refuse unless the caller says plainly
    // that's what they want. (Ed 2026-07-15.)
    const { data: invLines } = await supabase.from('ap_invoice_lines')
      .select('id, gl_account_id, amount_cents, description').eq('invoice_id', id);
    const codedAccts = [...new Set((invLines || []).filter((l) => l.gl_account_id).map((l) => l.gl_account_id))];
    if (codedAccts.length > 1 && !(req.body || {}).collapse_split) {
      const { data: named } = await supabase.from('chart_of_accounts').select('account_number, account_name').in('id', codedAccts);
      return res.status(409).json({
        error: 'invoice_is_split',
        detail: `This bill is coded line by line across ${codedAccts.length} accounts (${(named || []).map((a) => a.account_number + ' ' + a.account_name).join(', ')}). Setting one account for the whole invoice would collapse that split and re-post ${'$' + ((inv.total_cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })} as a single lump. Change the individual line instead — or confirm you want to collapse it.`,
        accounts: named || [],
      });
    }

    const isRecode = !!(inv.coded_gl_account_id && inv.posting_journal_entry_id);
    let ctx = null;
    if (isRecode) {
      if (!reason) return res.status(400).json({ error: 'reason_required', detail: 'This bill\'s accrual is already posted. Changing the account reverses that entry and posts a new one — say why.' });
      const { resolveUserRole } = require('./users');
      ctx = await resolveUserRole(req);
      if (!ctx || !ctx.supabaseUserId) return res.status(401).json({ error: 'sign_in_required', detail: 'Sign in to change the account on a posted bill.' });
      if (ctx.user && ctx.user.is_active === false) return res.status(403).json({ error: 'account_deactivated' });
    }
    const who = (ctx && ctx.user && (ctx.user.full_name || ctx.user.email)) || 'Staff';
    const { data: prevAcct } = inv.coded_gl_account_id
      ? await supabase.from('chart_of_accounts').select('account_number, account_name').eq('id', inv.coded_gl_account_id).maybeSingle()
      : { data: null };
    const prevLabel = prevAcct ? `${prevAcct.account_number} ${prevAcct.account_name}` : '(uncoded)';

    // Re-coding an already-posted accrual: reverse the old one first.
    let jeId = inv.posting_journal_entry_id;
    if (jeId) {
      const voidReason = isRecode
        ? `Re-coded ${prevLabel} -> ${acct.account_number} ${acct.account_name} by ${who}: ${reason}`
        : 'Re-coded expense account';
      try { const { voidJournalEntry } = require('../lib/accounting/posting'); await voidJournalEntry({ journal_entry_id: jeId, void_reason: voidReason }); }
      catch (e) {
        // A reversal we couldn't post means the OLD entry is still live on the
        // books. Re-posting now would double-count the expense. Stop.
        console.error('[ap] recode reversal FAILED — refusing to re-post:', e.message);
        return res.status(500).json({ error: 'reversal_failed', detail: 'Could not reverse the existing journal entry, so the account was not changed (re-posting would double-count the expense). Nothing was modified.' });
      }
      jeId = null;
    }
    await supabase.from('ap_invoices').update({ coded_gl_account_id: gl_account_id, auto_coded: false, needs_review: false, posting_journal_entry_id: jeId, updated_at: new Date().toISOString() }).eq('id', id);

    if (!jeId) {
      const { postAccrualForInvoice } = require('../lib/ap/intake');
      jeId = await postAccrualForInvoice({
        codedAccountId: gl_account_id, totalCents: inv.total_cents, invoiceDate: inv.invoice_date,
        communityId: inv.community_id, vendorInvoiceNumber: inv.vendor_invoice_number,
        vendorName: (inv.vendors && inv.vendors.name) || inv.vendor_name, vendorId: inv.vendor_id, invoiceId: inv.id,
        classificationReason: 'Manually coded by staff', sourceDocumentPath: inv.source_storage_path || null,
      });
    }
    // Teach the vendor->community->GL map so the next identical bill auto-codes.
    try { const { learnMapping } = require('../lib/ap/vendor_community'); await learnMapping({ accountNumber: inv.account_number || null, vendorId: inv.vendor_id || null, vendorName: (inv.vendors && inv.vendors.name) || inv.vendor_name || null, communityId: inv.community_id, glAccountId: gl_account_id }); } catch (e) { console.warn('[ap] learn map:', e.message); }

    // The exception lands on the invoice's own audit trail, next to the
    // approvals — so anyone looking at this bill sees the account was changed
    // after posting, by whom, and why, without digging into the GL.
    let auditWarning = null;
    if (isRecode) {
      const { error: audErr } = await supabase.from('ap_invoice_approvals').insert({
        invoice_id: id, action: 'recoded', user_id: (ctx.user && ctx.user.id) || null, user_name: who,
        amount_at_time_cents: inv.total_cents,
        notes: `Expense account changed from ${prevLabel} to ${acct.account_number} ${acct.account_name} after the accrual was posted. Prior entry reversed, replacement posted. Reason: ${reason}`,
      });
      if (audErr) {
        // Never let this fail silently — an unrecorded exception is the whole
        // problem this endpoint is trying to solve.
        console.error('[ap] recode audit insert FAILED:', audErr.message);
        auditWarning = 'The account was changed and the journal entry adjusted, but the audit note could not be saved. Tell Ed — migration 300 may not be applied yet.';
      }
    }

    res.json({ ok: true, gl_account: `${acct.account_number} ${acct.account_name}`, gl_account_number: acct.account_number, gl_account_name: acct.account_name, posting_journal_entry_id: jeId, posted: !!jeId, recoded: isRecode, previous_gl_account: isRecode ? prevLabel : null, warning: auditWarning });
  } catch (err) { console.error('[ap] code failed:', err); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// POST /invoices/:id/lines/:lineId/code — change ONE line's expense account and
// re-post the split accrual. A bill coded line by line has to be correctable line
// by line, or the split is a cage: the invoice-level control can only collapse it.
// (Ed 2026-07-15: "can you look at invoice to code properly".)
router.post('/invoices/:id/lines/:lineId/code', express.json(), async (req, res) => {
  try {
    const { id, lineId } = req.params;
    const gl_account_id = (req.body || {}).gl_account_id;
    const reason = String(((req.body || {}).reason) || '').trim();
    if (!gl_account_id) return res.status(400).json({ error: 'gl_account_id_required' });

    const { data: inv } = await supabase.from('ap_invoices').select('*, vendors(name)').eq('id', id).maybeSingle();
    if (!inv) return res.status(404).json({ error: 'not_found' });
    if (inv.status === 'voided') return res.status(400).json({ error: 'voided' });
    const { data: line } = await supabase.from('ap_invoice_lines').select('*').eq('id', lineId).eq('invoice_id', id).maybeSingle();
    if (!line) return res.status(404).json({ error: 'line_not_found' });
    const { data: acct } = await supabase.from('chart_of_accounts')
      .select('id, account_number, account_name').eq('id', gl_account_id).eq('community_id', inv.community_id).maybeSingle();
    if (!acct) return res.status(400).json({ error: 'invalid_account', detail: 'That account is not on this community\'s chart.' });
    if (line.gl_account_id === gl_account_id) return res.json({ ok: true, unchanged: true });

    // Same rule as the invoice-level control: changing a POSTED entry is the
    // exception and carries a name and a reason.
    const posted = !!inv.posting_journal_entry_id;
    let ctx = null;
    if (posted) {
      if (!reason) return res.status(400).json({ error: 'reason_required', detail: 'This bill\'s accrual is already posted. Changing a line reverses that entry and posts a new one — say why.' });
      const { resolveUserRole } = require('./users');
      ctx = await resolveUserRole(req);
      if (!ctx || !ctx.supabaseUserId) return res.status(401).json({ error: 'sign_in_required' });
    }
    const who = (ctx && ctx.user && (ctx.user.full_name || ctx.user.email)) || 'Staff';
    const { data: prev } = line.gl_account_id
      ? await supabase.from('chart_of_accounts').select('account_number, account_name').eq('id', line.gl_account_id).maybeSingle()
      : { data: null };
    const prevLabel = prev ? `${prev.account_number} ${prev.account_name}` : '(uncoded)';

    await supabase.from('ap_invoice_lines').update({ gl_account_id, notes: posted ? `Re-coded by ${who}: ${reason}`.slice(0, 500) : line.notes }).eq('id', lineId);

    // Re-post the whole split from the (now updated) lines.
    const { data: lines } = await supabase.from('ap_invoice_lines').select('*').eq('invoice_id', id).order('line_number');
    const allCoded = (lines || []).length > 0 && lines.every((l) => l.gl_account_id);
    let jeId = inv.posting_journal_entry_id;
    if (posted) {
      try { const { voidJournalEntry } = require('../lib/accounting/posting'); await voidJournalEntry({ journal_entry_id: jeId, void_reason: `Line ${line.line_number} re-coded ${prevLabel} -> ${acct.account_number} ${acct.account_name} by ${who}: ${reason}` }); }
      catch (e) {
        console.error('[ap] line recode reversal FAILED — refusing to re-post:', e.message);
        await supabase.from('ap_invoice_lines').update({ gl_account_id: line.gl_account_id }).eq('id', lineId);   // put it back
        return res.status(500).json({ error: 'reversal_failed', detail: 'Could not reverse the existing journal entry, so nothing was changed (re-posting would double-count the expense).' });
      }
      jeId = null;
    }
    if (allCoded) {
      const { postAccrualForInvoice } = require('../lib/ap/intake');
      jeId = await postAccrualForInvoice({
        invoiceId: id, communityId: inv.community_id, vendorId: inv.vendor_id,
        glLines: lines.map((l) => ({ accountId: l.gl_account_id, cents: l.amount_cents, memo: l.description })),
        totalCents: inv.total_cents, invoiceDate: inv.invoice_date,
        vendorInvoiceNumber: inv.vendor_invoice_number, vendorName: (inv.vendors && inv.vendors.name) || inv.vendor_name,
        sourceDocumentPath: inv.source_storage_path || null,
        classificationReason: `Coded line by line from the invoice — ${lines.length} lines across ${new Set(lines.map((l) => l.gl_account_id)).size} account(s).`,
      });
    }
    const biggest = (lines || []).filter((l) => l.amount_cents > 0).sort((a, b) => b.amount_cents - a.amount_cents)[0];
    await supabase.from('ap_invoices').update({ coded_gl_account_id: biggest ? biggest.gl_account_id : null, posting_journal_entry_id: jeId || null, updated_at: new Date().toISOString() }).eq('id', id);

    let auditWarning = null;
    if (posted) {
      const { error: audErr } = await supabase.from('ap_invoice_approvals').insert({
        invoice_id: id, action: 'recoded', user_id: (ctx.user && ctx.user.id) || null, user_name: who,
        amount_at_time_cents: line.amount_cents,
        notes: `Line ${line.line_number} ("${String(line.description || '').slice(0, 120)}") re-coded from ${prevLabel} to ${acct.account_number} ${acct.account_name} after posting. Entry reversed and re-posted. Reason: ${reason}`,
      });
      if (audErr) { console.error('[ap] line recode audit FAILED:', audErr.message); auditWarning = 'The line was re-coded and the journal entry adjusted, but the audit note could not be saved.'; }
    }
    res.json({ ok: true, gl_account: `${acct.account_number} ${acct.account_name}`, posting_journal_entry_id: jeId, posted: !!jeId, previous_gl_account: prevLabel, warning: auditWarning });
  } catch (err) { console.error('[ap] line code failed:', err); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// GET /invoices/:id/suggest-code — infer the expense account for an uncoded bill
// from the community's own ledger (how this vendor has been coded before), so
// staff don't hand-code a recurring vendor the books already answer. (Ed 2026-07-14.)
router.get('/invoices/:id/suggest-code', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: inv } = await supabase.from('ap_invoices').select('*, vendors(name)').eq('id', id).maybeSingle();
    if (!inv) return res.status(404).json({ error: 'not_found' });
    const { suggestClassification } = require('../lib/accounting/gl_classifier');
    const vendorName = (inv.vendors && inv.vendors.name) || inv.vendor_name || null;
    const suggestion = await suggestClassification({
      communityId: inv.community_id, vendorId: inv.vendor_id, vendorName,
      description: vendorName || inv.vendor_invoice_number || null,
      totalCents: inv.total_cents,
      // Don't let this bill's own accrual count as precedent for coding itself.
      excludeJournalEntryId: inv.posting_journal_entry_id || null,
    });
    res.json({ ok: true, suggestion });
  } catch (err) { console.error('[ap] suggest-code failed:', err); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// POST /credits — record a credit a vendor OWES this community, captured from
// wherever it was promised (usually an email thread). This is what makes "please
// make sure we get credit for this on the Swim Houston bill" real: the promise
// becomes a hold on that vendor's next invoice instead of a memory. (Ed 2026-07-15.)
router.post('/credits', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const { resolveUserRole } = require('./users');
    const ctx = await resolveUserRole(req);
    if (!ctx || !ctx.supabaseUserId) return res.status(401).json({ error: 'sign_in_required' });
    const { createExpectedCredit } = require('../lib/ap/vendor_credits');
    const out = await createExpectedCredit({
      communityId: b.community_id, vendorId: b.vendor_id || null, vendorName: b.vendor_name || null,
      reason: b.reason, expectedCents: Number.isInteger(b.expected_cents) ? b.expected_cents : null,
      servicePeriodStart: b.service_period_start || null, servicePeriodEnd: b.service_period_end || null,
      sourceEmailId: b.source_email_id || null, sourceRef: b.source_ref || null, sourceQuote: b.source_quote || null,
      requestedBy: (ctx.user && (ctx.user.full_name || ctx.user.email)) || 'staff',
    });
    if (out.error) return res.status(400).json({ error: out.error });
    res.json(out);
  } catch (err) { console.error('[ap] create credit failed:', err); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// GET /credits?community_id=&status= — the open-credit register: everything
// vendors owe us that hasn't been collected yet.
router.get('/credits', async (req, res) => {
  try {
    let q = supabase.from('vendor_credits_expected')
      .select('*, vendors:vendor_id(name), communities:community_id(name)')
      .order('created_at', { ascending: false }).limit(300);
    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);
    q = q.eq('status', req.query.status || 'expected');
    const { data, error } = await q;
    if (error) throw error;
    res.json({ credits: data || [] });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// POST /credits/:id/resolve — applied to a bill / waived / disputed.
router.post('/credits/:id/resolve', express.json(), async (req, res) => {
  try {
    const { resolveUserRole } = require('./users');
    const ctx = await resolveUserRole(req);
    if (!ctx || !ctx.supabaseUserId) return res.status(401).json({ error: 'sign_in_required' });
    const { resolveCredit } = require('../lib/ap/vendor_credits');
    const out = await resolveCredit({
      creditId: req.params.id, status: (req.body || {}).status,
      appliedInvoiceId: (req.body || {}).applied_invoice_id || null,
      appliedCents: Number.isInteger((req.body || {}).applied_cents) ? req.body.applied_cents : null,
      appliedBy: (ctx.user && (ctx.user.full_name || ctx.user.email)) || 'staff',
      notes: (req.body || {}).notes || null,
    });
    if (out.error) return res.status(400).json({ error: out.error });
    res.json(out);
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post('/payments', express.json(), async (req, res) => {
  try {
    const result = await recordPayment(req.body || {});
    res.json(result);
  } catch (err) {
    if (err.code === 'invalid_input' || err.code === 'invalid_state') {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    console.error('[ap] record payment failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/aging', async (req, res) => {
  try {
    const { community_id } = req.query;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    const { data, error } = await supabase
      .from('v_ap_aging')
      .select('*, vendors(name, category)')
      .eq('community_id', community_id)
      .order('total_balance_cents', { ascending: false });
    if (error) throw error;
    const totals = (data || []).reduce((acc, r) => {
      acc.total += Number(r.total_balance_cents || 0);
      acc.current += Number(r.current_cents || 0);
      acc.b1_30 += Number(r.bucket_1_30_cents || 0);
      acc.b31_60 += Number(r.bucket_31_60_cents || 0);
      acc.b61_90 += Number(r.bucket_61_90_cents || 0);
      acc.over_90 += Number(r.over_90_cents || 0);
      return acc;
    }, { total: 0, current: 0, b1_30: 0, b31_60: 0, b61_90: 0, over_90: 0 });
    res.json({ rows: data || [], totals });
  } catch (err) {
    console.error('[ap] aging failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
