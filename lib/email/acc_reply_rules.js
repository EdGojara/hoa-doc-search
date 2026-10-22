'use strict';
// ============================================================================
// lib/email/acc_reply_rules.js — what an ACC (architectural) reply may say (PURE)
// ----------------------------------------------------------------------------
// Ed 2026-10-20, ACC stabilization Phase 1. Real drafts this fixes:
//   - Brian Decker (Waterview, driveway application): Annie told him about a
//     landscaping notice, two certified-stage cases and a $70 balance. ACC
//     correspondence is about the project; unrelated violations, balances and
//     collections stay out unless the homeowner raised them.
//   - Stevie Gonzalez (Still Creek, backup battery): "the governing documents
//     require ARC applications to be submitted at least 30 days before work
//     begins". The documents say the ARC responds within 30 days AFTER receipt
//     (deemed disapproved), and no work before approval: a different rule.
//     A stated day count / lead time must be in the community's documents (with
//     the same before/after sense) or in the homeowner's own message, or it is
//     removed.
//   - "I've attached the form" with no form attached.
// Used by lib/email/draft_reply.js. Tested in tests/test_acc_reply_rules.js.
// ============================================================================

// Is this an ACC reply? (The classification, or Annie writing.)
function isAccScope({ classification, persona } = {}) {
  return classification === 'acc_request' || String(persona || '').toLowerCase() === 'annie';
}

// Did the homeowner themselves bring up a violation / notice? Then it is relevant.
const VIOLATION_TOPIC = /\b(violations?|notices?|letters?|cure|certified|deed restrictions?|warnings?|fines?|citations?|courtesy)\b/i;
function homeownerRaisedViolation(inboundText) { return VIOLATION_TOPIC.test(String(inboundText || '')); }
const ACCOUNT_TOPIC = /\b(balance|past[- ]due|owe[sd]?|owing|delinquen\w*|collections?|payment plan|late fees?|assessments? due)\b/i;
function homeownerRaisedAccount(inboundText) { return ACCOUNT_TOPIC.test(String(inboundText || '')); }

// Sentences, keeping their trailing punctuation and spacing so removal is clean.
function sentences(text) {
  const out = []; const re = /[^.!?\n]+(?:[.!?]+["')\]]*|\n|$)/g; let m;
  const s = String(text || '');
  while ((m = re.exec(s)) !== null) { if (m[0].trim()) out.push(m[0]); if (m.index === re.lastIndex) re.lastIndex++; }
  return out;
}
function removeSentences(text, drop) {
  let t = String(text || '');
  for (const s of drop) t = t.replace(s, '');
  return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '');
}

// Account matters in a draft sentence: violations / enforcement, balances, money owed.
const ENFORCEMENT_IN_DRAFT = /\b(open (?:items|cases?|violations?)|violations?|certified[- ]stage|courtesy (?:notice|letter)|cure (?:period|date|by)|enforcement|overgrowth notice|deed restriction (?:case|notice))\b|\b(?:open|certified)\b[^.]{0,25}\bcases?\b|\bcases? on file\b/i;
// "your ACC case" / "the committee" is the project itself, not enforcement.
const ACC_CASE = /\b(acc|arc|architectural|application|committee)\b/i;
const ENFORCEMENT_WORD = /\b(violations?|certified|notice|cure|enforcement)\b/i;
const MONEY_IN_DRAFT = /\$\s?\d|\b(balance|past[- ]due|owe[sd]?|owing|delinquen\w*|collections?)\b/i;
// Remove sentences about unrelated account matters (keep them when the homeowner raised the topic).
function stripUnrelatedAccountMatters(body, inboundText) {
  const keepViolations = homeownerRaisedViolation(inboundText);
  const keepAccount = homeownerRaisedAccount(inboundText);
  // The matched phrase itself decides: "open sod case" is enforcement, "your open ACC case" is the project.
  const isEnforcement = (s) => { const m = s.match(ENFORCEMENT_IN_DRAFT); return !!m && (ENFORCEMENT_WORD.test(m[0]) || !ACC_CASE.test(m[0])); };
  const removed = sentences(body).filter((s) => (!keepViolations && isEnforcement(s)) || (!keepAccount && MONEY_IN_DRAFT.test(s) && /\b(account|balance|owe|due|collections?|past[- ]due|delinquen)/i.test(s)));
  return { body: removed.length ? removeSentences(body, removed) : body, removed: removed.map((s) => s.trim()) };
}

// ---- day counts / lead times ----
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fourteen: 14, fifteen: 15, twenty: 20, 'twenty-one': 21, thirty: 30, 'thirty-one': 31, forty: 40, 'forty-five': 45, fifty: 50, sixty: 60, ninety: 90 };
const NUM = '(\\d{1,3}|' + Object.keys(WORDS).sort((a, b) => b.length - a.length).join('|') + ')';
// "30 days", "thirty (30) days", "forty-five (45) calendar days", "10 business days"
const DAYS_RE = new RegExp(`\\b${NUM}(?:\\s*\\(\\s*\\d{1,3}\\s*\\))?\\s*(?:calendar\\s+|business\\s+|working\\s+)?days?\\b`, 'gi');
const toNum = (s) => (/^\d+$/.test(s) ? Number(s) : WORDS[String(s).toLowerCase()] || null);
// The direction a day count is measured in: BEFORE an event (lead time) vs AFTER / WITHIN (a response window).
const BEFORE = /\b(before|prior to|in advance|ahead of|advance notice)\b/i;
const AFTER = /\b(after|from|following|of receipt|upon receipt|within|of (?:the )?(?:date|submission|receipt))\b/i;
function relationOf(window) { if (BEFORE.test(window)) return 'before'; if (AFTER.test(window)) return 'after'; return null; }
function dayMentions(text) {
  const s = String(text || ''); const out = []; let m;
  DAYS_RE.lastIndex = 0;
  while ((m = DAYS_RE.exec(s)) !== null) {
    const n = toNum(m[1]); if (!n) continue;
    const window = s.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60);
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 60);
    out.push({ n, raw: m[0], relation: relationOf(after) || relationOf(window), index: m.index });
  }
  return out;
}
// Day-count claims in the draft that are NOT supported: the homeowner's own message has the same
// number of days, or the documents state the same number of days in the same direction.
function unsupportedDayClaims(body, { docs = '', inbound = '' } = {}) {
  const fromHomeowner = new Set(dayMentions(inbound).map((d) => d.n));
  const inDocs = dayMentions(docs);
  const bad = [];
  for (const s of sentences(body)) {
    for (const c of dayMentions(s)) {
      if (fromHomeowner.has(c.n)) continue;
      const match = inDocs.filter((d) => d.n === c.n);
      const ok = match.length && (!c.relation || match.some((d) => !d.relation || d.relation === c.relation));
      if (!ok) { bad.push({ sentence: s.trim(), claim: c.raw, n: c.n, relation: c.relation, inDocs: match.length > 0 }); }
    }
  }
  return bad;
}
function removeUnsupportedDayClaims(body, ctx) {
  const bad = unsupportedDayClaims(body, ctx);
  if (!bad.length) return { body, removed: [] };
  const drop = [...new Set(bad.map((b) => b.sentence))];
  const raw = sentences(body).filter((s) => drop.includes(s.trim()));
  return { body: removeSentences(body, raw), removed: bad };
}

