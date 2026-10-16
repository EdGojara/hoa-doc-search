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
// A request for management WORK Amanda can start now ("can you scrub the numbers ... and create an RFP").
const WORK_VERB = '(?:create|prepare|prep|draft|write|put together|build|scrub|compare|review|pull together|pull|summari[sz]e|set up|send|get|update|clean up|redo|revise|organi[sz]e)';
const WORK_REQUEST = new RegExp(`\\b(?:(?:can|could|would|will) you(?: please)?|please|i need you to|we need you to|i'?d like you to)\\b[^.?!]{0,40}?\\b${WORK_VERB}\\b`, 'i');
// The work produces something that goes OUT (to vendors, owners, the public): it comes back for review first.
const OUTWARD_DOC = /\b(?:rfp|request for (?:proposals?|bids?)|bid (?:package|request)|invitation to bid|notice|letter|announcement|newsletter|mailing)\b/i;

/**
 * What the sender's NEW text asks of the reply. Returns
 * { substantive, kinds: ['disagreement'|'condition'|'request'|'work'], points: [sentence], outward }.
 */
function substantiveSignals(latestText) {
  const kinds = new Set(); const points = []; let outward = false;
  for (const s of sentences(latestText)) {
    if (SIGNOFF.test(s)) continue;
    let hit = false;
    if (DISAGREEMENT.test(s)) { kinds.add('disagreement'); hit = true; }
    if (CONDITION.test(s)) { kinds.add('condition'); hit = true; }
    if (REQUEST.test(s)) { kinds.add('request'); hit = true; }
    if (WORK_REQUEST.test(s)) { kinds.add('work'); hit = true; if (OUTWARD_DOC.test(s)) outward = true; }
    if (hit) points.push(s);
  }
  return { substantive: kinds.size > 0, kinds: [...kinds], points, outward };
}

// ---------------------------------------------------- settled constraints
// A Board instruction that already decided something ("we are only interested in
// purchasing the hardware, having it installed, and cloud storage/access. We are not
// interested in any monitoring."). Hugh's RFP draft asked him again whether
// monitoring should be required or optional (Ed 2026-10-16).
const CONSTRAINT = /\b(?:(?:we are|we're|we|i am|i'm) (?:only |not )(?:interested|looking)|only interested in|not interested in|(?:do not|don'?t|does not|doesn'?t) want|no (?:\w+ ){0,2}(?:monitoring|maintenance|contract|subscription)|must (?:be|include|not|have)|has to (?:be|include)|we want|(?:is|are) required|we require|under no circumstances|do not include|exclude)\b/i;

/**
 * Settled constraints from Board messages: [{ text, from, at, topics:[stem] }].
 * `messages` are { sender_name, sender_email, direction, body_full|body_preview, received_at }.
 * Only inbound Board text counts (our own replies are not the Board deciding).
 */
function settledConstraints(messages) {
  const out = [];
  for (const m of messages || []) {
    if (m.direction && m.direction !== 'inbound') continue;
    for (const s of sentences(latestMessageText(m.body_full || m.body_preview || ''))) {
      const hit = SIGNOFF.test(s) ? null : CONSTRAINT.exec(s);
      if (!hit || out.some((c) => c.text === s)) continue;
      // Topics from the constraint clause only ("..., but we are only interested in X"),
      // so a lead-in like "different options" never makes every "optional" a re-ask.
      out.push({ text: s, from: m.sender_name || m.sender_email || 'Board', at: m.received_at || null, topics: topicStems(s.slice(hit.index)) });
    }
  }
  return out;
}

// Vendors bundle these: a "maintenance agreement and health monitoring" plan is the
// monitoring question asked again under another name.
const TOPIC_FAMILY = { monito: ['monito', 'mainte', 'health', 'servic', 'subscr'], mainte: ['monito', 'mainte', 'health', 'servic'], cloud: ['cloud', 'storag', 'remote', 'access'], storag: ['cloud', 'storag', 'retent'], instal: ['instal'], hardwa: ['hardwa', 'equipm'] };
const TOPIC_STOP = new Set(['intere', 'purcha', 'having', 'only', 'looki', 'requir', 'includ', 'access', 'remote', 'servic', 'health']);
function topicStems(s) {
  const out = new Set();
  for (const w of String(s).split(/[^A-Za-z]+/)) {
    const st = w.toLowerCase().slice(0, 6);
    if (w.length >= 5 && !STOP.has(w.toLowerCase()) && !TOPIC_STOP.has(st)) for (const f of (TOPIC_FAMILY[st] || [st])) out.add(f);
  }
  return [...out];
}

function settledConstraintsBlock(constraints) {
  if (!constraints || !constraints.length) return '';
  return constraints.map((c) => `- "${c.text}" (${c.from}${c.at ? `, ${String(c.at).slice(0, 10)}` : ''})`).join('\n');
}

