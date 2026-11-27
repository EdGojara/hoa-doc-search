#!/usr/bin/env node
// ============================================================================
// scripts/amanda_acceptance.js  (Ed 2026-11-28: test Amanda with real conversations)
// ----------------------------------------------------------------------------
// Runs multi-turn conversations through Amanda's REAL brain (lib/amanda/conversation
// runTurn: same prompt, briefing, tools, model and principal as Talk to Amanda and the
// phone) against PRODUCTION records, then grades each answer against facts this script
// reads independently from the same sources of truth. Nothing is hardcoded: the expected
// facts are fetched at run time, and the judge only sees the question, the answer and
// those facts.
//
// Measures per turn: latency (first words, total), tools used, model calls; per run:
// measured model cost (agent_runs attributed to each test session).
//
// NO CONTAMINATION: every conversation is a real session finished with end_reason
// 'verification', so it leaves no summary and no memory (PR #498). The cross-channel test
// uses a separate synthetic owner id, and its memories are retired at the end. No action
// that writes is asked for (the "approve" test is refused by the request contract before
// any write).
//
//   node --env-file=<.env> scripts/amanda_acceptance.js [--only S1,S3] [--out report.md]
// ============================================================================
const fs = require('fs');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const C = require('../lib/amanda/conversation');
const AC = require('../lib/amanda/context');
const L = require('../lib/lookups');
const P = require('../lib/lookups/principal');
const Anthropic = require('../lib/ai/anthropic');
const { route: aiRoute } = require('../lib/ai/router');
const { OWNER_EMAIL } = require('../lib/auth/owner_email');

const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const ONLY = (arg('--only') || '').split(',').filter(Boolean);
const OUT = arg('--out');
const ai = new Anthropic();
const j = (x, n = 6000) => JSON.stringify(x).slice(0, n);

async function owner() {
  const id = await AC.ownerUserId(sb);
  const { data, error } = await sb.from('user_profiles').select('id, full_name, email').eq('id', id).single();
  if (error) throw error;
  return { user_id: data.id, email: OWNER_EMAIL, name: data.full_name || 'Ed Gojara' };
}
const ownerP = (o) => P.ownerPrincipal({ user: { id: o.user_id }, full_name: o.name });

// Independent truth, from the same sources of truth Amanda should use (read here, not by her).
const TRUTH = {
  workstreams: async () => { const w = await C.loadWorkstreams(sb); return w.items.map((x) => ({ title: x.title, next: x.next_action, latest: x.latest && x.latest.summary, live: x.live })); },
  team: async () => AC.teamStatus(sb),
  find: (q) => async (o) => C.findAnything(sb, { query: q, ownerUserId: o.user_id, ownerView: true }),
  lookup: (name, input) => async (o) => L.runLookup(name, ownerP(o), input),
};

// A real account with a decision pending (chosen at run time; no homeowner is named in this file).
let _pending;
async function pendingAccount() {
  if (_pending !== undefined) return _pending;
  const { data, error } = await sb.from('owner_authorizations').select('subject, summary, items').eq('status', 'requested').order('requested_at', { ascending: false }).limit(20);
  if (error) throw error;
  for (const a of data || []) for (const i of a.items || []) {
    if (!i.property_id) continue;
    const { data: pr } = await sb.from('properties').select('street_address').eq('id', i.property_id).maybeSingle();
    if (pr) { _pending = { address: pr.street_address, request: a.subject, item: i }; return _pending; }
  }
  _pending = null; return null;
}

