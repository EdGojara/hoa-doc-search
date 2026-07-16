// ============================================================================
// lib/email/draft_reply.js  (Ed 2026-07-06) — Claire drafts the RIGHT answer
// ----------------------------------------------------------------------------
// Ed's direction: Claire should put together what she thinks is the correct
// answer using everything the system knows — the homeowner's account data,
// Texas §209, the community's governing documents — and Ed reviews every one;
// NOTHING is released until he's read it and agreed or edited it.
//
// So this drafts a SUBSTANTIVE, grounded reply, not a punt:
//   1. ACCOUNT DATA — the homeowner's open violations (stage + cure date),
//      balance, property — so account-specific answers are correct.
//   2. KNOWLEDGE — getRelevantChunks() over the community's governing docs +
//      Texas §209 (the SAME hybrid retrieval askEd + voice-Claire use — one
//      source of truth, no parallel silo).
//   3. Claire answers grounded in both, in Bedrock's voice, never inventing a
//      fee/rule/deadline that isn't in the retrieved knowledge.
//
// Guardrails (the human gate does the rest — approve-to-send, Ed reads all):
//   - `careful:true` on compliance classes (legal / violation / ACC / financial)
//     so the board flags them for extra scrutiny.
//   - Even grounded, the draft EXPLAINS/RECOMMENDS the §209 or governing-doc
//     basis; it does not autonomously issue a final binding ruling, grant/deny
//     an approval, or waive a fee — Ed makes that call on review. The formal
//     §209 letters / ACC decisions still go through their own renderers.
//   - spam / internal → no draft.
// ============================================================================
const Anthropic = require('@anthropic-ai/sdk');
const { CASUAL_TONE } = require('../tone');
const { getRelevantChunks } = require('../hybrid_retrieval');
const { fetchAttachmentBlocks, fetchMessageText } = require('./graph_attachments');
const { createClient } = require('@supabase/supabase-js');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const MODEL = 'claude-sonnet-4-5';

const NO_DRAFT = new Set(['spam', 'internal']);
const CAREFUL = new Set(['legal_privileged', 'violation_report', 'acc_request', 'vendor_financial']);
const DRAFTABLE = new Set(['homeowner_request', 'vendor_general', ...CAREFUL]);

// Claire suggests looping a teammate in BEFORE replying, when the right answer
// depends on a fact a human should verify (a disputed photo/record, a money
// question, a legal posture). One short sentence naming what to check + who by
// role — advisory only; the reply still drafts. Returns a string or null.
async function suggestReviewer({ classification, subject, bodyText }) {
  try {
    const r = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 70,
      messages: [{ role: 'user', content: `A homeowner emailed an HOA management company (classification: ${classification}). Before the team sends a reply, should a specific Bedrock teammate verify something or be looped in first? If yes, answer with ONE short sentence naming WHAT to check and WHO by role — e.g. "Have a field inspector confirm the violation photo matches this address before replying," or "Have accounting confirm the balance before we commit to a number." If nothing needs a second person, answer EXACTLY: NONE.\n\nSubject: ${subject || ''}\n${(bodyText || '').slice(0, 1500)}` }],
    });
    const t = (r.content?.[0]?.text || '').trim();
    if (!t || /^none\b/i.test(t)) return null;
    return t.replace(/^["']|["']$/g, '').slice(0, 240);
  } catch (_) { return null; }
}

const money = (c) => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Pull the homeowner's live account context (grounds account-specific answers).
async function accountContext({ contactId, propertyId, contactName }) {
  if (!propertyId && !contactId) return '';
  const lines = [];
  if (propertyId) {
    const { data: prop } = await supabase.from('properties').select('street_address').eq('id', propertyId).maybeSingle();
    if (prop && prop.street_address) lines.push(`Property on file: ${prop.street_address}`);
    const { data: v } = await supabase.from('violations')
      .select('current_stage, opened_at, cure_period_ends_at, primary_category_id, enforcement_categories(label)')
      .eq('property_id', propertyId).is('resolved_at', null).limit(20);
    if (v && v.length) lines.push('Open violations: ' + v.map((x) => `${x.enforcement_categories ? x.enforcement_categories.label : 'violation'} at stage ${x.current_stage}${x.cure_period_ends_at ? ` (cure by ${String(x.cure_period_ends_at).slice(0, 10)})` : ''}, opened ${String(x.opened_at || '').slice(0, 10)}`).join('; '));
    else lines.push('Open violations: none');
    const { data: bal } = await supabase.from('v_homeowner_current_balance').select('balance_cents').eq('property_id', propertyId).maybeSingle();
    if (bal) lines.push(`Account balance: ${money(Number(bal.balance_cents) || 0)}${bal.balance_cents > 0 ? ' (owes)' : bal.balance_cents < 0 ? ' (credit)' : ' (current)'}`);
  }
  return lines.length ? `ACCOUNT DATA for ${contactName || 'this homeowner'}:\n- ${lines.join('\n- ')}` : '';
}

