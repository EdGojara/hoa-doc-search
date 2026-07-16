// ============================================================================
// lib/email/forward_hygiene.js  (Ed 2026-07-16)
// ----------------------------------------------------------------------------
// The two rules that keep an INTERNAL "forward to a teammate to check before we
// reply" forward from embarrassing us in front of the homeowner.
//
// A homeowner got Cc'd on one of these. The note discussed her ("forwarding this
// pool access follow-up from Azalia..."), the body said "nothing has been sent
// to the homeowner yet" — and she was on the Cc line reading all of it. The Cc
// field had defaulted to the ORIGINAL SENDER, who on a homeowner email IS the
// homeowner, and the server sent whatever it was handed.
//
// These are pure functions so the guard is TESTED, not inline logic that drifts.
// A privacy breach is exactly the class that must fail a build, not a code review.
// ============================================================================

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const parseList = (v) => String(v || '').split(/[,;]/).map((x) => x.trim()).filter((x) => EMAIL_RE.test(x));

/**
 * Who an internal review forward is allowed to reach: Bedrock staff only, never
 * the original sender, never an outside address.
 *
 * @returns {{ to:string[], cc:string[], dropped:string[] }}
 *   to/cc    — the internal addresses that survive, deduped
 *   dropped  — everything removed (external + the original sender), for the
 *              operator to see and for the audit note
 */
function internalRecipients({ toEmail, ccEmail, senderEmail }) {
  const senderLc = String(senderEmail || '').toLowerCase();
  const isInternal = (a) => /@bedrocktx\.com$/i.test(a) && a.toLowerCase() !== senderLc;
  const rawTo = parseList(toEmail);
  const rawCc = parseList(ccEmail);
  const to = [...new Set(rawTo.filter(isInternal))];
  const toSet = new Set(to.map((a) => a.toLowerCase()));
  const cc = [...new Set(rawCc.filter(isInternal))].filter((a) => !toSet.has(a.toLowerCase()));
  const dropped = [...new Set([...rawTo, ...rawCc].filter((a) => !isInternal(a)))];
  return { to, cc, dropped };
}

/**
 * Return the NEW message, dropping quoted history. A homeowner's email quotes the
 * entire prior chain inline ("On Wed, Jun 10 ... wrote: ... On Mon, Jun 8 ...")
 * which renders as one unreadable wall — and the forward attaches a clean thread
 * separately, so the inline quote is pure noise. Cut at the first quote marker.
 */
function stripQuoted(text) {
  const original = String(text || '');
  // Markers match ANYWHERE, not just at line start — Graph's htmlToText often
  // collapses the whole chain onto one line, so ^-anchored patterns never fire.
  // The Gmail marker requires a 4-digit YEAR between "On" and "wrote:", which is
  // the quote signature ("On Fri, Jun 12, 2026 at 11:56 AM ... wrote:") and
  // avoids false hits like "I turned it on. Later she wrote:".
  const markers = [
    // Gmail: "On <Weekday>, <Mon> <D>, <YYYY> at <time> <name> wrote:". Require
    // the WEEKDAY right after "On" so a stray "on" ("following up on my request")
    // can't anchor the cut; still require the year + "wrote:" to confirm.
    /\bOn\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s.{0,160}?\b(?:19|20)\d{2}\b.{0,80}?\b(?:wrote|schrieb):/is,
    /-{2,}\s*Original Message\s*-{2,}/i,             // Outlook original-message divider
    /\n_{5,}\s*\n/,                                  // Outlook underscore divider
    /\bFrom:\s.+?\bSent:\s.+?\bTo:\s/is,             // Outlook "From: ... Sent: ... To:" header block
    /\n\s*>{1,}/,                                     // plain-text quote carets (line-led)
    /\bSent from my (?:iPhone|iPad|Android|mobile|Samsung)/i,
    /\bGet Outlook for (?:iOS|Android)/i,
  ];
  let cut = original.length;
  for (const re of markers) { const mm = original.match(re); if (mm && mm.index < cut) cut = mm.index; }
  const trimmed = original.slice(0, cut).replace(/\s+$/g, '').trim();
  // If the whole thing was a quote (a bare forwarded chain with no new text),
  // keep the original rather than send a blank block.
  return trimmed || original.trim();
}

module.exports = { internalRecipients, stripQuoted, parseList };
