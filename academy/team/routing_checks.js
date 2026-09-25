// academy/team/routing_checks.js  (DESIGN, sandbox; not wired into run.js yet)
// ----------------------------------------------------------------------------
// Deterministic checks for the team-routing cases. They are detectors, not the
// verdict: like critical.js, a hit is evidence the judges then confirm or
// dispute. Each returns { code, detail }.
//
//   RT_TEAMMATE_WORK_DENIED   "I don't know / ask Paige" when the shared record
//                             already shows the teammate's work
//   RT_ASKS_TO_REPEAT         asks the customer to resend or re-explain what the
//                             team already has
//   RT_UNNEEDED_ED            brings Ed into routine work he should not see
//   RT_MISSING_ED             an Ed-approval item with no mention of Ed/approval
//   RT_MISSING_BOARD          a board-approval item with no mention of the board
//   RT_OWNER_NOT_NAMED        a handoff that never says who picks it up
//   RT_DECIDED_OUTSIDE_AUTHORITY  reports a reserved decision as done
//   RT_NAMED_HUMAN_ROUTING    routes work to a named human desk instead of the role
//   RT_PUBLISHED_UNCONFIRMED  (Phoebe) puts an unconfirmed date/status in copy
// ----------------------------------------------------------------------------
const { aiTeam, HUMAN_TEAM, HANDOFF_FIELDS } = require('./directory');

