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
 "pricing": {"upfront_cents": "integer cents of the one-time price BEFORE tax, null if none", "tax_rate_pct": "the percentage only when printed (e.g. SALES TAX NOT INCLUDED AT 7.25% -> 7.25); null when the quote only says tax may be added", "tax_included": "boolean",
   "unpriced": "true when the document has no price at all",
   "recurring": [{"label": "...", "monthly_cents": "integer cents", "required": "true if the proposal requires it (minimum term), false if optional", "min_term_months": "integer or null", "auto_renews": "boolean", "taxable": "true when the document says tax is added to monthly charges, false when it says exempt, else null",
     "provides": ["any of: cloud_access, active_monitoring, maintenance, health_alerts, firmware_updates, internet_line, licensing"]}]},
 "line_items": [{"description": "as printed", "category": "camera_new|camera_reused|license|recorder|network|labor|cloud_recurring|materials_labor|other", "quantity": "number as printed", "unit": "each|lot|month|...", "unit_price_cents": "integer or null", "extended_cents": "integer or null", "page": "page number in this file", "excerpt": "the printed line, verbatim, max 160 chars", "embedded_server": "true only if the line says the camera has its own server", "certainty": "certain|uncertain", "uncertain_reason": "why, when uncertain"}],
 "scope_statements": [{"category": "camera_new|camera_reused|license", "quantity": "number stated in the narrative/cover", "page": "page", "excerpt": "verbatim"}],
 "printed_subtotal_cents": "integer cents of the printed subtotal, null if none", "printed_subtotal_page": "page or null",
 "scope": {"summary": "one sentence", "locations": ["..."], "storage": "string or null", "retention_days": "integer or null (only if stated)", "licenses": "integer or null", "embedded_server_cameras": "integer or null"},
 "model": {"ownership": "association|vendor|null", "monitoring": "none|optional|included|required", "cloud_access": "included|with_plan|customer_provided|none|null"},
 "warranty": "verbatim or null", "insurance": "verbatim or null", "exclusions": ["..."], "assumptions": ["..."],
 "timing": "stated schedule or null", "change_order": "change-order / price-may-change language verbatim or null",
 "payment_terms": "verbatim or null", "other_terms": ["material terms: minimum term, auto-renewal, card fees, deposit"]
}]}
Rules: extract only what is printed; never guess a number; null when absent. Cents are integers ($44,619.75 -> 4461975). List every itemized line once; do NOT add up cameras or licenses yourself (totals are computed from your line items). Put narrative counts ("reuse 10 cameras", "swap 4") in scope_statements, not line_items. Mark a line uncertain when its quantity is ambiguous.`;

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

// Narrative quantities: one statement per location, never a phrase collapsed to one number.
const LINES_RULE = 'For scope_statements: when a quantity is stated for several locations ("3 New Cameras at both the Basketball Pavilion and Guard Shack", "2 each at A and B"), record ONE statement PER LOCATION with that quantity and the same verbatim excerpt, and set "location" on each. Never add the numbers up yourself.';

const linesPrompt = (p) => `Read ONLY the proposal from ${p.vendor_name}${p.pages ? ` on pages ${p.pages}` : ''} in this file. Return ONLY valid JSON:
{"line_items": [{"description": "as printed", "category": "camera_new|camera_reused|license|recorder|network|labor|cloud_recurring|materials_labor|other", "quantity": "number as printed", "unit": "each|lot|month|...", "unit_price_cents": "integer or null", "extended_cents": "integer or null", "page": "page number in this file", "excerpt": "the printed line, verbatim, max 160 chars", "embedded_server": "true only if the line says the camera has its own server", "certainty": "certain|uncertain", "uncertain_reason": "why, when uncertain"}],
 "scope_statements": [{"category": "camera_new|camera_reused|license", "quantity": "number", "location": "the location the quantity applies to, or null", "page": "page", "excerpt": "verbatim"}],
 "printed_subtotal_cents": "integer cents of the printed subtotal or one-time total, null if none", "printed_subtotal_page": "page or null"}
