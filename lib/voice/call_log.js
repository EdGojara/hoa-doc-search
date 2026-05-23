// ============================================================================
// lib/voice/call_log.js — post-call processing
// ----------------------------------------------------------------------------
// Runs asynchronously after a Claire call ends. Two jobs:
//   1. Stage-1 brief extraction — read the full transcript via Claude,
//      produce structured JSON (concern, answer_or_status, next_step,
//      owner, category, escalate, compliance_flag) per the
//      responder-engine.spec.md schema. Persist to homeowner_calls.brief.
//   2. Take-a-message detection — if the caller asked for a specific
//      person who wasn't available (Ed, the owner, a named manager) AND
//      Claire took a message, extract the structured message and email
//      the target person via Resend.
//
// Why post-call (not mid-call): keeping the live conversation latency
// under 1.5s/turn precludes synchronous Claude calls on the hot path.
// Brief extraction + email routing run on a fire-and-forget basis after
// the caller hangs up. The caller's experience isn't affected.
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const { sendEmail, isConfigured: isEmailConfigured } = require('../notifications/email');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Where take-a-message emails route. For v1, defaults to Ed's address;
// future iterations can resolve target email from contacts (e.g., if the
// caller asked for Martha Bravo, route to mbravo@bedrocktx.com).
const OWNER_EMAIL = process.env.BEDROCK_OWNER_EMAIL || 'egojara@bedrocktx.com';
const OWNER_NAME = 'Ed Gojara';

/**
 * Run post-call processing on a finished Claire call.
 *
 * @param {object} opts
 * @param {object} opts.callContext — the bridge's callContext object
 * @param {Array} opts.history — full conversation as [{role, content}]
 * @param {string} opts.endReason — why the call ended
 * @param {object} [opts.logger]
 */
async function processCallEnd({ callContext, history, endReason, logger = console }) {
  if (!history || history.length === 0) {
    logger.log(`[call_log ${callContext.call_sid}] no history, skipping post-call`);
    return;
  }

  const transcript = formatTranscript(history);

  // Run brief extraction + message detection in parallel
  const [brief, messageInfo] = await Promise.all([
    extractStage1Brief(transcript, callContext).catch((e) => {
      logger.warn(`[call_log ${callContext.call_sid}] brief extraction failed: ${e.message}`);
      return null;
    }),
    extractTakeAMessage(transcript, callContext).catch((e) => {
      logger.warn(`[call_log ${callContext.call_sid}] message extraction failed: ${e.message}`);
      return null;
    }),
  ]);

  // Persist brief + transcript to homeowner_calls
  try {
    const patch = {
      status: 'completed',
      ended_at: new Date().toISOString(),
      full_transcript: transcript,
      turn_count: history.filter((h) => h.role === 'user').length,
    };
    if (brief) {
      patch.brief = brief;
      patch.brief_extracted_at = new Date().toISOString();
      if (brief.compliance_flag) {
        patch.compliance_flag = true;
        patch.compliance_reason = brief.concern;
      }
    }
    await supabase
      .from('homeowner_calls')
      .update(patch)
      .eq('call_sid', callContext.call_sid);
    logger.log(`[call_log ${callContext.call_sid}] brief persisted; compliance=${brief?.compliance_flag ? 'yes' : 'no'}`);
  } catch (err) {
    logger.warn(`[call_log ${callContext.call_sid}] persist failed: ${err.message}`);
  }

  // Fire the take-a-message email if Claire took one
  if (messageInfo?.is_message_for_owner) {
    try {
      await sendOwnerMessageEmail({ messageInfo, callContext, transcript, logger });
      logger.log(`[call_log ${callContext.call_sid}] message email sent to ${OWNER_EMAIL}`);
    } catch (err) {
      logger.warn(`[call_log ${callContext.call_sid}] message email failed: ${err.message}`);
    }
  }
}

// ----------------------------------------------------------------------------
// Transcript formatting — for downstream Claude calls + email body
// ----------------------------------------------------------------------------
function formatTranscript(history) {
  return history
    .map((turn) => {
      const speaker = turn.role === 'assistant' ? 'Claire' : 'Caller';
      return `${speaker}: ${turn.content}`;
    })
    .join('\n\n');
}

