// ============================================================================
// lib/legal/pdf_extract.js — read an attorney invoice PDF into matters
// (Issue #9 step 2b)
// ----------------------------------------------------------------------------
// The general AP extractor keeps only line descriptions and amounts, so the
// matter identity an attorney prints (owner names, property address, the
// firm's file number, the section heading that says what kind of work it is)
// is lost. This reads the stored PDF itself, as a document (never pdf-parse),
// and returns the model's JSON verbatim; lib/legal/pdf_matters.js validates it
// against the canonical AP invoice before anything uses it.
// ============================================================================
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-sonnet-4-5';
const PROMPT_VERSION = 'legal-matters-v1';

const PROMPT = `You are reading ONE invoice from a law firm to a homeowners association (HOA).
Extract ONLY what is printed. Return a JSON object of exactly this shape (no prose, no markdown fence):

{
  "invoice_number": "string as printed, or null",
  "invoice_date": "YYYY-MM-DD, or null",
  "total": <number dollars: the total due for THIS invoice (not prior balances)>,
  "matters": [
    {
      "matter_ref": "the firm's matter / file / account number for this matter as printed (e.g. '12345-00001', '012345.000001', '1234.0001'), or null",
      "section_heading": "the heading the matter is listed under, as printed (e.g. 'Deed Restriction Matters', 'Collection Matters', 'General Matters'), or null",
      "title": "the matter's name exactly as printed (e.g. 'Smith, Jane & John - 123 Main St.', 'CLTN - Smith - 123 Main', 'General HOA Representation')",
      "parties": ["each homeowner / debtor name printed for this matter, as printed"],
      "property_address": "the homeowner's property street address printed for this matter, or null",
      "owner_account_number": "the HOA's own account number for the homeowner if printed (NOT the law firm's matter/file/account number), or null",
      "work_type": "collection | deed_restriction | bankruptcy | general | unknown",
      "fees": <number dollars or null>,
      "expenses": <number dollars or null>,
      "total": <number dollars: this matter's total on THIS invoice>,
      "entries": [
        { "date": "YYYY-MM-DD: the date printed on THIS time or expense entry, or null", "kind": "fee | expense",
          "description": "the entry text (up to about 160 characters)", "amount": <number dollars; negative for a credit>, "no_charge": <true if marked no charge / n/c> }
      ],
      "referenced_dates": [ { "date": "YYYY-MM-DD", "context": "short phrase" } ]
    }
  ],
  "other_dates": [ { "date": "YYYY-MM-DD", "context": "short phrase" } ]
}

Rules:
- One entry in "matters" per matter / file / account the invoice bills. A general or corporate matter with no homeowner is still a matter (parties [], property_address null, work_type "general").
- work_type: "collection" for assessment collection work (demand, lien, lien enforcement, foreclosure, judgment, collections, and releasing a lien, lis pendens or abstract of judgment); "deed_restriction" for deed-restriction / violation / covenant / architectural enforcement work; "bankruptcy" when the matter is a homeowner's bankruptcy; "general" for association / corporate / board advice; otherwise "unknown". A section heading like "Deed Restriction Matters" or a title prefix like "CLTN" is strong evidence.
- entries: every dated time entry and expense entry for the matter, in order, with its OWN printed date. When several entries sit under one printed date, give each that date. Include no-charge entries with no_charge true.
- DATES ARE CRITICAL. An entry's "date" is the date printed in that entry's date column: the day the work or expense was recorded. A date that only appears INSIDE an entry's narrative (a judgment date, filing date, hearing date, the date of an earlier letter, "entered 5/20/2026") is NOT the entry date: put it in that matter's "referenced_dates". Dates outside the entries (outstanding / prior invoice lists, "services rendered through", due dates, payment history) go in "other_dates". Never move a referenced or other date into an entry.
- Amounts are plain dollars (no $ or commas); a parenthesized amount is negative.
- Never invent a name, address, number, date or amount. Use null or [] when it isn't printed.`;

let client = null;
function anthropic() { if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }); return client; }

// Returns { raw, model, prompt_version, duration_ms }. Throws on a model or
// JSON failure (the caller records a 'failed' extraction with the message).
async function extractLegalInvoice(pdfBuffer) {
  const t0 = Date.now();
  // Streamed: a long multi-matter invoice (dozens of entries) needs a large
  // output budget, and the SDK requires streaming for long requests.
  const completion = await anthropic().messages.stream({
    model: MODEL,
    max_tokens: 32000,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
        { type: 'text', text: PROMPT },
      ],
    }],
  }).finalMessage();
  if (completion.stop_reason === 'max_tokens') throw new Error('The invoice reader ran out of room before finishing this invoice (output limit); nothing was saved from it.');
  const text = (completion.content || []).map((c) => c.text || '').join('');
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let raw;
  try { raw = JSON.parse(cleaned); } catch (err) {
    console.warn('[legal-extract] malformed JSON from model:', cleaned.slice(0, 300));
    throw new Error(`The invoice reader returned malformed JSON: ${err.message}`);
  }
  console.log('[legal-extract] model returned', JSON.stringify({ matters: Array.isArray(raw.matters) ? raw.matters.length : 0, total: raw.total, ms: Date.now() - t0 }));
  return { raw, model: MODEL, prompt_version: PROMPT_VERSION, duration_ms: Date.now() - t0 };
}

module.exports = { extractLegalInvoice, MODEL, PROMPT_VERSION, PROMPT };
