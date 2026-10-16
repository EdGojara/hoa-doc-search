// ============================================================================
// lib/email/persona_reply.js  (Ed 2026-07-20)
// ----------------------------------------------------------------------------
// A general-purpose, in-VOICE reply draft for any AI team member — so every
// specialist (Kat, Amanda, Reese, Paige) can reply to ANYTHING in their queue,
// not just the narrow trigger cases their dedicated handlers cover. Emma and
// Claire keep their own data-grounded generators; this covers the rest.
//
// Every draft is REVIEW-FIRST (a human approves before it sends) and honest-AI.
// Hard guardrails apply to all: never take a legal position, waive a fine,
// adjust a balance, grant an ACC/architectural decision, or commit to a figure
// or date the platform hasn't confirmed — those are drafted as "what I'll bring
// to the team/board" and held for a person.
// ============================================================================
const { route: aiRoute } = require('../../lib/ai/router');
const Anthropic = require('../../lib/ai/anthropic');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = aiRoute('email.persona_reply');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const focus = require('../amanda/reply_focus');

// LANE + voice per persona. Name and title are NOT here — they come from the
// roster, because this file held an eleventh copy of them and Kat's said
// 'Katherine "Kat" Reed' while every other surface called her Kat Reed.
// (Ed 2026-08-20.)
const { ROSTER } = require('../team/roster');
const _byPersona = new Map(ROSTER.map((m) => [m.persona, m]));
function personaIdentity(key) {
  const m = _byPersona.get(key);
  if (!m) throw new Error('no roster entry for persona "' + key + '"');
  return { name: m.name, title: m.signature_title || m.title };
}

const PERSONAS = {
  kat: {
    lane: 'board meeting packages, agendas, minutes, and notices.',
    careful: false,
  },
};

const GUARDRAILS = `HARD RULES (never break, this is a draft a human approves before it sends):
- Do NOT write an AI disclosure, sign-off, or signature in the body — the branded signature added below already carries the disclosure ("Powered by Bedrock Intelligence. A member of our team is always available if you need assistance."). Just write the helpful reply and end on your last real sentence.
- NEVER state a dollar figure, balance, date, or account detail you have not been given below. If answering needs data you don't have, say you're pulling it and will follow up — don't guess.
- NEVER take a legal position, waive or reduce a fine, adjust a balance, grant an architectural/ACC decision, or promise a specific payment/completion date. Frame anything like that as "I'll bring this to the board/team" and hold it.
- Be warm, specific, and concise. No corporate filler, no fake urgency, no invented facts.
- ATTACHMENTS: if the sender attached files (PDFs / photos), they are included below for you to READ. Read them and respond to their actual content. NEVER ask the sender to "send" or "forward" a document they already attached — that reads as if no one looked. If a file genuinely can't be shown, it's named below; acknowledge it by name and, only if you truly need something inside it, say specifically which file and what you need.
- REVIEWING PROPOSALS / BIDS / CONTRACTS: when you're asked to review one or more proposals, compare what each option actually DELIVERS — scope, coverage, equipment and specs, term, service model, and what is and isn't included — not just the price. A cheaper bid usually buys less; make that tradeoff explicit so the board can decide on value, not sticker price. Read every attached proposal in full before drafting, and if the bids aren't apples-to-apples, say so and lay out the real differences.
- If the email genuinely isn't yours to handle or clearly needs a human, say so briefly and offer the hand-off rather than forcing an answer.`;

function ctxBlock(context = {}) {
  const lines = [];
  if (context.communityName) lines.push(`Community: ${context.communityName}`);
  if (context.contactName) lines.push(`Writer / contact: ${context.contactName}`);
  if (context.propertyAddress) lines.push(`Property: ${context.propertyAddress}`);
  if (context.vendorName) lines.push(`Vendor: ${context.vendorName}`);
  if (Array.isArray(context.extra)) lines.push(...context.extra.filter(Boolean));
  return lines.length ? `\n\nWHAT THE PLATFORM KNOWS (ground your reply in ONLY this — do not invent beyond it):\n${lines.join('\n')}` : '\n\n(No linked account context — keep the reply general and, if it needs specifics, say you\'ll look them up.)';
}

