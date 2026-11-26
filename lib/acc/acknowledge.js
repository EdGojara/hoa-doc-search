// ============================================================================
// lib/acc/acknowledge.js  (Ed 2026-11-26)
// ----------------------------------------------------------------------------
// ANNIE ACKNOWLEDGES RECEIPT HERSELF. Ed: Annie takes ownership of incoming
// architectural applications, including ones a property manager forwards,
// acknowledges receipt and proceeds without waiting for him. Holidays and
// weekends may move review deadlines but never block intake or the receipt.
//
// Scar: 6331 Clear Canyon (Canyon Gate, CAN-ARC-2026-0005), received 11/26.
// Intake, filing and Annie's review all worked within three minutes, but the
// receipt was parked in the Draft Queue "until Ed releases it" (the 2026-07-22
// rule), and no one releases receipts: 52 of them sat there since July. The
// homeowner heard nothing.
//
// A receipt states a fact (we have it, its reference, the date received). It
// decides nothing, so the ACC transport guard in graph_send still checks it and
// refuses anything that reads as an approval or denial. It is sent only for a
// CURRENT case (never the held backlog, lib/acc/backlog_hold): Ed does not want
// homeowners suddenly hearing about months-old applications.
//
//   acknowledgeApplication(supabase, { decisionId, to, applicantName, communityName,
//     communityId, reference, address, receivedAt, additional, graph? })
//     -> { sent: true, to, message_id } | { skipped } | { error }
//   acknowledgmentText({...}) -> { subject, body }      (pure; tested)
//
// Kill switch: ACC_AUTO_ACKNOWLEDGE=off puts receipts back in the Draft Queue.
// ============================================================================

const { receivedDateLabel } = require('./received_date');

// Who a receipt (or the first message that serves as one) goes to: the applicant
// and the external correspondents on the case (a forwarding property manager),
// never our own staff.
const RCPT_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const isInternalAddr = (e) => /@(?:bedrocktx\.com|bedrocktxai\.com)$/i.test(String(e || '')) || /no-?reply|donotreply/i.test(String(e || ''));
function receiptRecipients(row = {}) {
  return [...new Set([row.submitter_email, ...(row.correspondent_emails || [])]
    .filter((e) => e && RCPT_EMAIL.test(String(e).trim()) && !isInternalAddr(e)).map((e) => String(e).trim().toLowerCase()))];
}

function autoAcknowledgeEnabled() {
  return !/^(0|false|off|no|disabled)$/i.test(String(process.env.ACC_AUTO_ACKNOWLEDGE || '').trim());
}

// longerReview: a plain-language reason the review needs more time (a committee or
// developer decision), so the homeowner is kept informed without a promised date.
function acknowledgmentText({ applicantName, reference, address, receivedAt, additional = false, longerReview = null }) {
  // A person's first name, or a neutral greeting for a company or unverified name
  // (lib/email/salutation; scar: "Hi Open," for an LLC, Ed 2026-11-26).
  const hi = require('../email/salutation').greeting(applicantName);
  const on = receivedDateLabel(receivedAt);
  const subject = additional
    ? `We received your additional documents${reference && reference !== 'your application' ? ' (' + reference + ')' : ''}`
    : `We received your architectural application${reference ? ' (' + reference + ')' : ''}`;
  const body = additional
    ? `${hi}\n\nThank you. We have received your additional documents${address ? ' for ' + address : ''} and added them to your application. It remains under review, and we will follow up with the decision.`
    : `${hi}\n\nWe have received your architectural review application${address ? ' for ' + address : ''}${on ? `, submitted on ${on}` : ''}, and it is now under review.${reference ? `\n\nYour reference number is ${reference}. Please keep it for your records.` : ''}\n\n${longerReview ? `Because this request ${longerReview}, the review may take a little longer than usual. We will keep you updated and follow up with the decision.` : 'We will review the request and follow up with the decision.'} If we need anything else to complete the review, we will reach out.`;
  return { subject, body };
}