// Prior back-and-forth so replies feel continuous and personal instead of a
// cold one-off. The thread (Graph conversation_id captures both directions,
// including Claire's own replies) plus a little cross-thread memory of the same
// person — so a repeat correspondent (a staffer asking Claire a second
// question, a homeowner following up) is recognized, not met like a stranger.
async function conversationHistory({ conversationId, senderEmail, currentText }) {
  const msgs = [];
  try {
    if (conversationId) {
      const { data } = await supabase.from('email_messages')
        .select('direction, sender_name, sender_email, subject, body_preview, received_at')
        .eq('conversation_id', conversationId).order('received_at', { ascending: true }).limit(12);
      msgs.push(...(data || []));
    }
    if (senderEmail && msgs.length < 8) {
      const { data } = await supabase.from('email_messages')
        .select('direction, sender_name, sender_email, subject, body_preview, received_at')
        .ilike('sender_email', senderEmail).order('received_at', { ascending: false }).limit(6);
      for (const m of (data || [])) if (!msgs.find((x) => x.received_at === m.received_at && x.subject === m.subject)) msgs.push(m);
    }
  } catch (_) { return ''; }
  if (!msgs.length) return '';
  msgs.sort((a, b) => String(a.received_at).localeCompare(String(b.received_at)));
  const cur = (currentText || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const lines = msgs.slice(-12)
    .map((m) => {
      const who = m.direction === 'outbound' ? 'Claire' : (m.sender_name || m.sender_email || 'Them');
      const text = (m.body_preview || m.subject || '').replace(/\s+/g, ' ').trim();
      return { who, text, key: `${String(m.received_at || '').slice(0, 10)} ${who}` };
    })
    // Drop the current message if it's already in the thread (avoid echoing it).
    .filter((l) => !(cur && l.text.startsWith(cur.slice(0, 60))))
    .map((l) => `[${l.key}] ${l.text.slice(0, 400)}`);
  return lines.join('\n');
}

async function draftReply({ email, classification, contactId, propertyId, communityId, contactName, communityName, arcFormTitle, force, notes, currentDraft, siblings }) {
  // Auto-draft (ingest) skips spam/internal — no point drafting 65k of it. But
  // when Ed EXPLICITLY hits "Draft reply" (force=true), always produce a reply
  // he can send or edit — including internal/staff mail (the staff-interaction
  // training loop). Only truly empty spam degrades to no-draft.
  if (!force && NO_DRAFT.has(classification)) {
    return { draftable: false, careful: false, reason: classification === 'spam' ? 'spam — no reply' : 'internal / system notification — no reply' };
  }
  const careful = CAREFUL.has(classification);
  const internal = classification === 'internal';
  const firstName = (contactName || '').trim().split(/\s+/)[0] || '';

  // The stored body_full was empty for everything ingested before it was
  // captured — fall back to fetching the live body so Claire drafts on the whole
  // message, not just the ~255-char preview. Best-effort.
  let bodyText = email.body_full || '';
  if (!bodyText && email.graph_id && email.mailbox) {
    try { bodyText = await fetchMessageText(email.mailbox, email.graph_id); } catch (_) {}
  }
  if (!bodyText) bodyText = email.body_preview || '';
  const emailText = `${email.subject || ''} ${bodyText}`.trim();

  // Gather grounding — account data + governing-doc/§209 knowledge (best-effort).
  let acct = '', docs = '', convo = '';
  try { acct = await accountContext({ contactId, propertyId, contactName }); } catch (_) {}
  try { docs = (await getRelevantChunks(emailText, communityName || '')) || ''; } catch (_) {}
  try { convo = await conversationHistory({ conversationId: email.conversation_id, senderEmail: email.sender_email, currentText: bodyText }); } catch (_) {}

  // Forwarded PDFs / photos: pull the actual attachments so Claire can READ them
  // and answer, instead of asking the teammate to "forward the details" she was
  // already sent. Best-effort — never breaks the draft.
  // NOTE: do NOT gate on has_attachments — forwarded screenshots arrive as
  // INLINE images, and Outlook reports hasAttachments=false for inline-only
  // mail. Fetch whenever we have the Graph coordinates; the fetch returns fast
  // when there's nothing. (Verified on Martha's "Fw: Eaglewood Board Meeting":
  // has_attachments=false but 4 inline images carried the whole message.)
  let attachBlocks = [], attachSummary = '';
  if (email.graph_id && email.mailbox) {
    try { const a = await fetchAttachmentBlocks(email.mailbox, email.graph_id); attachBlocks = a.blocks; attachSummary = a.summary; } catch (_) {}
  }

  // Claire has to know her own colleagues, same as Emma. A homeowner who writes
  // "I already spoke to Martha about this" must not get a reply that treats
  // Martha as a stranger. (Ed 2026-07-15.)
  const { teamRosterBlock } = require('./team_roster');
  const roster = await teamRosterBlock();

  const sys = `You are Claire, Bedrock Association Management's AI assistant, drafting a reply for a team member to review. This is a DRAFT — a human reads it and approves, edits, or holds it. Your job is to put together the RIGHT answer the way an expert HOA manager who knows Texas Property Code Chapter 209 and this community's governing documents would.
${CASUAL_TONE}
${roster}

GROUNDING — use the ACCOUNT DATA and KNOWLEDGE provided in the message:
- Base every factual claim (a fee, a rule, a deadline, a §209 cure right, an amount owed, a violation stage) on the ACCOUNT DATA or KNOWLEDGE given. Do NOT invent numbers, rules, or citations.
- If the answer needs a specific fact that ISN'T in what you were given, don't guess — say you'll confirm it and follow up.
- Reference the basis in plain language a homeowner understands (e.g. "under Texas §209 you have 30 days to cure" ONLY if the knowledge supports it) — no section-number soup, no document-citation voice.
${careful ? `- COMPLIANCE-SENSITIVE (${classification}): give the accurate grounded answer, but do NOT issue a final binding decision, grant or deny an approval, or waive a fee/fine on your own — explain what applies and the next step. The formal letter/decision follows separately. A person will decide.
- ENFORCEMENT GROUNDS (check before you promise anything): do NOT commit the association to an enforcement action (sending a violation or maintenance notice, citing another owner, opening a case) UNLESS the KNOWLEDGE above shows a specific covenant that imposes the obligation and makes it the association's to enforce. If it is a private matter between owners, a shared-fence cost split, a neighbor's vine/tree/vegetation encroaching, mechanical or equipment noise, or a condition the governing documents assign jointly to the owners, say plainly that the association cannot enforce it. If the KNOWLEDGE does not clearly show a covenant hook, do NOT promise action, say the team will confirm whether it is something the association addresses and follow up. Never insert the association into a neighbor-versus-neighbor dispute it has no authority over.
- DO NOT GIVE LEGAL ADVICE. When you decline enforcement, point the owner to two general options only: (1) speak with their neighbor directly, and (2) contact the appropriate city or county agency to see whether a local ordinance applies. Do NOT name a specific legal remedy, court, or process (no "small claims", no "common law nuisance claim", no naming a specific city hotline like 311), and do NOT tell them they "have a claim". Naming legal strategy is practicing law and it is not the association's role. A homeowner who wants legal options can talk to their own attorney, which you may note in one plain sentence if it fits. Keep it to what the association can and cannot do, plainly and warmly.` : ''}
- Address the SPECIFIC thing they wrote (name the issue/address/request) so it's clear a real person read it.
- LEAD WITH THE PERSON, NOT THE DATA. If they're describing a hardship, a frustration, or a complaint (lost sleep, a leak, a long-running problem), open by acknowledging THAT, warmly and specifically ("I'm sorry you've been dealing with the noise from the unit next to your bedroom" — reference the real detail they gave). Do NOT open a message like that by mechanically reciting their address back at them; it reads cold. Save any address confirmation for where it's naturally useful, or skip it. A brief, genuine acknowledgment first, then the answer.
- Use the ACCOUNT DATA to answer correctly (you already know their property and community, so don't ASK for it), but weave that knowledge in naturally rather than announcing "I see you're at [address]." Only ask for the address if the homeowner is genuinely unidentified (no property/community on file).
${arcFormTitle ? `- They want to build, install, or modify something, and it needs architectural (ACC) approval. Tell them you've ATTACHED the "${arcFormTitle}" for them to complete and return (they can also submit it through their homeowner portal). Briefly say what to include (project description, dimensions/materials/color, and a site plan or photos showing placement), and that the committee reviews it and responds in writing before any work starts. The form is attached automatically on send — reference it as attached, do not paste a link or say you'll "send it separately".` : ''}
- If they're NOT asking a question — a thank-you, a friendly reply, or an update that they've corrected/resolved the issue — don't force an answer. Reply warmly and briefly: thank them for letting us know, tell them we'll note it (and that the team will confirm the correction and close it out where that applies), and invite them to reach out if they need anything else.
- CONTINUE the conversation, don't restart it. If there's a CONVERSATION SO FAR below, pick up where it left off: don't re-introduce yourself, don't repeat what's already been said, and reference the earlier exchange naturally so it reads like an ongoing thread with someone you know. This matters most when a teammate is asking a follow-up.
- FORWARDED HELP REQUESTS: if a teammate forwarded an email (or attached PDFs/photos) and asked you to help respond, the thing to act on is the FORWARDED MESSAGE below and any ATTACHMENTS included. Read them and draft the actual reply to the underlying request. Do NOT ask the teammate to "forward the details" or "send more information" that is already in front of you — use what you were given. If the attachments genuinely don't contain what's needed, name the specific missing item.
${internal
  ? `- This is an INTERNAL message from a Bedrock teammate (not a homeowner). Reply like a warm, helpful colleague — first name, casual, brief. If it's just a friendly note (e.g. welcoming you to the team), reply in kind.
- Your value to staff is being genuinely useful, not just polite. Use everything the system gave you — the ACCOUNT DATA, KNOWLEDGE, and any ATTACHMENTS above. If that data CONFIRMS, ADDS TO, or CONTRADICTS what the teammate said, say so plainly: confirm it ("yep, that invoice is recorded to Canyon Gate"), add the useful detail, or correct it ("heads up, that account still shows $934.24 due — the payment isn't posted yet"). A correction to a teammate is welcome, not rude — lead with the fact.
- If they state something you CAN'T verify from what you were given (like "this has been paid"), do NOT just acknowledge it. Say you'll check it and name exactly what you'll look at (the ledger / the AP record / the account), then confirm back. Never rubber-stamp a claim you couldn't check.
- Do NOT use the formal "Bedrock Association Management" signoff — sign off simply as "Claire" or just end naturally.`
  : `- Sign off with "Bedrock Association Management" on its own line (Claire's AI signature is appended at send). No AI disclaimer in the body, no boilerplate.`}
- Return ONLY the email body text — no subject line, no preamble, no quotes.`;

  const ctx = `Community: ${communityName || '(unknown)'}
Contact: ${contactName || '(name unknown — do not guess a name)'}${firstName ? ` (first name: ${firstName})` : ''}
Classification: ${classification}

${convo ? `CONVERSATION SO FAR (earlier messages in this thread / with this person, oldest first — continue it, don't repeat or restart):\n${convo}\n` : ''}
${acct || 'ACCOUNT DATA: (none linked)'}

KNOWLEDGE (governing docs / Texas §209 / policies retrieved for this question):
${docs ? docs.slice(0, 9000) : '(no matching documents found)'}

THEY WROTE:
Subject: ${email.subject || ''}
${(bodyText || '(no text body — the content is in the attached image(s) below)').slice(0, 8000)}
${attachSummary ? `\n${attachSummary}` : ''}
${(siblings && siblings.length) ? `\nTHE SAME HOMEOWNER ALSO SENT these emails in the same span (they forgot something, or sent more info). Write ONE reply that addresses EVERYTHING together so they get a single coherent answer instead of separate responses — cover each point, and if the notes are all about the same issue treat them as one:\n${siblings.map((s, i) => `--- also sent (${i + 1})${s.subject ? ' — ' + s.subject : ''}:\n${String(s.body || '').slice(0, 2500)}`).join('\n\n')}\n` : ''}
${currentDraft ? `\nCURRENT DRAFT (revise THIS — keep what already works, change what the reviewer's notes ask for):\n${String(currentDraft).slice(0, 4000)}\n` : ''}
${notes ? `\nTHE REVIEWER'S NOTES — this is direction from the human who will send the reply. Incorporate their thoughts and follow their instructions, even if it changes the tone or the position taken (they have decided, and they are the human gate). Weave it in naturally in Claire's voice; do NOT quote the notes verbatim or mention that you were given notes:\n${String(notes).slice(0, 3000)}\n` : ''}
Draft Claire's reply body now.`;

  const resp = await anthropic.messages.create({
    model: MODEL, max_tokens: 800, system: sys,
    messages: [{ role: 'user', content: [{ type: 'text', text: ctx }, ...attachBlocks] }],
  });
  const { stripEmDashes } = require('../tone');
  const body = stripEmDashes(((resp.content[0] && resp.content[0].text) || '').trim());
  const subject = /^re:/i.test(email.subject || '') ? email.subject : `Re: ${email.subject || 'your message'}`;
  // Claire flags when a teammate should verify something before this goes out
  // (compliance-sensitive mail only, to keep it signal not noise).
  let review_hint = null;
  if (careful) { try { review_hint = await suggestReviewer({ classification, subject: email.subject, bodyText }); } catch (_) {} }
  return { draftable: true, careful, subject, body, review_hint, grounded: { account: !!acct, knowledge: !!docs } };
}

module.exports = { draftReply, DRAFTABLE, CAREFUL, NO_DRAFT, suggestReviewer };
