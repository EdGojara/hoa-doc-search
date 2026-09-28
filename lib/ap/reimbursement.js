// ============================================================================
// lib/ap/reimbursement.js  (Issue #3, Ed 2026-09-28)
// ----------------------------------------------------------------------------
// Rules for turning a staff "please reimburse <person> $X" email + a receipt
// into a reviewable payable. Deterministic and testable; the only AI calls live
// in intake.js (intent parse) and readReceiptAllocation below.
//
// Scar (Issue #3): Celina asked Emma to reimburse Gloria Allen $35.72 for part of
// a $166.00 Walmart receipt. The extractor correctly said a paid receipt is not
// an invoice, intake exited on that BEFORE its reimbursement branch, the email
// caller ignored "not_an_invoice", and a reply draft promised the check anyway.
//
// Rules:
//   * Intent before document type: a paid receipt is valid reimbursement support.
//   * Amount provenance: the amount REQUESTED by staff in the email is the payable
//     amount. The receipt grand total is supporting evidence only and is never
//     substituted. A handwritten/receipt allocation is evidence too. Any conflict
//     between them goes to needs_review with every figure shown.
//   * Coding: a staff coding instruction resolves only to a real account on the
//     community's chart. No instruction, no match, or more than one match ->
//     needs_review. Nothing is invented.
//   * No silent terminal state: an email that asks for a payment must end as a
//     payable or a needs_review exception, never as "not an invoice".
//   * A reply may promise posting / a check only when a payable exists.
// ============================================================================

const INTERNAL_DOMAIN = /@bedrocktx\.com$/i;
const isInternalSender = (email) => INTERNAL_DOMAIN.test(String(email || '').trim().toLowerCase());

// Clear request to pay or reimburse someone (email subject + body).
const PAYMENT_INTENT = /\breimburs\w*|\bpay(?:ment)?\s+(?:to|for|of|in the amount)\b|\bplease\s+(?:pay|process|issue|cut|send)\b|\bprocess\s+(?:the\s+|a\s+|this\s+)?(?:payment|reimbursement|check)\b|\b(?:cut|issue|write)\s+(?:a\s+|the\s+)?check\b|\bamount\s+of\s+\$?\d/i;
function hasPaymentIntent(text) { return PAYMENT_INTENT.test(String(text || '')); }

// Dollar amounts a person typed in the email: "$35.72", "35.72", "$1,200.00".
// Cents are required so a street number, date or zip can't read as money.
function requestedAmountsCents(text) {
  const t = String(text || '');
  const out = new Set();
  const re = /(^|[^\d.,/-])\$?\s?(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})(?![\d])/g;
  let m;
  while ((m = re.exec(t))) {
    const cents = Number(m[2].replace(/,/g, '')) * 100 + Number(m[3]);
    if (cents > 0) out.add(cents);
  }
  return [...out];
}

const $ = (c) => (c == null ? 'n/a' : '$' + (c / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','));