List every itemized line once (a lump-sum price line counts as one line, category materials_labor, with extended_cents). Do not total cameras or licenses yourself. ${LINES_RULE}`;

/** Count the proposals a raw reply contains even when it cannot be parsed (truncated JSON). */
const countVendors = (raw) => (String(raw || '').match(/"vendor_name"\s*:/g) || []).length;

/**
 * Extract every proposal in one PDF, in two passes so a long document can never be cut off
 * mid-JSON and silently lose proposals:
 *   1. the proposals in the file (vendor, pages, dates, pricing, terms), no line items
 *   2. per proposal, its line items, narrative statements and printed subtotal
 * Returns { items, raw_extracted, diagnostic: { returned_count, parsed_count, truncated[], invalid[] } }.
 * A proposal whose line items cannot be read is still returned (line_items null), never dropped.
 */
async function extractProposals(buffer, meta = {}, { anthropic, pdfText } = {}) {
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const document = { source_kind: meta.source_kind || 'email_attachment', filename: meta.filename || 'proposal.pdf', size_bytes: buffer.length, sha256, received_at: meta.received_at || null, message: meta.message || null, ref: meta.ref || null };
  const client = anthropic || new (require('../ai/anthropic'))({ apiKey: process.env.ANTHROPIC_API_KEY });
  const docBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } };
  const call = async (text, maxTokens) => {
    const r = await client.messages.create({ model: aiRoute('vendors.proposal_normalize'), max_tokens: maxTokens, messages: [{ role: 'user', content: [docBlock, { type: 'text', text }] }] });
    return { raw: (r.content || []).map((b) => b.text || '').join(''), truncated: r.stop_reason === 'max_tokens' };
  };
  const diagnostic = { file: document.filename, sha256, error: null, invalid: [], truncated: [], returned_count: 0, parsed_count: 0 };
  let raw = ''; let parsed = null;
  try {
    const h = await call(PROMPT + '\nIn THIS pass return "line_items": [] and "scope_statements": [] for every proposal; they are read in a second pass.', 8000);
    raw = h.raw;
    console.log('[proposal_extract] Claude returned:', JSON.stringify({ file: document.filename, pass: 'proposals', truncated: h.truncated, raw: raw.slice(0, 4000) }));
    parsed = parseJson(raw);
    if (h.truncated) diagnostic.truncated.push('proposals pass hit max_tokens');
  } catch (e) { diagnostic.error = e.message; console.warn('[proposal_extract] extraction failed:', document.filename, e.message); }
  const list = parsed && Array.isArray(parsed.proposals) ? parsed.proposals : [];
  diagnostic.returned_count = Math.max(list.length, countVendors(raw));
  diagnostic.parsed_count = list.length;

  const items = [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const item = { ...p, key: `${sha256.slice(0, 8)}-${i + 1}`, document: { ...document, pages: p.pages || null } };
    delete item.pages;
    item.pricing = item.pricing || {};
    // Pass 2: this proposal's line items. A failure leaves the proposal in place with no line items.
    try {
      const l = await call(linesPrompt(p), 12000);
      const li = parseJson(l.raw);
      console.log('[proposal_extract] Claude returned:', JSON.stringify({ file: document.filename, pass: `lines ${i + 1}`, truncated: l.truncated, raw: l.raw.slice(0, 2000) }));
      if (l.truncated || !li) { diagnostic.truncated.push(`line items for ${p.vendor_name}${l.truncated ? ' hit max_tokens' : ' did not parse'}`); item.line_items = null; item.scope_statements = null; }
      else { item.line_items = Array.isArray(li.line_items) ? li.line_items : null; item.scope_statements = Array.isArray(li.scope_statements) ? li.scope_statements : []; if (li.printed_subtotal_cents != null) item.printed_subtotal_cents = li.printed_subtotal_cents; if (li.printed_subtotal_page != null) item.printed_subtotal_page = li.printed_subtotal_page; }
    } catch (e) { diagnostic.truncated.push(`line items for ${p.vendor_name}: ${e.message}`); item.line_items = null; }
    if (!item.pricing.unpriced && item.pricing.upfront_cents == null && !(item.pricing.recurring || []).length && pdfText) {
      const fb = largestDollarCents(pdfText);
      if (fb != null) { item.pricing.upfront_cents = fb; item.needs_review = 'price from largest-dollar fallback, not the model'; }
    }
    const v = validateProposal(item);
    if (!v.ok) diagnostic.invalid.push({ key: item.key, errors: v.errors });
    items.push(item);
  }
  if (!list.length) diagnostic.invalid.push({ key: null, errors: [diagnostic.error ? `model call failed: ${diagnostic.error}` : diagnostic.returned_count ? `${diagnostic.returned_count} proposal(s) in the reply could not be parsed` : 'no proposals returned'], sample: String(pdfText || '').slice(0, 600) });
  return { items, raw_extracted: raw, diagnostic };
}

module.exports = { extractProposals, largestDollarCents, parseJson, PROMPT, LINES_RULE, countVendors };
