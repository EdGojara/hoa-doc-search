// ============================================================================
// lib/email/emma_reply.js  (Ed 2026-07-08)
// ----------------------------------------------------------------------------
// Emma drafts a payment-STATUS reply to a vendor, grounded strictly in the AP
// subledger. Like Claire's draft_reply, it's a DRAFT a human approves before it
// sends. Hard rules, because this is money to a counterparty:
//   - Only state what the ledger shows. Never invent an invoice, amount, or date.
//   - NEVER promise a specific pay date the data doesn't contain. "Approved and
//     scheduled for an upcoming check run" — not "you'll have it Friday."
//   - If we have no record of the invoice they're chasing, say so and ask them
//     to resend it to emma@ — don't imply it's in process.
//   - Paid? Give the check number and the date it was sent.
// ============================================================================
const Anthropic = require('@anthropic-ai/sdk');
const { vendorApStatus, findVendorInvoice, STATUS_PLAIN } = require('../ap/vendor_status');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-5';

const money = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const d10 = (s) => (s ? String(s).slice(0, 10) : '—');

// Pull any invoice-number-looking tokens out of what the vendor wrote.
function invoiceNumbersIn(text) {
  const m = String(text || '').match(/(?:inv(?:oice)?\.?\s*#?\s*|#)\s*([A-Za-z0-9][A-Za-z0-9\-\/]{2,})/gi) || [];
  return m.map((s) => s.replace(/.*?([A-Za-z0-9][A-Za-z0-9\-\/]{2,})$/, '$1')).slice(0, 5);
}

async function draftEmmaReply({ email, vendorId, vendorName }) {
  const status = await vendorApStatus(vendorId);
  const askedText = `${email.subject || ''} ${email.body_full || email.body_preview || ''}`;

  // Did they name a specific invoice? Look those up explicitly.
  const named = [];
  for (const num of invoiceNumbersIn(askedText)) {
    const inv = await findVendorInvoice(vendorId, num);
    if (inv) named.push({ asked: num, inv });
    else named.push({ asked: num, inv: null });
  }

  const openLines = (status.open || []).map((i) =>
    `- Invoice ${i.vendor_invoice_number || '(no #)'} dated ${d10(i.invoice_date)}, ${money(i.total_cents)}${i.community && i.community.name ? ` (${i.community.name})` : ''} — ${STATUS_PLAIN[i.status] || i.status}${i.due_date ? `, due ${d10(i.due_date)}` : ''}`).join('\n') || '(no open invoices on file for this vendor)';

  const payLines = (status.recent_payments || []).map((p) =>
    `- ${p.payment_method === 'check' ? `Check #${p.check_number || '—'}` : (p.payment_method || 'Payment')} for ${money(p.amount_cents)} sent ${d10(p.payment_date)} (${p.status})`).join('\n') || '(no recent payments on file)';

  const namedLines = named.length ? named.map((n) => n.inv
    ? `- They asked about invoice "${n.asked}": FOUND — ${money(n.inv.total_cents)} dated ${d10(n.inv.invoice_date)}, status: ${STATUS_PLAIN[n.inv.status] || n.inv.status}.`
    : `- They asked about invoice "${n.asked}": NOT ON FILE — we have no record of this invoice.`).join('\n') : '(no specific invoice number mentioned)';

  const sys = `You are Emma Brooks, Bedrock Association Management's AI accounts-payable team member, drafting a reply to a VENDOR for a human to review before it sends. Warm, professional, concise — like a great AP specialist.

GROUND EVERYTHING in the AP DATA below. Hard rules:
- State only what the data shows. Never invent an invoice, amount, check number, or date.
- Do NOT promise a specific payment date unless the data gives one. If an invoice is approved but unpaid, say it's "approved and scheduled for an upcoming check run" — no guaranteed date.
- If they ask about an invoice marked NOT ON FILE, tell them we don't have a record of it and ask them to resend it to emma@bedrocktx.com so you can get it into the queue. Do not imply it's being processed.
- If an invoice is on hold or in review, say that plainly and, if helpful, that you'll follow up once it clears.
- If it's paid, give the check number and the date it was sent.
- Address their specific question. Don't dump the whole ledger — answer what they asked.
- Sign off simply; the Emma signature is appended automatically. Return ONLY the email body text.`;

  const ctx = `Vendor: ${vendorName || '(unknown)'}
THEY WROTE:
Subject: ${email.subject || ''}
${(email.body_full || email.body_preview || '').slice(0, 3000)}

AP DATA (the ledger — ground your reply in this):
Specific invoices they named:
${namedLines}

Open invoices for this vendor:
${openLines}

Recent payments to this vendor:
${payLines}

Draft Emma's reply body now.`;

  const resp = await anthropic.messages.create({
    model: MODEL, max_tokens: 700, system: sys,
    messages: [{ role: 'user', content: [{ type: 'text', text: ctx }] }],
  });
  const body = ((resp.content[0] && resp.content[0].text) || '').trim();
  const subject = /^re:/i.test(email.subject || '') ? email.subject : `Re: ${email.subject || 'your invoice'}`;
  return { draftable: true, persona: 'emma', subject, body, grounded: { ap: status.hasData } };
}

module.exports = { draftEmmaReply };