// Decide the payable amount and keep every figure's source.
//   requested:  distinct amounts typed in the staff email
//   receiptTotalCents: the receipt's printed grand total (evidence only)
//   allocationCents:   a reimbursable subtotal written/marked on the receipt (evidence)
function resolveReimbursementAmount({ requested = [], receiptTotalCents = null, allocationCents = null }) {
  const provenance = {
    requested_cents: requested.length === 1 ? requested[0] : null,
    requested_candidates_cents: requested,
    requested_source: 'staff email instruction',
    receipt_total_cents: receiptTotalCents || null,
    receipt_total_source: 'receipt grand total (supporting document, not the amount due)',
    allocation_cents: allocationCents || null,
    allocation_source: 'allocation noted on the receipt',
  };
  const figures = `requested ${$(provenance.requested_cents)}; receipt total ${$(provenance.receipt_total_cents)}; receipt allocation ${$(provenance.allocation_cents)}`;
  if (requested.length > 1) return { ok: false, provenance, reason: `reimbursement: the email names more than one amount (${requested.map($).join(', ')}); confirm which is owed (${figures})` };
  if (requested.length === 0) return { ok: false, provenance, reason: `reimbursement: no amount stated in the email; the receipt total is not assumed to be the amount owed (${figures})` };
  const req = requested[0];
  if (receiptTotalCents && req > receiptTotalCents) return { ok: false, provenance, reason: `reimbursement: requested amount is more than the receipt total (${figures})` };
  if (allocationCents && allocationCents !== req) return { ok: false, provenance, reason: `reimbursement: requested amount and the receipt allocation disagree (${figures})` };
  return { ok: true, amount_cents: req, provenance, summary: figures };
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const CODING_WORDS = /\b(code|coded|coding|gl|charge|expense|account)\b/i;

// Resolve a staff coding instruction against THIS community's chart.
// Returns { status: 'matched'|'ambiguous'|'no_match'|'no_instruction', account?, candidates? }.
function resolveCodingDirective(text, accounts = []) {
  const raw = String(text || '');
  if (!CODING_WORDS.test(raw)) return { status: 'no_instruction' };
  const t = ' ' + norm(raw) + ' ';
  const byNumber = accounts.filter((a) => a.account_number && t.includes(' ' + norm(a.account_number) + ' '));
  if (byNumber.length === 1) return { status: 'matched', account: byNumber[0], matched_by: 'number' };
  if (byNumber.length > 1) return { status: 'ambiguous', candidates: byNumber };
  const named = accounts.filter((a) => { const n = norm(a.account_name); return n.split(' ').length >= 2 && t.includes(' ' + n + ' '); });
  if (!named.length) return { status: 'no_match' };
  const longest = Math.max(...named.map((a) => norm(a.account_name).length));
  const top = named.filter((a) => norm(a.account_name).length === longest);
  if (top.length > 1) return { status: 'ambiguous', candidates: top };
  return { status: 'matched', account: top[0], matched_by: 'name' };
}

// Decide what to do with a reimbursement after community + payee lookups.
// Pure: returns { outcome: 'commit', ... } or { outcome: 'needs_review', reason }.
function planReimbursement({ intent, staffText, staffSenderEmail, communityId, extracted, allocationCents = null, allocationNote = null, accounts = [] }) {
  if (!intent || !intent.is_reimbursement) return { outcome: 'not_reimbursement' };
  if (!intent.reimbursee_name) return { outcome: 'needs_review', reason: 'reimbursement: who is being reimbursed?' };
  if (!communityId) return { outcome: 'needs_review', reason: 'reimbursement: which community?' };
  const amt = resolveReimbursementAmount({ requested: requestedAmountsCents(staffText), receiptTotalCents: extracted.total_cents || null, allocationCents });
  if (!amt.ok) return { outcome: 'needs_review', reason: amt.reason, provenance: amt.provenance };
  if (!extracted.invoice_date) return { outcome: 'needs_review', reason: 'reimbursement: could not read the receipt date', provenance: amt.provenance };
  // Coding directives are honored only from Bedrock staff (a payee must not code its own payment).
  const coding = isInternalSender(staffSenderEmail) ? resolveCodingDirective(staffText, accounts) : { status: 'no_instruction' };
  if (coding.status !== 'matched') {
    const why = coding.status === 'ambiguous'
      ? `the coding instruction matches more than one account (${coding.candidates.map((a) => `${a.account_number} ${a.account_name}`).join(', ')})`
      : coding.status === 'no_match' ? "the coding instruction doesn't match an account on this community's chart"
        : 'no coding instruction from staff';
    return { outcome: 'needs_review', reason: `reimbursement: which expense account? ${why}`, provenance: amt.provenance };
  }
  const a = coding.account;
  return {
    outcome: 'commit', amount_cents: amt.amount_cents, provenance: amt.provenance,
    staffGl: { account_id: a.id, account_number: a.account_number, account_name: a.account_name, matched_by: coding.matched_by },
    notes: `Reimbursement to ${intent.reimbursee_name}: amount ${$(amt.amount_cents)} from the staff email instruction. Evidence: ${amt.summary}${!allocationCents && allocationNote ? ` (${allocationNote})` : ''}. Coded ${a.account_number} ${a.account_name} per staff instruction.`,
  };
}

// Route a staged document: intent first, then document type. Never a silent
// "not an invoice" when the email asks for a payment.
function routeAfterStage({ looksLikeInvoice, isReimbursement, paymentIntent }) {
  if (isReimbursement) return 'reimbursement';
  if (looksLikeInvoice) return 'invoice';
  return paymentIntent ? 'needs_review_not_invoice' : 'not_an_invoice';
}

// A reply may promise payment / a check ONLY when the AP state really supports
// it: an approved, scheduled or paid item. A payable that merely exists is
// awaiting approval (and often held for review), so promise sentences are
// replaced with the true state. Sentences split on . ! ? followed by whitespace
// (so "$35.72" never breaks a sentence) or on newlines.
const PROMISE_KW = /\b(cut (?:the |a )?check|get (?:this|it) posted|(?:will|i'll|we'll|i will|we will)\s+(?:get\s+)?(?:post|pay|process|issue|send|mail|cut)\w*|payment (?:is|has been|will be) (?:scheduled|processed|sent|issued)|check (?:is|has been|will be) (?:cut|issued|sent|mailed|on its way))\b/i;
const PAID_STATES = new Set(['approved', 'scheduled', 'paid', 'issued', 'check_printed']);
// state: { payable: bool, status?: ap_invoices.status, needs_review?: bool }
function paymentStateLine(state = {}) {
  if (PAID_STATES.has(state.status)) return null;   // strong language allowed
  if (state.payable) {
    return state.needs_review
      ? "I've entered this in Payables for review. Nothing is paid until it's reviewed and approved."
      : "I've entered this in Payables for approval.";
  }
  return state.needs_review
    ? "I've logged this in Payables for review. Nothing is paid until it's reviewed and approved."
    : "I couldn't set this up as a payable automatically, so a teammate will review it before anything is paid.";
}
function stateAwarePaymentDraft(body, state) {
  const text = String(body || '');
  const line = paymentStateLine(state || {});
  if (!line) return { body: text, changed: false };
  const parts = text.split(/(\n+|(?<=[.!?])[ \t]+)/);
  if (!parts.some((p, i) => i % 2 === 0 && PROMISE_KW.test(p))) return { body: text, changed: false };
  let inserted = false;
  const out = [];
  for (let i = 0; i < parts.length; i += 2) {
    const sentence = parts[i]; const sep = parts[i + 1] || '';
    if (PROMISE_KW.test(sentence)) {
      if (!inserted) { out.push(line + (sep || '')); inserted = true; } else if (/\n/.test(sep)) out.push(sep);
    } else out.push(sentence + sep);
  }
  return { body: out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n'), changed: true };
}

// A mailing address typed in the staff instruction ("remit to 123 Main St,
// Houston, Texas 77084"). EVIDENCE ONLY: shown to the reviewer, never written to
// the payee record automatically. Returns the distinct addresses found.
const STREET = '(?:Lane|Ln|Street|St|Drive|Dr|Road|Rd|Court|Ct|Avenue|Ave|Boulevard|Blvd|Way|Circle|Cir|Trail|Trl|Place|Pl|Parkway|Pkwy|Loop|Bend|Cove|Cv|Terrace|Ter|Run|Crossing|Xing|Highway|Hwy|Pass|Point|Pt|Ridge|Hollow|Path|Square|Sq)';
const ADDRESS_RE = new RegExp(`\\b(\\d{1,6}\\s+[A-Za-z0-9.'\\- ]{1,40}?\\s${STREET}\\.?(?:\\s*(?:#|Apt\\.?|Unit|Suite|Ste\\.?)\\s*[A-Za-z0-9-]+)?)\\s*,?\\s+([A-Za-z .'-]{2,30}?)\\s*,?\\s+(Texas|TX|[A-Z]{2})\\.?\\s*,?\\s*(\\d{5}(?:-\\d{4})?)\\b`, 'g');
function statedRemitAddresses(text) {
  const out = new Map();
  let m;
  const t = String(text || '');
  ADDRESS_RE.lastIndex = 0;
  while ((m = ADDRESS_RE.exec(t))) {
    const a = { line1: m[1].replace(/\s+/g, ' ').trim(), city: m[2].trim(), state: /^texas$/i.test(m[3]) ? 'TX' : m[3].toUpperCase(), zip: m[4] };
    out.set(`${a.line1}|${a.zip}`.toLowerCase(), a);
  }
  return [...out.values()];
}
const fmtAddress = (a) => (a && a.line1 ? `${a.line1}, ${a.city || ''}${a.city ? ', ' : ''}${a.state || ''} ${a.zip || ''}`.replace(/\s+/g, ' ').trim() : null);
const addrKey = (a) => (a ? `${String(a.line1 || '').toLowerCase().replace(/[^a-z0-9]/g, '')}|${String(a.zip || '').slice(0, 5)}` : '');
// Compare the stated address with one already on file (payee or linked contact).
function remitAddressNote(stated = [], onFile = null) {
  if (!stated.length && !onFile) return null;
  if (stated.length > 1) return `More than one mailing address in the staff instruction (${stated.map(fmtAddress).join(' / ')}): confirm which before the check run.`;
  const s1 = stated[0] || null;
  if (s1 && !onFile) return `Mailing address supplied in the staff instruction: ${fmtAddress(s1)}. Not saved to the payee; confirm it before the check run.`;
  if (!s1 && onFile) return `Payee mailing address on file: ${fmtAddress(onFile)}.`;
  if (addrKey(s1) === addrKey(onFile)) return `Mailing address in the staff instruction matches the one on file: ${fmtAddress(onFile)}.`;
  return `Mailing address DIFFERS: staff instruction says ${fmtAddress(s1)}; on file: ${fmtAddress(onFile)}. Neither was changed; confirm before the check run.`;
}

// Reimbursable subtotal written or marked on the receipt (e.g. a handwritten
// "BBQ sauce 3 x $11 + tax = $35.72"). Evidence only. Returns cents or null.
async function readReceiptAllocation(buffer) {
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const c = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 300,
      messages: [{ role: 'user', content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(buffer).toString('base64') } },
        { type: 'text', text: 'This receipt supports a reimbursement request. Look ONLY for a handwritten or marked-up note that lists which items are being reimbursed (not the printed receipt lines). If there is one, transcribe each handwritten line exactly as written, including quantity and unit price when shown, and the handwritten total if one is written. Return ONLY JSON: {"lines": [{"text": "as written", "quantity": number or null, "unit_price": number or null, "amount": number}], "written_total": number or null}. Return {"lines": [], "written_total": null} when there is no handwritten allocation. Never include the printed grand total.' },
      ] }],
    });
    const raw = (c.content && c.content[0] && c.content[0].text) || '{}';
    const j = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim());
    return allocationFromLines(j);
  } catch (e) {
    console.warn('[ap reimbursement] allocation read failed:', e.message);
    return { cents: null, note: null };
  }
}