async function acknowledgeApplication(supabase, args = {}) {
  const { decisionId, to, applicantName, communityName, communityId = null, reference, address, receivedAt = null, additional = false, longerReview = null } = args;
  const graph = args.graph || require('../email/graph_send');
  if (!autoAcknowledgeEnabled()) return { skipped: 'automatic receipts are turned off (ACC_AUTO_ACKNOWLEDGE=off)' };
  if (!decisionId) return { skipped: 'no application to acknowledge' };
  const recips = String(to || '').split(',').map((x) => x.trim()).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
  if (!recips.length) return { error: 'no valid applicant address to acknowledge' };

  const { data: dec, error } = await supabase.from('acc_decisions').select('id, status, created_at, acknowledged_at').eq('id', decisionId).maybeSingle();
  if (error) return { error: `the application could not be read (${error.message})` };
  if (!dec) return { error: 'application not found' };
  if (require('./backlog_hold').isBacklogHeld(dec)) return { skipped: 'backlog hold: no correspondence on historical applications without Ed' };
  if (!['pending_review', 'awaiting_info'].includes(dec.status)) return { skipped: `application is ${dec.status}` };
  if (!additional && dec.acknowledged_at) return { skipped: 'already acknowledged' };
  if (!graph.isConfigured()) return { error: 'email is not connected' };

  const { subject, body } = acknowledgmentText({ applicantName, reference, address, receivedAt, additional, longerReview });
  const built = require('../email/annie_signature').buildAnnieEmail(body, communityName);
  let sent;
  try {
    sent = await graph.sendAs({ from: graph.ANNIE_MAILBOX, to: recips.join(', '), subject, html: built.html, attachments: built.attachments || [], communityId, accDecisionId: decisionId });
  } catch (e) { return { error: e.userMessage || e.message }; }
  if (sent && sent.suppressed) return { error: `the outbound guard held it (${sent.reason || 'no reason given'})` };

  const now = new Date().toISOString();
  // The sent receipt on Annie's board and the homeowner's timeline.
  {
    const { error: lErr } = await supabase.from('email_messages').insert({
      mailbox: graph.ANNIE_MAILBOX, direction: 'outbound', sender_email: graph.ANNIE_MAILBOX,
      sender_name: 'Annie Reeves (Bedrock AI)', recipients: recips, subject,
      body_preview: body.slice(0, 400), classification: 'outbound_reply', classification_confidence: 'high',
      persona: 'annie', ai_summary: `Annie acknowledged the architectural application${address ? ' for ' + address : ''}${reference ? ' (' + reference + ')' : ''}`,
      community_id: communityId, triage_status: 'handled', record_ownership: 'association_record',
      reviewed_at: now, received_at: now, internet_message_id: (sent && sent.internetMessageId) || null,
    });
    if (lErr) console.warn(`[acc-ack] receipt sent but not logged for ${reference || decisionId}: ${lErr.message}`);
  }
  if (!additional) {
    const { error: sErr } = await supabase.from('acc_decisions').update({ acknowledged_at: now, acknowledged_to: recips.join(', '), acknowledgment_error: null }).eq('id', decisionId);
    if (sErr) console.error(`[acc-ack] receipt sent but not stamped on ${reference || decisionId}: ${sErr.message}`);
  }
  // Any receipt still waiting in the Draft Queue for this case is superseded.
  {
    const { error: dErr } = await supabase.from('outbound_email_drafts').update({ status: 'discarded', send_error: 'superseded: Annie sent the receipt herself' })
      .eq('related_type', 'acc_decision').eq('related_id', String(decisionId)).eq('draft_kind', 'acknowledgment').eq('status', 'draft');
    if (dErr && !/does not exist|schema cache/i.test(dErr.message || '')) console.warn(`[acc-ack] old receipt drafts not cleared for ${decisionId}: ${dErr.message}`);
  }
  console.log(`[acc-ack] Annie acknowledged ${reference || decisionId}`);
  return { sent: true, to: recips, message_id: (sent && sent.internetMessageId) || null };
}

module.exports = { acknowledgeApplication, acknowledgmentText, autoAcknowledgeEnabled, receiptRecipients };
