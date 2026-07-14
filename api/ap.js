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
const { createInvoice, approveInvoice, recordPayment, autoCodeGlAccount } = require('../lib/accounting/ap_engine');
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
    let q = supabase.from('ap_invoices')
      .select('*, vendors(name, category)')
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

router.get('/invoices/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [{ data: invoice }, { data: lines }, { data: approvals }] = await Promise.all([
      supabase.from('ap_invoices').select('*, vendors(name, category, payee_name, remit_address_line1, remit_city, remit_state, remit_zip)').eq('id', id).maybeSingle(),
      supabase.from('ap_invoice_lines').select('*, chart_of_accounts(account_number, account_name)').eq('invoice_id', id).order('line_number'),
      supabase.from('ap_invoice_approvals').select('*').eq('invoice_id', id).order('created_at'),
    ]);
    if (!invoice) return res.status(404).json({ error: 'not_found' });
    res.json({ invoice, lines: lines || [], approvals: approvals || [] });
  } catch (err) {
    console.error('[ap] invoice detail failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/invoices/:id/approve', express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const result = await approveInvoice({
      invoice_id: id,
      user_id: req.body?.user_id || null,
      user_name: req.body?.user_name || null,
      notes: req.body?.notes || null,
    });
    res.json(result);
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
router.post('/invoices/:id/code', express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const gl_account_id = (req.body || {}).gl_account_id;
    if (!gl_account_id) return res.status(400).json({ error: 'gl_account_id_required' });
    const { data: inv } = await supabase.from('ap_invoices').select('*, vendors(name)').eq('id', id).maybeSingle();
    if (!inv) return res.status(404).json({ error: 'not_found' });
    if (inv.status === 'voided') return res.status(400).json({ error: 'voided' });
    const { data: acct } = await supabase.from('chart_of_accounts')
      .select('id, account_number, account_name').eq('id', gl_account_id).eq('community_id', inv.community_id).maybeSingle();
    if (!acct) return res.status(400).json({ error: 'invalid_account', detail: 'That account is not on this community\'s chart.' });

    // Re-coding an already-posted accrual: reverse the old one first.
    let jeId = inv.posting_journal_entry_id;
    if (jeId && inv.coded_gl_account_id !== gl_account_id) {
      try { const { voidJournalEntry } = require('../lib/accounting/posting'); await voidJournalEntry({ journal_entry_id: jeId, void_reason: 'Re-coded expense account' }); } catch (e) { console.warn('[ap] recode reversal:', e.message); }
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

    res.json({ ok: true, gl_account: `${acct.account_number} ${acct.account_name}`, posting_journal_entry_id: jeId, posted: !!jeId });
  } catch (err) { console.error('[ap] code failed:', err); res.status(500).json({ error: safeErrorMessage(err) }); }
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
    });
    res.json({ ok: true, suggestion });
  } catch (err) { console.error('[ap] suggest-code failed:', err); res.status(500).json({ error: safeErrorMessage(err) }); }
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
