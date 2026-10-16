// ============================================================================
// lib/team/intent.js  (Ed 2026-10-16: question-first / intent-first)
// ----------------------------------------------------------------------------
// Before any teammate analyzes documents, drafts a reply or launches a workflow,
// she reads the triggering message and pins down, in a structured object:
//   1. what the sender is actually asking
//   2. the outcome they want
//   3. the constraints or preferences they stated (exclusions are HARD constraints)
//   4. the urgency they communicated
//   5. the decision or guidance they expect from her
//
// Hierarchy for the reply: answer the ask first, support it with trustEd context,
// name the material risks and gaps, recommend the next action. Supporting records
// refine the answer; they never replace the ask. No generic procurement process.
//
// Explicit exclusions override default product and package assumptions (Ed's
// fourth refinement): "no monitoring", "no recurring fees", "not vendor X",
// "not before December" are hard constraints. A recommendation that still includes
// an excluded element must say why (the compelling reason) and name the
// alternatives considered, or it is flagged.
//
// Shared team layer: Amanda uses it now (lib/community/amanda_reply.js,
// lib/amanda/decision_ready.js); other personas can import the same rule + check.
// Deterministic (no model call) so it is testable and cannot be ignored.
// ============================================================================

const INTENT_FIRST_RULE = `QUESTION FIRST. Before you analyze anything, read the sender's message and answer the question they actually asked. The INTENT block below states their ask, the outcome they want, their constraints, their urgency and the guidance they expect. Your opening paragraph must answer that ask directly (for a choice between proposals: which one to move toward and on what conditions). Then support it with the relevant records, name only the material risks and gaps, and say the next action.
Treat every exclusion the sender stated (a service, a recurring cost, a vendor, a timing option) as a hard constraint. Never put an excluded element into your recommendation by default. If the only workable route includes an excluded element, say so plainly, give the compelling reason, name the alternatives you considered (another vendor, an unbundled option, asking the vendor for a version without it), and only then recommend.
If the sender communicated urgency, acknowledge it and say what you are doing to keep things moving. Do not drift into adjacent topics they did not ask about, do not propose restarting a bid or a generic procurement process, and do not present options without the guidance they asked for.`;

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december';
const firstSentences = (t, n = 2) => String(t || '').replace(/\s+/g, ' ').split(/(?<=[.?!])\s+/).slice(0, n).join(' ');

/** Canonical key for an excluded thing, so engines can act on it. */
function exclusionKey(phrase) {
  const p = String(phrase || '').toLowerCase();
  if (/monitor/.test(p)) return 'monitoring';
  if (/recurring|monthly|subscription|ongoing (?:fee|cost)|annual fee/.test(p)) return 'recurring_fees';
  if (/maintenance (?:plan|agreement)/.test(p)) return 'maintenance_plan';
  return p.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'other';
}

/**
 * Structured intent from the triggering message. Pure.
 * Returns { asks[], primary_question, desired_outcome, wants[], constraints:{ exclusions[], preferences[] },
 *           urgency:{ level, signals[] }, expected_guidance }
 */