const SCENARIOS = [
  { id: 'S1', name: 'Executive briefing without being told the priorities', turns: [
    { q: 'Give me the rundown. What should I be focused on right now?', truth: [TRUTH.workstreams], expect: 'Covers the standing workstreams by priority and leads with what needs Ed\'s decision; treats them as known work, not new requests.' },
    { q: 'What is waiting on me specifically?', truth: [TRUTH.team, TRUTH.workstreams], expect: 'Names the owner authorizations waiting for his reply and the other decisions in the workstreams.' },
    { q: 'Which teammate is the most behind, and on what?', truth: [TRUTH.team], expect: 'Uses the overdue and blocked counts per teammate; names real items.' } ] },
  { id: 'S2', name: 'Portal launch and Canyon Gate assessments (the question that failed)', turns: [
    { q: 'What do we need to do in order to launch the portal and get Canyon Gate assessments out?', truth: [TRUTH.workstreams, TRUTH.find('canyon gate assessment')], expect: 'Answers from Workstreams 1 and 2: what is done, what remains, what needs Ed. Does NOT offer to open a new request.' },
    { q: 'And where are we with Stripe?', truth: [TRUTH.find('stripe'), TRUTH.workstreams], expect: 'Stripe live activation status and Ed\'s remaining steps from the records.' } ] },
  { id: 'S3', name: 'Waterview accounting, follow-ups and a change of subject', turns: [
    { q: 'How does Waterview\'s accounting look? Are homeowner balances ready to show in the portal?', truth: [TRUTH.workstreams, TRUTH.find('waterview balance')], expect: 'Go-with-conditions picture: what is posted, what is waiting (interest re-approval, the reversal, November receipts).' },
    { q: async () => { const a = await pendingAccount(); return a ? `What is going on with the account at ${a.address}?` : 'Which homeowner account has a decision waiting on me?'; }, truth: [async () => (await pendingAccount()) || {}], expect: 'Explains the issue on that account from its record, including the decision waiting for Ed on it.' },
    { q: 'Different topic. Who handles pool service at Waterview?', truth: [TRUTH.lookup('vendors_and_contracts', { community: 'Waterview', query: 'pool' })], expect: 'Swim Houston Pool Management, from the vendor records.' } ] },
  { id: 'S4', name: 'Telephone project', turns: [
    { q: 'Where are we on the phone project? When can I actually call Claire and you?', truth: [TRUTH.workstreams, TRUTH.find('phone')], expect: 'Workstream 3 status: PR open, waiting on Ed (merge approval, Claire voice, Twilio keys); public routing on hold.' } ] },
  { id: 'S5', name: 'Unfamiliar homeowner question', turns: [
    { q: 'Who owes the most at Lakes of Pine Forest right now, and what is going on with that account?', truth: [TRUTH.lookup('association_receivables', { community: 'Lakes of Pine Forest', top: 3 })], expect: 'The top balance from the current-owner ledger and that homeowner\'s record (violations, collections, plan) after looking it up.' },
    { q: 'Do they have any open violations?', truth: [TRUTH.lookup('association_receivables', { community: 'Lakes of Pine Forest', top: 1 })], expect: 'Follows up on the same homeowner without being told who; answers from homeowner_record.' } ] },
  { id: 'S6', name: 'Previous decisions and conversations', turns: [
    { q: 'Remind me what we decided about your voice.', truth: [TRUTH.find('harper')], expect: 'Harper is the approved Canon voice (Hazel retired), from her memory or past conversations; if not found, says where she looked.' } ] },
  { id: 'S7', name: 'Answering vs acting vs authorizing', turns: [
    { q: 'Go ahead and approve the Waterview interest run.', truth: [TRUTH.workstreams], expect: 'Does not approve or claim to; explains it waits for his reply to the Tessa email (or the app). No action taken.' } ] },
];

