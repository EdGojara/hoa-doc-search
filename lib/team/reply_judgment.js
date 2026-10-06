// ============================================================================
// lib/team/reply_judgment.js  (Ed 2026-10-06) — attachment-first, proportionate replies
// ----------------------------------------------------------------------------
// Two rules for any teammate drafting a reply, plus a deterministic check for the
// one failure a prompt alone has not prevented.
//
// Scar (Canyon Gate, 10/06): the board president wrote "I ordered a new road sign
// for the neighborhood. I have attached the receipt." with the receipt PDF
// attached. Amanda's draft said "I do not have visibility in your message to the
// actual receipt amount or vendor name", asked him for the dollar amount, quoted
// the association's operating cash, and laid out three governance options
// (ratify at the next meeting, written consent, agenda item) for what is a routine
// sign purchase. Two separate failures:
//   1. Her drafter never fetched the attachment, so the facts were not in front of
//      her, and she then claimed they were unavailable.
//   2. The board prompt told her to give every board member "2 to 3 options and a
//      recommendation", so an ordinary receipt became an authorization memo.
//
// The rules below go into the prompt. checkReply() catches the unavailable-claim
// deterministically (it is always wrong when an attachment was read) and flags
// governance framing for the reviewer.
// ============================================================================

const ATTACHMENT_RULE = `ATTACHMENTS COME FIRST. Read every attachment before you write anything.
- Pull the material facts out of it: for a receipt or invoice, the amount, the vendor and what was ordered, the date, and the apparent purpose; for a document, what it actually says.
- Use those facts in the reply ("the $X receipt from Vendor for the new road sign").
- Never say information is unavailable, unclear or missing, and never ask the sender to provide or resend it, when it is visible in an attachment. Only ask for something that genuinely is not there.
- If an attachment could not be read, say you received it by name and will review it; do not ask them to resend it.`;

const PROPORTIONALITY_RULE = `PROPORTIONALITY. Match the weight of the reply to the weight of the matter.
- A small, routine operational item (a receipt for a normal community purchase, a minor repair, a routine supply or service): acknowledge it, use the facts, say what happens next (for a receipt: it goes to accounting to be processed), and stop. Two to four sentences. No options, no ratification or authorization discussion, no budget or cash figures, no governance framing. Money being involved does not by itself make it a board-governance matter.
- An unusual, material, unbudgeted, legally sensitive, or authority-sensitive item (a large or unexpected spend, a contract or commitment, something that looks outside normal authority, a legal or insurance exposure, a conflict of interest): slow down, name the specific concern plainly, and say what is needed and from whom. Options and a recommendation belong here, and only here.
- Decide which it is from the facts (including the attachment), not from who sent it. A board member sending a routine receipt still gets the short, routine reply.`;

// Claims that information is not available / asks for it to be sent. Always wrong
// when an attachment was read and contains it; the drafter retries once.
const UNAVAILABLE_RE = /\b(?:do(?:es)? not|don['’]t|cannot|can['’]t|unable to|no)\s+(?:have\s+)?(?:visibility|see|view|access|find|locate|confirm)\b[^.\n]{0,80}\b(?:amount|vendor|receipt|total|invoice|price|cost|attachment|attached)\b|\b(?:please|could you|can you|if you can)\s+(?:confirm|provide|send|share|resend|re-send|let me know)\b[^.\n]{0,40}\b(?:the\s+)?(?:dollar\s+)?(?:amount|total|receipt|invoice|vendor|cost)\b/i;

// Governance framing that does not belong on a routine item. Flagged for the
// reviewer, not auto-rewritten: on a genuinely material item it may be right.
const GOVERNANCE_RE = /\b(?:your options|options as i see them|ratif(?:y|ication)|written consent|agenda item for a vote|board authorization|out[- ]of[- ]budget|spending authority|operating cash|cash on hand)\b/i;

/**
 * Check a drafted reply. Pure.
 * @returns {{ claims_unavailable: boolean, governance_framing: boolean, issues: string[] }}
 */
function checkReply(body, { attachmentsRead = false } = {}) {
  const text = String(body || '');
  const claims_unavailable = !!attachmentsRead && UNAVAILABLE_RE.test(text);
  const governance_framing = GOVERNANCE_RE.test(text);
  const issues = [];
  if (claims_unavailable) issues.push('says information is unavailable although an attachment was read');
  if (governance_framing) issues.push('governance/authorization framing: confirm the matter is material, not routine');
  return { claims_unavailable, governance_framing, issues };
}

const RETRY_NOTE = 'CORRECTION: your previous draft said information was unavailable or asked the sender to provide it, but the attachment above is readable and contains it. Read the attachment, use its facts, and do not ask for anything that is in it. Apply the proportionality rule.';

module.exports = { ATTACHMENT_RULE, PROPORTIONALITY_RULE, checkReply, RETRY_NOTE, UNAVAILABLE_RE, GOVERNANCE_RE };