function extractIntent({ subject = '', body = '', sender_name = null } = {}) {
  const text = `${subject}\n${body}`.replace(/\r/g, '');
  const flat = text.replace(/\s+/g, ' ');
  const asks = [];
  for (const m of flat.matchAll(/([^.?!]*\b(?:would you (?:please )?|could you (?:please )?|can you (?:please )?|please )(?:review|give|send|let us know|advise|recommend|assess|look at|tell us|provide|confirm)[^.?!]*[.?!])/gi)) asks.push(m[1].trim());
  for (const m of flat.matchAll(/([^.?!]*\?)/g)) if (!asks.includes(m[1].trim())) asks.push(m[1].trim());

  const wants = [];
  if (/\b(purchas(?:e|ing) the hardware|buy (?:the )?hardware|own (?:the )?(?:system|equipment|hardware))/i.test(flat)) wants.push('hardware');
  if (/\b(have it installed|having it installed|installation|install)\b/i.test(flat)) wants.push('installation');
  if (/\b(cloud (?:storage|access)|storage\/access|remote (?:access|viewing))/i.test(flat)) wants.push('cloud access/storage');

  const exclusions = [];
  const addEx = (kind, phrase, value = null) => { const key = kind === 'vendor' ? `vendor:${String(value).toLowerCase()}` : kind === 'timing' ? `not_before:${String(value).toLowerCase()}` : exclusionKey(phrase); if (!exclusions.some((e) => e.key === key)) exclusions.push({ kind, key, text: phrase.trim(), value }); };
  for (const m of flat.matchAll(/\b(?:not interested in|do not want|don'?t want|no need for|without|we do not need|we don'?t need)\s+(?:any\s+)?([a-z][a-z /-]{2,40}?)(?=[.,;!?]|\s+(?:and|or|but)\b|$)/gi)) {
    const ph = m[1].trim(); if (/^(it|that|this|them|delay|issue)/i.test(ph)) continue;
    // A capitalized name ("do not want Aegis again") is a vendor, not a service.
    const name = ph.match(/^([A-Z][A-Za-z0-9&]+(?: [A-Z][A-Za-z0-9&]+)?)/);
    if (name && !/^(Any|The|A|An)$/.test(name[1])) { addEx('vendor', m[0], name[1]); continue; }
    addEx(/monitor|recurring|fee|plan|subscription|service/i.test(ph) ? 'service' : 'element', m[0]);
  }
  for (const m of flat.matchAll(/\bno (monitoring|recurring (?:fees?|costs?|charges?)|monthly (?:fees?|charges?)|subscription|maintenance plan)\b/gi)) addEx('service', m[0]);
  for (const m of flat.matchAll(/\b(?:not|never|no) (?:use |using |with |from )?(?:vendor |company )?([A-Z][A-Za-z0-9&]+(?: [A-Z][A-Za-z0-9&]+)?)(?=[.,;!?]|\s|$)/g)) {
    if (/^(I|We|The|This|That|Any|A|An|Monitoring|December|January)$/i.test(m[1])) continue;
    if (/\bnot (?:use|using|with|from|vendor|company)\b/i.test(m[0]) || /\bnot [A-Z]/.test(m[0])) addEx('vendor', m[0], m[1]);
  }
  for (const m of flat.matchAll(new RegExp(`\\bnot (?:before|until) (${MONTHS})\\b`, 'gi'))) addEx('timing', m[0], m[1]);

  const signals = [];
  for (const [re, label] of [
    [/\b(act|move) (?:quickly|fast|soon)\b|\basap\b|\burgent(?:ly)?\b|\bright away\b|\bimmediately\b/i, 'asked to move quickly'],
    [/\b(?:many|several|cameras?) (?:are )?(?:down|out|not working)|\bhave many down\b|\bmany down\b/i, 'equipment is down'],
    [new RegExp(`\\b(?:wouldn'?t|won'?t|will not|can'?t|cannot) (?:be able to )?install[^.]{0,40}\\buntil (${MONTHS})`, 'i'), 'installation already delayed'],
    [/\b(?:resident|someone|car|vehicle) (?:hitting|hit|crashed into) the gate\b|\baggressive\b|\bincident\b/i, 'security incident'],
  ]) { const m = flat.match(re); if (m) signals.push({ label, text: m[0] }); }
  const urgency = { level: signals.length >= 2 ? 'high' : signals.length ? 'elevated' : 'normal', signals };

  const guidance = /\b(assessment|recommend|which (?:one|proposal|vendor|option)|advise|your (?:read|view|opinion))\b/i.test(flat) ? 'recommendation' : asks.length ? 'answer' : 'acknowledge';
  const comparing = /\bproposals?\b|\bbids?\b|\bquotes?\b/i.test(flat);
  const primary = comparing && guidance === 'recommendation'
    ? `Which proposal should we move toward${wants.length ? `, given that we want ${wants.join(', ')}` : ''}${exclusions.length ? `, ${exclusions.map((e) => e.kind === 'vendor' ? `not ${e.value}` : `no ${e.key.replace(/_/g, ' ')}`).join(', ')}` : ''}${urgency.level !== 'normal' ? ', and we need to move quickly' : ''}?`
    : (asks[0] || firstSentences(body, 1));
  const desired = comparing ? `a recommended proposal to move forward with${wants.length ? ` (${wants.join(', ')})` : ''}` : (wants.join(', ') || null);
  return { asks, primary_question: primary, desired_outcome: desired, wants, constraints: { exclusions, preferences: wants }, urgency, expected_guidance: guidance, sender: sender_name || null };
}