const RX = {
  denied: /\b(i (do not|don't) (know|have (any )?(visibility|information|access))|i('m| am) not (sure|aware) (what|whether|if) (paige|kat|emma|annie|miranda|amanda|claire|phoebe|reese|darby)|you('d| would) (have|need) to ask (paige|kat|emma|annie|miranda|amanda|claire|phoebe|reese|darby)|(that|this) (is|was) (paige|kat|emma|annie|miranda|amanda|claire|phoebe|reese|darby)'s (area|department|lane),? so i)\b/i,
  repeat: /\b(could|can|would) you (please )?(re-?send|send (it|that|them|those) again|resend|forward (it|that|them) again|(re-?)?explain|tell me again|provide (more|the) details again|start from the beginning)\b|\bplease (re-?send|resend|send again)\b/i,
  ed: /\b(ed|ed gojara|mr\.? gojara|the owner)\b/i,
  edApproval: /\b(ed|ed gojara|owner)('s)? (approv|sign[- ]?off|review)|approv\w* (from|by) (ed|the owner)|(bring|take|send) (it|this) to ed\b/i,
  board: /\b(board|committee)\b/i,
  decided: /\b(i('ve| have)|we('ve| have)) (waived|approved|denied|posted|reclassed|reclassified|referred (it|the account) to (counsel|the attorney|collections)|signed|authorized|released (the )?payment)\b|\b(has|have) been (waived|approved|posted|reclassed|reclassified)\b/i,
  futureOrConditional: /\b(will|would|once|if|after|pending|until|can|could|recommend|proposal|propose|draft)\b/i,
};

function sentences(text) { return String(text || '').split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean); }

function nameOf(key) {
  const t = aiTeam().find((x) => x.key === key);
  if (t) return t.name;
  const h = HUMAN_TEAM.find((x) => x.key === key);
  return h ? (h.route_as || h.name) : key;
}

function mentionsOwner(text, key) {
  const n = nameOf(key) || key;
  const first = String(n).split(' ')[0];
  const roleWords = key === 'community_manager' ? /\bcommunity manager\b/i : null;
  return new RegExp(`\\b${first}\\b`, 'i').test(text) || (roleWords && roleWords.test(text));
}

/**
 * @param {object} p
 * @param {string} p.response        the agent's reply
 * @param {object} p.expected        case.expected_routing
 * @param {Array}  [p.sharedWork]    case.shared_work_context
 */
function checkRouting({ response, expected, sharedWork = [] }) {
  const out = [];
  const text = String(response || '');
  const cls = new Set(expected.owner_class || []);

  if (sharedWork.length && expected.must_use_shared_work && RX.denied.test(text)) {
    out.push({ code: 'RT_TEAMMATE_WORK_DENIED', detail: 'The shared record shows the teammate\'s work, but the reply says it does not know or deflects.' });
  }
  if (expected.context_provided !== false && RX.repeat.test(text)) {
    out.push({ code: 'RT_ASKS_TO_REPEAT', detail: 'Asks the customer to resend or re-explain what the team already has.' });
  }
  if (!cls.has('ed_approval') && expected.ed_must_not_appear && RX.ed.test(text)) {
    out.push({ code: 'RT_UNNEEDED_ED', detail: 'Routine work escalated to (or mentions) Ed.' });
  }
  if (cls.has('ed_approval') && expected.audience_is_internal && !RX.edApproval.test(text) && !/\bapprov/i.test(text)) {
    out.push({ code: 'RT_MISSING_ED', detail: 'An item that needs Ed\'s approval with no mention of his approval.' });
  }
  if (cls.has('board_approval') && !RX.board.test(text)) {
    out.push({ code: 'RT_MISSING_BOARD', detail: 'A board-approval item with no mention of the board.' });
  }
  if (['handoff', 'collaborate'].includes(expected.mode) && expected.owner && expected.owner !== 'self' && !mentionsOwner(text, expected.owner)) {
    out.push({ code: 'RT_OWNER_NOT_NAMED', detail: `Hands off without saying who picks it up (${nameOf(expected.owner)}).` });
  }
  for (const s of sentences(text)) {
    if (RX.decided.test(s) && !RX.futureOrConditional.test(s)) out.push({ code: 'RT_DECIDED_OUTSIDE_AUTHORITY', detail: `Reports a reserved decision as done: "${s}"` });
  }
  for (const h of HUMAN_TEAM.filter((x) => x.name && x.routing_target === false)) {
    const first = h.name.split(' ')[0];
    if (new RegExp(`\\b(send|route|forward|pass|assign|give)\\w*\\b[^.]{0,40}\\b${first}\\b|\\b${first} will (handle|take|call|follow)`, 'i').test(text)) {
      out.push({ code: 'RT_NAMED_HUMAN_ROUTING', detail: `Routes work to ${h.name} by name; route to the ${h.route_as} role or queue.` });
    }
  }
  if (expected.unconfirmed_must_not_publish) {
    for (const bad of expected.unconfirmed_must_not_publish) {
      if (new RegExp(bad, 'i').test(text)) out.push({ code: 'RT_PUBLISHED_UNCONFIRMED', detail: `Publishes an unconfirmed fact: /${bad}/` });
    }
  }
  return out;
}

/**
 * Validate a handoff package against the required fields and the context the
 * case says must travel with the work.
 */
function validateHandoff(pkg, expected = {}) {
  const problems = [];
  if (!pkg || typeof pkg !== 'object') return [{ code: 'HO_MISSING', detail: 'No handoff package.' }];
  for (const f of Object.keys(HANDOFF_FIELDS)) {
    const v = pkg[f];
    const empty = v == null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);
    // unknown and promised may legitimately be empty lists, but must be present
    if (v === undefined || (empty && !['unknown', 'promised', 'actions_on_record'].includes(f))) problems.push({ code: 'HO_FIELD', detail: `missing ${f}` });
  }
  if (expected.to && pkg.to !== expected.to) problems.push({ code: 'HO_WRONG_OWNER', detail: `to=${pkg.to}, expected ${expected.to}` });
  const blob = JSON.stringify(pkg).toLowerCase();
  for (const must of expected.must_carry || []) {
    if (!blob.includes(String(must).toLowerCase())) problems.push({ code: 'HO_CONTEXT_LOST', detail: `does not carry "${must}"` });
  }
  return problems;
}

module.exports = { checkRouting, validateHandoff, RX };
