// ============================================================================
// lib/accounting/payment_confirmation.js  (Issue #14)
// ----------------------------------------------------------------------------
// The hands-off auto-record at ingest posts a PAYMENT to the GL (Dr expense /
// Cr 1000 Operating Cash) and then skips AP intake. It used to fire on any
// vendor_financial email with a learned account mapping and one amount, so on
// 2026-09-24 three Cinco MUD INVOICES ("Please process. This is set to auto pay.
// Please add $1 to the draft amount.") posted $1.00 "payments" and never reached
// Payables. A payment can only be recorded from an email that SAYS a payment
// happened, and never from a staff request to process a bill. Pure.
// ============================================================================

// The email says money already moved.
const CONFIRMS = /\b(payment\s+(?:was\s+|has\s+been\s+)?(?:successfully\s+)?(?:charged|received|processed|posted|completed|submitted|applied)|payment\s+success(?:ful)?|successful\s+payment|auto-?pay(?:ment)?\s+(?:was\s+|has\s+been\s+)?(?:successfully\s+)?(?:submitted|processed|completed|charged)|thank\s+you\s+for\s+your\s+payment|payment\s+confirmation|payment\s+receipt|receipt\s+for\s+your\s+payment)\b/i;
// Someone is asking us to do something with a bill (process / post / pay / log).
const ASKS = /\bplease\s+(?:pay|process|post|enter|log|add|record|draft|schedule|set\s+up)\b|\bprocess\s+(?:and|&)\s+post\b|\bneeds?\s+to\s+be\s+(?:paid|processed|posted|logged|entered)\b|\badd\s+\$?\d[\d.,]*\s+to\s+the\s+(?:draft|payment|amount)\b/i;
const INTERNAL = /@bedrocktx\.com$/i;

// { subject, body, from, hasAttachments } -> { ok, reason }
function paymentConfirmationGate({ subject, body, from, hasAttachments } = {}) {
  const text = `${subject || ''}\n${body || ''}`;
  if (ASKS.test(text)) return { ok: false, reason: 'someone asks for this bill to be processed: it belongs in Payables, not recorded as a payment' };
  if (hasAttachments && INTERNAL.test(String(from || '').trim())) return { ok: false, reason: 'a staff-forwarded email with attachments is a bill for Payables, not a payment notice' };
  if (!CONFIRMS.test(text)) return { ok: false, reason: 'the email does not say a payment was made' };
  return { ok: true, reason: null };
}

module.exports = { paymentConfirmationGate, CONFIRMS, ASKS };
