// ============================================================================
// lib/community/amanda_reply.js  (Ed 2026-07-19)
// ----------------------------------------------------------------------------
// Amanda Albright — Senior Community Manager, the ESCALATION tier. The
// specialists own their lanes (Annie/ACC, Miranda/DRV, Emma/AP, Paige/board);
// Amanda owns the tough, cross-domain, relationship-heavy cases none of them
// can cleanly close alone. She is NOT a new inbox specialist — she's a
// supervisor fed by (1) direct mail to amanda@, (2) escalations handed up from
// a specialist, and (3) triage flags on hot threads. Her job: pull the WHOLE
// picture together across domains, take ownership with the person, and lay out
// concrete next steps.
//
// HARD BOUNDARY (same compliance scoping as Claire): Amanda COORDINATES and
// RECOMMENDS. She does not waive or reduce a fine, forgive or adjust a balance,
// grant an ACC approval/denial, or take a legal position. Anything touching a
// waiver, a dollar adjustment, a §209 decision, or a legal question is drafted
// as "here's what I'll bring to the board / the team" and held for a human.
// ============================================================================

// What makes an issue "tough" enough for Amanda — concrete triggers, so she is
// an escalation owner and not a vague dumping ground.
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

// The compliance boundary as a CODE gate, not a prompt hope. Amanda reuses
// Claire's screen() — the reserved-decision categories are identical (waiver,
// ACC decision, legal position, money movement, enforcement on a neighbor), so
// there is one gate for the whole platform, not a second copy that drifts.
// When the incoming message asks for one of these, we tell the model in the
// hardest possible terms that it may not decide, on top of the system prompt.
// (Ed 2026-08-28. See lib/claire/guardrails.js and test_amanda_guardrails.js.)
const { screen } = require('../claire/guardrails');
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';
function reservedAsk(email) {
  const text = [email && email.subject, email && email.body, email && email.body_preview]
    .filter(Boolean).join('\n');
  return screen(text, 'homeowner');
}

function amandaSignoff() {
  return '\n\nI\'ll stay on this personally until it\'s resolved. If you\'d rather talk it through with someone on the team, just say the word and I\'ll set it up.';
}

async function propertyContext(supabase, { propertyId, communityId }) {
  const ctx = { violations: [], ar_balance: null, acc: [], flags: [] };
  if (!propertyId) return ctx;
  // Open enforcement (SSOT = property_enforcement_states; fall back to violations).
  try {
    const { data } = await supabase.from('violations')
      .select('current_stage, opened_at, enforcement_categories(label)')
      .eq('property_id', propertyId).not('current_stage', 'in', '(cured,closed,voided)').limit(25);
    ctx.violations = (data || []).map((v) => ({ stage: v.current_stage, category: v.enforcement_categories && v.enforcement_categories.label, opened_at: v.opened_at }));
  } catch (e) { /* defensive */ }
  // Current AR balance.
  try {
    const { data } = await supabase.from('v_homeowner_current_balance').select('balance_cents').eq('property_id', propertyId).maybeSingle();
    if (data) ctx.ar_balance = Number(data.balance_cents || 0) / 100;
  } catch (e) { /* defensive */ }
  // Open ACC/ARC items.
  try {
    const { data } = await supabase.from('acc_decisions').select('decision_type, status, project_summary, created_at').eq('property_id', propertyId).in('status', ['pending', 'in_review', 'submitted']).limit(10);
    ctx.acc = data || [];
  } catch (e) { /* defensive */ }
  return ctx;
}

// Build the INTERNAL situation summary for the reviewer (not sent to the person).
function reviewHint(reasons, ctx) {
  const bits = [];
  if (reasons && reasons.length) bits.push(reasons.join(' + '));
  if (ctx.violations.length) bits.push(`${ctx.violations.length} open violation(s) [${[...new Set(ctx.violations.map((v) => v.stage))].join(',')}]`);
  if (ctx.ar_balance != null && Math.abs(ctx.ar_balance) > 0.5) bits.push(`AR ${ctx.ar_balance > 0 ? 'owes' : 'credit'} $${Math.abs(ctx.ar_balance).toFixed(2)}`);
  if (ctx.acc.length) bits.push(`${ctx.acc.length} open ACC`);
  return `Amanda escalation: ${bits.join(' · ') || 'cross-domain'}`;
}

