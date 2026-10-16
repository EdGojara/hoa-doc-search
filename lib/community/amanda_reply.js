// ============================================================================
// lib/community/amanda_reply.js  (Ed 2026-07-19)
// ----------------------------------------------------------------------------
// Amanda Albright — Senior Community Manager, the ESCALATION tier. The
// specialists own their lanes (Annie/ACC, Miranda/DRV, Emma/AP, Paige/board);
// Amanda owns the tough, cross-domain, relationship-heavy cases none of them
// can cleanly close alone.
//
// As of 2026-08-28 the reusable operator capabilities — grounding, audience,
// board data, the reserved-decision gate, the exception router — live in
// lib/team/operator_core.js. This file is now Amanda's PERSONA over that core:
// her escalation triggers, her voice/system prompts per audience, and the
// orchestration. When another teammate is turned on, they compose the same core
// with their own persona bits; nothing here is copied into them.
//
// HARD BOUNDARY (same as Claire): Amanda COORDINATES and RECOMMENDS. She does
// not waive/reduce a fine, adjust a balance, grant an ACC decision, or take a
// legal position. Those are drafted as "here's what I'll bring to the board /
// the team" and held for a human — enforced by the shared reserved gate.
// ============================================================================

const {
  reservedAsk, propertyContext, assembleGrounding,
  pickAudience, resolveAudience, audienceGetsCommunityFacts,
  boardDataContext, cleanModelBody, classifyDisposition, detectLegalThreat,
  detectHarmEmergency, HARM_DRAFT_INSTRUCTION, greetingName, CONTACT_ROUTING_RULE, NO_OVERPROMISE_RULE, threadHistory,
} = require('../team/operator_core');
const { route: aiRoute } = require('../../lib/ai/router');
const { FINANCE_PRIMER } = require('../team/knowledge/finance_primer');

// What makes an issue "tough" enough for Amanda — her escalation triggers.
const EMOTION = /\b(furious|outrag|unacceptable|ridiculous|disgust|harass|threaten|sick of|fed up|never again|worst|incompeten|lawyer|attorney|sue|lawsuit|legal action|discriminat|ada|fair housing|retaliat)\b/i;
const HARDSHIP = /\b(hardship|medical|hospital|passed away|deceased|widow|disab|unemploy|lost my job|foreclos|bankrupt)\b/i;
const ESCALATE_WORDS = /\b(escalat|supervisor|manager|speak to someone|who is in charge|complaint|formal complaint|board member|president of the board)\b/i;

function looksLikeEscalation(email, { threadCount = 0 } = {}) {
  const text = [email.subject, email.body, email.body_preview].filter(Boolean).join('\n');
  const hits = [];
  if (EMOTION.test(text)) hits.push('charged/legal-adjacent language');
  if (HARDSHIP.test(text)) hits.push('hardship');
  if (ESCALATE_WORDS.test(text)) hits.push('explicit escalation ask');
  if (threadCount >= 4) hits.push(`${threadCount} unresolved back-and-forths`);
  return { escalate: hits.length > 0, reasons: hits };
}

function amandaSignoff() {
  return '\n\nI\'ll stay on this personally until it\'s resolved. If you\'d rather talk it through with someone on the team, just say the word and I\'ll set it up.';
}

// The INTERNAL situation summary for the reviewer (not sent to the person).
function reviewHint(reasons, ctx) {
  const bits = [];
  if (reasons && reasons.length) bits.push(reasons.join(' + '));
  if (ctx.violations.length) bits.push(`${ctx.violations.length} open violation(s) [${[...new Set(ctx.violations.map((v) => v.stage))].join(',')}]`);
  if (ctx.ar_balance != null && Math.abs(ctx.ar_balance) > 0.5) bits.push(`AR ${ctx.ar_balance > 0 ? 'owes' : 'credit'} $${Math.abs(ctx.ar_balance).toFixed(2)}`);
  if (ctx.acc.length) bits.push(`${ctx.acc.length} open ACC`);
  return `Amanda escalation: ${bits.join(' · ') || 'cross-domain'}`;
}

