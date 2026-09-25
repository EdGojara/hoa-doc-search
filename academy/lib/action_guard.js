// academy/lib/action_guard.js  (Amanda Academy v1.2, sandbox)
// ----------------------------------------------------------------------------
// Machine-checkable integrity guard, run on a draft BEFORE it can be shown or
// sent. It checks claims against RECORDS and the CAPABILITY REGISTRY, not the
// model's good intentions:
//
//   1. PAST ACTION CLAIMS   "I checked / emailed / called ..." must match an
//      action record (production: interactions, sent mail, objective_events,
//      tool calls this turn). Negated statements ("I have not called") are not
//      claims.
//   2. CAPABILITY           any first-person action, past OR future, must be
//      something this agent can do (academy/team/capabilities.js). "I'll call
//      the broker" needs make_phone_call; no AI may claim a physical action.
//   3. COMMITMENTS          a promise with a time ("today", "by Friday") needs a
//      recorded commitment with a due time and a tracking capability (Ed
//      2026-09-25). "Now" is immediate action and needs only the capability.
//   4. DEADLINES            a time attached to someone else ("they'll have it by
//      Friday") must appear in the context.
//   5. AUTHORITY            "I will bind / sign / approve / waive / pay" is a
//      board or Ed decision unless the context grants it.
//   6. ORG ROLES            escalation targets must exist in the team directory;
//      no invented "risk team", "VP of operations", "leadership".
//   7. COVERAGE CERTAINTY   "lapsed" / "we're covered" when the record says
//      unconfirmed.
//   8. LEGAL CLAIMS         a statute, chapter, section, or "Texas law" must be
//      in a retrieved source; "commonly 10% or 20%" is a norm, not this
//      community's rule.
//
// The revision request describes each violation and asks for a natural rewrite.
// It never supplies replacement wording (v1.1 pasted its suggested phrases
// verbatim and read robotic).
// ----------------------------------------------------------------------------
const { capabilitiesFor, capabilityForClaim, CAPABILITIES } = require('../team/capabilities');

const VERB_TYPES = {
  check: /\b(checked|looked into|verified|searched|reviewed|pulled)\b/i,
  call: /\b(called|phoned|spoke (with|to)|talked (with|to)|left (a )?(voicemail|message))\b/i,
  email: /\b(emailed|e-mailed|wrote to|messaged|texted)\b/i,
  follow_up: /\b(followed up|pushed (them|him|her|the vendor|for)|chased|nudged|pressed (them|him|her))\b/i,
  confirm: /\b(confirmed)\b/i,
  send: /\b(sent|forwarded|submitted|mailed)\b/i,
  contact: /\b(reached out|contacted|notified|escalated|informed|flagged)\b/i,
  schedule: /\b(scheduled|booked|set up a (call|visit|meeting))\b/i,
  post: /\b(posted|recorded|entered|booked the entry|reclassed|reclassified)\b/i,
  pay: /\b(paid|issued (a|the) (check|payment)|sent (a|the) payment)\b/i,
  approve: /\b(approved|authorized|signed|waived)\b/i,
};

