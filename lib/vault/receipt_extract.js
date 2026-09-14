// ============================================================================
// lib/vault/receipt_extract.js  (Ed 2026-09-14)
// ----------------------------------------------------------------------------
// Read a photographed receipt and return the fields we need to support and
// reconcile a credit-card charge: vendor, date, total, tax, card last-4, and a
// GL-category guess. Owner-vault only. House rules: send the image binary to
// the model, return the raw extraction for debugging, never invent a value.
// ============================================================================
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PROMPT = `You are reading ONE photographed receipt for a small company's bookkeeping.
Return ONLY strict JSON of this shape (no prose, no markdown fence):

{
  "vendor_name": "string — the merchant/business name, or null",
  "receipt_date": "YYYY-MM-DD or null",
  "total": <number dollars — the final amount paid, or null>,
  "tax": <number dollars — sales tax, or null>,
  "currency": "USD (or the printed currency), or null",
  "card_last4": "string — last 4 digits of the card if printed, or null",
  "payment_method": "string — 'Visa', 'Amex', 'cash', etc., or null",
  "category_guess": "string — a plain expense category (e.g. 'Meals', 'Office supplies', 'Software', 'Travel', 'Fuel', 'Utilities'), or null",
  "line_items": [ { "description": "string", "amount": <number dollars> } ]
}

Rules:
- Amounts are plain dollars, no $ or commas. The "total" is the FINAL amount
  charged (after tax and tip).
- Use the transaction date printed on the receipt. If only MM/DD, infer the
  year from context; if none, use null.
- Never invent a value. If something is not printed or is unreadable, use null
  (and [] for line_items).
- card_last4 is 4 digits only, no masking characters.`;

const MEDIA = { 'image/jpeg': 1, 'image/jpg': 'image/jpeg', 'image/png': 1, 'image/webp': 1, 'image/gif': 1 };

/**
 * @param {Buffer} buffer   the receipt image
 * @param {string} mimetype e.g. 'image/jpeg'
 * @returns {Promise<{ok, extracted, raw, error}>}  never throws
 */
async function extractReceipt(buffer, mimetype) {
  const mt = String(mimetype || '').toLowerCase();
  const media_type = MEDIA[mt] === 1 ? mt : (MEDIA[mt] || null);
  if (!media_type) {
    return { ok: false, error: `Unsupported image type "${mimetype}". Use JPEG or PNG (an iPhone photo works; HEIC does not).`, extracted: null, raw: null };
  }
  let raw = null;
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type, data: buffer.toString('base64') } },
          { type: 'text', text: PROMPT },
        ],
      }],
    });
    raw = (resp.content || []).map((c) => c.text || '').join('').trim();
    console.log('[vault-receipt] model returned:', raw.slice(0, 500));
    const jsonText = raw.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    const p = JSON.parse(jsonText);
    const toCents = (n) => (n == null || n === '' || Number.isNaN(Number(n))) ? null : Math.round(Number(n) * 100);
    const extracted = {
      vendor_name: p.vendor_name || null,
      receipt_date: /^\d{4}-\d{2}-\d{2}$/.test(p.receipt_date || '') ? p.receipt_date : null,
      total_cents: toCents(p.total),
      tax_cents: toCents(p.tax),
      currency: (p.currency && String(p.currency).slice(0, 8)) || 'USD',
      card_last4: (p.card_last4 && String(p.card_last4).replace(/\D/g, '').slice(-4)) || null,
      payment_method: p.payment_method || null,
      category_guess: p.category_guess || null,
      line_items: Array.isArray(p.line_items) ? p.line_items : [],
    };
    return { ok: true, extracted, raw, error: null };
  } catch (err) {
    console.error('[vault-receipt] extract failed:', err.message);
    return { ok: false, error: err.message, extracted: null, raw };
  }
}

module.exports = { extractReceipt };