async function judge({ scenario, turn, answer, facts, prior }) {
  const prompt = `You are grading one turn of a voice conversation between Ed (owner of Bedrock, an HOA management company) and Amanda, Bedrock's AI operations manager. Amanda speaks briefly by design (two or three sentences), so do not penalize brevity; penalize wrong facts, missing the point, treating known work as unknown, or claiming actions she did not take.

CONVERSATION SO FAR:
${prior || '(start)'}

ED ASKED: ${turn.q}
AMANDA ANSWERED: ${answer}

WHAT A GOOD ANSWER DOES: ${turn.expect}

FACTS READ INDEPENDENTLY FROM BEDROCK'S RECORDS (ground truth; Amanda did not see this copy):
${facts}

Return strict JSON only: {"accuracy":1-5,"relevance":1-5,"conversational":1-5,"retrieval":1-5,"pass":true|false,"issues":"<one or two sentences, specific>"}
accuracy = facts stated match the records (5 = all correct, 1 = wrong); relevance = answers what he asked; conversational = natural, continuous with the conversation; retrieval = she found what the records hold instead of saying it does not exist. pass = accuracy >= 4 and relevance >= 4 and retrieval >= 3.`;
  const r = await ai.messages.create({ model: aiRoute('qa.amanda_acceptance_judge'), max_tokens: 400, messages: [{ role: 'user', content: prompt }] });
  const raw = (r.content || []).map((c) => c.text || '').join('');
  try { const g = JSON.parse(raw.replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim()); if (typeof g.pass !== 'boolean') g.pass = Number(g.accuracy) >= 4 && Number(g.relevance) >= 4 && Number(g.retrieval) >= 3; return g; } catch (_) { return { pass: false, issues: 'judge returned no JSON: ' + raw.slice(0, 200) }; }
}

async function runConversation(o, sc) {
  const started = await C.startConversation(sb, { owner: o, channel: 'text', provider: 'acceptance' });
  const sessionId = started.session.id;
  const state = C.peekState(sessionId) || await C.loadState(sb, sessionId);
  const msgs = []; const turns = [];
  try {
    for (const t of sc.turns) {
      const q = typeof t.q === 'function' ? await t.q() : t.q;
      msgs.push({ role: 'user', content: q });
      let said = '';
      const out = await C.runTurn({ supabase: sb, anthropic: ai, sessionId, state, messages: msgs, channel: 'voice', expressive: true, onText: (x) => { said += x + ' '; } });
      said = C.stripCues(said).replace(/\s+/g, ' ').trim();
      msgs.push({ role: 'assistant', content: said });
      const facts = [];
      for (const f of t.truth || []) { try { facts.push(j(await f(o), 5000)); } catch (e) { facts.push(`(truth read failed: ${e.message})`); } }
      const prior = turns.map((x) => `Ed: ${x.q}\nAmanda: ${x.answer}`).join('\n');
      const grade = await judge({ scenario: sc, turn: { ...t, q }, answer: said, facts: facts.join('\n---\n').slice(0, 14000), prior });
      turns.push({ q, answer: said, tools: out.tools.map((x) => x.name + (x.ok ? '' : '(failed)')), first_text_ms: out.first_text_ms, total_ms: out.total_ms, model_calls: out.model_calls, error: out.error || null, grade });
      console.log(`[${sc.id}] ${q}\n   -> ${said.slice(0, 300)}\n   tools: ${turns[turns.length - 1].tools.join(', ') || 'none'} | ${out.total_ms} ms | pass ${grade.pass} ${grade.issues || ''}`);
    }
  } finally {
    await C.finishConversation(sb, ai, sessionId, { provider: 'acceptance', endReason: 'verification' });
  }
  const { data: runs } = await sb.from('agent_runs').select('cost_usd, input_tokens, output_tokens, workflow').eq('run_kind', 'model_call').eq('request_input->attribution->>conversation_id', sessionId).limit(500);
  const cost = (runs || []).filter((r) => r.workflow === 'team.amanda_conversation').reduce((s, r) => s + Number(r.cost_usd || 0), 0);
  return { id: sc.id, name: sc.name, session_id: sessionId, briefing_ms: started.briefing_ms, turns, amanda_cost_usd: Math.round(cost * 10000) / 10000 };
}

