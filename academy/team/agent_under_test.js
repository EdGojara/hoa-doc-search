// academy/team/agent_under_test.js  (sandbox; not loaded by production)
// ----------------------------------------------------------------------------
// Builds what a teammate receives for a TEAM case (academy/team/cases), and
// parses what comes back.
//
// Amanda on board / homeowner / vendor / staff cases uses her production-derived
// v1.2 candidate prompt (candidate_prompt.candidateSystem) plus the team layers.
// Paige, Claire, Phoebe (and Amanda on a prospect) use a SANDBOX team prompt
// assembled from the Academy layers, because their production prompts have not
// been brought into the Academy yet. The report labels which was used.
//
// Layer precedence (highest first): integrity + capabilities > culture >
// shared directory > role/lane > personality > channel/intent.
// ----------------------------------------------------------------------------
const { classifyIntent } = require('../lib/intent');
const { candidateSystem, teamLayers, FACTUAL_INTEGRITY, UNCERTAINTY, channelFormat, responseShape } = require('../lib/candidate_prompt');
const { cultureBlock } = require('./culture');
const { PROFILES } = require('./personalities');
const { aiTeam, directory } = require('./directory');

const HANDOFF_RULE = `HANDOFFS: if this belongs to someone else (a teammate, a human role, Ed, the board, legal review), or you are bringing someone in, do everything inside your authority, tell the person who picks it up, and end your output with the package that travels with the work:
---HANDOFF---
{"from":"<you>","to":"<teammate key: amanda|paige|claire|phoebe|kat|emma|annie|miranda|reese|darby|maggie, or community_manager|ed|board|legal_review>","person":"who they are and how they reached us","ask":"what they asked","known":["fact (source)"],"unknown":["..."],"actions_on_record":["..."],"promised":["..."],"why_theirs":"...","next_step":"..."}
The package goes to the recipient, never to the customer. If you own it yourself, leave it out.`;

const HARD_LIMITS = 'HARD LIMITS: you never waive or reduce a fine or fee, approve or deny an ACC application, take a legal position, make a Texas Chapter 209 determination, commit association funds, sign a contract, or post an accounting entry. You bring those to whoever decides (YOUR TEAM, ESCALATION PATHS).';

function teamContextText(c) {
  return [...(c.available_context || []).map((x) => `${x.text} ${x.source}`), ...(c.conversation_history || []).map((h) => h.text),
    ...(c.shared_work_context || []).map((w) => `${w.what} ${w.at} ${w.ref} ${w.status}`)].join('\n');
}

function personalityBlock(agent) {
  const p = PROFILES[agent];
  if (!p) return '';
  return `YOUR PERSONALITY (tone and style only; it never changes a fact, your authority, or your follow-through):
Temperament: ${p.temperament}
Voice: ${p.voice}
Humor: ${p.humor}
Under pressure: ${p.under_pressure}
Watch for: ${p.blind_spot}`;
}

function sandboxSystem(agent, c, intent, team) {
  const me = aiTeam().find((t) => t.key === agent);
  return [
    `You are ${me.name}, ${me.role} at Bedrock Association Management, an AI teammate (say so if asked). Your lane: ${me.lane}. Community: ${c.community_context.name}.`,
    FACTUAL_INTEGRITY, UNCERTAINTY, HARD_LIMITS,
    cultureBlock(),
    teamLayers(agent, team),
    personalityBlock(agent),
    'No em-dashes; use commas. Plain text, no markdown.',
    channelFormat(c.channel), responseShape(intent), HANDOFF_RULE,
  ].join('\n\n');
}

