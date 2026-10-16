// ============================================================================
// lib/amanda/reply_focus.js  (Ed 2026-10-16: "answer the latest sender's point first")
// ----------------------------------------------------------------------------
// THE SCAR. Kevin Thoms (Canyon Gate Treasurer) answered Amanda's camera
// recommendation: he agreed iTech is the direction once the steps are met, but
// disagreed with "proceed" if it meant acting before a fully executed final
// proposal, terms and conditions, and an insurance certificate naming the HOA as
// additional insured. The draft waiting for him was:
//
//   "Hi Treasurer, Thank you for getting Camera Proposals set up, I really
//    appreciate it. We're all set on our end, and I'll reach out if anything
//    else comes up."
//
// It answered nothing. What the drafters actually saw (dumped from production):
//   - the completion-thank-you detector matched "completed" inside the QUOTED
//     copy of Amanda's own reply ("I completed my review"), not Kevin's words,
//     and its template then REPLACED Amanda's draft outright;
//   - the template turned the subject "Camera Proposals" into "getting Camera
//     Proposals set up" and greeted the display name "Treasurer HOA" as "Treasurer";
//   - Amanda's drafter read body_preview (Graph cuts it at about 255 characters,
//     mid-sentence before the insurance certificate), got no thread history (it
//     looked the history up by a row id that does not exist until after insert),
//     and treated a Board officer writing from the role mailbox as audience "other".
//
// This module holds the deterministic parts (CLAUDE.md: a prose rule the model
// ignores must become a check), in the same shape as decision_ready.js:
//   latestMessageText()     the sender's NEW words, quoted history cut off
//   substantiveSignals()    does the new text carry a concern, disagreement,
//                           condition or request (then no generic acknowledgement)
//   senderFirstName()       a real first name, never a role label; falls back to
//                           the signature and then the Board roster by position
//   checkReplyFocus()       generic acknowledgement, point not addressed, point not
//                           first, misread recommendation not clarified, role or
//                           wrong-name salutation, claims the matter is complete
//   retryNote()             the one corrective retry
//   ANSWER_LATEST_RULE      the system-prompt rule for every Amanda reply
// ============================================================================

// ------------------------------------------------------------ latest message
// Where a reply's quoted history starts: Outlook ("From: ... Sent:"), Gmail
// ("On ... wrote:"), "Original Message" separators, underscore rules, ">" quotes.
const QUOTE_START = [
  /^\s*From:\s.*\r?\n\s*(?:Sent|Date):\s/im,
  /^\s*On\s.{4,200}\bwrote:\s*$/im,
  /^\s*-{2,}\s*Original Message\s*-{2,}/im,
  /^\s*_{8,}\s*$/m,
  /^\s*>/m,
];

/** The sender's new text: everything above the first quoted-history marker. */
function latestMessageText(body) {
  const s = String(body || '').replace(/\r\n/g, '\n');
  let cut = s.length;
  for (const re of QUOTE_START) { const m = re.exec(s); if (m && m.index < cut) cut = m.index; }
  return s.slice(0, cut).replace(/\n{3,}/g, '\n\n').trim();
}

/** The quoted history below the new text (context only, never the thing to answer). */
function quotedHistory(body) {
  const s = String(body || '').replace(/\r\n/g, '\n');
  const latest = latestMessageText(s);
  const at = latest ? s.indexOf(latest.slice(-40)) + latest.slice(-40).length : 0;
  return s.slice(Math.max(0, at)).trim();
}

