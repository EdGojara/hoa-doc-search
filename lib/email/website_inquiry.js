'use strict';
// ============================================================================
// lib/email/website_inquiry.js  (Ed 2026-10-18, PR #224) — verified website inquiries
// ----------------------------------------------------------------------------
// The bedrocktx.com Contact form emails each submission to welcome@ from
// notifications@bedrocktxai.com (Resend, DKIM-signed for bedrocktxai.com), with
// Reply-To = the submitter and a fixed body:
//     New Bedrock website inquiry
//     Purpose: <prospective|board|homeowner|closing|vendor|other>
//     Name: … / Email: … / Phone: … / Community: … / Message: …
//
// The AI classifier called real prospective and vendor inquiries SPAM (contact-
// form + "learn more about your company"), which would have filed them as
// Dismissed with no owner and no draft. A VERIFIED inquiry is therefore never
// spam: the form already screens bots (honeypot), and the owner is decided here
// from the stated purpose and the message's intent.
//
// TRUST IS EARNED, NOT CLAIMED. bedrocktxai.com publishes no DMARC record, so the
// From address can be forged. An inquiry is VERIFIED only when ALL hold:
//   1. sender is exactly the configured website sender;
//   2. the receiving server's (Microsoft's, the FIRST) Authentication-Results says
//      dkim=pass for header.d=bedrocktxai.com (aligned with the From domain);
//   3. subject and body match the form's strict format, Purpose agrees with the
//      subject, Name / Email / Message present, Email valid;
//   4. the Reply-To header (when present) is the same address as the Email field.
// Anything that CLAIMS to be a website inquiry but fails is UNVERIFIED: it is not
// trusted (no owner routing, no draft), it is kept visible for a human with the
// reasons, and it is never silently dismissed.
// ============================================================================

const PURPOSES = ['prospective', 'board', 'homeowner', 'closing', 'vendor', 'other'];
const SUBJECT_RE = /^Bedrock website inquiry: (prospective|board|homeowner|closing|vendor|other)$/i;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const norm = (v) => String(v || '').trim().toLowerCase();
const websiteSender = () => norm(process.env.WEBSITE_INQUIRY_SENDER || 'notifications@bedrocktxai.com');
const websiteDkimDomain = () => norm(process.env.WEBSITE_INQUIRY_DKIM_DOMAIN || 'bedrocktxai.com');

// Does this message CLAIM to be a website inquiry (sender or subject)? Claimed
// messages are verified; everything else never touches this path.
function claimsWebsiteInquiry(email) {
  return norm(email && email.sender_email) === websiteSender() || SUBJECT_RE.test(String((email && email.subject) || '').trim());
}

// Strict body parse. Field lines must appear in the form's order after the title line.
function parseBody(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const reasons = [];
  if (!/^New Bedrock website inquiry$/i.test(lines[0] || '')) reasons.push('body_title_missing');
  const order = ['purpose', 'name', 'email', 'phone', 'community', 'message'];
  const out = {}; let pos = 1;
  for (const key of order) {
    const idx = lines.findIndex((l, i) => i >= pos && new RegExp(`^${key}\\s*:`, 'i').test(l));
    if (idx < 0) { reasons.push(`field_missing:${key}`); continue; }
    const first = lines[idx].replace(new RegExp(`^${key}\\s*:\\s*`, 'i'), '');
    // Message is the last field and may span lines.
    out[key] = key === 'message' ? [first, ...lines.slice(idx + 1)].join('\n').trim() : first.trim();
    pos = idx + 1;
  }
  const blank = (v) => !v || v === '—' || v === '-';
  if (out.purpose && !PURPOSES.includes(norm(out.purpose))) reasons.push('purpose_unknown');
  if (blank(out.name)) reasons.push('name_missing');
  if (!out.email || !EMAIL_RE.test(out.email)) reasons.push('email_invalid');
  if (blank(out.message)) reasons.push('message_missing');
  return {
    reasons,
    purpose: norm(out.purpose), name: blank(out.name) ? null : out.name, email: out.email ? norm(out.email) : null,
    phone: blank(out.phone) ? null : out.phone, community: blank(out.community) ? null : out.community, message: blank(out.message) ? null : out.message,
  };
}

