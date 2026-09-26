// academy/team/ruling_guard.js  (sandbox; not loaded by production)
// ----------------------------------------------------------------------------
// Substantive-ruling guard (Ed 2026-09-26). When the pre-draft owner classifier
// routes a governance, architectural, accounting, legal, or other specialist
// decision to someone else, the agent replying may:
//   acknowledge the question, summarize known facts, state the handoff, and
//   explain what happens next
// but may NOT make the ruling itself. Applies to every agent, not only Claire.
//
// v1.3 miss this closes (AA-TEAM-001 run 2, Claire -> Amanda):
//   "So yes, they could decide wood fences need approval or limit certain styles
//    through a rule." ... "The board can't do that on its own."
// Allowed:
//   "I've sent this to Amanda because it needs a governance review. She has the
//    documents and your question, so you won't have to start over."
// ----------------------------------------------------------------------------

// Rulings that apply in any domain.
const GENERIC = [
  /\b(so|then),? (yes|no)\b/i,
  /\bthe (short )?answer is (yes|no)\b/i,
  /^(yes|no)[,.!]/i,
];

// Domain rulings, keyed by the owner classifier's signal.
const DOMAIN = {
  governance: [
    /\b(the board|they|the association|you)\s+(can|could|cannot|can'?t|may|may not|is allowed to|are allowed to|is not allowed to|has the (power|authority)|have the (power|authority)|does ?n'?t have the (power|authority)|would need|needs? to|must)\b[^.]{0,80}\b(adopt|change|ban|require|approve|decide|vote|amend|limit|restrict|do (that|this|it))\b/i,
    /\b(can'?t|cannot|can) do (that|this|it) on (its|their) own\b/i,
    /\b(that|this) (would|will) (need|require) (a|an) (member |membership )?(vote|amendment)\b/i,
  ],
  architectural: [
    /\b(will|would|should) (likely |probably )?(be|get) (approved|denied|rejected)\b/i,
    /\b(meets|complies with|satisfies|violates|does ?n'?t meet) (the )?(guidelines|standards|rules|requirements)\b/i,
    /\b(is|looks|seems) (compliant|approvable|fine|allowed|not allowed)\b/i,
    /\byou('re| are) (good|clear|fine) to (start|build|go)\b/i,
  ],
  discrepancy: [
    /\bthe difference is\b/i,
    /\b(the )?(correct|right|accurate) (balance|number|figure|one) is\b/i,
    /\b\$[\d,]+(\.\d\d)? is (the )?(right|correct)\b/i,
    /\b(it'?s|this is) (just |simply |only )?(a )?timing\b/i,
  ],
  posting: [
    /\b(go ahead|you can post|ok to post|okay to post|post it|approved to post)\b/i,
    /\b(this|it|that) (can|should) (be )?(post|reclass)\w*\b/i,
  ],
  legal: [
    /\b(is|was) not harassment\b/i,
    /\bthe (violation|notice|fine|fee) (is|was) (valid|proper|legitimate|correct|justified|enforceable)\b/i,
    /\b(we|the association) (are|were|is|was) within (our|its) rights\b/i,
    /\byou (are|were) in violation\b/i,
    /\b(no|a) (legal )?(basis|grounds) for\b/i,
  ],
  pricing: [/\$\s?[\d,.]+\s*(per|\/)\s*(door|home|unit|month)\b/i, /\b(we|bedrock) (would|will) charge\b/i],
};

function domainFor(owner) {
  const sig = (owner.signals || []).join(' ');
  if (/legal/.test(sig)) return 'legal';
  if (/architectural/.test(sig)) return 'architectural';
  if (/discrepancy/.test(sig)) return 'discrepancy';
  if (/posting/.test(sig)) return 'posting';
  if (/pricing/.test(sig)) return 'pricing';
  if (/governance/.test(sig)) return 'governance';
  return null;
}

function sentences(text) { return String(text || '').split(/(?<=[.!?])\s+|\n+/).map((s) => s.replace(/\*\*/g, '').trim()).filter(Boolean); }

/**
 * @returns guard-shaped violations: { rule, code, sentence, detail }
 */
function rulingViolations({ message, owner, agent }) {
  if (!owner || !owner.handoff_required || !owner.owner || owner.owner === agent) return [];
  const domain = domainFor(owner);
  const patterns = [...GENERIC, ...(domain ? DOMAIN[domain] : [])];
  const out = [];
  for (const s of sentences(message)) {
    // a sentence that only reports what the owner will do is not a ruling
    if (/\b(will|is going to|can) (review|look at|decide|confirm|walk you through|let you know|get back)\b/i.test(s) && !GENERIC.some((re) => re.test(s))) continue;
    const hit = patterns.find((re) => re.test(s));
    if (hit) out.push({ rule: 'SUBSTANTIVE_RULING', code: 'CF_SUBSTANTIVE_RULING_BEFORE_HANDOFF', sentence: s, detail: `this ${domain || 'decision'} belongs to ${owner.owner}, but the sentence makes the ruling` });
  }
  return out;
}

const WHY = 'Ownership sent this decision to someone else. You may acknowledge the question, summarize the known facts, say who has it, and explain what happens next. Leave the ruling to them.';

module.exports = { rulingViolations, domainFor, WHY };