const ADVERBS = '(?:just\\s+|already\\s+|also\\s+|personally\\s+|again\\s+|now\\s+|going\\s+to\\s+|gonna\\s+|about\\s+to\\s+|right\\s+now\\s+)*';
// "I checked", "I've called", "we have already emailed", "I pushed"
const PAST = new RegExp(`\\b(I|we)(?:'ve|\\s+have|\\s+had)?\\s+${ADVERBS}([a-z-]+(?:\\s+[a-z-]+){0,5})`, 'gi');
// "I'll call", "I will go", "I'm calling", "I am going to email", "I can post", "let me call"
const FUTURE = new RegExp(`\\b(?:(I|we)(?:'ll|\\s+will|'m|\\s+am|'re|\\s+are|\\s+can|\\s+plan\\s+to|\\s+intend\\s+to)|let\\s+me)\\s+${ADVERBS}([a-z-]+(?:\\s+[a-z-]+){0,6})`, 'gi');
const NEGATED = /^(not|never|cannot|can'?t|won'?t|don'?t|do not|didn'?t|did not|haven'?t|have not|hadn'?t|am not|'m not|unable)\b/i;
const MODAL_SKIP = /^(will|can|could|would|should|am|'ll|need|want|plan|hope|expect|think|know|understand|see|hear|appreciate|apologize|agree|recommend|suggest|believe|am sorry|sorry|owe|get it|realize)\b/i;

const TIME_PHRASE = /\b(today|tonight|this (morning|afternoon|evening|week)|tomorrow|by (the )?(end of (the )?(day|week|month)|eod|eow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|tonight|close of business|noon|\d{1,2}(:\d\d)?\s*(am|pm)?)|within \d+\s*(hours?|business days?|days?|minutes?)|in the next (day|few days|day or two|\d+ (hours?|days?))|(later|early|end of) this week|next week|before (the )?(weekend|meeting))\b/i;
const DEADLINE = /\b(by (the )?(end of (the )?(day|week|month)|eod|eow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|tonight|close of business)|within \d+\s*(hours?|business days?|days?)|in the next (day|few days|day or two|\d+ (hours?|days?))|(later|early) this week)\b/gi;
const LAPSE = /\b((coverage|policy|insurance)\s+(has\s+)?(lapsed|expired and is gone|is (no longer|not) in force)|(we are|we're|the association is|property is|it is)\s+(currently\s+)?uninsured|real property is uninsured)\b/gi;
const COVERED = /\b(we('re| are) (fully )?(covered|insured)|coverage is (in place|active|in force))\b/gi;
const UNCONFIRMED_CTX = /\b(unconfirmed|not (yet )?confirmed|no (renewal|binder)|have not found|has not been found|not found)\b/i;

// Authority: decisions that belong to the board or Ed (directory AUTHORITY).
// The agent herself is the subject of the decision verb ("I will bind", "we're
// binding it today"); "the board can bind" or "I'll bring the board a quote" pass.
const SELF_AUTH = /\b(?:I|we)(?:'ll|\s+will|'m|\s+am|\s+are|'re|\s+can|\s+would)?\s+(?:going to\s+|also\s+|then\s+|immediately\s+|just\s+|move to\s+)*(bind|binding|sign|signing|approve|approving|waive|waiving|authorize|authorizing|terminate|terminating|reclass|reclassing|reclassify)\b[^.]{0,40}/i;
const AUTHORITY_CTX = /\b(board (approved|authorized|voted|directed)|within (my|manager|management) (spending )?authority|authority to bind|delegated authority)\b/i;

// Escalation targets that do not exist in the team directory.
const INVENTED_ROLE = /\b(?:our|the|my|a)\s+((?:senior\s+)?leadership(?: team)?|risk(?: management)? (?:team|department|contact|manager|group)|risk team|executive team|exec team|management team|operations team|ops team|vp(?: of [a-z]+)?|vice president(?: of [a-z]+)?|director of [a-z]+|head of [a-z]+|supervisor|claims (?:team|department)|insurance (?:team|department)|legal department|e&o carrier|errors and omissions carrier|risk management contact)\b|\bleadership\b(?! (?:of|on) the board)/i;

// Legal: a cited authority must appear in the retrieved context.
const LEGAL_CITE = /\b(chapter \d{2,4}|§\s?\d+(\.\d+)*|\d{3}\.\d{3,5}|property code|texas law|state law|federal law|statut(e|es|ory)|the law (says|requires|allows|permits|limits)|legally (required|allowed|permitted)|under (texas|state|the) (law|statute))\b/gi;
const TYPICAL_NORM = /\b(commonly|typically|usually|often|generally|standard(ly)?|many|most|some)\b[^.]{0,80}\b(\d{1,2}\s?%|declarations|associations|hoas|communities|documents|bylaws)\b[^.]{0,60}\b(\d{1,2}\s?%)?/i;

function sentences(text) { return String(text || '').split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean); }

function firstPersonClaims(text) {
  const out = [];
  for (const s of sentences(text)) {
    for (const [tense, RX] of [['past', PAST], ['future', FUTURE]]) {
      RX.lastIndex = 0;
      let m;
      while ((m = RX.exec(s))) {
        const tail = m[2];
        if (NEGATED.test(tail)) continue;                 // "I have not called" is not a claim
        if (tense === 'past' && MODAL_SKIP.test(tail)) continue;
        if (tense === 'past' && /^(be|been|being)\b/i.test(tail) && !/\bbeen (out )?to the\b/i.test(tail)) continue;
        out.push({ tense, sentence: s, phrase: `${m[1] || 'let me'} ${tail}`, tail });
      }
    }
  }
  return out;
}

// Back-compat for v1.1 callers/tests: past-tense typed claims.
function actionClaims(text) {
  const out = [];
  for (const c of firstPersonClaims(text).filter((x) => x.tense === 'past')) {
    for (const [type, re] of Object.entries(VERB_TYPES)) if (re.test(c.tail)) { out.push({ type, sentence: c.sentence, phrase: c.phrase }); break; }
  }
  const seen = new Set();
  return out.filter((x) => { const k = x.type + '|' + x.sentence; if (seen.has(k)) return false; seen.add(k); return true; });
}

const words = (s) => new Set(String(s || '').toLowerCase().match(/[a-z]{4,}/g) || []);
function matchesCommitment(sentence, commitments) {
  const w = words(sentence);
  return commitments.find((c) => c && c.due && [...words(c.what)].some((x) => w.has(x)));
}

/**
 * @param {object} p
 * @param {string} p.message
 * @param {Array}  [p.actionLog]    [{type, what, at, ref}]
 * @param {string} [p.contextText]  everything the agent was given
 * @param {string} [p.agent]        roster persona key (capability registry)
 * @param {Array}  [p.commitments]  [{what, due, capability}] recorded by the agent
 */
function guard({ message, actionLog = [], contextText = '', agent = 'amanda', commitments = [] }) {
  const violations = [];
  const ctx = String(contextText || '');
  const ctxLower = ctx.toLowerCase();
  const logTypes = new Set(actionLog.map((a) => a.type));
  const caps = capabilitiesFor(agent);
  const push = (v) => violations.push(v);

  // 1 + 2. first-person claims: records (past) and capability (both tenses)
  for (const c of firstPersonClaims(message)) {
    const cap = capabilityForClaim(c.tail);
    if (cap && !caps[cap].enabled) {
      push({ rule: 'CAPABILITY', code: 'CF_CAPABILITY_CLAIM', capability: cap, tense: c.tense, sentence: c.sentence,
        detail: `"${c.phrase}" needs ${cap} (${CAPABILITIES[cap].label}), which ${agent} does not have: ${caps[cap].why}` });
      continue;
    }
    if (c.tense === 'past') {
      for (const [type, re] of Object.entries(VERB_TYPES)) {
        if (!re.test(c.tail)) continue;
        const supported = logTypes.has(type) || (type === 'check' && /\b(search|searched|review(ed)?|checked)\b[^.]{0,60}\b(on|as of) \d/i.test(ctx));
        if (!supported) push({ rule: 'FABRICATED_ACTION', code: 'CF_FABRICATED_ACTION', sentence: c.sentence, detail: `"${c.phrase}" claims something already happened, but there is no ${type} record of it` });
        break;
      }
    }
  }

  for (const s of sentences(message)) {
    const selfFuture = firstPersonClaims(s).some((c) => c.tense === 'future');
    // 3. time-bound self commitments need a recorded, trackable commitment
    if (selfFuture && TIME_PHRASE.test(s)) {
      const rec = matchesCommitment(s, commitments);
      if (!caps.schedule_followup.enabled) push({ rule: 'UNTRACKED_COMMITMENT', code: 'CF_UNTRACKED_COMMITMENT', sentence: s, detail: `promises a time, but ${agent} cannot create a tracked follow-up` });
      else if (!rec) push({ rule: 'UNTRACKED_COMMITMENT', code: 'CF_UNTRACKED_COMMITMENT', sentence: s, detail: 'promises a time with no recorded commitment and due time, so nobody would know if it slipped' });
      else if (rec.capability && caps[rec.capability] && !caps[rec.capability].enabled) push({ rule: 'CAPABILITY', code: 'CF_CAPABILITY_CLAIM', capability: rec.capability, sentence: s, detail: `the recorded commitment needs ${rec.capability}, which ${agent} does not have` });
    } else {
      // 4. a deadline attached to someone else must be in the context
      DEADLINE.lastIndex = 0;
      const d = s.match(DEADLINE);
      if (d) for (const phrase of d) if (!ctxLower.includes(phrase.toLowerCase())) push({ rule: 'FABRICATED_DEADLINE', code: 'CF_FABRICATED_DEADLINE', sentence: s, detail: `"${phrase}" is a date nobody set` });
    }
    // 5. authority
    const a = s.match(SELF_AUTH);
    if (a && !AUTHORITY_CTX.test(ctx)) {
      push({ rule: 'AUTHORITY', code: 'CF_UNAUTHORIZED_DECISION', sentence: s, detail: `"${a[0]}" commits the association; that decision belongs to the board or Ed, not to ${agent}` });
    }
    // 6. invented org roles
    const r = s.match(INVENTED_ROLE);
    if (r) push({ rule: 'INVENTED_ORG_ROLE', code: 'CF_INVENTED_ORG_ROLE', sentence: s, detail: `"${r[0].trim()}" is not anyone in the team directory` });
    // 7. coverage certainty
    if (UNCONFIRMED_CTX.test(ctx)) {
      LAPSE.lastIndex = 0; COVERED.lastIndex = 0;
      const l = s.match(LAPSE); const cv = s.match(COVERED);
      if (l && !/\b(whether|if|not (say|saying)|cannot say|can'?t say|no evidence)\b/i.test(s)) push({ rule: 'UNCONFIRMED_AS_FACT', code: 'CF_UNCONFIRMED_AS_LAPSED', sentence: s, detail: `"${l[0]}" states as fact what the record shows is unconfirmed` });
      if (cv && !/\b(whether|if|confirm)\b/i.test(s)) push({ rule: 'UNCONFIRMED_AS_FACT', code: 'CF_INVENTED_FACT', sentence: s, detail: `"${cv[0]}" asserts coverage the record does not confirm` });
    }
    // 8. legal claims against retrieved sources
    LEGAL_CITE.lastIndex = 0;
    const lg = s.match(LEGAL_CITE);
    if (lg) for (const phrase of lg) {
      const p = phrase.toLowerCase().replace(/^under (the )?/, '');
      const num = (p.match(/\d{2,4}/) || [])[0];
      const inCtx = ctxLower.includes(p) || (num && new RegExp(`(chapter|§|section)\\s?${num}\\b|\\b${num}\\.\\d`).test(ctxLower));
      if (!inCtx) push({ rule: 'UNSOURCED_LEGAL', code: 'CF_INVENTED_LEGAL_AUTHORITY', sentence: s, detail: `cites "${phrase}", which no retrieved source states` });
    }
    const t = s.match(TYPICAL_NORM);
    if (t && /\d{1,2}\s?%|declarations|bylaws/i.test(t[0]) && !ctxLower.includes(t[0].toLowerCase().slice(0, 30))) {
      push({ rule: 'TYPICAL_AS_RULE', code: 'CF_INVENTED_GOVDOC_RULE', sentence: s, detail: 'describes what is common elsewhere; only this community\'s documents answer the question' });
    }
  }

  const seen = new Set();
  return violations.filter((v) => { const k = v.rule + '|' + v.sentence; if (seen.has(k)) return false; seen.add(k); return true; });
}

// Why each rule exists, in plain terms. The model rewrites in its own words.
const WHY = {
  CAPABILITY: 'You cannot do this. Say what you can do (see WHAT YOU CAN ACTUALLY DO) or who on YOUR TEAM handles it.',
  FABRICATED_ACTION: 'It has not happened. Describe what you know and what you are doing next.',
  UNTRACKED_COMMITMENT: 'A promised time needs a recorded commitment (the COMMITMENTS block) or it becomes an unmonitored promise. Either record it or describe the action without a time.',
  FABRICATED_DEADLINE: 'Nobody committed to that date. Say the date is not set yet, or leave timing out.',
  AUTHORITY: 'This is not your decision. Say who decides and what you will bring them.',
  INVENTED_ORG_ROLE: 'That person or group does not exist. Use only people, roles, and queues in YOUR TEAM (the board, Ed, named teammates).',
  UNCONFIRMED_AS_FACT: 'The record does not establish this. Say what is confirmed and what is not.',
  UNSOURCED_LEGAL: 'No retrieved document states this. Say the rule is not on file and what you will pull, or that it goes to legal review.',
  TYPICAL_AS_RULE: 'What other communities do does not answer this one. Leave it out; say what you will pull.',
};

function revisionRequest(violations) {
  return 'Some sentences in your draft are not supported. For each one: what is wrong, and why it matters.\n'
    + violations.map((v, i) => `${i + 1}. "${v.sentence}"\n   Problem: ${v.detail}.\n   Why: ${WHY[v.rule] || ''}`).join('\n')
    + '\nRewrite only what these problems require, in your own voice. Do not reuse stock phrases, do not say the same thing twice, and keep everything else as it was. Keep or update your COMMITMENTS block if you have one. Return only the revised output.';
}

module.exports = { guard, actionClaims, firstPersonClaims, revisionRequest, sentences, WHY };