function teamUserContent(c) {
  const me = aiTeam().find((t) => t.key === c.agent);
  const who = c.incoming_message.from;
  const first = String(who).split(/\s+/)[0];
  const role = ((c.people || []).find((p) => p.name === who) || {}).role || (who === 'system' ? 'internal task' : c.audience);
  const names = Object.fromEntries(directory().map((m) => [m.key, m.name || m.role]));
  const hist = (c.conversation_history || []).length ? `EARLIER IN THIS THREAD:\n${c.conversation_history.map((h) => `${h.from}: ${h.text}`).join('\n')}\n\n` : '';
  const ctx = (c.available_context || []).length ? c.available_context.map((x) => `- ${x.text} (source: ${x.source})`).join('\n') : 'None.';
  const work = (c.shared_work_context || []).length
    ? `SHARED TEAM RECORD (work teammates have done; answer from it and credit them):\n${c.shared_work_context.map((w) => `- [${w.at}] ${names[w.by] || w.by}, ${w.type}: ${w.what} (${w.status}; ${w.ref})`).join('\n')}\n\n` : '';
  const acts = (c.action_log || []).length ? c.action_log.map((a) => `- [${a.at}] ${a.type}: ${a.what}`).join('\n') : '- none recorded';
  return `THE MESSAGE (channel: ${c.channel}):\nFrom: ${who} (${role})\n\n${c.incoming_message.text}\n\n${hist}CONTEXT (${c.community_context.name}):\n${ctx}\n\n${work}ACTIONS ON RECORD (what you have actually done; anything not listed has NOT happened):\n${acts}\n\nDraft ${me.name.split(' ')[0]}'s ${who === 'system' ? 'message' : `reply to ${first}`}.`;
}

const AMANDA_AUDIENCES = new Set(['board', 'homeowner', 'vendor', 'staff']);

function teamRequest(c, { team = {} } = {}) {
  const intent = classifyIntent({ message: c.incoming_message.text, channel: c.channel, contextText: teamContextText(c), audience: c.audience });
  let system; let prompt_source;
  if (c.agent === 'amanda' && AMANDA_AUDIENCES.has(c.audience)) {
    system = candidateSystem({ audience: c.audience, communityName: c.community_context.name, channel: c.channel, intent, team, agent: 'amanda' }) + '\n\n' + personalityBlock('amanda') + '\n\n' + HANDOFF_RULE;
    prompt_source = 'amanda v1.2 candidate (production-derived) + team layers';
  } else {
    system = sandboxSystem(c.agent, c, intent, team);
    prompt_source = 'sandbox team prompt (Academy layers)';
  }
  return { system, prompt: teamUserContent(c), intent, prompt_source };
}

// Split the model output into the customer message and the internal blocks.
function parseAgentOutput(text) {
  let s = String(text || '');
  const out = { message: '', commitments: [], handoff: null, parse_errors: [] };
  const grab = (tag) => {
    const i = s.indexOf(`---${tag}---`);
    if (i < 0) return null;
    const rest = s.slice(i + tag.length + 6);
    const next = rest.search(/\n---[A-Z]+---/);
    const body = (next >= 0 ? rest.slice(0, next) : rest).trim();
    s = s.slice(0, i) + (next >= 0 ? rest.slice(next) : '');
    return body.replace(/^```(json)?|```$/g, '').trim();
  };
  const h = grab('HANDOFF'); const cm = grab('COMMITMENTS');
  if (h) { try { out.handoff = JSON.parse(h); } catch (e) { out.parse_errors.push('handoff: ' + e.message); } }
  if (cm) { try { const v = JSON.parse(cm); out.commitments = Array.isArray(v) ? v : [v]; } catch (e) { out.parse_errors.push('commitments: ' + e.message); } }
  out.message = s.trim();
  return out;
}

function validateTeamCase(c) {
  const errs = [];
  for (const f of ['case_id', 'agent', 'audience', 'channel', 'incoming_message', 'expected_routing', 'answer_key']) if (!c[f]) errs.push(`missing ${f}`);
  if (c.agent && !aiTeam().some((t) => t.key === c.agent)) errs.push(`unknown agent ${c.agent}`);
  return errs;
}

module.exports = { teamRequest, parseAgentOutput, teamContextText, validateTeamCase, sandboxSystem, HANDOFF_RULE, personalityBlock };