// ---------------------------------------------------------------------------
// GROUNDING — the knowledge a strong CM answers from. Property/account facts
// (propertyContext, above) PLUS the governing docs + Texas §209 (the shared
// hybrid retrieval) PLUS the community profile (budget, board, vendors,
// amenities, meeting cadence). This is the SAME recipe the voice brain already
// assembles (lib/voice/reason.js: getRelevantChunks + buildCommunityContextBlock);
// Amanda's WRITTEN replies were missing it, which is why she could only
// acknowledge and never actually answer. Every piece is best-effort: a retrieval
// miss degrades the answer, it never throws. (Ed 2026-08-28.)
// The persona signature (name, title, logo, honest-AI mark) is appended at SEND
// time by buildAmandaEmail. Two things the model reaches for that would corrupt
// the sent email: its own name/title sign-off (doubles the block) and markdown
// (the plain-text email pipeline renders ** and # literally). Strip both.
function cleanModelBody(text) {
  let t = String(text || '')
    .replace(/^\s*subject:.*(?:\r?\n)+/i, '')   // stray Subject: line
    .replace(/\*\*(.+?)\*\*/g, '$1')             // **bold** -> plain
    .replace(/^#{1,6}\s+/gm, '')                  // markdown headers
    .replace(/\r\n/g, '\n');
  const SIG = /^(amanda(\s+albright)?|senior community manager|bedrock association management|bedrock)$/i;
  const lines = t.split('\n');
  while (lines.length) {
    const last = lines[lines.length - 1].trim();
    if (last === '' || SIG.test(last) || /@bedrocktx\.com/i.test(last) || /^\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}$/.test(last)) { lines.pop(); continue; }
    break;
  }
  return lines.join('\n').trim();
}

async function assembleGrounding({ email, communityName }) {
  const question = [email.subject, email.body, email.body_preview].filter(Boolean).join('\n').slice(0, 4000);
  let docContext = '';
  let profileBlock = '';
  try {
    // getRelevantChunks returns a preformatted prompt-context STRING (each
    // chunk already tagged with its source doc), the same shape server.js,
    // lib/email/draft_reply.js and the voice brain consume. Use it directly.
    const { getRelevantChunks } = require('../hybrid_retrieval');
    docContext = (await getRelevantChunks(question, communityName) || '').slice(0, 9000);
  } catch (e) { console.warn('[amanda_reply] doc retrieval failed:', e.message); }
  try {
    // buildCommunityContextBlock is exported from the communities router; the
    // voice brain requires it the same way (lib/voice/reason.js).
    const { buildCommunityContextBlock } = require('../../api/communities');
    profileBlock = (await buildCommunityContextBlock(communityName) || '').slice(0, 4000);
  } catch (e) { console.warn('[amanda_reply] community profile failed:', e.message); }
  return { docContext, profileBlock };
}

const AMANDA_SYSTEM = (communityName) => `You are Amanda Albright, Senior Community Manager at Bedrock Association Management, responsible for ${communityName || 'this community'}. You are drafting an email reply that a human teammate reviews before it is sent.

WHO YOU ARE: the escalation-tier manager. You take ownership, you are warm but direct, and you actually answer the question using the facts in front of you — you are not a form letter.

HARD RULES — never break these, they are the reason a human reviews you:
- Do NOT waive or reduce a fine, forgive or adjust a balance, grant or deny an ACC/architectural request, change a deadline in a Texas Chapter 209 process, or state a legal position or a 209 determination. If the person asks for any of these, acknowledge it, take ownership, and say you will bring it to the board or the team with your recommendation. You never decide it in this reply.
- Answer ONLY from the CONTEXT provided. If the answer is not there, do not invent it — say you will confirm and follow up. Never fabricate a rule, number, date, policy, covenant citation, or name.
- Never expose internal jargon, case numbers, staff notes, or any other resident's information.

VOICE: warm, plain, specific. Use the person's first name and concrete community facts. No em-dashes, use commas. No corporate filler. When a governing rule applies, state plainly what it says and where it comes from in their documents, in plain language. When you cannot fully resolve the matter now, give ONE clear next step and a timeline.

Write the FULL message body only, greeting through sign-off. Do NOT add a signature block, your title, or contact details, those are appended automatically. Write plain text with no markdown, asterisks, or headers; if you list options, use short numbered lines.`;

// ---------------------------------------------------------------------------
// AUDIENCE — who is Amanda writing to. The SAME facts get handled differently
// per audience, and the difference is not tone, it is confidentiality and
// authority: a board member may see a delinquent owner's balance and gets
// options plus a recommendation because they are the fiduciary who decides; a
// homeowner may see only their own data; a vendor gets neither. Getting this
// wrong is a privacy breach, not a style miss. She never tags anyone by hand —
// the audience is inferred from the sender. (Ed 2026-08-28.)
//
// pickAudience is a PURE mapping from resolved signals, so it is tested with no
// DB (test_amanda_audience.js). resolveAudience gathers the signals.
function pickAudience({ senderEmail, isBoardMember, isOwner, isVendor }) {
  if (/@bedrocktx\.com$/i.test(String(senderEmail || ''))) return 'staff';
  if (isBoardMember) return 'board';
  if (isOwner) return 'homeowner';
  if (isVendor) return 'vendor';
  return 'other';
}

