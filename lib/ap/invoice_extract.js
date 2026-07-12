// ============================================================================
// lib/ap/invoice_extract.js  (Ed 2026-07-08)
// ----------------------------------------------------------------------------
// Extract the fields Emma needs off a vendor invoice PDF, so it can be loaded
// into ap_invoices and deduped. Returns cents (like the rest of the ledger).
// Amounts and dates are what the dedup engine keys on, so they matter most —
// if the model can't find a total or a date, the intake holds the invoice for
// manual entry rather than guessing (a wrong amount is worse than a hold).
// ============================================================================
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PROMPT = `You are reading a single vendor INVOICE (or bill/statement) that an HOA
management company received for payment. Extract ONLY what is printed. Return a
JSON object of exactly this shape (no prose, no markdown fence):

{
  "vendor_name":      "string — the company billing us (the 'from' / remit-to company), or null",
  "vendor_email":     "string — vendor email if shown, else null",
  "remit_to":         "string — the remit/payment mailing address if shown, else null",
  "invoice_number":   "string — the vendor's invoice/bill number exactly as printed, or null if none",
  "invoice_date":     "YYYY-MM-DD — the invoice date, or null",
  "due_date":         "YYYY-MM-DD — the due date if shown, or null",
  "terms":            "string — payment terms e.g. 'Net 30', 'Due on Receipt', or null",
  "po_number":        "string — purchase order number if shown, else null",
  "account_number":   "string — the utility/vendor ACCOUNT number this bill is for (common on utility bills like water/electric), exactly as printed, or null",
  "service_period_start": "YYYY-MM-DD — start of the billing/service period this bill covers, or null",
  "service_period_end":   "YYYY-MM-DD — end of the billing/service period this bill covers, or null",
  "auto_draft":       <true|false — does the bill say it is paid by bank draft / auto-pay / ACH / 'DO NOT PAY' / automatic withdrawal? true only if clearly stated>,
  "subtotal":         <number — dollars, or null>,
  "tax":              <number — dollars, or null>,
  "total":            <number — dollars, the AMOUNT DUE / invoice total (the single most important field)>,
  "property_or_community_hint": "string — any association / community / property name or address the work was for, or null",
  "line_items": [ { "description":"string", "amount": <number dollars> } ],
  "looks_like_invoice": <true|false — is this actually a bill/invoice/statement to pay, vs. something else?>
}

Rules:
- Amounts are plain dollars (no $ or commas). 'total' is the amount we owe.
- If the document is clearly NOT an invoice/bill (e.g. a letter, a receipt already paid, a contract), set looks_like_invoice=false and fill what you can.
- Never invent an invoice number, amount, or date. Use null when it isn't printed.
- auto_draft: set true ONLY when the bill explicitly says it's auto-drafted / bank draft / do-not-pay / auto-pay. Otherwise false.`;

const toCents = (n) => (n == null || isNaN(Number(n))) ? null : Math.round(Number(n) * 100);

async function extractInvoice(pdfBuffer) {
  const t0 = Date.now();
  const completion = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
        { type: 'text', text: PROMPT },
      ],
    }],
  });
  const text = completion.content?.[0]?.text || '';
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let p;
  try { p = JSON.parse(cleaned); } catch (err) { throw new Error(`Invoice extraction returned malformed JSON: ${err.message}`); }

  return {
    vendor_name: p.vendor_name || null,
    vendor_email: p.vendor_email || null,
    remit_to: p.remit_to || null,
    invoice_number: p.invoice_number ? String(p.invoice_number).trim() : null,
    invoice_date: p.invoice_date || null,
    due_date: p.due_date || null,
    terms: p.terms || null,
    po_number: p.po_number || null,
    account_number: p.account_number ? String(p.account_number).trim() : null,
    service_period_start: /^\d{4}-\d{2}-\d{2}/.test(p.service_period_start || '') ? p.service_period_start.slice(0, 10) : null,
    service_period_end: /^\d{4}-\d{2}-\d{2}/.test(p.service_period_end || '') ? p.service_period_end.slice(0, 10) : null,
    auto_draft: p.auto_draft === true,
    subtotal_cents: toCents(p.subtotal),
    tax_cents: toCents(p.tax),
    total_cents: toCents(p.total),
    community_hint: p.property_or_community_hint || null,
    line_items: Array.isArray(p.line_items) ? p.line_items : [],
    looks_like_invoice: p.looks_like_invoice !== false,
    _duration_ms: Date.now() - t0,
  };
}

module.exports = { extractInvoice, toCents };
