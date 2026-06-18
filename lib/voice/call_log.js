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
const { reviewCallForPacing } = require('./post_call_review');
const { processInboundInteraction } = require('../correspondence/inbound_pipeline');
const { matchViolationFromText } = require('../enforcement/match_violation_from_text');

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

  // Persist brief + transcript to homeowner_calls + follow-up state for the
  // Calls Dashboard (migration 106 added the follow_up_status / respond_by_at
  // columns). Logic:
  //   - compliance_flag OR brief.escalate=true → open, 4hr deadline
  //   - brief.category in {enforcement, legal, collections, accounting,
  //     financial, ar, payment} → open, 24hr deadline
  //   - brief has a non-trivial next_step → open, 3-day deadline
  //   - otherwise (no brief or self-resolved) → no follow-up (NULL)
  //
  // Bedrock staff sees these as their work queue in the new Calls tab.
  function computeFollowUp(briefObj, complianceFlag, startedAtIso) {
    if (!briefObj && !complianceFlag) return { status: null, respond_by: null };
    const escalate = briefObj && (briefObj.escalate === true || String(briefObj.escalate).toLowerCase() === 'true');
    const category = (briefObj && String(briefObj.category || '')).toLowerCase();
    const nextStep = briefObj && String(briefObj.next_step || '').trim();

    const startedAt = startedAtIso ? new Date(startedAtIso) : new Date();
    const addHours = (h) => new Date(startedAt.getTime() + h * 3600 * 1000).toISOString();
    const addDays = (d) => new Date(startedAt.getTime() + d * 86400 * 1000).toISOString();

    if (complianceFlag || escalate) return { status: 'open', respond_by: addHours(4) };
    if (['enforcement', 'legal', 'collections'].includes(category)) return { status: 'open', respond_by: addHours(24) };
    if (['accounting', 'financial', 'ar', 'payment'].includes(category)) return { status: 'open', respond_by: addHours(24) };
    if (nextStep && nextStep.length > 5 && !/^(n\/?a|none|no|-+)$/i.test(nextStep)) {
      return { status: 'open', respond_by: addDays(3) };
    }
    return { status: null, respond_by: null };
  }

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
    // Compute and attach follow-up state. Need started_at to anchor the
    // deadline — fetch it from the row if not on callContext.
    let startedAtIso = callContext.started_at || null;
    if (!startedAtIso) {
      try {
        const { data: row } = await supabase
          .from('homeowner_calls')
          .select('started_at')
          .eq('call_sid', callContext.call_sid)
          .maybeSingle();
        startedAtIso = row?.started_at || new Date().toISOString();
      } catch (_) { startedAtIso = new Date().toISOString(); }
    }
    const fu = computeFollowUp(brief, !!brief?.compliance_flag, startedAtIso);
    if (fu.status) {
      patch.follow_up_status = fu.status;
      patch.respond_by_at = fu.respond_by;
    }

    await supabase
      .from('homeowner_calls')
      .update(patch)
      .eq('call_sid', callContext.call_sid);
    logger.log(`[call_log ${callContext.call_sid}] brief persisted; compliance=${brief?.compliance_flag ? 'yes' : 'no'}; follow_up=${fu.status || 'none'}`);

    // Unified-stream summary row — write the call into `interactions` so it
    // surfaces in the Homeowner Profile alongside emails, letters, portal
    // requests. Per project_correspondence_dual_rail + task 6 of the
    // Homeowner Profile build. Skip if we don't have a community_id (NOT NULL
    // on interactions) — bare call_sid lookups without community context
    // exist mostly during dev/test.
    if (callContext.community?.id) {
      try {
        const contentLines = [];
        if (brief?.concern) contentLines.push(`Caller concern: ${brief.concern}`);
        if (brief?.answer_or_status) contentLines.push(`Answer/status: ${brief.answer_or_status}`);
        if (brief?.next_step) contentLines.push(`Next step: ${brief.next_step}${brief.owner ? ` (owner: ${brief.owner})` : ''}`);
        if (brief?.escalate) contentLines.push(`⚠ ESCALATED${brief.escalate_reason ? ': ' + brief.escalate_reason : ''}`);
        if (messageInfo?.is_message_for_owner) {
          contentLines.push(`📨 Message taken for ${messageInfo.intended_recipient || OWNER_NAME} — topic: ${messageInfo.topic || '(none)'}`);
        }
        if (callContext.handoff_accepted) contentLines.push('🤝 Caller transferred to staff');
        const content = contentLines.length > 0 ? contentLines.join('\n') : '(no brief extracted)';
        const subject = brief?.concern
          ? brief.concern.slice(0, 180)
          : (messageInfo?.is_message_for_owner ? `Message for ${messageInfo.intended_recipient || OWNER_NAME}` : 'Voice call');

        // Auto-tag the call to the open violation the caller is talking about,
        // so it surfaces inline under that case on the drive ("they called
        // about the fence") instead of only in the flat timeline. Conservative:
        // tags ONLY when exactly one open case matches the concern — ambiguous
        // or no-match leaves it general (matcher returns null/ambiguous). Ed
        // 2026-06-18. Best-effort: any failure just means no tag.
        const propertyIdForTag = callContext.caller?.property_id || null;
        let autoTaggedViolationId = null;
        if (propertyIdForTag) {
          try {
            const { data: openVRows } = await supabase
              .from('violations')
              .select('id, current_stage, enforcement_categories(slug, label)')
              .eq('property_id', propertyIdForTag)
              .not('current_stage', 'in', '("cured","closed","voided")');
            const openV = (openVRows || []).map((v) => ({
              id: v.id,
              category_label: v.enforcement_categories?.label || null,
              category_slug: v.enforcement_categories?.slug || null,
            }));
            const concernText = [brief?.concern, brief?.next_step, subject].filter(Boolean).join(' ');
            const m = matchViolationFromText(concernText, openV);
            if (m && !m.ambiguous && m.violation_id) {
              autoTaggedViolationId = m.violation_id;
              logger.log(`[call_log ${callContext.call_sid}] auto-tagged call to violation ${m.violation_id} (${m.matched_label})`);
            }
          } catch (tagErr) {
            logger.warn(`[call_log ${callContext.call_sid}] violation auto-tag failed (non-fatal): ${tagErr.message}`);
          }
        }

        // original_external_id keyed by voice:<call_sid> for cross-source dedup
        // (idx_interactions_external_dedup is a non-unique index — at current
        // call volume duplicates are negligible and easy to clean up).
        const interactionInsert = {
          community_id: callContext.community.id,
          contact_id: callContext.caller?.id || null,
          property_id: callContext.caller?.property_id || null,
          violation_id: autoTaggedViolationId,
          type: 'phone',
          direction: 'inbound',
          delivery_method: 'phone',
          subject,
          content,
          status: 'received',
          sent_at: patch.ended_at,
          received_at: startedAtIso,
          source: 'forward',
          original_external_id: `voice:${callContext.call_sid}`,
          ai_drafted: false,
          notes: `homeowner_call_sid=${callContext.call_sid}; category=${brief?.category || 'unknown'}; compliance=${!!brief?.compliance_flag}; escalate=${!!brief?.escalate}; handoff=${!!callContext.handoff_accepted}`,
        };
        const { data: newInteraction, error: insErr } = await supabase
          .from('interactions')
          .insert(interactionInsert)
          .select('id')
          .single();
        if (insErr) throw insErr;
        logger.log(`[call_log ${callContext.call_sid}] interactions summary written id=${newInteraction.id}`);

        // Fire-and-forget AI classification + draft pipeline. Adds
        // ai_classification to the inbound row and (when urgency warrants)
        // creates a child ai_draft interaction that staff edits + sends.
        // Skip drafting when the call resulted in compliance handoff — the
        // human conversation already covered it; drafting after the fact
        // would just create inbox noise.
        const draftEnabled = !callContext.handoff_accepted && !brief?.compliance_flag;
        processInboundInteraction(
          supabase,
          { ...interactionInsert, id: newInteraction.id, contact_name: callContext.caller?.full_name, community_name: callContext.community?.name },
          { logger, draftEnabled },
        ).catch((err) => {
          logger.warn(`[call_log ${callContext.call_sid}] inbound_pipeline failed: ${err.message}`);
        });
      } catch (err) {
        // Non-fatal — call data is already in homeowner_calls; this is
        // additive unified-stream visibility.
        logger.warn(`[call_log ${callContext.call_sid}] interactions summary failed: ${err.message}`);
      }
    } else {
      logger.warn(`[call_log ${callContext.call_sid}] no community_id on callContext — skipping interactions summary write`);
    }
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

  // Pacing review — always-on, additive. Reviews transcript for pacing
  // failures and writes structured observations to claire_pacing_observations.
  // Ed sweeps unreviewed observations periodically; the loop closes when a
  // pattern gets encoded into the system prompt or per-community config.
  // Fire-and-forget — review failures never affect call outcomes (call is
  // already over) or block the brief/message work above.
  reviewCallForPacing({
    callSid: callContext.call_sid,
    history,
    logger,
  }).catch((err) => {
    logger.warn(`[call_log ${callContext.call_sid}] pacing review failed: ${err.message}`);
  });
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