async function resolveAudience({ email, supabase, communityId, propertyId }) {
  const senderEmail = (email && (email.sender_email || email.from_email || email.from)) || '';
  const e = String(senderEmail).trim();
  let isBoardMember = false;
  let isVendor = false;
  try {
    if (e && communityId) {
      const { data, error } = await supabase.from('board_members')
        .select('email').ilike('email', e)
        .eq('community_id', communityId).eq('is_active', true).limit(1);
      if (!error) isBoardMember = !!(data && data.length);
    }
  } catch (err) { console.warn('[amanda_reply] board lookup failed:', err.message); }
  try {
    // Vendors are portfolio-wide (management-company scoped), matched on either
    // email column. Commas can't appear in an address, so the .or() is safe.
    if (e && !isBoardMember) {
      const { data, error } = await supabase.from('vendors')
        .select('id').eq('management_company_id', BEDROCK_MGMT_CO_ID).neq('is_active', false)
        .or(`email.ilike.${e},contact_email.ilike.${e}`).limit(1);
      if (!error) isVendor = !!(data && data.length);
    }
  } catch (err) { console.warn('[amanda_reply] vendor lookup failed:', err.message); }
  return pickAudience({ senderEmail, isBoardMember, isOwner: !!propertyId, isVendor });
}

const AMANDA_BOARD_SYSTEM = (communityName) => `You are Amanda Albright, Senior Community Manager at Bedrock Association Management, writing to a BOARD MEMBER of ${communityName || 'this community'}. A human teammate reviews this before it is sent.

WHO YOU ARE WRITING TO: a fiduciary who governs the association. Treat them like a board. Do not hand them a single answer or make the decision for them — lay out the relevant facts, give 2 to 3 clear options with the tradeoffs, and state YOUR recommendation. The board decides, often by a vote.

WHAT YOU MAY SHARE: because they govern the association, you may include the community and owner detail relevant to their decision — delinquency status, enforcement stage, financial figures, vendor specifics. This is the one audience where that is appropriate. Never invent a figure, and never repeat it to anyone outside the board.

WHAT YOU STILL MAY NOT DO: you do not, on your own authority, execute a fine waiver, a payment, a spend, an ACC decision, or a legal position, and you do not state a Texas Chapter 209 determination. You recommend, the board acts. If they ask you to just do it, give them the recommendation and the option to direct it — do not report it as already done.

GROUNDING: answer from the CONTEXT below. If it is not there, say you will confirm and follow up rather than guess.

VOICE: concise, professional, decision-oriented, warm but not chatty. No em-dashes, use commas. Write the full message body only, greeting through sign-off, no signature block. Write plain text with no markdown, asterisks, or headers; put each option on its own short numbered line.`;

const AMANDA_VENDOR_SYSTEM = (communityName) => `You are Amanda Albright, Senior Community Manager at Bedrock Association Management, writing to a VENDOR or service provider working with ${communityName || 'one of our communities'}. A human teammate reviews this before it is sent.

WHO YOU ARE WRITING TO: an outside company. You represent Bedrock and the association. Be professional, clear, and specific about what you need from them.

WHAT YOU MAY NOT DISCLOSE, this is a hard line: the association's financials, budget, reserves, current or prior insurance premium, bank or payment details, homeowner delinquency or account data, any individual owner's information, or board deliberations. A vendor needs scope, schedule, and requirements, never the association's books. If answering would require any of that, do not, and say you will follow up.

WHAT YOU MAY NOT DO on your own authority: commit or approve association funds, authorize a spend, agree to a price or a contract, or promise payment or a date for payment. Those require board or management approval. Coordinate the request and say you will confirm and get it approved.

WHAT YOU CAN DO: request or clarify a quote, scope, or schedule; ask for a certificate of insurance, W-9, or documentation; coordinate access and logistics; and set expectations about the approval process.

GROUNDING: answer from the CONTEXT below. If it is not there, say you will confirm and follow up rather than guess.

VOICE: professional, concise, directive. No em-dashes, use commas. Plain text, no markdown or headers. Write the full message body only, greeting through sign-off, no signature block.`;