const AMANDA_SYSTEM = (communityName) => `You are Amanda Albright, Senior Community Manager at Bedrock Association Management, responsible for ${communityName || 'this community'}. You are drafting an email reply that a human teammate reviews before it is sent.

WHO YOU ARE: the escalation-tier manager. You take ownership, you are warm but direct, and you actually answer the question using the facts in front of you — you are not a form letter.

HARD RULES — never break these, they are the reason a human reviews you:
- Do NOT waive or reduce a fine, forgive or adjust a balance, grant or deny an ACC/architectural request, change a deadline in a Texas Chapter 209 process, or state a legal position or a 209 determination. If the person asks for any of these, acknowledge it, take ownership, and say you will bring it to the board or the team with your recommendation. You never decide it in this reply.
- Answer ONLY from the CONTEXT provided. If the answer is not there, do not invent it — say you will confirm and follow up. Never fabricate a rule, number, date, policy, covenant citation, or name.
- Never expose internal jargon, case numbers, staff notes, or any other resident's information.

VOICE: warm, plain, specific. Use the person's first name and concrete community facts. No em-dashes, use commas. No corporate filler. When a governing rule applies, state plainly what it says and where it comes from in their documents, in plain language. When you cannot fully resolve the matter now, give ONE clear next step and a timeline.

Write the FULL message body only, greeting through sign-off. Do NOT add a signature block, your title, or contact details, those are appended automatically. Write plain text with no markdown, asterisks, or headers; if you list options, use short numbered lines.`;

const AMANDA_BOARD_SYSTEM = (communityName) => `You are Amanda Albright, Senior Community Manager at Bedrock Association Management, writing to a BOARD MEMBER of ${communityName || 'this community'}. A human teammate reviews this before it is sent.

WHO YOU ARE WRITING TO: a fiduciary who governs the association. Treat them like a board, and remember you are their manager: do all the management work yourself and bring them only the decision that is genuinely theirs (unusual, unbudgeted, above management's authority, legally or authority-sensitive). For that decision, state YOUR recommendation first, with the facts and figures behind it; mention an alternative only when it genuinely matters. The board decides, often by a vote. When they send you something routine (a receipt for a normal purchase, a routine operational update), do NOT manufacture a decision: acknowledge it, use the facts, say what happens next, and keep it short.

WHAT YOU MAY SHARE: because they govern the association, you may include the community and owner detail relevant to their decision — delinquency status, enforcement stage, financial figures, vendor specifics. This is the one audience where that is appropriate. Never invent a figure, and never repeat it to anyone outside the board.

WHAT YOU STILL MAY NOT DO: you do not, on your own authority, execute a fine waiver, a payment, a spend, an ACC decision, or a legal position, and you do not state a Texas Chapter 209 determination. You recommend, the board acts. If they ask you to just do it, give them the recommendation and the option to direct it — do not report it as already done.

GROUNDING: answer from the CONTEXT below, which includes the BOARD DECISION FACTS retrieved from trustEd before you started. Never guess a figure. Only something genuinely outside trustEd (a vendor's updated price, a document nobody has sent) may be described as being requested, and say from whom.

VOICE: concise, professional, decision-oriented, warm but not chatty. No em-dashes, use commas. Write the full message body only, greeting through sign-off, no signature block. Write plain text with no markdown, asterisks, or headers; put each option on its own short numbered line.`;

const AMANDA_VENDOR_SYSTEM = (communityName) => `You are Amanda Albright, Senior Community Manager at Bedrock Association Management, writing to a VENDOR or service provider working with ${communityName || 'one of our communities'}. A human teammate reviews this before it is sent.

WHO YOU ARE WRITING TO: an outside company. You represent Bedrock and the association. Be professional, clear, and specific about what you need from them.

WHAT YOU MAY NOT DISCLOSE, this is a hard line: the association's financials, budget, reserves, current or prior insurance premium, bank or payment details, homeowner delinquency or account data, any individual owner's information, or board deliberations. A vendor needs scope, schedule, and requirements, never the association's books. If answering would require any of that, do not, and say you will follow up.

WHAT YOU MAY NOT DO on your own authority: commit or approve association funds, authorize a spend, agree to a price or a contract, or promise payment or a date for payment. Those require board or management approval. Coordinate the request and say you will confirm and get it approved.

WHAT YOU CAN DO: request or clarify a quote, scope, or schedule; ask for a certificate of insurance, W-9, or documentation; coordinate access and logistics; and set expectations about the approval process.

GROUNDING: answer from the CONTEXT below. If it is not there, say you will confirm and follow up rather than guess.

VOICE: professional, concise, directive. No em-dashes, use commas. Plain text, no markdown or headers. Write the full message body only, greeting through sign-off, no signature block.`;

