// ============================================================================
// lib/email/reply_recipient.js  (Ed 2026-07-25; rebuilt 2026-10-14)
// ----------------------------------------------------------------------------
// WHO A REPLY GOES TO. One resolver for every agent's Reply and Reply All.
//
//   1. A WEBSITE CONTACT FORM relays every submission from a fixed address
//      (Eaglewood's form sends as mkessler@bedrocktx.com) with the real person in
//      the BODY ("Name: / Email: / Phone: / Message:"). Only then is the body's
//      labeled email the reply target (the Bich Pham scar, 2026-07-25).
//   2. A legitimate Reply-To header (same organization as the sender, or a relay
//      sender) is honored.
//   3. Otherwise the actual sender.
//   Never: our own mailbox as the default for an external sender, or the mailbox
//   the reply is sent from.
//
// Scar (2026-10-14): Melody Hess (NewFirst) replied to Kat; Reply was addressed to
// kat@bedrocktx.com with a "came through a website contact form" warning. Every
// normal reply quotes its history, and a quoted header line ("From: Katherine
// "Kat" Reed <kat@bedrocktx.com>") matched the old detector's "From:" label, so
// ANY reply in ANY thread could be mistaken for a form and answered to ourselves.
// Now a form is recognized only when BOTH hold: the sender is a relay (our own
// domain, or a no-reply / website / form address) AND the text ABOVE any quoted
// history is a labeled form block (an Email field plus a Name, Phone or Message
// field). "From:" / "Sender:" are reply-header lines, never form fields.
// ============================================================================

const EMAIL_RE = /[^\s<>@,;:"']+@[^\s<>@,;:"']+\.[A-Za-z]{2,}/;
const OWN_DOMAINS = (process.env.OWN_EMAIL_DOMAINS || 'bedrocktx.com,bedrocktxai.com').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const RELAY_LOCAL = /^(no-?reply|do-?not-?reply|donotreply|wordpress|forms?|webforms?|website|webmaster|contact|notifications?|mailer|postmaster)([._+-].*)?$/i;

function isValidEmail(s) {
  if (!s) return false;
  return !!String(s).trim().match(new RegExp('^' + EMAIL_RE.source + '$'));
}
function normEmail(s) {
  return String(s || '').trim().replace(/^mailto:/i, '').replace(/[.,;>]+$/, '').toLowerCase();
}
const domainOf = (e) => normEmail(e).split('@')[1] || '';
const isOwn = (e) => OWN_DOMAINS.includes(domainOf(e));
// the registrable part ("mail.newfirst.com" -> "newfirst.com") for same-organization checks
const orgOf = (e) => domainOf(e).split('.').slice(-2).join('.');

// The text the sender actually wrote: everything above the first quoted-history marker.
function ownText(text) {
  const t = String(text || '');
  const cut = t.search(/(^|\n)[ \t>]*(-{2,}\s*Original Message\s*-{2,}|From:[^\n]*\n[ \t>]*(Sent|Date):|On [^\n]{4,120} wrote:|_{6,})/i);
  return cut > 0 ? t.slice(0, cut) : t;
}

// A relay that sends on someone else's behalf: our own domain, or an automated web/form sender.
const isRelaySender = (senderEmail) => isOwn(senderEmail) || RELAY_LOCAL.test(normEmail(senderEmail).split('@')[0] || '');

// Labeled contact fields of a web form (read only from the sender's own text, never the quote).
// "From:" and "Sender:" are email-header lines, not form fields, and are not read.
function extractFormContact(text) {
  const body = ownText(text);
  if (!body) return { name: null, email: null, phone: null, fields: 0 };
  let email = null;
  const labeled = body.match(/(?:^|\n)[ \t]*(?:e-?mail(?:\s*address)?|reply[\s-]?to)[ \t]*[:：][ \t]*(.+)/i);
  if (labeled) { const cand = (labeled[1].match(EMAIL_RE) || [])[0]; if (cand && isValidEmail(cand)) email = normEmail(cand); }
  let name = null;
  const nameM = body.match(/(?:^|\n)[ \t]*(?:name|full[ \t]*name|submitted[ \t]*by)[ \t]*[:：][ \t]*([^\n<]{1,80})/i);
  if (nameM) { const n = nameM[1].trim(); if (n && !EMAIL_RE.test(n)) name = n; }
  let phone = null;
  const phoneM = body.match(/(?:^|\n)[ \t]*(?:phone|tel(?:ephone)?|mobile|cell)[ \t]*[:：][ \t]*([0-9()\-.\s+]{7,20})/i);
  if (phoneM) phone = phoneM[1].trim();
  const message = /(?:^|\n)[ \t]*(?:message|comments?|inquiry|details)[ \t]*[:：]/i.test(body);
  return { name, email, phone, fields: [email, name, phone, message].filter(Boolean).length };
}

// A real contact-form relay: a relay sender AND a labeled form block with an email and another field.
function isContactForm({ senderEmail, bodyText }) {
  if (!isRelaySender(senderEmail)) return false;
  const f = extractFormContact(bodyText);
  return !!f.email && f.fields >= 2 && f.email !== normEmail(senderEmail);
}

/**
 * Who a reply goes to.
 * @param {object} p { senderEmail, senderName, bodyText, replyTo: [addresses] (from the message headers),
 *                    mailbox: the mailbox the message is in / the reply is sent from }
 * @returns {{ email, name, source: 'form_body'|'reply_to'|'sender'|'none', warnings: [string] }}
 */
function suggestReplyTo({ senderEmail, senderName, bodyText, replyTo = [], mailbox = null } = {}) {
  const sender = normEmail(senderEmail); const self = normEmail(mailbox); const warnings = [];
  const ok = (e) => isValidEmail(e) && normEmail(e) !== self && !(isOwn(e) && !isOwn(sender));
  if (isContactForm({ senderEmail, bodyText })) {
    const f = extractFormContact(bodyText);
    if (ok(f.email)) return { email: f.email, name: f.name || null, source: 'form_body', warnings };
  }
  const rt = (replyTo || []).map(normEmail).find((e) => isValidEmail(e) && e !== sender);
  if (rt) {
    if (ok(rt) && (orgOf(rt) === orgOf(sender) || isRelaySender(sender))) return { email: rt, name: null, source: 'reply_to', warnings };
    warnings.push(`The message asks for replies to go to ${rt}, a different organization from the sender (${sender}). Replying to the sender instead; change it only if you have confirmed that address.`);
  }
  if (sender && sender !== self) return { email: senderEmail, name: senderName || null, source: 'sender', warnings };
  warnings.push('The sender is the mailbox this reply would come from; choose the recipient.');
  return { email: null, name: null, source: 'none', warnings };
}

// Reply All: everyone else on the message (To + Cc), never ourselves, our AI/system mailboxes,
// the primary recipient again, or duplicates.
function replyAllCc({ primary, senderEmail, to = [], cc = [], mailbox = null, exclude = [] } = {}) {
  const skip = new Set([normEmail(primary), normEmail(mailbox), ...exclude.map(normEmail)].filter(Boolean));
  const out = []; const seen = new Set();
  for (const e of [senderEmail, ...to, ...cc]) {
    const n = normEmail(e);
    if (!isValidEmail(n) || skip.has(n) || seen.has(n)) continue;
    seen.add(n); out.push(n);
  }
  return out;
}

module.exports = { extractFormContact, isContactForm, isRelaySender, suggestReplyTo, replyAllCc, ownText, isValidEmail, normEmail, OWN_DOMAINS };