// ----------------------------------------------------------------------------
// Stage-1 brief extraction — same schema as responder-engine.spec.md §3
// ----------------------------------------------------------------------------
async function extractStage1Brief(transcript, callContext) {
  const callerLine = callContext.caller
    ? `Caller: ${callContext.caller.full_name || '(unknown)'} at ${callContext.caller.property_address || '(unknown address)'}`
    : 'Caller: unknown (no caller-ID match)';
  const communityLine = callContext.community?.name
    ? `Community: ${callContext.community.name}`
    : 'Community: unknown';

  const prompt = `You're reading a transcript of a phone call between a Bedrock Association Management AI assistant (Claire) and a homeowner. Extract a structured brief.

${callerLine}
${communityLine}

TRANSCRIPT:
${transcript}

Return ONLY a JSON object matching this schema (no markdown fences, no commentary):
{
  "concern": "string — what they really called about, in plain terms",
  "answer_or_status": "string — what Claire told them or current status",
  "next_step": "string — concrete next action",
  "owner": "string — who's doing it (us / homeowner / board / vendor)",
  "specific_detail": "string — one concrete detail from THEIR words to react to",
  "channel": "voice",
  "category": "violation_question | billing_dispute | vendor_request | maintenance_request | governance_question | complaint_about_neighbor | general | message_for_staff | other",
  "escalate": false,
  "escalate_reason": "string only if escalate=true",
  "compliance_flag": false
}

Set compliance_flag=true if the call touches: violations, fines, enforcement, ACC decisions, fee waivers, collections, or §209 deadlines.
Set escalate=true if the call involves: legal threats, distress, fair-housing, money disputes, or anything Claire couldn't answer truthfully.`;

  const resp = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001', // cheap + fast; brief extraction is structured
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = (resp.content[0]?.text || '').trim();
  // Strip ``` fences if Claude wrapped it
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    console.warn('[call_log] brief JSON parse failed:', err.message, 'raw:', cleaned.slice(0, 200));
    return null;
  }
}

// ----------------------------------------------------------------------------
// Take-a-message detection — did Claire take a message for Ed / a manager?
// ----------------------------------------------------------------------------
async function extractTakeAMessage(transcript, callContext) {
  const prompt = `You're reading a transcript of a phone call. Determine if the caller was trying to reach a SPECIFIC PERSON (Ed Gojara, the owner, a named manager) who wasn't available, AND if Claire (the AI assistant) took a message on that person's behalf.

If yes, extract the structured message. If no, return is_message_for_owner: false.

TRANSCRIPT:
${transcript}

Return ONLY a JSON object (no markdown fences, no commentary):
{
  "is_message_for_owner": true | false,
  "intended_recipient": "Ed Gojara" | "owner" | "Martha Bravo" | "Jennifer Flores" | "(other name)" | null,
  "caller_name": "string — caller's name as they identified themselves, or null",
  "callback_phone": "string — number they want a callback at, or null",
  "callback_window": "string — when they're available to talk back, or null",
  "topic": "string — short topic (1-5 words)",
  "summary": "string — what they want to discuss, 2-4 sentences in Claire's voice repeating it back",
  "urgency": "low | medium | high",
  "compliance_sensitive": true | false
}

Set compliance_sensitive=true if the topic involves: violations, fines, fee waivers, ACC decisions, collections.`;

  const resp = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = (resp.content[0]?.text || '').trim();
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    const obj = JSON.parse(cleaned);
    return obj && obj.is_message_for_owner ? obj : null;
  } catch (err) {
    console.warn('[call_log] message JSON parse failed:', err.message, 'raw:', cleaned.slice(0, 200));
    return null;
  }
}

// ----------------------------------------------------------------------------
// Send the take-a-message email to Ed
// ----------------------------------------------------------------------------
async function sendOwnerMessageEmail({ messageInfo, callContext, transcript, logger }) {
  if (!isEmailConfigured()) {
    logger.warn('[call_log] RESEND_API_KEY not configured — message email skipped');
    return;
  }

  const callerName = messageInfo.caller_name
    || callContext.caller?.full_name
    || 'Unknown caller';
  const callerPhone = messageInfo.callback_phone
    || callContext.caller_phone
    || callContext.from_phone
    || '(no number)';
  const urgency = (messageInfo.urgency || 'medium').toUpperCase();
  const recipient = messageInfo.intended_recipient || 'you';
  const community = callContext.community?.name || 'Unknown community';

  const urgencyEmoji = urgency === 'HIGH' ? '🔴' : urgency === 'MEDIUM' ? '🟡' : '🟢';
  const complianceFlag = messageInfo.compliance_sensitive
    ? '\n\n⚠️ **COMPLIANCE-SENSITIVE** — topic touches violations/fines/enforcement. Handle accordingly.'
    : '';

  const subject = `${urgencyEmoji} Message from ${callerName} via Claire (${messageInfo.topic || 'callback'})`;

  const body = `**${callerName} called and asked for ${recipient}.**

Claire took the message. Here's what they want to discuss:

> ${messageInfo.summary || '(no summary captured)'}

**Callback info**
- **Phone:** ${callerPhone}
- **Best time:** ${messageInfo.callback_window || '(not specified)'}
- **Community:** ${community}
- **Urgency:** ${urgency}${complianceFlag}

---

**Full call transcript:**

${transcript}

---

*Sent automatically by Claire after a voice call. Caller heard: "I'll get this to ${recipient} and they'll call you back."*`;

  await sendEmail({
    to: OWNER_EMAIL,
    subject,
    text: body,
    // Also useful: a reply-to header set to the caller's actual email if we have it
    replyTo: callContext.caller?.primary_email || undefined,
  });
}

module.exports = { processCallEnd };