// The receiving server's verdict: the FIRST Authentication-Results header (Microsoft
// prepends its own; anything a sender planted sits below it).
function dkimVerdict(headers) {
  const list = Array.isArray(headers) ? headers : Object.entries(headers || {}).map(([name, value]) => ({ name, value }));
  const ar = list.find((h) => norm(h.name) === 'authentication-results');
  if (!ar) return { pass: false, reason: 'authentication_results_missing' };
  const v = String(ar.value || '');
  const clauses = v.split(';').map((c) => c.trim());
  const d = websiteDkimDomain();
  const ok = clauses.some((c) => /^dkim=pass\b/i.test(c) && new RegExp(`header\\.d=${d.replace(/\./g, '\\.')}(\\s|$|;)`, 'i').test(c + ' '));
  return ok ? { pass: true } : { pass: false, reason: /dkim=pass/i.test(v) ? 'dkim_domain_not_aligned' : 'dkim_not_pass' };
}
function headerValue(headers, name) {
  const list = Array.isArray(headers) ? headers : Object.entries(headers || {}).map(([n, value]) => ({ name: n, value }));
  const h = list.find((x) => norm(x.name) === norm(name));
  return h ? String(h.value || '') : null;
}

// Owner from purpose + intent (Ed 2026-10-18).
const SHOPPING_RE = /\b(new|another|different|replac\w*|switch\w*|chang\w*)\s+(our\s+|the\s+|a\s+)?(hoa\s+|property\s+)?(management|manager|management company)\b|looking\s+for\s+(a\s+|an\s+)?(new\s+)?(hoa\s+|property\s+)?(management|manager)|management\s+(company\s+)?(proposals?|rfp|bids?|quotes?)|request\s+for\s+proposals?|\brfp\b|(not happy|unhappy|dissatisfied|frustrated)\s+with\s+(our\s+)?(current\s+)?(management|manager)|current\s+management\s+(company\s+)?contract|(contract|agreement)\s+(is\s+)?(ending|expiring|up for renewal)|interview\w*\s+(management|managers)|take\s+over\s+(management|our community)/i;
const PAYABLES_RE = /\b(invoice|invoices|payment|paid|unpaid|remittance|past\s+due|overdue|statement|w-?9|1099|ach|billing|bill|check\s+(number|#)|outstanding\s+balance|accounts\s+payable)\b/i;

function assignOwner({ purpose, message, community }) {
  const text = `${message || ''} ${community || ''}`;
  if (purpose === 'prospective') return { owner: 'maggie', intent: 'prospective_management_client', draft_classification: 'homeowner_request' };
  if (purpose === 'board' && SHOPPING_RE.test(text)) return { owner: 'maggie', intent: 'board_seeking_new_management', draft_classification: 'homeowner_request' };
  if (purpose === 'board') return { owner: 'claire', intent: 'existing_board_inquiry', draft_classification: 'homeowner_request', hint: 'Board inquiry: loop Amanda in for management matters.' };
  if (purpose === 'homeowner') return SHOPPING_RE.test(text)
    ? { owner: 'maggie', intent: 'board_seeking_new_management', draft_classification: 'homeowner_request' }
    : { owner: 'claire', intent: 'homeowner_inquiry', draft_classification: 'homeowner_request' };
  if (purpose === 'closing') return { owner: 'reese', intent: 'closing_title_inquiry', draft_classification: 'homeowner_request' };
  if (purpose === 'vendor') return PAYABLES_RE.test(text)
    ? { owner: 'emma', intent: 'vendor_payables', draft_classification: 'vendor_general', hint: 'Vendor payables question from the website: Emma reviews.' }
    : { owner: 'claire', intent: 'vendor_business_inquiry', draft_classification: 'vendor_general', hint: 'Vendor / business inquiry: Claire triages and routes.' };
  return SHOPPING_RE.test(text)
    ? { owner: 'maggie', intent: 'board_seeking_new_management', draft_classification: 'homeowner_request' }
    : { owner: 'claire', intent: 'general_inquiry', draft_classification: 'homeowner_request' };
}

// Verify and parse a claimed inquiry. `fetchHeaders` returns the message's
// internetMessageHeaders (or throws); a failure leaves it UNVERIFIED.
async function verifyWebsiteInquiry(email, { fetchHeaders }) {
  const reasons = [];
  const subject = String(email.subject || '').trim();
  const sm = subject.match(SUBJECT_RE);
  if (!sm) reasons.push('subject_format');
  if (norm(email.sender_email) !== websiteSender()) reasons.push('sender_not_website');
  const parsed = parseBody(email.body_full || email.body_preview || '');
  reasons.push(...parsed.reasons);
  if (sm && parsed.purpose && norm(sm[1]) !== parsed.purpose) reasons.push('purpose_mismatch');
  let headers = null;
  try { headers = await fetchHeaders(); } catch (e) { reasons.push('header_lookup_failed'); }
  if (headers) {
    const dk = dkimVerdict(headers);
    if (!dk.pass) reasons.push(dk.reason);
    const rt = headerValue(headers, 'reply-to');
    if (rt && parsed.email) {
      const rtAddr = norm((rt.match(/<([^>]+)>/) || [])[1] || rt);
      if (rtAddr !== parsed.email) reasons.push('reply_to_mismatch');
    }
  } else if (!reasons.includes('header_lookup_failed')) reasons.push('headers_unavailable');

  const base = { claimed: true, purpose: parsed.purpose || (sm ? norm(sm[1]) : null), name: parsed.name, email: parsed.email, phone: parsed.phone, community: parsed.community };
  if (reasons.length) {
    return { ...base, verified: false, reasons: [...new Set(reasons)],
      warning: 'Claims to be a Bedrock website inquiry but could not be verified (possible forgery or a changed form). Not trusted: no automatic owner or draft. Review it by hand.' };
  }
  const a = assignOwner(parsed);
  return { ...base, verified: true, message: parsed.message, owner: a.owner, intent: a.intent, draft_classification: a.draft_classification, hint: a.hint || null, verified_by: 'dkim+format' };
}

// Production header fetch: one Graph read, only for messages that claim to be inquiries.
function graphHeaderFetcher(mailbox, graphId) {
  return async function fetchHeaders() {
    if (!graphId) throw new Error('no graph id');
    const token = await require('./graph_send').getToken();
    const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(graphId)}?$select=internetMessageHeaders`, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) throw new Error(`Graph headers failed (${r.status})`);
    const j = await r.json();
    if (!Array.isArray(j.internetMessageHeaders) || !j.internetMessageHeaders.length) throw new Error('no headers returned');
    return j.internetMessageHeaders;
  };
}

// The inquiry as stored on the row (no free-text message duplicated; the body is on the row).
const publicRecord = (w) => w && ({
  claimed: true, verified: !!w.verified, purpose: w.purpose || null, name: w.name || null, email: w.email || null, phone: w.phone || null, community: w.community || null,
  ...(w.verified ? { owner: w.owner, intent: w.intent, hint: w.hint || null, verified_by: w.verified_by } : { reasons: w.reasons, warning: w.warning }),
});

// A homeowner (or general) website inquiry that is really an architectural question goes to
// Annie as an ACC request, so the ACC rules apply (community requirements, form, no promises).
// The submitter stays the reply recipient. Scar: Karen Deaver (Lakes of Pine Forest, Oct 20)
// asked whether painting her front door black needs a form; the purpose "homeowner" sent it
// to Claire and the ACC classification was overwritten. (Ed 2026-10-20.)
function routeAccQuestion(w, aiClassification) {
  if (!w || !w.verified || aiClassification !== 'acc_request') return w;
  if (!['homeowner', 'other'].includes(w.purpose)) return w;
  if (w.owner === 'maggie') return w;   // a shopping-for-management inquiry stays with Maggie
  return { ...w, owner: 'annie', intent: 'homeowner_acc_question', draft_classification: 'acc_request', hint: 'Architectural question from the website: Annie answers from the community’s requirements.' };
}

const REPLY_SUBJECT = 'Re: Your message to Bedrock Association Management';

module.exports = { claimsWebsiteInquiry, verifyWebsiteInquiry, parseBody, dkimVerdict, assignOwner, routeAccQuestion, graphHeaderFetcher, publicRecord, PURPOSES, SUBJECT_RE, REPLY_SUBJECT };