async function draftAmandaReply({ email, supabase, propertyId, communityId, contactName, communityName }) {
  const senderName = (contactName && String(contactName).trim().split(/\s+/)[0])
    || (String(email.sender_name || '').trim().split(/\s+/)[0]) || 'there';
  const trig = looksLikeEscalation(email);
  const ctx = await propertyContext(supabase, { propertyId, communityId });
  const gate = reservedAsk(email);   // code-detected reserved-decision request
  const audience = await resolveAudience({ email, supabase, communityId, propertyId });

  // The warm ownership acknowledgment — Amanda's pre-2026-08-28 behavior, now
  // the FALLBACK. If grounded generation is unavailable or returns nothing, we
  // send this rather than nothing or a hallucination (CLAUDE.md: always a
  // fallback). Only claims "I pulled your history" when a property resolved.
  const looked = ctx.violations.length || ctx.acc.length || ctx.ar_balance != null;
  const fallbackBody = `Hi ${senderName},\n\n`
    + `Thank you for reaching out, and I'm sorry this has been frustrating. I'm Amanda, the senior manager for ${communityName || 'your community'}, and I've taken personal ownership of getting this sorted.`
    + (looked
      ? `\n\nI've pulled the full history on your property so we're working from the complete picture, not one piece of it. Here's what happens next: I'll review everything end to end, coordinate with the right people on our side, and come back to you with a clear path and a timeline. You won't have to repeat yourself to anyone.`
      : `\n\nHere's what happens next: I'll go through this end to end, coordinate with the right people on our side, and come back to you with a clear path and a timeline. You won't have to repeat yourself to anyone.`)
    + amandaSignoff();

  // GROUNDED GENERATION. Best-effort; any failure falls back to the ownership
  // acknowledgment. The reply is queued as a DRAFT for human review regardless,
  // which is the live safety net while this capability earns its eval fixtures.
  let body = fallbackBody;
  let grounded = false;
  try {
    const { docContext, profileBlock } = await assembleGrounding({ email, communityName });
    const accountFacts = [
      ctx.violations.length ? `Open violations: ${ctx.violations.map((v) => `${v.category || 'violation'} (stage ${v.stage})`).join('; ')}` : null,
      ctx.ar_balance != null && Math.abs(ctx.ar_balance) > 0.5 ? `Account balance: ${ctx.ar_balance > 0 ? 'owes' : 'credit'} $${Math.abs(ctx.ar_balance).toFixed(2)}` : null,
      ctx.acc.length ? `Open ACC/architectural items: ${ctx.acc.map((a) => a.project_summary || a.decision_type).filter(Boolean).join('; ')}` : null,
    ].filter(Boolean).join('\n') || 'No account facts resolved for this sender.';

    const userContent = `THE RESIDENT'S MESSAGE:\nFrom: ${contactName || email.sender_name || 'a resident'}\nSubject: ${email.subject || '(none)'}\n\n${email.body || email.body_preview || ''}\n\n`
      + `THIS RESIDENT'S ACCOUNT (private to them — use to inform your reply, never quote another resident's data):\n${accountFacts}\n\n`
      + `COMMUNITY FACTS:\n${(audience === 'homeowner' || audience === 'board' || audience === 'staff') ? (profileBlock || 'None available.') : 'Withheld. This audience does not receive the association\'s internal community data.'}\n\n`
      + `GOVERNING DOCUMENTS & RULES retrieved for this question:\n${docContext || 'None retrieved.'}\n\n`
      + (gate.allow ? '' : (audience === 'board'
        ? `RESERVED REQUEST DETECTED — this asks for a decision reserved to the board acting as a body. Give 2 to 3 options with the tradeoffs and your recommendation for the board's decision. Do not report the decision as already made.\n\n`
        : `RESERVED REQUEST DETECTED — the sender is asking you to ${gate.reason.replace(/_/g, ' ')}, which you have NO authority to grant, deny, or decide. Do not state or imply a decision. Acknowledge it, explain what you can (what the rule says or where it stands), and say you are bringing it to the board or the team with your recommendation, with a next step and a timeline.\n\n`))
      + `Draft Amanda's reply to ${senderName}.`;

    const system = ({ board: AMANDA_BOARD_SYSTEM, vendor: AMANDA_VENDOR_SYSTEM }[audience] || AMANDA_SYSTEM)(communityName);

    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 1200,
      system,
      messages: [{ role: 'user', content: userContent }],
    });
    const out = cleanModelBody((resp.content || []).map((b) => b.text || '').join(''));
    console.log('[amanda_reply] grounded draft:', JSON.stringify({ outLen: out.length, docCtx: docContext.length, profile: profileBlock.length }));
    if (out.length > 40) { body = out; grounded = true; }
  } catch (e) {
    console.warn('[amanda_reply] grounded generation failed, using fallback:', e.message);
  }

  return {
    draftable: true, careful: true,
    subject: `Re: ${email.subject || 'your message'}`,
    body,
    review_hint: reviewHint(trig.reasons, ctx) + ` · aud:${audience}` + (grounded ? ' · grounded' : ' · ownership-ack (fallback)') + (gate.allow ? '' : ` · RESERVED:${gate.reason}`),
    context: ctx,
  };
}

module.exports = { draftAmandaReply, looksLikeEscalation, reservedAsk, pickAudience };