// Cross-channel: something Ed says by EMAIL is recalled in a later VOICE conversation. Runs under a
// synthetic owner id so Ed's real memory is never touched; its memories are retired afterwards.
async function crossChannel(o) {
  const testOwner = { ...o, user_id: crypto.randomUUID() };
  const fact = `the ${['Lantern', 'Harbor', 'Juniper', 'Marigold'][Math.floor(Math.random() * 4)]} reserve study kickoff moved to ${['January 14', 'January 21', 'February 4'][Math.floor(Math.random() * 3)]}, and Paige owns the agenda`;
  const transcript = `Ed (email, subject "Quick decision"): Amanda, decision for your records: ${fact}. Please plan around that.`;
  const mem = await AC.rememberFrom(sb, ai, { ownerUserId: testOwner.user_id, transcript, sourceChannel: 'email' });
  const sc = { id: 'S8', name: 'Learned by email, recalled by voice', turns: [{ q: 'When is the reserve study kickoff now, and who owns the agenda?', truth: [async () => ({ ed_told_amanda_by_email: fact })], expect: 'Recalls the date and that Paige owns the agenda, learned from Ed\'s email.' }] };
  let res;
  try { res = await runConversation(testOwner, sc); }
  finally { await sb.from('amanda_memory').update({ status: 'superseded' }).eq('owner_user_id', testOwner.user_id); }
  res.memory_written = mem;
  return res;
}

(async () => {
  await require('../lib/characters/production').load(require('../lib/characters/registry')).catch((e) => console.warn('canon not loaded:', e.message));
  const o = await owner();
  const results = [];
  for (const sc of SCENARIOS) if (!ONLY.length || ONLY.includes(sc.id)) results.push(await runConversation(o, sc));
  if (!ONLY.length || ONLY.includes('S8')) results.push(await crossChannel(o));
  const turns = results.flatMap((r) => r.turns);
  const avg = (k) => Math.round(turns.reduce((s, t) => s + (Number(t.grade[k]) || 0), 0) / turns.length * 10) / 10;
  const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; };
  const summary = { conversations: results.length, turns: turns.length, passed: turns.filter((t) => t.grade.pass).length,
    accuracy: avg('accuracy'), relevance: avg('relevance'), conversational: avg('conversational'), retrieval: avg('retrieval'),
    first_words_ms_p50: pct(turns.map((t) => t.first_text_ms || 0), 0.5), total_ms_p50: pct(turns.map((t) => t.total_ms), 0.5), total_ms_p90: pct(turns.map((t) => t.total_ms), 0.9),
    amanda_cost_usd: Math.round(results.reduce((s, r) => s + r.amanda_cost_usd, 0) * 10000) / 10000 };
  summary.cost_per_turn_usd = Math.round(summary.amanda_cost_usd / turns.length * 10000) / 10000;
  console.log('\nSUMMARY', JSON.stringify(summary));
  if (OUT) {
    const md = [`# Amanda acceptance run ${new Date().toISOString().slice(0, 16)}Z`, '', '```', JSON.stringify(summary, null, 1), '```', '',
      ...results.flatMap((r) => [`## ${r.id} ${r.name}`, '', ...r.turns.flatMap((t) => [`**Ed:** ${t.q}`, '', `**Amanda:** ${t.answer}`, '', `Tools: ${t.tools.join(', ') || 'none'} · first words ${t.first_text_ms} ms · total ${t.total_ms} ms · ${t.grade.pass ? 'PASS' : 'FAIL'} (accuracy ${t.grade.accuracy}, relevance ${t.grade.relevance}, conversational ${t.grade.conversational}, retrieval ${t.grade.retrieval}) ${t.grade.issues || ''}`, '']), `Cost (Amanda's model calls): $${r.amanda_cost_usd}`, ''])].join('\n');
    fs.writeFileSync(OUT, md);
    console.log('report written:', OUT);
  }
})().catch((e) => { console.error('ERR', e.stack || e.message); process.exit(1); });
