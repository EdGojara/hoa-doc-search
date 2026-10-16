// ============================================================================
// lib/email/completion_thanks.js  (Ed 2026-09-11)
// ----------------------------------------------------------------------------
// "Should we thank her once she says it's complete?" — yes, selectively. When a
// REAL person sends a genuine completion/confirmation ("you're all set", "good
// to go", "it's set up"), the AI team drafts a brief thank-you queued for
// review — it does NOT auto-fire, and it does NOT fire on system/bot
// notifications or on messages that are actually asking us to do something.
//
// This is a discernment gate, kept deterministic on purpose: a false thank-you
// is low-harm but looks robotic, so the bar is "clearly a human wrapping
// something up," nothing looser.
// ----------------------------------------------------------------------------
// 2026-10-16 (Kevin Thoms, Canyon Gate camera thread): the detector matched
// "completed" inside the QUOTED copy of Amanda's own reply ("I completed my
// review") while Kevin's new words disagreed with her recommendation, and the
// template thanked him "for getting Camera Proposals set up" as "Hi Treasurer".
// Now: only the sender's NEW text counts (quoted history cut off), any concern,
// disagreement or condition vetoes, the subject is never turned into a thing
// they "set up", and a role label is never a name.
// ============================================================================

const { latestMessageText, substantiveSignals, senderFirstName } = require('../amanda/reply_focus');

// Machine senders — never thank a notification bot (e.g. NewFirst's
// treasurymanagement@ "Positive Pay Items Ready For Review").
const AUTOMATED = /(no-?reply|do-?not-?reply|donotreply|notification|notifications|mailer|treasury\s*management|treasurymanagement|automated|alerts?@|postmaster|@.*amazonses)/i;

// A genuine "it's done / you're set" completion signal.
const COMPLETION = /\b(all set|you'?re (all )?set|we'?re (all )?set|good to go|is (now )?(live|active|set up|ready|complete)|(has|have) been (set up|added|completed|activated|processed|enabled|approved)|added you|got you (added|set up)|taken care of|completed|is complete|up and running|ready to go|all done|finalized)\b/i;

// Signals the message is actually a REQUEST / open item needing our action — a
// terminal ack never carries these, so any of them vetoes the thank-you.
const NEEDS_ACTION = /\b(please (send|provide|complete|fill|sign|confirm|review|advise|call|reply|remit|forward)|can you|could you|could i|would you (please|mind)|need (you|your|us) to|send (me|us|over)|attach(ed)? (the|a|your)|fill out|sign the|approve the|any update|status of|past due|remit(tance)?|outstanding balance)\b/i;

/**
 * True when `email` is a genuine completion confirmation from a real person that
 * warrants a brief thank-you. Conservative: unsure -> false.
 */
function isCompletionAck(email) {
  if (!email) return false;
  if (email.direction && email.direction !== 'inbound') return false;
  const from = String(email.sender_email || '');
  if (!from || AUTOMATED.test(from)) return false;
  // The sender's NEW words only. The subject and the quoted history are not what
  // they said now ("Re: Camera Proposals" quoting "I completed my review").
  const text = latestMessageText(email.body_full || email.body || email.body_preview || '').slice(0, 2000);
  if (!text.trim()) return false;
  if (!COMPLETION.test(text)) return false;
  if (NEEDS_ACTION.test(text)) return false;
  // A concern, disagreement or condition is never a wrap-up, whatever else it says.
  const sig = substantiveSignals(text);
  if (sig.kinds.includes('disagreement') || sig.kinds.includes('condition')) return false;
  return true;
}

// The topic, from the subject with the reply/forward prefixes stripped.
function subjectTopic(subject) {
  return String(subject || '').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').replace(/\s*\[#?[^\]]*\]\s*$/, '').trim();
}

/**
 * A short, warm thank-you body (no signature — the send path appends the
 * persona's branded block). Templated on purpose: cheap, reliable, and a
 * thank-you doesn't need retrieval. Greets by first name, never a role label
 * ("Treasurer HOA"); no name known -> "Hello,". The subject is a topic, not a
 * task they completed, so it is never turned into "for getting <subject> set up".
 */
function draftThankYouBody(email) {
  const first = senderFirstName(email);
  return `${first ? `Hi ${first},` : 'Hello,'}\n\nThank you for taking care of this, I really appreciate it. I'll reach out if anything else comes up.`;
}

module.exports = { isCompletionAck, draftThankYouBody, subjectTopic, AUTOMATED, COMPLETION, NEEDS_ACTION };