/** Open RFP / bid records for the community, so a reply says truthfully where the work lives. Read-only. */
async function openBidRequests(supabase, communityId) {
  if (!supabase || !communityId) return '';
  try {
    const { data, error } = await supabase.from('bid_requests').select('id, title, status, service_category, generated_document, rfp_file_path, bid_deadline, created_at')
      .eq('community_id', communityId).is('closed_at', null).order('created_at', { ascending: false }).limit(5);
    if (error) return `RFP RECORDS: unavailable (${error.message}).`;
    if (!data || !data.length) return '';
    return data.map((b) => `- "${b.title || b.service_category || 'RFP'}" (record ${String(b.id).slice(0, 8)}, status ${b.status || 'unknown'}; RFP document ${b.generated_document || b.rfp_file_path ? 'drafted' : 'not drafted yet'}${b.bid_deadline ? `; bids due ${b.bid_deadline}` : ''}). Nothing has been sent to vendors unless stated here.`).join('\n');
  } catch (e) { return `RFP RECORDS: unavailable (${e.message}).`; }
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
const DEFENSIVE = /\b(?:we(?:'re| are) not (?:actually |really )?(?:in )?(?:disagree\w*|at odds)|(?:we(?:'re| are) )?(?:aligned, )?not (?:really |actually )?in disagreement|there (?:is|was) no (?:real )?disagreement|no disagreement (?:here|between us)|you(?: may)? (?:have )?(?:misunderstood|misread|misinterpreted)|as I (?:clearly )?(?:said|stated|noted|explained|wrote) (?:in my|previously|earlier|before|above))\b/i;
// Acknowledging the sender's concern on its merits (Ed's spec: acknowledge that the protections he asks for are consistent with the intent).
const ACKNOWLEDGE = /\b(?:i agree|agree with|agreed|i (?:don'?t|do not) disagree|you'?re right|you are right|that'?s right|fair (?:point|concern)|valid (?:point|concern)|good (?:point|catch)|well taken|(?:the )?right (?:condition|call|instinct|protections?|question)|right to (?:insist|hold|ask|require)|i understand (?:your|the) concern|consistent with (?:what|my|the intent)|exactly (?:what|the protections?) i (?:intended|meant))\b/i;
const CLARIFY =/\b(meant|mean|intended|to clarify|clarify|did not mean|didn'?t mean|was not (?:meant|intended|a recommendation)|wasn'?t (?:meant|intended))\b/i;

const STOP = new Set('about above after again against along already also although always among another anything around because been before being below between both cannot could does doing down during each either else enough even ever every first from further have having here into itself just least less made make many might more most much must myself need never once only other ought ours over same shall should since some still such than that their theirs them then there these they thing this those though through thus under until upon very want were what when where whether which while whom whose will with within without would your yours thank thanks review morning afternoon evening email message regards agree disagree however'.split(' '));
const stem = (w) => w.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6);

/** Distinctive terms of the sender's points (stems), to test the reply engages them. */
function salientTerms(points) {
  const out = new Set();
  for (const p of points) for (const w of String(p).split(/[^A-Za-z0-9'’]+/)) {
    const lw = w.toLowerCase();
    // Acronyms count ("RFP", "COI"); names of the person being addressed do not.
    if ((lw.length >= 5 && !STOP.has(lw) && lw !== 'amanda') || /^[A-Z]{3,5}s?$/.test(w)) out.add(stem(lw));
  }
  return [...out];
}

// Words of a text as stems, for matching against salientTerms (short acronyms included).
const textStems = (s) => String(s || '').split(/[^A-Za-z0-9'’]+/).filter((w) => w.length >= 5 || /^[A-Z]{3,5}s?$/.test(w)).map(stem);
// "scrub" and "scrubbed" are the same term: a shared 5-letter prefix (or the whole short stem) is a match.
const termIn = (t, stems) => stems.some((d) => d === t || (t.length >= 5 && d.length >= 5 && d.slice(0, 5) === t.slice(0, 5)) || (t.length < 5 && d === t));

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
  const m = /^(?:hi|hello|hey|dear|(?:good )?(?:morning|afternoon|evening))\b,?\s*([^,\n:]*)[,:]?\s*$/i.exec(first)
    || /^([A-Z][A-Za-z'’-]+(?:\s+(?:and|&)\s+[A-Z][A-Za-z'’-]+)*)\s*,\s*$/.exec(first)   // a bare "Kevin," opening
    || /^([A-Z][A-Za-z'’-]+),\s*good (?:morning|afternoon|evening)[.!,]?\s*$/i.exec(first);   // "Hugh, good morning."
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
 *   concern_not_acknowledged  a disagreeing sender's concern is never acknowledged on its merits
 *   role_salutation        greets a role label ("Hi Treasurer")
 *   wrong_name             greets someone other than the sender
 * When the sender asked for work (Hugh: "scrub the numbers ... and create an RFP for me quickly"):
 *   asks_permission        "let me know if you would like me to proceed", "should I go ahead"
 *   gates_on_questions     holds the work until the Board answers ("before I send it, I want to confirm with you")
 *   deferred_start         offers or promises to start later ("I can put together", "I will get started")
 *   not_started            never says the work is underway now
 *   claims_sent            says the requested document is finished, sent or circulated
 *   no_review_step         an outward document (RFP, notice, letter) with no "back to you for review before it goes out"
 *   declines_request       refuses or replaces the requested work with something else
 *   unbacked_action        says she is contacting / confirming with an outside party now, with no record of it
 *   commits_bidders        commits to inviting / soliciting particular vendors (choosing bidders is the Board's call)
 *   bidder_list_missing    an RFP reply that never says a bidder list goes to the Board to confirm
 * With related Board mail:
 *   related_request_ignored  a Board member's work request on another thread about this matter goes unmentioned
 * With settled constraints from the Board's own earlier instructions:
 *   reasks_settled         asks a question the Board already decided ("required or optional" monitoring)
 */
const PERMISSION_ASK = /\b(?:let me know if you(?:'d| would) like (?:me )?to (?:proceed|go ahead|move forward|start|begin)|would you like me to (?:proceed|go ahead|move forward|start|begin)|do you want me to (?:proceed|go ahead|move forward|start|begin)|(?:shall|should) i (?:proceed|go ahead|move forward|start|begin)|let me know (?:how|if) you(?:'d| would) like (?:me )?to proceed|please confirm (?:that )?(?:i|you would like me to) (?:should )?(?:proceed|go ahead)|unless you(?:'d| would)? (?:want|prefer|like) (?:me )?(?:to )?(?:proceed|go|handle it|do (?:it|this|that|something)) differently|unless you (?:say|tell me) otherwise)\b/i;
// Refusing or replacing the requested work ("I'm not building a fresh RFP ... I recommend the Board
// instead approve iTech"): the second Hugh dry run. Matched against the request's own terms.
const DECLINE = /\b(?:i'?m not|i am not|i won'?t|i will not|not going to|rather than|instead of|no need (?:for|to)|don'?t (?:think )?(?:we )?need)\b[^.?!]{0,40}?\b(?:build(?:s|ing)?|creat(?:e|es|ing)|prepar(?:e|es|ing)|draft(?:s|ing)?|issu(?:e|es|ing)|do(?:ing)?|put(?:ting)?|run(?:ning)?|start(?:s|ing)?|go(?:ing)?)\b/i;
const GATING = /\b(?:before i (?:send|finali[sz]e|start|begin|draft|proceed|circulate|issue)[^.?!]{0,80}(?:confirm|know|hear|check with you|your direction)|once i hear back|after i hear back|when i hear back|i (?:want|need|would like|'d like) to confirm with you|(?:need|want) your (?:direction|input|answer|guidance) (?:on|before)|can you (?:confirm|let me know) (?:whether|which|if))\b/i;
const DEFERRED_START = /\b(?:i (?:can|could) (?:put together|prepare|draft|build|create|pull together|start)|i(?:'ll| will) (?:get started|start (?:on|working)|begin (?:on|working)|work on (?:it|that|this) (?:once|after|when))|happy to (?:put together|prepare|draft|build|create))\b/i;
const STARTED_NOW = /\b(?:(?:i am|i'm|we are|we're) (?:now )?(?:creating|preparing|drafting|building|putting together|working on|scrubbing|pulling together|reconciling|writing|starting)|(?:i have|i've) (?:started|begun)|(?:is|are) (?:now )?underway|(?:i am|i'm) on it|starting (?:it|on it|that) now|(?:doing|building|drafting|preparing) (?:it|that|this) now)\b/i;
const CLAIMS_SENT = /\b(?:(?:i have|i've|we have|we've) (?:sent|issued|distributed|circulated|released|finished|finalized|completed) (?:the|it|this|that|out)|(?:the )?(?:rfp|notice|letter|bid (?:package|request)) (?:is|has been|went) (?:out|sent|issued|finished|finalized|complete[d]?|distributed)|(?:attached|enclosed) is the (?:final|completed) (?:rfp|notice|letter))\b/i;
// "I am confirming with iTech whether ..." describes contact with a third party that no
// record shows is happening (the Hugh dry run). Ed's honesty rule: a "now" claim needs a
// record. Vendor questions go into the RFP as bid requirements instead.
const UNBACKED_CONTACT = /\b(?:[Ii] am|I'm|[Ww]e are|[Ww]e're) (?:now |currently |also )?(?:(?:confirming|checking|following up|verifying|clarifying) with|asking|contacting|reaching out to|calling|emailing|(?:requesting|getting|obtaining) [^.?!]{0,40}?\bfrom) (?:the )?(?:vendors?|bidders?|contractors?|[A-Z][\w&.'-]+|[a-z]+[A-Z][\w&.'-]*)\b(?![^.?!]*\b(?:in|through|via) (?:the )?(?:RFP|rfp|bid))/;
// Choosing who bids is a Board decision (Canyon Gate RFP item B-03): a reply never commits to
// inviting, soliciting or contacting particular vendors before the Board confirms the bidder
// list. Ed's review of #216: Hugh's draft said "I will invite iTech and Envera to rebid".
const BIDDER_COMMIT = /\b(?:I(?:'ll| will| am|'m)|we(?:'ll| will| are|'re))\s+(?:also\s+|now\s+)?(?:invit\w*|re-?invit\w*|solicit\w*|reach(?:ing)? out to|send(?:ing)? (?:the RFP|the rfp|it|this|the draft) (?:out )?to|request(?:ing)? (?:bids?|quotes?|proposals?|pricing|rebids?) from|ask(?:ing)? [^.?!]{0,40}\bto (?:re-?)?bid)\b/i;
const BIDDER_LIST_PROPOSED = /\bpropos\w* (?:a |the )?(?:bidder|vendor|bid) list\b[^.?!]{0,80}\b(?:board|you)\b[^.?!]{0,30}\b(?:confirm\w*|approv\w*)/i;
const REVIEW_STEP = /\b(?:for (?:your|the board'?s|board) review|to you (?:and the board )?for review|back to (?:you|the board|hugh|kevin|[A-Z][a-z]+)[^.?!]{0,80}(?:review|approv|before)|(?:review|approv\w*) (?:it|the draft|the rfp)?[^.?!]{0,40}before (?:it|anything|they|we|any(?:thing)? goes|it goes|sending|i send|we send|vendors)|before (?:it|anything|the rfp|any(?:thing)?) (?:goes|is sent|gets sent|goes out|is released|is issued)|nothing (?:goes|will go|is sent|gets sent)(?: out)?(?: to (?:any )?vendors?)? (?:until|before|without))\b/i;
const QUESTIONISH = /\?|\b(?:confirm with you|do you want|would you like|should (?:the|we|i|it|this)|whether (?:to|the|we|you)|required or optional|or (?:optional|required)|which (?:option|vendors?|list|approach) (?:you|the board))\b/i;

// The question puts a choice to the Board (include it or not, required or optional), not a scheduling detail.
const DECISION_FRAME = /\b(?:required|optional|include|included|including|exclude|whether|want|instead|or not|either|add|drop|keep)\b/i;

/**
 * Board work requests on OTHER threads that concern this same matter (Hugh's "scrub the
 * numbers on this proposal and create an RFP" beside Kevin's reply on the proposal).
 * Same matter = the request shares a distinctive term with this thread. `required` are
 * the request's own terms this thread does not already use ("rfp", "scrub", "number"):
 * a reply that acts on it names at least one. [{ text, from, required:[stem] }].
 */
function relatedWorkRequests(relatedRows, threadText) {
  const thread = textStems(threadText);
  const out = [];
  for (const m of relatedRows || []) {
    if (m.direction === 'outbound') continue;
    const sig = substantiveSignals(latestMessageText(m.body_full || m.body_preview || ''));
    if (!sig.kinds.includes('work')) continue;
    const terms = salientTerms(sig.points);
    const shared = terms.filter((t) => termIn(t, thread));
    // Generic work verbs ("create", "prepare") never identify the request; its object does ("rfp", "scrub").
    const required = terms.filter((t) => !termIn(t, thread) && !/^(?:quickl|please|thanks|amanda|soon|today|create|prepar|draft|build|review|send|compar|pull|update|write|organi|revise)/.test(t));
    if (shared.length && required.length) out.push({ text: sig.points.join(' '), from: m.sender_name || m.sender_email || 'Board', required });
  }
  return out;
}

function checkReplyFocus(draft, { latestText = '', senderFirstName: expected = null, constraints = [], relatedRequests = [] } = {}) {
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
    const draftStems = textStems(text);
    const covered = terms.filter((t) => termIn(t, draftStems));
    const need = Math.min(3, Math.max(1, Math.ceil(terms.length * 0.25)));
    if (covered.length < need) issues.push({ code: 'point_not_addressed', text: `covers ${covered.length} of the sender's terms (${terms.slice(0, 12).join(', ')}); needs ${need}` });
    // A one-line lead-in ("Hugh, here is where this stands.") joins the paragraph after it:
    // the check is whether the opening substance answers the point, not the lead-in alone.
    const paras = paragraphsAfterGreeting(text);
    const firstPara = paras[0] && paras[0].split(/\s+/).length < 10 ? paras.slice(0, 2).join(' ') : (paras[0] || '');
    const firstStems = textStems(firstPara);
    const needFirst = sig.kinds.includes('work') ? 1 : 2;
    if (!ENGAGE.test(firstPara) && terms.filter((t) => termIn(t, firstStems)).length < needFirst) issues.push({ code: 'point_not_first', text: firstPara.slice(0, 160) || '(empty)' });
    if (sig.kinds.includes('disagreement')) {
      for (const s of sentences(text)) if (DEFENSIVE.test(s)) issues.push({ code: 'defensive', text: s });
      if (!ACKNOWLEDGE.test(text)) issues.push({ code: 'concern_not_acknowledged', text: 'the sender disagreed and the reply never acknowledges the concern on its merits' });
    }
    const target = misreadTarget(sig.points);
    if (target && !(new RegExp(`\\b${target}`, 'i').test(text) && CLARIFY.test(text))) issues.push({ code: 'misread_not_clarified', text: `sender questioned "${target}"; the reply never says what it meant` });
  }

  if (sig.kinds.includes('work')) {
    // The request's object terms ("rfp", "numbers", "proposal"), to recognize a refusal of THIS work.
    const requested = [...new Set(sig.points.flatMap((p) => p.split(/[^A-Za-z]+/)).filter((w) => w.length >= 3 && !STOP.has(w.toLowerCase()) && !/^(?:can|you|for|and|the|amanda|quickly|please|thanks|could|would|will|create|prepare|draft|build|scrub|me)$/i.test(w)).map((w) => w.toLowerCase().slice(0, 6)))];
    for (const s of sentences(text)) {
      if (PERMISSION_ASK.test(s)) issues.push({ code: 'asks_permission', text: s });
      if (DECLINE.test(s) && requested.some((t) => new RegExp(`\\b${t}`, 'i').test(s))) issues.push({ code: 'declines_request', text: s });
      if (GATING.test(s)) issues.push({ code: 'gates_on_questions', text: s });
      if (DEFERRED_START.test(s)) issues.push({ code: 'deferred_start', text: s });
      if (CLAIMS_SENT.test(s)) issues.push({ code: 'claims_sent', text: s });
      if (BIDDER_COMMIT.test(s)) issues.push({ code: 'commits_bidders', text: s });
      if (UNBACKED_CONTACT.test(s) && !/\b(?:I am|I'm) (?:confirming|checking) (?:that|this) (?:with )?(?:you|the board)\b/i.test(s)) issues.push({ code: 'unbacked_action', text: s });
    }
    if (!STARTED_NOW.test(text)) issues.push({ code: 'not_started', text: 'the reply never says the requested work is underway now' });
    if (sig.outward && !REVIEW_STEP.test(text)) issues.push({ code: 'no_review_step', text: 'an outward document with no review before it goes out' });
    if (/\b(?:rfp|request for (?:proposals?|bids?)|bid (?:package|request)|invitation to bid)\b/i.test(sig.points.join(' ')) && !BIDDER_LIST_PROPOSED.test(text)) issues.push({ code: 'bidder_list_missing', text: 'an RFP reply that never says a bidder list will be proposed for the Board to confirm' });
  }

  // A Board member's request on another thread about this same matter goes unmentioned.
  if (relatedRequests && relatedRequests.length) {
    const stems = textStems(text);
    for (const rq of relatedRequests) if (!rq.required.some((t) => termIn(t, stems))) issues.push({ code: 'related_request_ignored', text: `${rq.from}: "${rq.text.slice(0, 140)}"` });
  }
  // A question about something the Board already decided. Topic match on the question's
  // sentence, with vendor-bundle synonyms (a "maintenance agreement" is the monitoring plan).
  if (constraints && constraints.length) {
    for (const s of sentences(text)) {
      if (!QUESTIONISH.test(s) || !DECISION_FRAME.test(s)) continue;
      const qs = new Set(topicStems(s));
      const hit = constraints.find((c) => (c.topics || topicStems(c.text)).some((t) => qs.has(t)));
      if (hit) issues.push({ code: 'reasks_settled', text: `${s} (already decided: "${hit.text}")` });
    }
  }
  return { ok: issues.length === 0, substantive: sig.substantive, issues };
}

function retryNote(issues, { senderFirstName: name = null, latestText = '' } = {}) {
  const has = (c) => issues.some((i) => i.code === c);
  const lines = [];
  if (has('generic_ack') || has('claims_complete')) lines.push('- You used a generic acknowledgement or said the matter is settled. The sender raised a concern, condition or request. Remove "all set", "thanks for getting this set up", "I\'ll reach out if anything comes up" and any claim that it is complete; answer what they actually said.');
  if (has('point_not_addressed') || has('point_not_first')) lines.push('- Your first paragraph must answer the sender\'s actual point, in their terms. Their point: ' + substantiveSignals(latestText).points.join(' ').slice(0, 500));
  if (has('misread_not_clarified')) { const w = (issues.find((i) => i.code === 'misread_not_clarified').text.match(/"([a-z]+)"/) || [])[1]; lines.push(`- The sender read one of your earlier words differently than you meant it${w ? `: they wrote "${w}"; use that word` : ''}. Say plainly and without defensiveness what you meant by it and what you did not mean.`); }
  if (has('concern_not_acknowledged')) lines.push('- Acknowledge the sender\'s concern on its merits ("I agree that ...", "those protections are consistent with what I intended") before or while you clarify.');
  if (has('defensive')) lines.push('- Do not tell the sender they do not disagree or that they misread you. Acknowledge their point first ("I agree with the distinction you are making"), then clarify what you meant.');
  if (has('asks_permission') || has('gates_on_questions') || has('deferred_start') || has('not_started')) lines.push('- The sender asked you to do the work and you have what you need to begin. Say you are doing it now. Do not ask permission to proceed, do not hold it behind questions, and do not offer to start later. Routine choices (which vendors to invite, how to format the document) are yours to make; state the choice you made. Ask only about something that truly blocks the work.');
  if (has('declines_request')) lines.push('- The sender asked for specific work. Do that work. You may note a different earlier recommendation in one sentence, but never refuse the request or substitute your own plan for it.');
  if (has('claims_sent')) lines.push('- Do not say the document is finished, sent or circulated. It is being drafted.');
  if (has('commits_bidders') || has('bidder_list_missing')) lines.push('- Choosing which vendors bid is the Board\'s decision. Do not name vendors you will invite or say you will invite, contact or send the RFP to anyone. Say exactly: "I\'ll propose a bidder list for the Board to confirm."');
  if (has('unbacked_action')) lines.push('- Do not say you are contacting, confirming with or asking a vendor or other outside party now; nothing shows that is happening. Put open vendor questions into the RFP as requirements every bidder must answer.');
  if (has('no_review_step')) lines.push('- Say the draft comes back to the sender (or the Board) for review before anything goes out.');
  if (has('related_request_ignored')) lines.push('- A Board member has asked for work on this same matter in another email (see RELATED RECENT MESSAGES). Say in one sentence what you are doing about it now: ' + issues.filter((i) => i.code === 'related_request_ignored').map((i) => i.text).join(' | '));
  if (has('reasks_settled')) lines.push('- You asked about something the Board already decided (see SETTLED CONSTRAINTS). Treat that decision as a hard requirement and state it; do not ask again.');
  if (has('role_salutation') || has('wrong_name')) lines.push(`- Greet the sender by name${name ? ` ("${name}")` : ''}, never by a role label such as "Treasurer" or "President".${name ? '' : ' If you do not know their name, use "Good morning," with no name.'}`);
  return `REVISE YOUR DRAFT (answer the latest sender first):\n${lines.join('\n')}\nOffending text: ${issues.map((i) => `"${String(i.text).slice(0, 160)}"`).join(' | ')}`;
}

// --------------------------------------------- related recent instructions
/**
 * Board instructions on other threads in the last 48 hours (Hugh's "scrub the
 * numbers and create an RFP" arrived two minutes before Kevin's reply, under a
 * different subject). Same mailbox, same community or the same sender domain,
 * a different conversation. Includes our own replies to that Board (Hugh's RFP
 * request follows Amanda's camera recommendation on another thread).
 * relatedRecentMessages returns the rows; relatedRecentInstructions formats them.
 * Read-only; [] / '' on any failure.
 */
async function relatedRecentMessages(supabase, { mailbox, communityId, conversationId, senderEmail, receivedAt, excludeId, excludeGraphId } = {}) {
  if (!supabase || !mailbox) return [];
  try {
    const until = receivedAt ? new Date(receivedAt) : new Date();
    const since = new Date(until.getTime() - 48 * 3600 * 1000);
    const { data, error } = await supabase.from('email_messages')
      .select('id, graph_id, conversation_id, direction, sender_name, sender_email, recipients, subject, body_full, body_preview, received_at, community_id')
      .eq('mailbox', mailbox)
      .gte('received_at', since.toISOString()).lte('received_at', new Date(until.getTime() + 60 * 1000).toISOString())
      .order('received_at', { ascending: true }).limit(60);
    if (error) { console.warn('[reply_focus] related messages read failed:', error.message); return []; }
    const domain = (String(senderEmail || '').split('@')[1] || '').toLowerCase();
    const onDomain = (addr) => domain && String(addr || '').toLowerCase().endsWith('@' + domain);
    return (data || []).filter((m) => m.conversation_id !== conversationId && m.id !== excludeId && !(excludeGraphId && m.graph_id === excludeGraphId)
      && (m.direction === 'outbound'
        ? (Array.isArray(m.recipients) ? m.recipients : []).some(onDomain)
        : ((communityId && m.community_id === communityId) || onDomain(m.sender_email)))).slice(-8);
  } catch (e) { console.warn('[reply_focus] related messages failed:', e.message); return []; }
}

function formatRelated(rows) {
  return (rows || []).map((m) => {
    const who = m.direction === 'outbound' ? 'Amanda (us)' : (m.sender_name || m.sender_email);
    const body = m.direction === 'outbound' ? String(m.body_full || m.body_preview || '').slice(0, 2500) : latestMessageText(m.body_full || m.body_preview || '').slice(0, 600);
    return `[${String(m.received_at).slice(0, 16).replace('T', ' ')} UTC, ${who}, "${m.subject || ''}"]: ${body.replace(/\s+/g, ' ')}`;
  }).join('\n');
}

async function relatedRecentInstructions(supabase, opts = {}) {
  return formatRelated(await relatedRecentMessages(supabase, opts));
}

/** Board messages in this conversation (for settled constraints). Read-only. */
async function conversationMessages(supabase, conversationId) {
  if (!supabase || !conversationId) return [];
  try {
    const { data, error } = await supabase.from('email_messages').select('id, graph_id, direction, sender_name, sender_email, body_full, body_preview, received_at')
      .eq('conversation_id', conversationId).order('received_at', { ascending: true }).limit(20);
    if (error) { console.warn('[reply_focus] conversation read failed:', error.message); return []; }
    return data || [];
  } catch (_) { return []; }
}

const ANSWER_LATEST_RULE = `ANSWER THE LATEST SENDER FIRST (Ed's standing rule for every reply):
- Read THE LATEST MESSAGE and answer that sender's actual point in your first paragraph, in their terms. The quoted history and earlier correspondence are context, not the thing you are answering.
- When they raise a concern, a disagreement, a condition or a request, never answer with a generic acknowledgement: no "we're all set", no "thanks for getting this set up", no "I'll reach out if anything else comes up", and never say the matter is complete while items remain open.
- When they appear to have read your earlier recommendation differently than you meant it, first acknowledge their point in their terms (for example "I agree with the distinction you are making"), then clarify directly: say what you meant and what you did not mean. Never tell them they do not disagree or that they misread you. If the protections they ask for are consistent with what you intended, say so plainly.
- When a Board member has since given an instruction on the same matter (see RELATED RECENT INSTRUCTIONS), say what you are doing about it now.
- Be concise and Board-appropriate: a reply to one Board member's point is a few short paragraphs, roughly 150 words. Do not repeat your earlier analysis or re-list the open items as a numbered recap; name them in a sentence.
- SETTLED CONSTRAINTS are decisions the Board already made. Treat each as a hard requirement, state it as the governing scope, and never ask about it again (if a vendor bundles it under another name, such as a "maintenance and health monitoring plan", it is still excluded or optional per that decision).
- A Board member's explicit request for work is the instruction and supersedes your earlier recommendation (Hugh asked for an RFP after you advised against a new bidding cycle: build the RFP). Never refuse it or substitute your own plan; if you see a real risk, note it in one sentence and still do the work.
- When the sender asks you to do work and you have enough to begin, begin it and say so ("I am preparing the RFP now"). Do not ask permission to proceed, do not hold the work behind questions, and do not offer to do it later. Routine management choices (structure, format, proposed schedule) are yours: make them and state them. Ask only about something that genuinely blocks the work.
- Choosing which vendors bid is the Board's decision. In an RFP reply never name vendors you will invite and never say you will invite, contact or send the RFP to anyone; say "I'll propose a bidder list for the Board to confirm."
- Never say a document is finished, sent or circulated unless the RFP RECORDS or the thread show it. Never say you are contacting, confirming with or asking a vendor now unless the context shows that request exists; put open vendor questions into the RFP as requirements every bidder answers. Anything that goes out to vendors, owners or the public comes back to the sender or the Board for review first; say so.
- Greet the sender by their first name. Never greet a role label such as "Treasurer" or "President".`;

// ------------------------------------------------ the shared ordinary-reply path
// One helper pair so every ordinary reply drafter gets the same fix (Ed 2026-10-16:
// "fix it in the shared ordinary email reply path, not for Kevin and Hugh only").
// Used by lib/community/amanda_reply.js, lib/email/draft_reply.js (Claire and every
// specialist, the inbox "Draft reply" button) and lib/email/persona_reply.js (the
// Kat / Amanda / Reese / Paige re-draft).

/**
 * Everything a drafter needs to answer the latest sender. Read-only, best-effort.
 * Related messages, Board constraints from other threads and RFP records are read
 * only for a verified Board sender: for anyone else the "same domain" would be
 * gmail.com, and other residents' mail must never reach a reply.
 * Returns { latestText, quoted, senderFirstName, signals, settled, related, rfpRecords, audience, promptBlock }.
 */
async function gatherReplyContext(supabase, email, { communityId = null, contactName = null, audience = null, sourceMessageId = null } = {}) {
  const fullBody = (email && (email.body || email.body_full || email.body_preview)) || '';
  const latestText = latestMessageText(fullBody) || fullBody;
  const quoted = quotedHistory(fullBody);
  const senderFirst = await resolveSenderFirstName(supabase, communityId, email || {}, contactName);
  let aud = audience;
  if (!aud && supabase && communityId) {
    try { aud = await require('../team/operator_core').resolveAudience({ email, supabase, communityId }); } catch (_) { aud = null; }
  }
  const selfId = sourceMessageId || (email && email.id) || null;
  const selfGraph = (email && email.graph_id) || null;
  const notSelf = (m) => m.id !== selfId && !(selfGraph && m.graph_id === selfGraph);
  const convRows = (await conversationMessages(supabase, email && email.conversation_id)).filter(notSelf);
  let relatedRows = []; let rfpRecords = '';
  if (aud === 'board') {
    relatedRows = await relatedRecentMessages(supabase, { mailbox: email.mailbox, communityId, conversationId: email.conversation_id,
      senderEmail: email.sender_email, receivedAt: email.received_at, excludeId: selfId, excludeGraphId: selfGraph });
    rfpRecords = await openBidRequests(supabase, communityId);
  }
  // Board decisions bind only Board matters; a homeowner thread's "we want" is not a settled constraint.
  const settled = aud === 'board' ? settledConstraints([...convRows, ...relatedRows]) : [];
  const relatedRequests = aud === 'board' ? relatedWorkRequests(relatedRows, `${latestText}\n${quoted}\n${(email && email.subject) || ''}`) : [];
  const related = formatRelated(relatedRows);
  const signals = substantiveSignals(latestText);
  const questioned = signals.kinds.includes('disagreement') ? misreadTarget(signals.points) : null;
  const promptBlock = `THE LATEST MESSAGE (answer THIS sender's point first${senderFirst ? `; greet them as ${senderFirst}` : ''}):\n${latestText}\n\n`
    + (signals.substantive ? `THEIR POINT (a ${signals.kinds.join(' / ')}; answer it directly, never with a generic acknowledgement): ${signals.points.join(' ')}\n\n` : '')
    + (quoted ? `QUOTED BELOW THEIR MESSAGE (earlier messages, including our own; context only, do not answer them again):\n${quoted.slice(0, 8000)}\n\n` : '')
    + (settled.length ? `SETTLED CONSTRAINTS (the Board already decided these; hard requirements, state them as the governing scope, never ask about them again):\n${settledConstraintsBlock(settled)}\n\n` : '')
    + (rfpRecords ? `RFP RECORDS IN TRUSTED for this community (where RFP work lives; say truthfully what exists):\n${rfpRecords}\n\n` : '')
    + (related ? `RELATED RECENT MESSAGES WITH THIS BOARD (other threads, last 48 hours; if one is about this matter, act on it):\n${related}\n\n` : '');
  const closing = closingInstruction({ senderFirst, signals, questioned, relatedRequests, settled });
  return { latestText, quoted, senderFirstName: senderFirst, signals, questioned, settled, relatedRequests, related, rfpRecords, audience: aud, promptBlock, closing };
}

/**
 * The last thing the model reads before writing: the sender's point restated after all
 * the context (a long quoted recommendation otherwise sits between the point and the
 * reply), the word they questioned, and the obligations that apply. Same for every path.
 */
function closingInstruction({ senderFirst, signals, questioned, relatedRequests = [], settled = [] }) {
  if (!signals || !signals.substantive) return '';
  const lines = [`WRITE THE REPLY NOW${senderFirst ? ` to ${senderFirst}` : ''}. Greet them by first name. Your first paragraph answers their point: ${signals.points.join(' ')}`];
  if (signals.kinds.includes('disagreement')) lines.push(`Open by acknowledging their concern on its merits, in their terms (for example "I agree with the distinction you are making"). Never tell them they are not disagreeing or that they misread you.`);
  if (questioned) lines.push(`They questioned your word "${questioned}". Use that word: say what you meant by "${questioned}" and what you did not mean.`);
  if (relatedRequests.length) lines.push(`A Board member also asked, on another thread: ${relatedRequests.map((r) => `"${r.text}"`).join(' ')} Say in one sentence what you are doing about it now.`);
  if (settled.length) lines.push('Keep every SETTLED CONSTRAINT as a hard requirement; do not ask about any of them.');
  if (signals.kinds.includes('work')) lines.push('Begin the requested work and say so; do not ask permission or hold it behind questions.');
  return lines.join('\n');
}

/**
 * Run the reply-focus check on a generated body; on failure ask once more through
 * `redraft(note)` (the caller's own model call with the note appended), then
 * return what remains. { body, issues:[code], retried }.
 */
// `extra` (optional): another deterministic check sharing the same single retry, e.g. the
// decision-ready check for a Board reply: (text) => ({ ok, issues:[{code,text}], note }).
async function enforceReplyFocus(body, ctx, redraft, { extra = null } = {}) {
  const opts = { latestText: ctx.latestText, senderFirstName: ctx.senderFirstName, constraints: ctx.settled, relatedRequests: ctx.relatedRequests };
  const run = (txt) => ({ rf: checkReplyFocus(txt, opts), ex: extra ? extra(txt) : { ok: true, issues: [] } });
  let r = run(body);
  let out = body; let retried = false;
  if ((!r.rf.ok || !r.ex.ok) && typeof redraft === 'function') {
    try {
      const note = [!r.ex.ok ? r.ex.note : null, !r.rf.ok ? retryNote(r.rf.issues, opts) : null].filter(Boolean).join('\n\n');
      const again = await redraft(note);
      if (again && String(again).trim().length > 40) { out = String(again).trim(); retried = true; r = run(out); }
    } catch (e) { console.warn('[reply_focus] corrective retry failed:', e.message); }
  }
  return { body: out, issues: [...new Set([...r.rf.issues.map((i) => i.code), ...r.ex.issues.map((i) => `decision-ready:${i.code}`)])], retried };
}

module.exports = {
  gatherReplyContext, enforceReplyFocus, closingInstruction, misreadTarget,
  latestMessageText, quotedHistory, substantiveSignals, senderFirstName, signatureFirstName, resolveSenderFirstName,
  rosterNameForRole, roleOf, isRoleLabel, checkReplyFocus, retryNote, relatedRecentInstructions, relatedRecentMessages, formatRelated, relatedWorkRequests,
  conversationMessages, settledConstraints, settledConstraintsBlock, topicStems, openBidRequests, ANSWER_LATEST_RULE,
  GENERIC_ACKS, COMPLETION_CLAIM,
};