// Did they SEND an application (so a blank form must not be offered back)? Brian Decker
// ("attached is the architectural review application form"), Luis Salazar ("Here is the
// application"), Stevie Gonzalez's second email ("Still Creek ACC Form, completed and signed")
// -> yes. Stevie's first email ("let me know ... if there's a form") and Karen Deaver's
// question -> no.
const SUBMITTED_TEXT = /\b(attached|attaching|here is|here's|enclosed|sending|submitting|i've included|please find)\b[^.\n]{0,80}\b(application|acc form|arc form|form)\b|\b(completed|signed|filled[- ]out|filled in)\b[^.\n]{0,40}\b(application|form)\b|\b(application|form)\b[^.\n]{0,30}\b(completed|signed|attached)\b/i;
const SUBMITTED_FILE = /(application|\bacc\b|\barc\b|\bform\b|survey|plat|site[ _-]?plan|schematic|drawing)/i;
function looksLikeSubmittedApplication({ bodyText = '', attachmentNames = [], hasAttachments = false } = {}) {
  if (!hasAttachments && !(attachmentNames && attachmentNames.length)) return false;
  return SUBMITTED_TEXT.test(String(bodyText)) || (attachmentNames || []).some((n) => SUBMITTED_FILE.test(String(n)));
}

// "I've attached the form" / "Attached is the application" said by US (not "the form you attached").
const WE_ATTACHED = /\b(?:i(?:'ve| have)?|we(?:'ve| have)?)\s+(?:also\s+)?(?:attached|included|enclosed)\b|\b(?:is|are)\s+attached\b(?![^.]*\byou\b)|\battached\s+(?:is|are|you'?ll find|here)\b|\b(?:i'm|i am|we're|we are)\s+attaching\b/i;
function claimsWeAttached(body) { return WE_ATTACHED.test(String(body || '')); }

module.exports = { looksLikeSubmittedApplication, isAccScope, homeownerRaisedViolation, homeownerRaisedAccount, stripUnrelatedAccountMatters, dayMentions, unsupportedDayClaims, removeUnsupportedDayClaims, claimsWeAttached, sentences };
