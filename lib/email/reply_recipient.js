// ============================================================================
// lib/email/reply_recipient.js  (Ed 2026-07-25)
// ----------------------------------------------------------------------------
// A website "contact form" emails every submission from a FIXED relay address
// (e.g. Eaglewood's form sends as "Eaglewood Community <mkessler@bedrocktx.com>")
// and puts the real person in the BODY:
//
//     Name: Bich Pham
//     Email: briantranpham@gmail.com
//     Phone: 8324367570
//     Message: ...
//
// Replying to the envelope From sends the answer to the relay, NOT the
// homeowner — which is exactly what happened: Claire's reply to Bich Pham went
// to mkessler@bedrocktx.com and she never got it. When the body carries a
// labeled email, we SUGGEST that as the reply recipient instead.
//
// Conservative by design: only a LABELED field ("Email:", "Reply-to:", "From:")
// triggers a suggestion, and only when it's a valid address that differs from
// the envelope sender. Otherwise we fall back to the sender as before. The
// operator always sees (and can edit) the suggested To before sending.
// ============================================================================

const EMAIL_RE = /[^\s<>@,;:"']+@[^\s<>@,;:"']+\.[A-Za-z]{2,}/;

function isValidEmail(s) {
  if (!s) return false;
  const m = String(s).trim().match(new RegExp('^' + EMAIL_RE.source + '$'));
  return !!m;
}

function normEmail(s) {
  return String(s || '').trim().replace(/^mailto:/i, '').replace(/[.,;>]+$/, '').toLowerCase();
}

// Pull the labeled contact fields a web form writes into the body. Returns
// { name, email, phone } with whatever it found (email is normalized/validated).
function extractFormContact(text) {
  const body = String(text || '');
  if (!body) return { name: null, email: null, phone: null };

  // Labeled email — "Email:", "E-mail:", "Email address:", "Reply-to:", "From:".
  // First labeled hit wins (forms put it near the top).
  let email = null;
  const labeled = body.match(/(?:^|\n)[ \t]*(?:e-?mail(?:\s*address)?|reply[\s-]?to|from|sender)[ \t]*[:：][ \t]*(.+)/i);
  if (labeled) {
    const cand = (labeled[1].match(EMAIL_RE) || [])[0];
    if (cand && isValidEmail(cand)) email = normEmail(cand);
  }

  let name = null;
  const nameM = body.match(/(?:^|\n)[ \t]*(?:name|full[ \t]*name|submitted[ \t]*by)[ \t]*[:：][ \t]*([^\n<]{1,80})/i);
  if (nameM) {
    const n = nameM[1].trim();
    // A "Name:" line that is actually an email (some forms mislabel) isn't a name.
    if (n && !EMAIL_RE.test(n)) name = n;
  }

  let phone = null;
  const phoneM = body.match(/(?:^|\n)[ \t]*(?:phone|tel(?:ephone)?|mobile|cell)[ \t]*[:：][ \t]*([0-9()\-.\s+]{7,20})/i);
  if (phoneM) phone = phoneM[1].trim();

  return { name, email, phone };
}

// Decide who a reply should actually go to.
//   { email, name, source: 'form_body' | 'sender' }
// 'form_body' means we found a real correspondent inside a relayed form; the UI
// flags it so the operator knows the reply is going to the person, not the site.
function suggestReplyTo({ senderEmail, senderName, bodyText } = {}) {
  const sender = normEmail(senderEmail);
  const form = extractFormContact(bodyText);
  if (form.email && form.email !== sender) {
    return { email: form.email, name: form.name || null, source: 'form_body' };
  }
  return { email: senderEmail || null, name: senderName || null, source: 'sender' };
}

module.exports = { extractFormContact, suggestReplyTo, isValidEmail, normEmail };