// Draft a reply as `persona`. Returns { draftable, persona, subject, body, careful }.
async function draftPersonaReply({ persona, email, context = {}, notes = null, currentDraft = null, examples = null }) {
  // Every teammate in the roster can reply in their own voice, not just the few
  // with a custom PERSONAS entry. Derive name / title / lane from the roster so a
  // missing PERSONAS key no longer silently returns "no draft" — it did exactly
  // that for amanda / reese / paige (only kat was configured), so clicking
  // Re-draft on an Amanda email produced "No draft" and never reached the
  // attachment-reading path. (Ed 2026-09-17.)
  const ident = _byPersona.get(persona);
  if (!ident) return { draftable: false };
  const cfg = PERSONAS[persona] || {};
  const p = {
    name: ident.name,
    title: ident.signature_title || ident.title,
    lane: cfg.lane || ident.domain || ident.title || 'general association matters',
    careful: cfg.careful === true,
  };

  let roster = '';
  try { roster = await require('./team_roster').teamRosterBlock(); } catch (_) {}

  // Encode-Ed: how Ed has edited this teammate's past replies (single-teacher).
  let examplesBlock = '';
  try { if (examples && examples.length) { const { formatExamplesForPrompt } = require('./reply_learning'); examplesBlock = formatExamplesForPrompt(examples); } } catch (_) {}

  const sys = `You are ${p.name}, Bedrock Association Management's AI ${p.title}, drafting a reply for a human to review before it sends. Your lane: ${p.lane}${roster}
${examplesBlock ? '\n' + examplesBlock + '\n' : ''}
${GUARDRAILS}

${focus.ANSWER_LATEST_RULE}

Write ONLY the email body — no subject line, no "From/To", no signature (the branded signature is appended automatically). Greet the sender by first name when you know it.`;

  const askedText = `${email.subject || ''}\n\n${email.body_full || email.body_preview || ''}`.slice(0, 8000);
  const steer = notes ? `\n\nThe reviewer added these notes to fold in — follow them:\n"${notes}"` : '';
  const revise = currentDraft ? `\n\nRevise THIS existing draft (keep what works, apply the notes):\n"""\n${currentDraft}\n"""` : '';

  // Read the sender's attachments so the specialist answers their CONTENT instead
  // of asking the sender to resend files they already attached (Ed 2026-09-17:
  // Amanda's draft asked a vendor to send three proposals he'd attached). This
  // path handles Amanda/Kat/Reese/Paige — the general drafter already reads
  // attachments; this one didn't fetch them at all. Best-effort; never blocks.
  let attachBlocks = [], attachSummary = '';
  if (email.mailbox && email.graph_id) {
    try {
      const { fetchAttachmentBlocks } = require('./graph_attachments');
      const a = await fetchAttachmentBlocks(email.mailbox, email.graph_id);
      attachBlocks = a.blocks || []; attachSummary = a.summary || '';
    } catch (_) {}
  }

  // The shared reply-focus context (Ed 2026-10-16): the latest sender's own words first,
  // the quoted history as context, their real name (never a role label), the thread,
  // and for a Board sender the settled constraints, related Board mail and RFP records.
  // Before this, a re-draft of Kevin Thoms's email here saw none of the thread.
  let fctx = null;
  try { fctx = await focus.gatherReplyContext(supabase, email, { communityId: context.communityId || null, contactName: context.contactName || null }); }
  catch (e) { console.warn('[persona_reply] reply context failed:', e.message); }

  // A Board sender gets what Amanda's ingest drafter gives a Board sender (Ed 2026-10-16,
  // the re-draft of Kevin's email failed twice where ingest passed): who they are, the
  // decision-ready rule, and the Board decision facts retrieved before drafting. Without
  // it this path knew him only as "Writer / contact: Treasurer HOA".
  let boardSys = ''; let boardFacts = ''; let dr = null;
  if (fctx && fctx.audience === 'board') {
    dr = require('../amanda/decision_ready');
    const role = focus.roleOf(email);
    const office = role ? role.replace('vicepresident', 'vice president').replace(/^./, (c) => c.toUpperCase()) : null;
    boardSys = `\n\nWHO YOU ARE WRITING TO: ${fctx.senderFirstName || 'a Board member'}${office ? `, the ${office}` : ''}, a member of the ${context.communityName || 'association'} Board of Directors. You are their community manager. A reply to one Board member's point is a direct answer in plain paragraphs, not the Situation / Recommendation structure.\n\n${dr.DECISION_READY_RULE}`;
    try { boardFacts = await dr.boardDecisionFacts(supabase, context.communityId, `${email.subject || ''}\n${fctx.latestText}`); }
    catch (e) { boardFacts = `BOARD DECISION FACTS: unavailable (${e.message}). Name this limitation rather than promising to check later.`; }
  }
  const shownContext = fctx && fctx.senderFirstName ? { ...context, contactName: fctx.senderFirstName } : context;
  const user = `Reply to this email as ${p.name.split(' ')[0]}.${ctxBlock(shownContext)}\n\n--- THE EMAIL ---\nSubject: ${email.subject || '(no subject)'}\nFrom: ${email.sender_name || email.sender_email || 'sender'}\n\n${fctx ? fctx.promptBlock : askedText}${attachSummary ? `\n\n${attachSummary}` : ''}`
    + (boardFacts ? `\n\nBOARD DECISION FACTS (retrieved from trustEd before drafting; use these figures, never promise to look them up):\n${boardFacts}` : '')
    + `${steer}${revise}`
    + (fctx && fctx.closing ? `\n\n${fctx.closing}` : '');

  // Attachments ride along as content blocks so the model READS them. If a
  // pathological attachment makes the call fail, retry text-only rather than
  // failing the whole draft — the summary in `user` still names every file.
  const call = (blocks, extra) => anthropic.messages.create({
    model: MODEL, max_tokens: 900, system: sys + boardSys,
    messages: [{ role: 'user', content: [{ type: 'text', text: user + (extra ? `\n\n${extra}` : '') }, ...blocks] }],
  });
  try {
    let resp;
    try { resp = await call(attachBlocks); }
    catch (e) {
      if (attachBlocks.length) { console.warn('[persona_reply] attachment blocks rejected, retrying text-only:', e.message); resp = await call([]); }
      else throw e;
    }
    // No em dashes in anything a Board member or homeowner reads (Ed's voice rule; the
    // other two ordinary drafters already strip them, this one did not).
    const { stripEmDashes } = require('../tone');
    let body = stripEmDashes((resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim());
    if (!body) return { draftable: false };
    // Reply-focus check, one corrective retry, then flag (the same check as Amanda's ingest drafter).
    let focusIssues = [];
    if (fctx) {
      const f = await focus.enforceReplyFocus(body, fctx, async (note) => {
        const r2 = await call(attachBlocks, note).catch(() => call([], note));
        return stripEmDashes((r2.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim());
      }, { extra: dr ? (txt) => { const c = dr.checkDecisionReady(txt); return { ...c, note: c.ok ? null : dr.retryNote(c.issues) }; } : null });
      body = f.body; focusIssues = f.issues;
    }
    const subject = /^re:/i.test(email.subject || '') ? email.subject : `Re: ${email.subject || 'your message'}`;
    const out = { draftable: true, persona, subject, body, careful: !!p.careful || focusIssues.length > 0, focus_issues: focusIssues,
      review_hint: focusIssues.length ? `CHECK: reply-focus: ${focusIssues.join(', ')}` : null };
    // Receipts (Ed 2026-09-17): when the draft is built on attached documents,
    // attach a grounding record (fact/recommendation/gap + sources) and an
    // independent number check the reviewer sees before approving. Best-effort —
    // never blocks the draft. Document-review drafts first, hence the gate.
    if (attachBlocks.length) {
      try {
        const { groundAndVerify } = require('../team/grounding');
        const gv = await groundAndVerify({ draftBody: body, sourceText: askedText, sourceBlocks: attachBlocks });
        if (gv.grounding) out.grounding = gv.grounding;
        if (gv.verification) out.verification = gv.verification;
      } catch (_) {}
    }
    return out;
  } catch (e) {
    console.warn('[persona_reply] draft failed:', e.message);
    return { draftable: false };
  }
}

module.exports = { draftPersonaReply, PERSONAS };