async function draftAmandaReply({ email, supabase, propertyId, communityId, contactName, communityName, sourceMessageId, mailbox, graphId, diagnostic = false }) {
  const focus = require('../amanda/reply_focus');
  // The WHOLE message. At ingest the email carries body_full, not body, and
  // body_preview is Graph's ~255-character cut: Kevin Thoms's reply reached Amanda
  // ending "terms and conditions, and", without the insurance certificate (Ed 2026-10-16).
  const fullBody = email.body || email.body_full || email.body_preview || '';
  const latestText = focus.latestMessageText(fullBody) || fullBody;
  const quoted = focus.quotedHistory(fullBody);
  // Greet who wrote, not the account, and never a role label ("Hi Treasurer"):
  // display name, then signature, then the resolved contact, then the Board roster.
  const knownFirst = await focus.resolveSenderFirstName(supabase, communityId, email, contactName);
  const senderName = knownFirst || greetingName(email, contactName);
  const trig = looksLikeEscalation(email);
  // Shared severe signals: a litigation threat or possible imminent harm must
  // escalate loudly even at the community-manager tier. Merged into the reasons
  // so they drive the disposition and the hint; harm also reshapes the draft.
  const inboundText = `${email.subject || ''}\n${latestText}`;
  const threat = detectLegalThreat(inboundText);
  const harm = detectHarmEmergency(inboundText);
  const escalationReasons = [...(trig.reasons || []), ...(threat ? [threat] : []), ...(harm ? [harm] : [])];
  const ctx = await propertyContext(supabase, { propertyId });
  const gate = reservedAsk(email);   // shared code gate: reserved-decision request
  const audience = await resolveAudience({ email, supabase, communityId, propertyId });

  // The warm ownership acknowledgment — the FALLBACK if grounded generation is
  // unavailable or returns nothing (CLAUDE.md: always a fallback).
  const looked = ctx.violations.length || ctx.acc.length || ctx.ar_balance != null;
  const fallbackBody = `Hi ${senderName},\n\n`
    + `Thank you for reaching out, and I'm sorry this has been frustrating. I'm Amanda, the senior manager for ${communityName || 'your community'}, and I've taken personal ownership of getting this sorted.`
    + (looked
      ? `\n\nI've pulled the full history on your property so we're working from the complete picture, not one piece of it. Here's what happens next: I'll review everything end to end, coordinate with the right people on our side, and come back to you with a clear path and a timeline. You won't have to repeat yourself to anyone.`
      : `\n\nHere's what happens next: I'll go through this end to end, coordinate with the right people on our side, and come back to you with a clear path and a timeline. You won't have to repeat yourself to anyone.`)
    + amandaSignoff();

  let body = fallbackBody;
  let grounded = false;
  let judgmentIssues = [];
  let focusIssues = [];
  let sawPrompt = null;   // diagnostic: exactly what the drafter was given
  try {
    const { docContext, profileBlock } = await assembleGrounding({ email, communityName });
    // See what the resident attached before drafting or citing anything.
    let photoRead = '';
    try {
      if (sourceMessageId || (graphId && (mailbox || email.mailbox))) {
        const { describeMessageImages } = require('../team/attachment_vision');
        const v = await describeMessageImages(supabase, sourceMessageId || email.id, { mailbox: mailbox || email.mailbox, graphId: graphId || email.graph_id });
        if (v.description) photoRead = `WHAT THE RESIDENT'S ATTACHED PHOTO(S) SHOW — a factual read of the image, treat it as the evidence. Cite ONLY what is visible here; do NOT assert a violation the photo does not clearly support:\n${v.description}\n\n`;
      }
    } catch (_) { /* vision is best-effort */ }
    // Read the attachments themselves (receipts, invoices, PDFs, documents), not
    // just the photos. Without this Amanda answered a receipt email saying she
    // could not see the amount. (Ed 2026-10-06; see lib/team/reply_judgment.js.)
    let attachBlocks = []; let attachSummary = '';
    try {
      const mb = mailbox || email.mailbox; const gid = graphId || email.graph_id;
      if (mb && gid) {
        const { fetchAttachmentBlocks } = require('../email/graph_attachments');
        const a = await fetchAttachmentBlocks(mb, gid);
        attachBlocks = a.blocks || []; attachSummary = a.summary || '';
      }
    } catch (e) { console.warn('[amanda_reply] attachment fetch failed (drafting without them):', e.message); }
    let history = '';
    try {
      const h = await threadHistory(supabase, sourceMessageId || email.id,
        { conversationId: email.conversation_id || null, senderEmail: email.sender_email || null, excludeGraphId: graphId || email.graph_id || null });
      if (h) history = `EARLIER CORRESPONDENCE WITH THIS RESIDENT (across all threads — respond to the CURRENT state, do not repeat advice they have already acted on). Note: prior messages, including quoted earlier replies, may contain mistakes; where the attached photo or the records contradict a prior statement, trust the evidence, not the prior claim:\n${h}\n\n`;
    } catch (_) { /* history is best-effort */ }
    let objectiveBlock = '';
    try {
      const obj = require('../team/objectives');
      const open = await obj.findOpenObjectiveFor(supabase, { residentEmail: email.sender_email, propertyId });
      if (open) { const evts = await obj.objectiveEvents(supabase, open.id); objectiveBlock = obj.objectiveContextBlock(open, evts) + '\n'; }
    } catch (_) { /* objectives spine is best-effort */ }
    // Board governance data flows ONLY to a verified board member. The audience
    // gate is the disclosure control; this is where the data it unlocks enters.
    const boardBlock = audience === 'board' ? await boardDataContext(supabase, communityId) : '';
    // Ed 2026-10-16: retrieve -> analyze -> decide -> respond. The records a board decision needs are
    // pulled BEFORE drafting, so Amanda states the numbers instead of promising to check them.
    let decisionFacts = '';
    if (audience === 'board') {
      try { decisionFacts = await require('../amanda/decision_ready').boardDecisionFacts(supabase, communityId, inboundText); }
      catch (e) { decisionFacts = `BOARD DECISION FACTS: unavailable (${e.message}). Name this limitation rather than promising to check later.`; console.warn('[amanda_reply] decision facts failed:', e.message); }
    }
    const accountFacts = [
      ctx.violations.length ? `Open violations: ${ctx.violations.map((v) => `${v.category || 'violation'} (stage ${v.stage})`).join('; ')}` : null,
      ctx.ar_balance != null && Math.abs(ctx.ar_balance) > 0.5 ? `Account balance: ${ctx.ar_balance > 0 ? 'owes' : 'credit'} $${Math.abs(ctx.ar_balance).toFixed(2)}` : null,
      ctx.acc.length ? `Open ACC/architectural items: ${ctx.acc.map((a) => a.project_summary || a.decision_type).filter(Boolean).join('; ')}` : null,
    ].filter(Boolean).join('\n') || 'No account facts resolved for this sender.';

    // A Board member's instruction on another thread about the same matter (Hugh's
    // "scrub the numbers and create an RFP" arrived two minutes before Kevin's reply).
    let related = '';
    if (audience === 'board') {
      related = await focus.relatedRecentInstructions(supabase, { mailbox: mailbox || email.mailbox, communityId, conversationId: email.conversation_id,
        senderEmail: email.sender_email, receivedAt: email.received_at, excludeId: sourceMessageId || email.id, excludeGraphId: graphId || email.graph_id });
    }
    const signals = focus.substantiveSignals(latestText);

    const userContent = `THE LATEST MESSAGE (answer THIS sender's point first):\nFrom: ${email.sender_name || contactName || 'a resident'} (greet them as ${senderName})\nSubject: ${email.subject || '(none)'}\n\n${latestText}\n\n`
      + (signals.substantive ? `THEIR POINT (a ${signals.kinds.join(' / ')}; answer it directly, never with a generic acknowledgement): ${signals.points.join(' ')}\n\n` : '')
      + (quoted ? `QUOTED BELOW THEIR MESSAGE (earlier messages, including our own; context only, do not answer them again):\n${quoted.slice(0, 8000)}\n\n` : '')
      + (related ? `RELATED RECENT INSTRUCTIONS FROM THIS BOARD (other threads, last 48 hours; if one is about this matter, say what you are doing about it):\n${related}\n\n` : '')
      + history
      + `THIS RESIDENT'S ACCOUNT (private to them — use to inform your reply, never quote another resident's data):\n${accountFacts}\n\n`
      + `COMMUNITY FACTS:\n${audienceGetsCommunityFacts(audience) ? (profileBlock || 'None available.') : 'Withheld. This audience does not receive the association\'s internal community data.'}\n\n`
      + objectiveBlock
      + photoRead
      + (attachSummary ? `ATTACHMENTS: ${attachSummary}\n\n` : '')
      + `GOVERNING DOCUMENTS & RULES retrieved for this question:\n${docContext || 'None retrieved.'}\n\n`
      + (audience === 'board' && boardBlock ? `BOARD GOVERNANCE DATA (association records, appropriate for a board member, never repeat outside the board):\n${boardBlock}\n\n` : '')
      + (audience === 'board' && decisionFacts ? `BOARD DECISION FACTS (retrieved from trustEd before drafting; use these figures, never promise to look them up):\n${decisionFacts}\n\n` : '')
      + (gate.allow ? '' : (audience === 'board'
        ? `RESERVED REQUEST DETECTED — this asks for a decision reserved to the board acting as a body. Do all the management work first, then state your recommendation for the board's decision, with the figures behind it, and any alternative that genuinely matters. Do not report the decision as already made.\n\n`
        : `RESERVED REQUEST DETECTED — the sender is asking you to ${gate.reason.replace(/_/g, ' ')}, which you have NO authority to grant, deny, or decide. Do not state or imply a decision. Acknowledge it, explain what you can (what the rule says or where it stands), and say you are bringing it to the board or the team with your recommendation, with a next step and a timeline.\n\n`))
      + (harm ? `${HARM_DRAFT_INSTRUCTION}\n\n` : '')
      + `Draft Amanda's reply to ${senderName}.`;

    // Amanda carries HOA finance/accounting as standing knowledge (Ed: most CMs
    // are weak on finance, she is not). Not shared with a vendor — she never
    // discusses the association's finances with an outside company.
    const baseSystem = ({ board: AMANDA_BOARD_SYSTEM, vendor: AMANDA_VENDOR_SYSTEM }[audience] || AMANDA_SYSTEM)(communityName);
    const financeContext = FINANCE_PRIMER
      + '\n\nYou are a community manager who is genuinely fluent on finances, not the accountant. Explain the basics with confidence so a board never feels their manager is lost on the numbers. For detailed accounting, reconciliation, or anything you are not sure of, say you will bring in Kat, our accounting manager, rather than guessing.';
    let system = (audience === 'vendor' ? baseSystem : baseSystem + '\n\n' + financeContext) + '\n\n' + CONTACT_ROUTING_RULE + '\n\n' + NO_OVERPROMISE_RULE;
    const judgment = require('../team/reply_judgment');
    system += '\n\n' + judgment.ATTACHMENT_RULE + '\n\n' + judgment.PROPORTIONALITY_RULE;
    // Append what Ed has taught Amanda in shadow review (the encode-Ed loop).
    const { loadApprovedGuidance, guidanceBlock } = require('../team/learned_guidance');
    const learned = guidanceBlock(await loadApprovedGuidance(supabase, 'amanda'));
    if (learned) system += `\n\n${learned}`;
    const decisionReady = require('../amanda/decision_ready');
    if (audience === 'board') system += '\n\n' + decisionReady.DECISION_READY_RULE
      + '\n\nA reply to one Board member\'s point (agreement, disagreement, a condition, a question about something you wrote) is a direct answer in plain paragraphs, not the Situation / Recommendation structure.';
    system += '\n\n' + focus.ANSWER_LATEST_RULE;

    const Anthropic = require('../../lib/ai/anthropic');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const ask = async (extra) => {
      const text = userContent + (extra ? `\n\n${extra}` : '');
      const call = (content) => anthropic.messages.create({ model: aiRoute('team.amanda_reply'), max_tokens: 1200, system, messages: [{ role: 'user', content }] });
      let r;
      try { r = await call(attachBlocks.length ? [...attachBlocks, { type: 'text', text }] : text); }
      catch (e) {
        if (!attachBlocks.length) throw e;
        // A pathological attachment must not cost the whole draft: retry text-only,
        // naming what was attached (same pattern as lib/email/draft_reply.js).
        console.warn('[amanda_reply] attachment rejected, retrying text-only:', e.message);
        attachBlocks = [];
        r = await call(text + `\n\n(The attachments could not be opened. Acknowledge them by name: ${attachSummary || 'attached files'}. Do not ask the sender to resend them.)`);
      }
      return cleanModelBody((r.content || []).map((b) => b.text || '').join(''), ['Amanda', 'Amanda Albright', 'Senior Community Manager']);
    };
    if (diagnostic) sawPrompt = userContent;
    let out = await ask();
    // Deterministic guard: claiming the facts are unavailable when an attachment
    // was read is always wrong. Ask once more with the correction.
    let check = judgment.checkReply(out, { attachmentsRead: attachBlocks.length > 0 });
    if (check.claims_unavailable) {
      out = await ask(judgment.RETRY_NOTE);
      check = judgment.checkReply(out, { attachmentsRead: attachBlocks.length > 0 });
    }
    judgmentIssues = check.issues;
    // Decision-ready check (board): passive endings, promised system-accessible diligence, vague
    // financial claims, options with no recommendation. One corrective retry, then report what remains.
    // Reply-focus check (every audience, Ed 2026-10-16): answers the latest sender's point
    // first, no generic acknowledgement when they raised something, a misread
    // recommendation is clarified, greeted by name and never by role. Both checks share
    // ONE corrective retry, then whatever remains is flagged and the draft is held.
    const focusCtx = { latestText, senderFirstName: knownFirst };
    const runChecks = (txt) => ({
      dr: audience === 'board' ? decisionReady.checkDecisionReady(txt) : { ok: true, issues: [] },
      rf: focus.checkReplyFocus(txt, focusCtx),
    });
    let chk = runChecks(out);
    if (!chk.dr.ok || !chk.rf.ok) {
      const notes = [!chk.dr.ok ? decisionReady.retryNote(chk.dr.issues) : null, !chk.rf.ok ? focus.retryNote(chk.rf.issues, focusCtx) : null].filter(Boolean).join('\n\n');
      out = await ask(notes);
      chk = runChecks(out);
    }
    if (!chk.dr.ok) judgmentIssues = [...judgmentIssues, ...[...new Set(chk.dr.issues.map((i) => `decision-ready: ${i.code}`))]];
    if (!chk.rf.ok) { focusIssues = [...new Set(chk.rf.issues.map((i) => i.code))]; judgmentIssues = [...judgmentIssues, ...focusIssues.map((c) => `reply-focus: ${c}`)]; }
    console.log('[amanda_reply] grounded draft:', JSON.stringify({ outLen: out.length, docCtx: docContext.length, profile: profileBlock.length }));
    if (out.length > 40) { body = out; grounded = true; }
  } catch (e) {
    console.warn('[amanda_reply] grounded generation failed, using fallback:', e.message);
  }

  const disp = classifyDisposition({ gateAllowed: gate.allow, grounded, escalationReasons, audience });
  // A draft that still fails the reply-focus check after its retry never goes out on its own.
  if (focusIssues.length) {
    disp.disposition = 'needs_review';
    disp.confidence = 'low';
    disp.reason = [disp.reason !== 'routine, grounded, in-bounds, verified sender' ? disp.reason : null, `reply does not answer the latest message (${focusIssues.join(', ')})`].filter(Boolean).join('; ');
  }

  return {
    draftable: true, careful: true,
    subject: `Re: ${email.subject || 'your message'}`,
    body,
    disposition: disp.disposition, confidence: disp.confidence, disposition_reason: disp.reason,
    audience, grounded, reserved: !gate.allow, reserved_reason: gate.allow ? null : gate.reason,
    escalation_reasons: escalationReasons,
    review_hint: reviewHint(escalationReasons, ctx) + ` · aud:${audience}` + (grounded ? ' · grounded' : ' · ownership-ack (fallback)') + (gate.allow ? '' : ` · RESERVED:${gate.reason}`) + ` · ${disp.disposition}/${disp.confidence}`
      + (judgmentIssues.length ? ` · CHECK: ${judgmentIssues.join('; ')}` : ''),
    judgment_issues: judgmentIssues,
    focus_issues: focusIssues,
    ...(diagnostic ? { diagnostic: { audience, sender_first_name: knownFirst, latest_text: latestText, prompt: sawPrompt } } : {}),
    context: ctx,
  };
}

// reservedAsk / pickAudience / classifyDisposition are re-exported from the
// operator core so existing callers and tests keep importing them from here.
module.exports = { draftAmandaReply, looksLikeEscalation, reservedAsk, pickAudience, classifyDisposition };
