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
// ============================================================================

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
  const text = [email.subject, email.body_preview, email.body_full].filter(Boolean).join('  ').slice(0, 2000);
  if (!text.trim()) return false;
  if (!COMPLETION.test(text)) return false;
  if (NEEDS_ACTION.test(text)) return false;
  return true;
}

// The topic, from the subject with the reply/forward prefixes stripped.
function subjectTopic(subject) {
  return String(subject || '').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').replace(/\s*\[#?[^\]]*\]\s*$/, '').trim();
}

/**
 * A short, warm thank-you body (no signature — the send path appends the
 * persona's branded block). Templated on purpose: cheap, reliable, and a
 * thank-you doesn't need retrieval. Greets by first name, names the topic.
 */
function draftThankYouBody(email) {
  const first = String(email.sender_name || '').trim().split(/\s+/)[0] || 'there';
  const topic = subjectTopic(email.subject);
  const forPhrase = topic ? ` for getting ${topic} set up` : '';
  return `Hi ${first},\n\nThank you${forPhrase} — I really appreciate it. We're all set on our end, and I'll reach out if anything else comes up.`;
}

module.exports = { isCompletionAck, draftThankYouBody, subjectTopic, AUTOMATED, COMPLETION, NEEDS_ACTION };