function sentences(text) {
  return String(text || '').replace(/\r\n/g, '\n').split(/(?<=[.?!])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
}

// ----------------------------------------------------------- substance
const DISAGREEMENT = /\b(disagree|don'?t agree|do not agree|object(?:ion)?|concern(?:s|ed)?|not comfortable|uncomfortable|push back|problem with|issue with|misunderst\w*|confus\w*|i (?:read|took|understood) .{1,80} (?:as|to mean))\b/i;
const CONDITION = /\b(without (?:a|an|the|any|first)?|until|unless|only (?:after|once|if|when)|once .{1,60}\b(?:met|complete[d]?|executed|signed|received|in place)|provided that|subject to|before (?:we|the association|the hoa|anything|any|proceeding|signing|we sign))\b/i;
const REQUEST = /\b(please|can you|could you|would you|need (?:you|to|a|the)|i'?d like|we need|i want|make sure)\b|\?/i;
const SIGNOFF = /^(?:thanks?|thank you|regards|best|sincerely|cheers|respectfully)\b[^.]{0,30}$/i;

/**
 * What the sender's NEW text asks of the reply. Returns
 * { substantive, kinds: ['disagreement'|'condition'|'request'], points: [sentence] }.
 */
function substantiveSignals(latestText) {
  const kinds = new Set(); const points = [];
  for (const s of sentences(latestText)) {
    if (SIGNOFF.test(s)) continue;
    let hit = false;
    if (DISAGREEMENT.test(s)) { kinds.add('disagreement'); hit = true; }
    if (CONDITION.test(s)) { kinds.add('condition'); hit = true; }
    if (REQUEST.test(s)) { kinds.add('request'); hit = true; }
    if (hit) points.push(s);
  }
  return { substantive: kinds.size > 0, kinds: [...kinds], points };
}

// -------------------------------------------------------------- names
// A role or mailbox label is never a person's name ("Treasurer HOA", "President HOA").
const ROLE_WORD = /^(?:treasurer|president|vice|vicepresident|vp|secretary|director|directors|board|hoa|poa|association|property|propertymanager|manager|management|committee|chair|chairman|chairperson|member|owner|homeowner|resident|office|admin|accounting|info|support|team)$/i;
const ROLE_LOCAL = /^(?:treasurer|president|vicepresident|vice\.?president|vp|secretary|director\d*|boardmember\d*|board)$/i;

function isRoleLabel(name) {
  const toks = String(name || '').trim().split(/[\s,&/]+/).filter(Boolean);
  if (!toks.length) return false;
  return ROLE_WORD.test(toks[0]) || toks.some((t) => /^(?:hoa|poa|board)$/i.test(t));
}

const firstOf = (s) => {
  s = String(s || '').trim();
  if (!s || s.includes('@') || isRoleLabel(s)) return null;
  if (/^(info|admin|support|billing|accounting|sales|no.?reply|noreply|bedrock|mailer|postmaster|team|office|do.?not.?reply)\b/i.test(s)) return null;
  const first = s.split(/[\s,&/]+/).filter(Boolean)[0] || '';
  return /^[A-Z][A-Za-z'’-]{1,}$/.test(first) ? first : null;
};

/** The name the sender signed with ("Kevin Thoms", "Hugh Durlam, President"), from the new text. */
function signatureFirstName(latestText) {
  const lines = String(latestText || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-10);
  for (const l of lines) {
    const m = /^([A-Z][a-z'’-]+)\s+(?:[A-Z]\.?\s+)?[A-Z][A-Za-z'’-]+(?:\s*,\s*[A-Za-z .]+)?$/.exec(l);
    if (m && !ROLE_WORD.test(m[1]) && !SIGNOFF.test(l) && !/^(?:good|thank|thanks|kind|best|warm)$/i.test(m[1])) return m[1];
  }
  return null;
}

/**
 * The first name to greet: display name unless it is a role label, then the
 * signature in the new text, then the resolved contact, then (async variant)
 * the Board roster by the role the mailbox names. null when none is known.
 */
function senderFirstName(email, contactName) {
  const body = (email && (email.body || email.body_full || email.body_preview)) || '';
  return firstOf(email && email.sender_name) || signatureFirstName(latestMessageText(body)) || firstOf(contactName) || null;
}

/** The role a role mailbox or role display name stands for ("treasurer@..." -> "treasurer"). */
function roleOf(email) {
  const local = String((email && email.sender_email) || '').split('@')[0];
  if (ROLE_LOCAL.test(local)) return local.replace(/\./g, '').replace(/\d+$/, '').toLowerCase();
  const n = String((email && email.sender_name) || '').trim();
  if (isRoleLabel(n)) return n.replace(/\b(?:hoa|poa|board)\b/ig, '').replace(/\s+/g, '').toLowerCase() || null;
  return null;
}

const samePosition = (role, position) => String(position || '').replace(/[^a-z]/gi, '').toLowerCase() === String(role || '').replace(/[^a-z]/gi, '').toLowerCase();

/** Async: the active Board member holding the role a role mailbox names. Read-only. */
async function rosterNameForRole(supabase, communityId, email) {
  const role = roleOf(email);
  if (!supabase || !communityId || !role) return null;
  try {
    const { data, error } = await supabase.from('board_members').select('name, position').eq('community_id', communityId).eq('is_active', true).limit(50);
    if (error) return null;
    const hit = (data || []).filter((b) => samePosition(role, b.position));
    return hit.length === 1 ? firstOf(hit[0].name) : null;
  } catch (_) { return null; }
}

async function resolveSenderFirstName(supabase, communityId, email, contactName) {
  return senderFirstName(email, contactName) || await rosterNameForRole(supabase, communityId, email);
}

// ------------------------------------------------------------- the check
// Generic acknowledgements: never acceptable when the sender raised something.
const GENERIC_ACKS = [
  /\b(?:we'?re|we are|you'?re|you are|i'?m|i am) all set\b/i,
  /\ball set on (?:our|my) end\b/i,
  /\bthanks?(?: you)? for getting [^.?!]{1,80} set up\b/i,
  /\b(?:i'?ll|i will|we'?ll|we will) (?:reach out|let you know|be in touch|follow up) if anything (?:else )?comes up\b/i,
  /\bif anything (?:else )?comes up\b/i,
  /\bnothing (?:else|further|more) (?:is )?(?:needed|required) (?:from you|on your end)\b/i,
  /\bgood to go\b/i,
  /\bclose the loop\b/i,
];
// Claims the matter is finished. Wrong while open items remain.
const COMPLETION_CLAIM = /\b(?:this|the|that) (?:matter|issue|item|project|request) (?:is|has been) (?:now )?(?:complete[d]?|closed|resolved|finalized|wrapped up|taken care of)\b|\beverything is (?:complete|done|finalized|taken care of)\b/i;
// Words that show the reply engages the point (agreeing, clarifying, owning it).
const ENGAGE = /\b(agree|understand|you'?re right|fair point|good point|distinction|to clarify|clarify|i meant|meant|intended|concern|you raised|your point)\b/i;
// Telling the sender they do not disagree, or that they misread, is defensive: it
// argues with their point instead of acknowledging it. The live dry run for Kevin
// opened "We are not in disagreement." (Ed's spec: clarify without becoming defensive.)
const DEFENSIVE = /\b(?:we(?:'re| are) not (?:actually |really )?(?:in )?(?:disagree\w*|at odds)|there (?:is|was) no (?:real )?disagreement|you(?: may)? (?:have )?(?:misunderstood|misread|misinterpreted)|as I (?:clearly )?(?:said|stated|noted|explained|wrote) (?:in my|previously|earlier|before|above))\b/i;
const CLARIFY =/\b(meant|mean|intended|to clarify|clarify|did not mean|didn'?t mean|was not (?:meant|intended|a recommendation)|wasn'?t (?:meant|intended))\b/i;

const STOP = new Set('about above after again against along already also although always among another anything around because been before being below between both cannot could does doing down during each either else enough even ever every first from further have having here into itself just least less made make many might more most much must myself need never once only other ought ours over same shall should since some still such than that their theirs them then there these they thing this those though through thus under until upon very want were what when where whether which while whom whose will with within without would your yours thank thanks review morning afternoon evening email message regards agree disagree however'.split(' '));
const stem = (w) => w.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6);

/** Distinctive terms of the sender's points (stems), to test the reply engages them. */
function salientTerms(points) {
  const out = new Set();
  for (const p of points) for (const w of String(p).split(/[^A-Za-z0-9'’]+/)) {
    const lw = w.toLowerCase();
    if (lw.length >= 5 && !STOP.has(lw)) out.add(stem(lw));
  }
  return [...out];
}

// "disagree with the recommendation to proceed", "your recommendation to sign": the word the sender read.
function misreadTarget(points) {
  for (const p of points) {
    if (!DISAGREEMENT.test(p)) continue;
    const m = /\b(?:recommend(?:ation|ed|s)?|suggest(?:ion|ed)?|advice|you said|your (?:word|wording|phrase))\s+(?:to\s+|that we\s+|that the association\s+)?"?([a-z]{4,})/i.exec(p);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

function greetingLine(draft) {
  const first = String(draft || '').replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).find(Boolean) || '';
  const m = /^(?:hi|hello|hey|dear|good (?:morning|afternoon|evening))\b,?\s*([^,\n:]*)[,:]?\s*$/i.exec(first)
    || /^([A-Z][A-Za-z'’-]+(?:\s+(?:and|&)\s+[A-Z][A-Za-z'’-]+)*)\s*,\s*$/.exec(first);   // a bare "Kevin," opening
  return m ? { line: first, name: m[1].trim() } : null;
}

// The body after the greeting, split into paragraphs.
function paragraphsAfterGreeting(draft) {
  const paras = String(draft || '').replace(/\r\n/g, '\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paras.length && greetingLine(paras[0]) && paras[0].split('\n').length === 1) paras.shift();
  else if (paras.length && greetingLine(paras[0])) paras[0] = paras[0].split('\n').slice(1).join('\n');
  return paras;
}

/**
 * Deterministic check that a reply answers the latest sender. Returns
 * { ok, substantive, issues:[{code, text}] }.
 *   generic_ack            "we're all set", "thanks for getting X set up", "I'll reach out if anything comes up"
 *   claims_complete        says the matter is finished
 *   point_not_addressed    shares too few of the sender's distinctive terms
 *   point_not_first        the first paragraph does not engage the sender's point
 *   misread_not_clarified  the sender read a word of ours differently and the reply never says what it meant
 *   defensive              tells a disagreeing sender they do not disagree, or that they misread
 *   role_salutation        greets a role label ("Hi Treasurer")
 *   wrong_name             greets someone other than the sender
 */
function checkReplyFocus(draft, { latestText = '', senderFirstName: expected = null } = {}) {
  const issues = [];
  const text = String(draft || '');
  const sig = substantiveSignals(latestText);
  const g = greetingLine(text);
  if (g && g.name && isRoleLabel(g.name)) issues.push({ code: 'role_salutation', text: g.line });
  else if (g && expected && g.name && !new RegExp(`\\b${expected}\\b`, 'i').test(g.name)) issues.push({ code: 'wrong_name', text: `${g.line} (sender is ${expected})` });

  if (sig.substantive) {
    for (const s of sentences(text)) {
      if (GENERIC_ACKS.some((re) => re.test(s))) issues.push({ code: 'generic_ack', text: s });
      if (COMPLETION_CLAIM.test(s)) issues.push({ code: 'claims_complete', text: s });
    }
    const terms = salientTerms(sig.points);
    const draftStems = new Set(text.split(/[^A-Za-z0-9'’]+/).filter((w) => w.length >= 5).map(stem));
    const covered = terms.filter((t) => draftStems.has(t));
    const need = Math.min(3, Math.max(1, Math.ceil(terms.length * 0.25)));
    if (covered.length < need) issues.push({ code: 'point_not_addressed', text: `covers ${covered.length} of the sender's terms (${terms.slice(0, 12).join(', ')}); needs ${need}` });
    const firstPara = paragraphsAfterGreeting(text)[0] || '';
    const firstStems = new Set(firstPara.split(/[^A-Za-z0-9'’]+/).filter((w) => w.length >= 5).map(stem));
    if (!ENGAGE.test(firstPara) && terms.filter((t) => firstStems.has(t)).length < 2) issues.push({ code: 'point_not_first', text: firstPara.slice(0, 160) || '(empty)' });
    if (sig.kinds.includes('disagreement')) for (const s of sentences(text)) if (DEFENSIVE.test(s)) issues.push({ code: 'defensive', text: s });
    const target = misreadTarget(sig.points);
    if (target && !(new RegExp(`\\b${target}`, 'i').test(text) && CLARIFY.test(text))) issues.push({ code: 'misread_not_clarified', text: `sender questioned "${target}"; the reply never says what it meant` });
  }
  return { ok: issues.length === 0, substantive: sig.substantive, issues };
}

function retryNote(issues, { senderFirstName: name = null, latestText = '' } = {}) {
  const has = (c) => issues.some((i) => i.code === c);
  const lines = [];
  if (has('generic_ack') || has('claims_complete')) lines.push('- You used a generic acknowledgement or said the matter is settled. The sender raised a concern, condition or request. Remove "all set", "thanks for getting this set up", "I\'ll reach out if anything comes up" and any claim that it is complete; answer what they actually said.');
  if (has('point_not_addressed') || has('point_not_first')) lines.push('- Your first paragraph must answer the sender\'s actual point, in their terms. Their point: ' + substantiveSignals(latestText).points.join(' ').slice(0, 500));
  if (has('misread_not_clarified')) lines.push('- The sender read one of your earlier words differently than you meant it. Say plainly and without defensiveness what you meant and what you did not mean.');
  if (has('defensive')) lines.push('- Do not tell the sender they do not disagree or that they misread you. Acknowledge their point first ("I agree with the distinction you are making"), then clarify what you meant.');
  if (has('role_salutation') || has('wrong_name')) lines.push(`- Greet the sender by name${name ? ` ("${name}")` : ''}, never by a role label such as "Treasurer" or "President".${name ? '' : ' If you do not know their name, use "Good morning," with no name.'}`);
  return `REVISE YOUR DRAFT (answer the latest sender first):\n${lines.join('\n')}\nOffending text: ${issues.map((i) => `"${String(i.text).slice(0, 160)}"`).join(' | ')}`;
}

// --------------------------------------------- related recent instructions
/**
 * Board instructions on other threads in the last 48 hours (Hugh's "scrub the
 * numbers and create an RFP" arrived two minutes before Kevin's reply, under a
 * different subject). Same mailbox, same community or the same sender domain,
 * inbound, a different conversation. Read-only; '' on any failure.
 */
async function relatedRecentInstructions(supabase, { mailbox, communityId, conversationId, senderEmail, receivedAt, excludeId, excludeGraphId } = {}) {
  if (!supabase || !mailbox) return '';
  try {
    const until = receivedAt ? new Date(receivedAt) : new Date();
    const since = new Date(until.getTime() - 48 * 3600 * 1000);
    const { data, error } = await supabase.from('email_messages')
      .select('id, graph_id, conversation_id, sender_name, sender_email, subject, body_full, body_preview, received_at, community_id')
      .eq('mailbox', mailbox).eq('direction', 'inbound')
      .gte('received_at', since.toISOString()).lte('received_at', new Date(until.getTime() + 60 * 1000).toISOString())
      .order('received_at', { ascending: true }).limit(40);
    if (error) return '';
    const domain = String(senderEmail || '').split('@')[1] || '';
    const rows = (data || []).filter((m) => m.conversation_id !== conversationId && m.id !== excludeId && !(excludeGraphId && m.graph_id === excludeGraphId)
      && ((communityId && m.community_id === communityId) || (domain && String(m.sender_email || '').toLowerCase().endsWith('@' + domain.toLowerCase()))));
    if (!rows.length) return '';
    return rows.slice(-6).map((m) => `[${String(m.received_at).slice(0, 16).replace('T', ' ')} UTC, ${m.sender_name || m.sender_email}, "${m.subject || ''}"]: ${latestMessageText(m.body_full || m.body_preview || '').replace(/\s+/g, ' ').slice(0, 600)}`).join('\n');
  } catch (_) { return ''; }
}

const ANSWER_LATEST_RULE = `ANSWER THE LATEST SENDER FIRST (Ed's standing rule for every reply):
- Read THE LATEST MESSAGE and answer that sender's actual point in your first paragraph, in their terms. The quoted history and earlier correspondence are context, not the thing you are answering.
- When they raise a concern, a disagreement, a condition or a request, never answer with a generic acknowledgement: no "we're all set", no "thanks for getting this set up", no "I'll reach out if anything else comes up", and never say the matter is complete while items remain open.
- When they appear to have read your earlier recommendation differently than you meant it, first acknowledge their point in their terms (for example "I agree with the distinction you are making"), then clarify directly: say what you meant and what you did not mean. Never tell them they do not disagree or that they misread you. If the protections they ask for are consistent with what you intended, say so plainly.
- When a Board member has since given an instruction on the same matter (see RELATED RECENT INSTRUCTIONS), say what you are doing about it now.
- Be concise and Board-appropriate: a reply to one Board member's point is a few short paragraphs, roughly 150 words. Do not repeat your earlier analysis or re-list the open items as a numbered recap; name them in a sentence.
- Greet the sender by their first name. Never greet a role label such as "Treasurer" or "President".`;

module.exports = {
  latestMessageText, quotedHistory, substantiveSignals, senderFirstName, signatureFirstName, resolveSenderFirstName,
  rosterNameForRole, roleOf, isRoleLabel, checkReplyFocus, retryNote, relatedRecentInstructions, ANSWER_LATEST_RULE,
  GENERIC_ACKS, COMPLETION_CLAIM,
};
