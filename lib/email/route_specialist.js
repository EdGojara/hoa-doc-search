// ============================================================================
// lib/email/route_specialist.js  (Ed 2026-07-26)
// ----------------------------------------------------------------------------
// "Make sure Claire has the data to answer, OR hand off to the specialist and
// the platform sends it to the right person."
//
// personaForMessage() already content-routes VENDOR mail to the right teammate
// (reese/amanda/kat/emma by keyword). But a HOMEOWNER who emails info@ with an
// accounting, resale, board, or compliance question falls straight through to
// Claire — she's the front office and the default. When that question is really
// a specialist's decision or action, Claire shouldn't answer out of her depth
// (and shouldn't invent a specific she doesn't have — see the fabrication
// guard). This is the missing content-router for Claire's own lane.
//
// DELIBERATELY a SUGGESTION, not a silent reassignment. personaForMessage stamps
// the board at ingest; if we re-pointed homeowner mail there, real homeowner
// threads would quietly leave the front-office queue and a staffer working
// "Claire's inbox" would miss them. Instead the drafter surfaces this as a
// one-click hand-off the operator confirms. Reversible, visible, and consistent
// with the exception-queue model (system proposes, human supervises). Once we've
// watched it name the right person for a couple of weeks we can promote it to
// automatic at ingest — a staged gate-flip, not a marathon-tail slam-in.
//
// Pure + deterministic (no LLM call) so it's cheap, predictable, and TESTED.
// ============================================================================

// Names/titles come from the ONE canonical roster so the hand-off card can
// never disagree with the board. This used to be a hand-copied mirror with a
// comment asking the next person to keep it in sync, which is a promise, not a
// control. (lib/team/roster.js)
const _roster = require('../team/roster');
const SPECIALISTS = Object.fromEntries(
  ['miranda', 'annie', 'reese', 'paige', 'kat'].map((p) => {
    const m = _roster.get(p);
    if (!m) throw new Error(`route_specialist: "${p}" is not on the roster`);
    return [p, { name: m.name, title: m.title }];
  }),
);

// Each rule: a persona + a "why" + a tight regex. Priority order matters —
// a resale request that mentions a balance is Reese's, not Kat's; a dispute of
// a violation is Miranda's, not a generic ACC. First match wins.
const RULES = [
  // Resale / estoppel / closing — a title company or realtor needs a document,
  // not a conversation. Checked first: these often mention money + an address
  // and would otherwise trip the accounting net.
  { persona: 'reese', why: 'a resale certificate / estoppel / closing request',
    rx: /\b(estoppel|resale certificate|resale cert|closing (statement|package|disclosure|docs?)|settlement statement|title (co\b|company)|transfer of ownership|new owner|homewise|home ?wise|realtor|earnest money)\b/i },

  // A homeowner disputing or asking to cure a violation is a compliance judgment
  // (Miranda), which Claire is explicitly barred from making. "violation_report"
  // classification already flags many of these; this catches the homeowner-side
  // dispute/cure wording that lands as a plain homeowner_request.
  { persona: 'miranda', why: 'a violation dispute or cure-timeline question (a compliance judgment)',
    rx: /\b(dispute (the|this|my) (violation|notice|fine)|this violation is wrong|not my (violation|fault)|already (fixed|cured|corrected|took care)|cure (period|date|deadline)|extension (on|to|for) (the )?(cure|violation|fine)|remove the (fine|violation)|contest (the|this))\b/i },

  // Architectural / exterior modification request. acc_request classification
  // already routes to Annie in personaForMessage; this is the keyword backstop
  // for a homeowner_request that's really an ARC ask.
  { persona: 'annie', why: 'an architectural / exterior-modification (ACC) request',
    rx: /\b(acc\b|arc\b|architectural (review|committee|request|application)|exterior (modification|change|paint)|request approval to (build|install|add|paint|replace)|submit (a )?(plan|application) (for|to)|fence (install|replace|approval)|paint (color )?approval)\b/i },

  // Board governance — a homeowner asking to reach the board, run for the board,
  // attend/see minutes of a meeting, or raise a policy question is Paige's lane.
  { persona: 'paige', why: 'a board / governance / meeting matter',
    rx: /\b(the board|board of directors|board meeting|annual meeting|run for (the )?board|board (member|seat|candidate)|meeting minutes|agenda|hoa policy|amend the (bylaws|ccr|declaration))\b/i },

  // Accounting — assessments, balances, payments, statements, autopay, refunds,
  // payment plans. Claire HAS the live balance in her account grounding, so a
  // simple "what do I owe" she can answer; this fires on the ones that need an
  // accounting ACTION (set up autopay, dispute a charge, arrange a plan, refund).
  { persona: 'kat', why: 'an accounting action (payment plan, autopay, refund, disputed charge)',
    rx: /\b(payment plan|payment arrangement|set up autopay|auto[-\s]?pay|refund|overcharge|double (charged|billed|payment)|disputed? (charge|assessment|late fee|balance)|waive (the )?(late fee|fine|interest)|statement (is )?wrong|apply my payment|where did my payment)\b/i },
];

/**
 * Decide whether a message currently in Claire's lane really belongs to a
 * specialist. Returns { persona, name, title, reason } or null (Claire keeps it).
 *
 * @param {object} o
 * @param {string} o.classification  the ingest classification (may be '')
 * @param {string} o.subject
 * @param {string} o.bodyText        the homeowner's actual message text
 */
function routeSpecialist({ classification, subject, bodyText } = {}) {
  const text = `${subject || ''}\n${bodyText || ''}`;
  if (!text.trim()) return null;

  // Classification-level fast paths (mirror personaForMessage's intent so the
  // suggestion agrees with the board's own attribution rules).
  if (classification === 'acc_request') {
    return { persona: 'annie', ...SPECIALISTS.annie, reason: 'an architectural / exterior-modification (ACC) request' };
  }

  for (const r of RULES) {
    if (r.rx.test(text)) {
      return { persona: r.persona, ...SPECIALISTS[r.persona], reason: r.why };
    }
  }
  return null;
}

module.exports = { routeSpecialist, SPECIALISTS };