// Handwriting is read unreliably, so the allocation counts only when the
// handwritten lines add up to the handwritten total (qty x unit checked too).
// Anything inconsistent is dropped as evidence rather than trusted.
function allocationFromLines(j) {
  const lines = Array.isArray(j && j.lines) ? j.lines : [];
  if (!lines.length) return { cents: null, note: null };
  let sum = 0;
  for (const l of lines) {
    const amt = Math.round(Number(l.amount) * 100);
    if (!Number.isFinite(amt) || amt <= 0) return { cents: null, note: 'handwritten allocation unreadable' };
    if (l.quantity != null && l.unit_price != null && Math.round(Number(l.quantity) * Number(l.unit_price) * 100) !== amt) return { cents: null, note: 'handwritten allocation lines do not add up' };
    sum += amt;
  }
  const written = j.written_total != null ? Math.round(Number(j.written_total) * 100) : null;
  if (written != null && written !== sum) return { cents: null, note: 'handwritten allocation total does not match its lines' };
  return { cents: sum, note: lines.map((l) => String(l.text || '').slice(0, 60)).join('; ') };
}

module.exports = {
  allocationFromLines,
  isInternalSender, hasPaymentIntent, requestedAmountsCents, resolveReimbursementAmount,
  resolveCodingDirective, planReimbursement, routeAfterStage, stateAwarePaymentDraft, paymentStateLine, readReceiptAllocation,
  statedRemitAddresses, remitAddressNote, fmtAddress,
};
