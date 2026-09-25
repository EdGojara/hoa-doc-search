// academy/lib/case_schema.js
// ----------------------------------------------------------------------------
// Amanda Academy case model + validator.
//
// A case has two halves:
//   * what AMANDA SEES: scenario framing, people, community context, history,
//     the incoming message, and available_context (each item a sourced FACT or
//     a governing-document excerpt).
//   * the ANSWER KEY (judges only): facts / supported_inferences / unknowns kept
//     explicitly separate, hidden traps, authority boundaries, expected
//     communication, next action, completion condition.
// Amanda never sees the answer key. The validator enforces the separation.
// ----------------------------------------------------------------------------
const { CATALOG } = require('./critical');

const DIMENSIONS = ['expertise', 'judgment', 'relationship', 'execution'];
const AUDIENCES = ['homeowner', 'board', 'vendor', 'staff'];
const CHANNELS = ['email', 'chat', 'phone', 'portal', 'meeting'];
const STATUSES = ['draft', 'reviewed', 'active', 'retired'];

function validateCase(c) {
  const e = [];
  const req = (cond, msg) => { if (!cond) e.push(msg); };
  req(/^AA-[A-Z]{3}-\d{3}$/.test(c.case_id || ''), 'case_id must look like AA-XXX-000');
  req(Number.isInteger(c.version) && c.version >= 1, 'version must be an integer >= 1');
  req(STATUSES.includes(c.status), `status must be one of ${STATUSES}`);
  req(c.agent === 'amanda', 'agent must be amanda');
  req(Array.isArray(c.domain) && c.domain.length && c.domain.every((d) => DIMENSIONS.includes(d)), 'domain must list tested dimensions');
  req(typeof c.title === 'string' && c.title.length > 5, 'title required');
  req(AUDIENCES.includes(c.audience), `audience must be one of ${AUDIENCES}`);
  req(CHANNELS.includes(c.channel), `channel must be one of ${CHANNELS}`);
  req(typeof c.scenario === 'string' && c.scenario.length > 20, 'scenario required');
  req(Array.isArray(c.people) && c.people.length, 'people required');
  req(c.community_context && typeof c.community_context.name === 'string', 'community_context.name required');
  req(c.incoming_message && c.incoming_message.from && c.incoming_message.text, 'incoming_message {from,text} required');
  req(Array.isArray(c.available_context), 'available_context must be an array');
  for (const [i, f] of (c.available_context || []).entries()) {
    req(f.id && f.text && f.source, `available_context[${i}] needs id, text, source`);
    req(['FACT', 'GOVDOC'].includes(f.kind), `available_context[${i}].kind must be FACT or GOVDOC (inferences/unknowns belong in the answer key)`);
  }
  for (const [i, x] of (c.action_log || []).entries()) req(x.type && x.what && x.at && x.ref, `action_log[${i}] needs type, what, at, ref (a real record)`);
  const k = c.answer_key || {};
  req(Array.isArray(k.facts) && k.facts.length, 'answer_key.facts required (FACT)');
  req(Array.isArray(k.supported_inferences), 'answer_key.supported_inferences required (SUPPORTED INFERENCE; may be empty)');
  req(Array.isArray(k.unknowns), 'answer_key.unknowns required (UNKNOWN; may be empty)');
  for (const [i, f] of (k.facts || []).entries()) req(f.text && f.source, `answer_key.facts[${i}] needs text + source`);
  for (const [i, s] of (k.supported_inferences || []).entries()) req(s.text && Array.isArray(s.based_on) && s.based_on.length, `supported_inferences[${i}] needs text + based_on[]`);
  for (const [i, u] of (k.unknowns || []).entries()) req(typeof u === 'string' || (u && u.text), `unknowns[${i}] must be text`);
  req(Array.isArray(k.hidden_traps), 'answer_key.hidden_traps required');
  req(Array.isArray(k.expected_issues), 'answer_key.expected_issues required');
  req(Array.isArray(k.acceptable_actions), 'answer_key.acceptable_actions required');
  req(Array.isArray(k.actions_requiring_approval), 'answer_key.actions_requiring_approval required');
  req(Array.isArray(k.actions_requiring_escalation), 'answer_key.actions_requiring_escalation required');
  req(Array.isArray(k.prohibited_assumptions), 'answer_key.prohibited_assumptions required');
  req(k.expected_communication && k.expected_communication.tone, 'answer_key.expected_communication.tone required');
  req(k.expected_next_action && k.expected_next_action.action && k.expected_next_action.owner, 'answer_key.expected_next_action {action, owner} required');
  req(typeof k.completion_condition === 'string' && k.completion_condition.length > 5, 'answer_key.completion_condition required');
  for (const code of k.critical_failures_to_watch || []) req(CATALOG[code], `unknown critical failure code ${code}`);
  for (const chk of c.deterministic_checks || []) {
    req(['absent', 'present'].includes(chk.type) && chk.pattern, 'deterministic_checks need type absent|present + pattern');
    if (chk.critical) req(CATALOG[chk.critical], `deterministic check critical code ${chk.critical} unknown`);
    try { new RegExp(chk.pattern, chk.flags || 'i'); } catch (err) { e.push(`bad regex ${chk.pattern}`); }
  }
  req(c.provenance && typeof c.provenance === 'string', 'provenance required');
  // Leak guard: Amanda-visible text must not contain answer-key-only content.
  const visible = JSON.stringify([c.scenario_visible_to_amanda, c.incoming_message, c.available_context, c.conversation_history]).toLowerCase();
  for (const t of k.hidden_traps || []) if (t.length > 25 && visible.includes(t.toLowerCase().slice(0, 25))) e.push(`hidden trap text leaks into Amanda-visible content: "${t.slice(0, 40)}"`);
  return e;
}

// What Amanda is shown for a case (never the answer key).
function amandaView(c) {
  return {
    audience: c.audience, channel: c.channel, community: c.community_context.name,
    person: c.incoming_message.from, message: c.incoming_message.text,
    situation: c.scenario_visible_to_amanda || null,
    history: c.conversation_history || [],
    facts: (c.available_context || []).filter((f) => f.kind === 'FACT'),
    govdocs: (c.available_context || []).filter((f) => f.kind === 'GOVDOC'),
    community_facts: c.community_context.facts || [],
    action_log: c.action_log || [],
  };
}

module.exports = { validateCase, amandaView, DIMENSIONS, AUDIENCES, CHANNELS, STATUSES };
