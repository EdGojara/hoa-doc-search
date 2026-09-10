// ============================================================================
// lib/voice/fact_fastpath.js  (Ed 2026-09-10)
// ----------------------------------------------------------------------------
// Claire's "fast lane" detector. A homeowner asking a plain OPERATIONAL fact —
// "what day is trash pickup", "when does the pool close", "how do I reach the
// office", "how much are my assessments", "when is the annual meeting" — is
// asking for structured data that ALREADY lives in the community profile block
// (communities.profile, community_facts, community_contacts, amenities). Those
// answers do NOT need the 2-4 second three-way governing-document retrieval.
//
// Measured (2026-09-10, live): "what day is trash pickup" spent 4.4s in
// document retrieval before the model even started — for an answer that is a
// one-line profile fact. The model was never the bottleneck; retrieving PDFs we
// didn't need was.
//
// SAFETY IS THE WHOLE GAME HERE. This fires ONLY on a clear operational-fact
// match AND only when NO governing-doc / compliance signal is present. Anything
// ambiguous falls through to full hybrid retrieval — the safe default. The
// "can I build X" / "how many trees does my corner lot need" class (a hard-won
// correctness fix, see CLAUDE.md tree-count scar) must NEVER reach the fast
// lane, so any doc/compliance token vetoes it outright.
// ============================================================================

// Governing-doc / compliance / rules signals. If ANY of these appears, the
// question is NOT a fast-lane fact — send it through full retrieval. This list
// is intentionally broad: a false veto only costs latency (full retrieval still
// answers correctly); a false fast-lane could skip the documents on a question
// that needed them, which is a correctness bug.
const DOC_SIGNALS = /\b(can i|could i|may i|am i (allowed|permitted)|allowed to|permitted|permission|approv|arc\b|architect|variance|violat|fine|penalt|cure|hearing|deed|restrict|covenant|cc\s?&?\s?rs?|by-?laws?|declaration|rules?|regulation|guideline|build|building|install|construct|erect|remove|replace|fence|paint|roof|shed|pergola|gazebo|deck|patio|driveway|sidewalk|tree|shrub|landscap|pet|animal|dog|cat|parking|rv\b|boat|trailer|rent(al|ing)?|leas(e|ing)|tenant|airbnb|solar|antenna|satellite|flag|sign|holiday|dispute|complain|lawsuit|legal|attorney|estoppel|resale)\b/i;

// Fast-lane intents — plain operational facts held in the profile. Each rule is
// a { topic, ask } pair: BOTH must appear (in any order) for a match, so a stray
// keyword alone never triggers it. `extra`, when present, is an additional
// required token. Order-independence matters: "what DAY does RECYCLING come" and
// "what are the RECYCLING DAYs" must both match.
const FACT_RULES = [
  // Trash / recycling / bulk pickup schedule
  { topic: /\b(trash|garbage|recycl\w*|bulk|waste)\b/i,
    ask: /\b(day|days|pick\s?up|pickup|schedule|when|collect\w*|time)\b/i },
  // Amenity hours (pool, gate, clubhouse, gym, tennis, playground)
  { topic: /\b(pool|gate|clubhouse|club house|gym|fitness|tennis|amenit\w*|playground)\b/i,
    ask: /\b(hours?|open|clos\w*|time|when)\b/i },
  // Office / management hours + contact
  { topic: /\b(office|management|manager|hoa|association)\b/i,
    ask: /\b(hours?|open|clos\w*|when|phone|number|email|contact|call|reach|address)\b/i },
  // Who / how to contact
  { topic: /\b(who (do|should|to)|how (do|can) i)\b/i,
    ask: /\b(call|contact|reach|email|phone)\b/i },
  { topic: /\bcontact\b/i,
    ask: /\b(info\w*|number|phone|email|management|manager|hoa|office)\b/i },
  // Assessments / dues — amount, due date, frequency, how to pay
  { topic: /\b(assessment\w*|dues|hoa fee|association fee|monthly (fee|due)|annual (fee|due))\b/i,
    ask: /\b(how much|amount|cost|when|due|pay\w*|frequency|often|balance)\b/i },
  // Meeting dates (annual / board)
  { topic: /\bmeeting\b/i,
    ask: /\b(when|date|time|schedule|next)\b/i,
    extra: /\b(annual|board|hoa|association)\b/i },
];

/**
 * True when `utt` is a plain operational-fact question answerable from the
 * community profile, with NO governing-doc / compliance signal. Conservative by
 * design: when in doubt, returns false so the caller uses full retrieval.
 */
function isCommonFactQuestion(utt) {
  const t = String(utt || '').trim();
  if (t.length < 3 || t.length > 200) return false; // too short (ack) or too long (not a clean fact Q)
  if (DOC_SIGNALS.test(t)) return false;             // any doc/compliance signal -> full retrieval
  return FACT_RULES.some((r) => r.topic.test(t) && r.ask.test(t) && (!r.extra || r.extra.test(t)));
}

module.exports = { isCommonFactQuestion, DOC_SIGNALS, FACT_RULES };