/** The INTENT block for a drafting prompt. */
function intentBlock(intent) {
  if (!intent) return '';
  const ex = intent.constraints.exclusions.map((e) => `${e.key} ("${e.text}")`).join('; ') || 'none stated';
  return `INTENT (read from the sender's message before anything else; answer this first):\nQuestion: ${intent.primary_question}\nOutcome wanted: ${intent.desired_outcome || 'not stated'}\nHard constraints (exclusions): ${ex}\nUrgency: ${intent.urgency.level}${intent.urgency.signals.length ? ` (${intent.urgency.signals.map((s) => s.label).join('; ')})` : ''}\nGuidance expected from you: ${intent.expected_guidance}`;
}

// ---------------------------------------------------------------- the check
const paragraphs = (t) => String(t || '').replace(/\r\n/g, '\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
const sentencesOf = (t) => String(t || '').replace(/\r\n/g, '\n').split(/(?<=[.?!])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
const ANSWER = /\b(recommend|preferred (?:direction|vendor|option)|move (?:toward|forward with|ahead with)|my assessment|the answer is|go with)\b/i;
const EXPLAINS = /\b(because|required for|only (?:way|route|option)|no (?:other|alternative)|compelling)\b/i;
const ALTERNATIVES = /\b(alternatives?|other vendors?|another vendor|unbundled|version without|without the|instead)\b/i;
const NOT_INCLUDED = /\b(not (?:part of|included|recommended|in (?:my|the) recommend)|unless|only if|excluded|does not want|do not add|don'?t add|optional)\b/i;
const GENERIC_PROCESS = /\b(issue (?:a |an )?(?:new )?rfp|go back out to bid|re-?bid|restart (?:the )?(?:bid|rfp|procurement)|solicit (?:additional|more|new) (?:bids|proposals|quotes)|request (?:additional|more|new) proposals from other vendors)\b/i;
const COMPANY_NAME = /\b[A-Za-z][A-Za-z0-9&]*(?: [A-Z][A-Za-z0-9&]*)* (?:Monitoring|Security|Systems|Protection)(?:,? (?:Inc|LLC|L\.?P|Corp)\.?)?/g;
const NEGATED_PROCESS = /\b(?:no need to|do not|don'?t|need not|without|rather than|instead of|not)\s+(?:\w+\s+){0,2}(?:issue|go back out|re-?bid|restart|solicit|request)/i;
const URGENCY_ACK = /\b(cameras? (?:are |being )?down|urgen\w*|quickly|keep (?:the )?install\w* (?:moving|on track)|move quickly|time-sensitive|without delay|right away|as soon as|December|installation (?:date|timing|is already)|delay\w*)\b/i;

/**
 * Deterministic check of a reply against the intent. Returns issues:
 *   unanswered_ask        the opening does not answer the sender's question
 *   ignored_constraint    recommends / prices an excluded element with no reason and no alternatives
 *   adjacent_focus        proposes a generic process (rebid / new RFP) the sender did not ask for
 *   options_without_guidance  lists options without the recommendation the sender asked for
 *   urgency_omitted       the sender communicated urgency; the reply never acknowledges it
 */
function checkIntent(text, intent) {
  const issues = [];
  if (!intent) return issues;
  const paras = paragraphs(text).filter((p) => !/^(hi|hello|dear|good (?:morning|afternoon|evening))\b[^.]*,?$/i.test(p));
  const opening = paras.slice(0, 2).join(' ');
  if (intent.expected_guidance === 'recommendation' && !ANSWER.test(opening)) issues.push({ code: 'unanswered_ask', text: `opening does not answer: ${intent.primary_question}` });
  for (const ex of intent.constraints.exclusions) {
    const name = ex.kind === 'vendor' ? String(ex.value) : ex.key === 'monitoring' ? 'monitor' : ex.key === 'recurring_fees' ? '(?:monthly|recurring|/month|per month)' : ex.key.replace(/_/g, ' ');
    const re = new RegExp(ex.kind === 'vendor' ? `\\b${name}\\b` : name, 'i');
    // Company names ("iTech Monitoring, Inc.") are not the excluded service.
    for (const s of sentencesOf(text).map((x) => x.replace(COMPANY_NAME, 'the vendor'))) {
      if (!re.test(s)) continue;
      const recommends = ex.kind === 'vendor' ? /\b(recommend|move (?:toward|forward with)|approve|go with|preferred)\b/i.test(s) : /\b(recommend|approve|include|includes|add|plus|with its|funded)\b/i.test(s) || /\$\s?\d/.test(s);
      if (!recommends) continue;
      if (NOT_INCLUDED.test(s) && ex.kind !== 'vendor') continue;
      if (EXPLAINS.test(text) && ALTERNATIVES.test(text)) continue;
      issues.push({ code: 'ignored_constraint', text: s, constraint: ex.key });
      break;
    }
  }
  // "There is no need to restart the bid process" is the opposite of proposing one.
  const g = sentencesOf(text).find((x) => GENERIC_PROCESS.test(x) && !NEGATED_PROCESS.test(x));
  if (g) issues.push({ code: 'adjacent_focus', text: g.match(GENERIC_PROCESS)[0] });
  const optionLines = String(text || '').split('\n').filter((l) => /^\s*(?:\d+[.)]|option [a-c1-3]\b|[-*]\s+option)/i.test(l)).length;
  if (intent.expected_guidance === 'recommendation' && optionLines >= 2 && !ANSWER.test(String(text || ''))) issues.push({ code: 'options_without_guidance', text: `${optionLines} options without the recommendation asked for` });
  if (intent.urgency.level !== 'normal' && !URGENCY_ACK.test(String(text || ''))) issues.push({ code: 'urgency_omitted', text: `sender said: ${intent.urgency.signals.map((s) => s.text).join('; ')}` });
  return issues;
}

function intentRetryLines(issues, intent) {
  const has = (c) => issues.some((i) => i.code === c);
  const L = [];
  if (has('unanswered_ask')) L.push(`- Your opening does not answer the sender's question. Start by answering it: ${intent ? intent.primary_question : ''}`);
  if (has('ignored_constraint')) L.push(`- You recommended or priced something the sender excluded (${[...new Set(issues.filter((i) => i.code === 'ignored_constraint').map((i) => i.constraint))].join(', ')}). Leave it out of the recommendation, or say why it cannot be avoided and name the alternatives you considered.`);
  if (has('adjacent_focus')) L.push('- You proposed a generic process (a new RFP or rebid) the sender did not ask for. Work with the proposals in hand unless none can work, and say why if so.');
  if (has('options_without_guidance')) L.push('- You listed options without the guidance the sender asked for. Say which one you recommend.');
  if (has('urgency_omitted')) L.push('- The sender said this is urgent. Acknowledge it and say what you are doing now to keep it moving.');
  return L;
}

module.exports = { INTENT_FIRST_RULE, extractIntent, intentBlock, checkIntent, intentRetryLines, exclusionKey };
