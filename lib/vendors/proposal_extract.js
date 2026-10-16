// ============================================================================
// lib/vendors/proposal_extract.js  (Ed 2026-10-16)
// ----------------------------------------------------------------------------
// Extraction for the RFP / Bid Workflow comparison. Stage 1 of the two-stage
// flow (extract -> validate -> render): reads a proposal document into the
// comparable structure lib/vendors/proposal_comparison.js validates and renders.
//
// CLAUDE.md extraction rules, all honored here:
//   - send the PDF BINARY (document block), never pdf-parse text (form-PDF scar)
//   - log the raw model output server-side, return raw_extracted to the caller
//   - validate every item (validateProposal); a failing item is reported, never dropped silently
//   - fallback for the critical field: if the model returns no price, a largest-
//     dollar scan of the PDF text proposes one and marks the item for review
//   - a packet holding several proposals comes back as several items (page ranges)
// ============================================================================
const crypto = require('crypto');
const { route: aiRoute } = require('../ai/router');
const { validateProposal } = require('./proposal_comparison');

const PROMPT = `You are reading vendor proposal documents for a homeowners association. One file may contain SEVERAL proposals (a board packet). Return ONLY valid JSON:
{"proposals":[{
 "vendor_name": "legal name as printed",
 "pages": "page range in this file, e.g. \\"1-9\\"",
 "document_date": "YYYY-MM-DD: the proposal/quote date or the vendor's signature date; null if none",
 "quote_number": "string or null", "revision": "number or null",
 "expires_on": "YYYY-MM-DD or null (an explicit 'Expires On' / 'valid through' date only)",
 "budgetary": "true if the vendor calls it budgetary / subject to change",
 "pricing": {"upfront_cents": "integer cents of the one-time price BEFORE tax, null if none", "tax_rate_pct": "number or null", "tax_included": "boolean",
   "unpriced": "true when the document has no price at all",
   "recurring": [{"label": "...", "monthly_cents": "integer cents", "required": "true if the proposal requires it (minimum term), false if optional", "min_term_months": "integer or null", "auto_renews": "boolean", "taxable": "true/false/null as printed",
     "provides": ["any of: cloud_access, active_monitoring, maintenance, health_alerts, firmware_updates, internet_line, licensing"]}]},
 "scope": {"summary": "one sentence", "cameras_total": "integer or null", "cameras_new": "integer or null", "cameras_reused": "integer or null", "locations": ["..."], "storage": "string or null", "retention_days": "integer or null (only if stated)", "licenses": "integer or null", "embedded_server_cameras": "integer or null"},
 "model": {"ownership": "association|vendor|null", "monitoring": "none|optional|included|required", "cloud_access": "included|with_plan|customer_provided|none|null"},
 "warranty": "verbatim or null", "insurance": "verbatim or null", "exclusions": ["..."], "assumptions": ["..."],
 "timing": "stated schedule or null", "change_order": "change-order / price-may-change language verbatim or null",
 "payment_terms": "verbatim or null", "other_terms": ["material terms: minimum term, auto-renewal, card fees, deposit"]
}]}
Rules: extract only what is printed; never guess a number; null when absent. Cents are integers ($44,619.75 -> 4461975).`;

function parseJson(raw) {
  const t = String(raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch (_) {}
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  return null;
}

/** Largest-dollar fallback: the biggest $ amount printed, in cents. */
function largestDollarCents(text) {
  let max = null;
  for (const m of String(text || '').matchAll(/\$\s?([\d,]+\.\d{2})/g)) { const c = Math.round(Number(m[1].replace(/,/g, '')) * 100); if (Number.isFinite(c) && (max == null || c > max)) max = c; }
  return max;
}

/**
 * Extract every proposal in one PDF. Returns { items, raw_extracted, diagnostic }.
 * `meta` = { filename, source_kind, received_at, message, ref } becomes each item's source pointer.
 */
async function extractProposals(buffer, meta = {}, { anthropic, pdfText } = {}) {
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const document = { source_kind: meta.source_kind || 'email_attachment', filename: meta.filename || 'proposal.pdf', size_bytes: buffer.length, sha256, received_at: meta.received_at || null, message: meta.message || null, ref: meta.ref || null };
  const client = anthropic || new (require('../ai/anthropic'))({ apiKey: process.env.ANTHROPIC_API_KEY });
  let raw = ''; let parsed = null; let error = null;
  try {
    const r = await client.messages.create({ model: aiRoute('vendors.proposal_normalize'), max_tokens: 6000, messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
      { type: 'text', text: PROMPT },
    ] }] });
    raw = (r.content || []).map((b) => b.text || '').join('');
    console.log('[proposal_extract] Claude returned:', JSON.stringify({ file: document.filename, raw: raw.slice(0, 4000) }));
    parsed = parseJson(raw);
  } catch (e) { error = e.message; console.warn('[proposal_extract] extraction failed:', document.filename, e.message); }

  const items = []; const diagnostic = { file: document.filename, sha256, error, invalid: [] };
  const list = parsed && Array.isArray(parsed.proposals) ? parsed.proposals : [];
  list.forEach((p, i) => {
    const item = { ...p, key: `${sha256.slice(0, 8)}-${i + 1}`, document: { ...document, pages: p.pages || null } };
    delete item.pages;
    item.pricing = item.pricing || {};
    if (!item.pricing.unpriced && item.pricing.upfront_cents == null && !(item.pricing.recurring || []).length && pdfText) {
      const fb = largestDollarCents(pdfText);
      if (fb != null) { item.pricing.upfront_cents = fb; item.needs_review = 'price from largest-dollar fallback, not the model'; }
    }
    const v = validateProposal(item);
    if (!v.ok) diagnostic.invalid.push({ key: item.key, errors: v.errors });
    items.push(item);
  });
  if (!list.length) diagnostic.invalid.push({ key: null, errors: [error ? `model call failed: ${error}` : 'no proposals returned'], sample: String(pdfText || '').slice(0, 600) });
  return { items, raw_extracted: raw, diagnostic };
}

module.exports = { extractProposals, largestDollarCents, parseJson, PROMPT };
