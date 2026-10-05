// tests/test_amanda_request.js  (Issue #29 Phase 2A) — the shared Amanda request contract
// In-memory fake: writes are allowed ONLY to objectives / objective_events (any other
// write throws), with the 489 rule "one OPEN objective per subject_key". A fake model
// client counts calls. No network, no real model, no domain action.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { handleRequest, screenIntent, normalizedSubject, subjectKeyFor, honestyGuard } = require('../lib/amanda/request');

const tests = []; const check = (n, fn) => tests.push([n, fn]);
const u = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CG = u(901); const NOW = Date.parse('2026-10-05T15:00:00Z');
const ACTOR = { email: 'owner@example.test', name: 'Ed Owner' };
const OPEN = ['open', 'waiting_resident', 'waiting_third_party', 'waiting_human'];

function db(seed = {}, { failInsert = {} } = {}) {
  const T = { communities: [{ id: CG, name: 'Canyon Gate at Cinco Ranch', management_status: 'active', financials_active: true, arc_active: true, is_demo: false }], objectives: [], objective_events: [], ...JSON.parse(JSON.stringify(seed)) };
  const writes = []; let seq = 0;
  const WRITABLE = new Set(['objectives', 'objective_events']);
  function from(t) {
    const f = []; let order = null; let lim = null; let mode = 'select'; let payload = null; let single = false;
    const q = {
      select() { return q; }, eq(c, v) { f.push((r) => r[c] === v); return q; }, in(c, v) { f.push((r) => v.includes(r[c])); return q; },
      gte(c, v) { f.push((r) => r[c] != null && String(r[c]) >= String(v)); return q; }, lte(c, v) { f.push((r) => r[c] != null && String(r[c]) <= String(v)); return q; },
      lt(c, v) { f.push((r) => r[c] != null && String(r[c]) < String(v)); return q; }, not() { return q; },
      or(expr) { const parts = expr.split(',').map((p) => p.split('.')); f.push((r) => parts.some(([c, op, v]) => (op === 'eq' ? r[c] === v : op === 'is' ? r[c] == null : false))); return q; },
      order(c, o = {}) { order = [c, o.ascending !== false]; return q; }, limit(n) { lim = n; return q; },
      insert(p) { if (!WRITABLE.has(t)) throw new Error(`write attempted on ${t}`); mode = 'insert'; payload = p; return q; },
      update(p) { if (!WRITABLE.has(t)) throw new Error(`write attempted on ${t}`); mode = 'update'; payload = p; return q; },
      upsert() { throw new Error(`write attempted on ${t}`); }, delete() { throw new Error(`write attempted on ${t}`); },
      single() { single = true; return q; },
      then(res, rej) { return Promise.resolve(exec()).then(res, rej); },
    };
    function exec() {
      const rows = T[t] || (T[t] = []);
      if (mode === 'insert') {
        if (failInsert[t]) return { data: null, error: failInsert[t] };
        const row = { id: u(500 + (++seq)), created_at: new Date().toISOString(), ...payload };
        if (t === 'objectives' && row.subject_key && OPEN.includes(row.status || 'open') && rows.some((r) => r.subject_key === row.subject_key && OPEN.includes(r.status))) return { data: null, error: { code: '23505', message: 'duplicate key' } };
        rows.push(row); writes.push({ t, op: 'insert', row });
        return { data: single ? row : [row], error: null };
      }
      let out = rows.filter((r) => f.every((p) => p(r)));
      if (mode === 'update') { for (const r of out) { Object.assign(r, payload); writes.push({ t, op: 'update', id: r.id }); } return { data: out, error: null }; }
      if (order) { const [c, asc] = order; out = [...out].sort((a, b) => (String(a[c] ?? '') < String(b[c] ?? '') ? -1 : 1) * (asc ? 1 : -1)); }
      if (lim != null) out = out.slice(0, lim);
      return { data: single ? out[0] || null : out.map((r) => ({ ...r })), error: null };
    }
    return q;
  }
  return { from, T, writes };
}
function model(reply) {
  const m = { calls: 0, prompts: [], messages: { create: async (args) => { m.calls += 1; m.prompts.push(args.messages[0].content); if (reply instanceof Error) throw reply; return { content: [{ type: 'text', text: typeof reply === 'string' ? reply : JSON.stringify(reply) }] }; } } };
  return m;
}
const WORK_REPLY = { intent: 'work', reply: 'I would start with the board packet and the open payables.', plan: ['Check the packet status with Paige', 'Clear the two past-due bills with Emma'], specialists: ['paige', 'emma', 'nobody'], next_dependency: 'Financials for September', title: 'Canyon Gate ready for Monday', domain: 'board' };
const ask = (d, m, input) => handleRequest({ channel: 'app', actor: ACTOR, ...input }, { supabase: d, anthropic: m, now: NOW });

check('invalid input is refused deterministically: no model call, no writes', async () => {
  const d = db(); const m = model(WORK_REPLY);
  for (const [input, err] of [[{ actor: null, text: 'hi' }, 'actor_required'], [{ text: '   ' }, 'empty'], [{ text: 'x'.repeat(2001) }, 'too_long'], [{ text: 'hi', channel: 'voice' }, 'channel_not_enabled']]) {
    const r = await handleRequest({ channel: 'app', actor: ACTOR, ...input }, { supabase: d, anthropic: m, now: NOW });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.error, err); assert.strictEqual(r.model_calls, 0);
  }
  assert.strictEqual(m.calls, 0); assert.strictEqual(d.writes.length, 0);
});

check('DECISION: "Approve this bill" is routed, never executed: no model call, no objective, exact destination + floor', async () => {
  const d = db(); const m = model(WORK_REPLY);
  const r = await ask(d, m, { text: 'Approve this bill', refs: { kind: 'ap_invoice', id: u(7) } });
  assert.strictEqual(r.intent, 'decision'); assert.strictEqual(r.model_calls, 0); assert.strictEqual(r.actions_executed, 0); assert.strictEqual(r.durable, false);
  assert.strictEqual(r.action_request.allowed_here, false); assert.strictEqual(r.action_request.verb, 'approve');
  assert.strictEqual(r.action_request.destination.href, `/#tab=ap&invoice=${u(7)}`);
  assert.match(r.action_request.floor, /Payables/); assert.match(r.reply, /can't approve anything from a conversation/);
  const rel = await ask(d, m, { text: 'Amanda, release payment on this one', refs: { kind: 'ap_invoice', id: u(7) } });
  assert.strictEqual(rel.intent, 'decision'); assert.match(rel.action_request.floor, /Only Ed releases payments/);
  const fin = await ask(d, m, { text: 'please finalize the ACC decision', refs: { kind: 'acc_decision', id: u(8) } });
  assert.strictEqual(fin.action_request.destination.href, `/#tab=acc&decision=${u(8)}`);
  assert.strictEqual(m.calls, 0); assert.strictEqual(d.writes.length, 0);
});

check('intent screen: decisions / work / questions; "send me" is a question, not an action', () => {
  assert.strictEqual(screenIntent('Approve this bill').intent, 'decision');
  assert.strictEqual(screenIntent('can you mark it paid').intent, 'decision');
  assert.strictEqual(screenIntent('Get Canyon Gate ready for Monday.').intent, 'work');
  assert.strictEqual(screenIntent('Find out why this invoice is stuck and fix what you safely can.').intent, 'work');
  assert.strictEqual(screenIntent('Amanda, what still needs me today?').intent, 'query');
  assert.strictEqual(screenIntent('Can you send me a summary of Canyon Gate?').intent, 'query');
  assert.strictEqual(screenIntent('Mrs. Smith says she already submitted her ACC application. See what is going on.').intent, null, 'left to the single model call');
});

check('QUERY (broader question) answers from state with ONE model call and creates nothing', async () => {
  const d = db(); const m = model({ intent: 'query', reply: 'The Gexa bill is late because nobody approved it — Emma has it.', plan: [], specialists: ['emma'] });
  const r = await ask(d, m, { text: 'Why is the Gexa bill late?' });
  assert.strictEqual(r.intent, 'query'); assert.strictEqual(r.model_calls, 1); assert.strictEqual(m.calls, 1);
  assert.strictEqual(r.durable, false); assert.strictEqual(r.objective, null);
  assert.strictEqual(d.writes.length, 0, 'a question writes nothing');
  assert.ok(!/—/.test(r.reply), 'no em-dashes');
  assert.match(m.prompts[0], /CURRENT STATE \(from trustEd records/); assert.match(m.prompts[0], /You PROPOSE/);
  assert.match(m.prompts[0], /Never write as if the work is underway or promised/); assert.match(m.prompts[0], /Copy any count exactly/);
});

// A feed with known lanes: now 3 (Emma 2, Annie 1), waiting 1, policy 1 (the W-9 hold).
const statusWorld = () => ({
  objectives: [
    { id: u(81), title: 'Past due: Gexa Energy', status: 'open', autonomy_class: 'REVIEW', priority: 'high', next_action: 'Approve in Payables', domain: 'ap', subject_key: 'amanda_request:a:1', accountable_persona: 'amanda', community_id: CG, opened_at: '2026-10-01T00:00:00Z', last_activity_at: '2026-10-01T00:00:00Z' },
    { id: u(82), title: 'New payee: Sky High', status: 'open', autonomy_class: 'REVIEW', priority: 'normal', next_action: 'Check W-9', domain: 'ap', subject_key: 'amanda_request:a:2', accountable_persona: 'amanda', community_id: CG, opened_at: '2026-10-02T00:00:00Z', last_activity_at: '2026-10-02T00:00:00Z' },
    { id: u(83), title: 'ACC: Driveway extension', status: 'open', autonomy_class: 'REVIEW', priority: 'normal', next_action: 'Review new documents', domain: 'acc', subject_key: 'amanda_request:a:3', accountable_persona: 'amanda', community_id: CG, opened_at: '2026-10-03T00:00:00Z', last_activity_at: '2026-10-03T00:00:00Z' },
    { id: u(84), title: 'Bill waiting on the community', status: 'open', autonomy_class: 'BLOCK', blocked_reason: 'Payables needs the community.', domain: 'ap', subject_key: 'amanda_request:a:4', accountable_persona: 'amanda', community_id: CG, opened_at: '2026-09-20T00:00:00Z', last_activity_at: '2026-09-20T00:00:00Z' },
  ],
  ap_invoices: [{ id: u(85), community_id: CG, vendor_id: 'vDJ', vendor_invoice_number: '1010', total_cents: 30000, status: 'on_hold', needs_review: true, notes: 'Emma: loaded from email. ON HOLD (Issue #14, Ed 2026-10-01): W-9 required before payment.', created_at: '2026-10-02T00:00:00Z', vendor: { name: 'Rene Rosales (DJ Randy)' }, communities: { name: 'Canyon Gate at Cinco Ranch' } }],
});

check('EXACT STATUS: "What still needs me today?" is answered from the feed read model with 0 model calls and exact lane/specialist counts', async () => {
  const d = db(statusWorld()); const m = model(WORK_REPLY);
  const r = await ask(d, m, { text: 'What still needs me today?' });
  assert.strictEqual(r.intent, 'query'); assert.strictEqual(r.deterministic, 'status');
  assert.strictEqual(r.model_calls, 0); assert.strictEqual(m.calls, 0, 'no model for the exact-status family');
  assert.deepStrictEqual(r.status.counts, { now: 3, waiting: 1, policy: 1 });
  assert.deepStrictEqual(r.status.by_specialist, { Emma: 2, Annie: 1 });
  assert.match(r.reply, /^Today, 3 items need you now, 1 is waiting on something and 1 needs your decision\./);
  assert.match(r.reply, /For your decision:\n- On hold: Rene Rosales \(DJ Randy\) #1010 \(\$300\.00\)/);
  assert.match(r.reply, /Needs you now:\n- Past due: Gexa Energy/);
  assert.strictEqual(r.durable, false); assert.strictEqual(d.writes.length, 0);
  assert.strictEqual(r.status.policy[0].action.href, `/#tab=ap&invoice=${u(85)}`);
  for (const t of ['Amanda, what still needs me today?', 'what needs me', 'What is on my plate today?', 'Give me a status update', 'What needs me at Canyon Gate today?']) {
    const x = await ask(db(statusWorld()), m, { text: t });
    assert.strictEqual(x.model_calls, 0, t); assert.strictEqual(x.deterministic, 'status', t);
  }
  assert.strictEqual(m.calls, 0);
  const scoped = await ask(db(statusWorld()), m, { text: 'What needs me at Canyon Gate today?' });
  assert.strictEqual(scoped.community.name, 'Canyon Gate at Cinco Ranch'); assert.match(scoped.reply, /^For Canyon Gate today, /);
  const empty = await ask(db(), m, { text: 'What still needs me today?' });
  assert.strictEqual(empty.reply, 'Nothing needs a person right now.'); assert.strictEqual(empty.model_calls, 0);
});

check('EXACT STATUS stays narrow: broader questions still take the single model call', async () => {
  for (const t of ['Why is the Texas Access Works bill on hold?', 'What still needs me to approve the Gexa bill and why is it late?', 'Summarize Canyon Gate']) {
    const m = model({ intent: 'query', reply: 'ok' });
    const r = await ask(db(statusWorld()), m, { text: t });
    assert.strictEqual(r.model_calls, 1, t); assert.strictEqual(m.calls, 1, t); assert.notStrictEqual(r.deterministic, 'status', t);
  }
});

check('HONESTY: the exact production phrases are rewritten as proposals; harmless future language is kept', () => {
  assert.strictEqual(honestyGuard("I'll route the two approvals to Emma now and flag the three blockers so we can clear what's possible before Monday."),
    "I would route the two approvals to Emma and flag the three blockers so we can clear what's possible before Monday.");
  assert.strictEqual(honestyGuard('On it. Canyon Gate has two past due invoices, Gexa Energy and the Bedrock management fee, that need to go to Emma for approval before Monday.'),
    'Canyon Gate has two past due invoices, Gexa Energy and the Bedrock management fee, that need to go to Emma for approval before Monday.');
  assert.strictEqual(honestyGuard("I'm routing the Gexa bill to Emma. I'm sending the reminder to staff."), 'I would route the Gexa bill to Emma. I would send the reminder to staff.');
  assert.strictEqual(honestyGuard("I'm handling it."), 'I can track this work and propose the plan.');
  assert.strictEqual(honestyGuard("I'll take care of it right away."), 'I can track this work and propose the plan.');
  assert.strictEqual(honestyGuard('Let me flag the Winstead bill for Payables.'), 'I would flag the Winstead bill for Payables.');
  assert.strictEqual(honestyGuard('I am going to chase the corrected invoice now.'), 'I would chase the corrected invoice.');
  const harmless = "Emma will need your approval on both. I'll need the September financials first. The meeting will be Monday.";
  assert.strictEqual(honestyGuard(harmless), harmless, 'non-execution future language is untouched');
});

check('HONESTY end to end: a model reply with "On it" / "I will ... now" never reaches the operator or the timeline', async () => {
  const d = db();
  const m = model({ ...WORK_REPLY, reply: "On it. I'll route the two approvals to Emma now and flag the three blockers.", plan: ["I'm sending the Gexa bill to Emma", 'Check the packet with Paige'] });
  const r = await ask(d, m, { text: 'Get Canyon Gate ready for Monday.' });
  assert.strictEqual(r.reply, 'I would route the two approvals to Emma and flag the three blockers.');
  assert.deepStrictEqual(r.plan, ['I would send the Gexa bill to Emma', 'Check the packet with Paige']);
  const out = d.T.objective_events.find((e) => e.kind === 'message_out').summary;
  assert.ok(!/On it|I'll route|now and|I'm sending/i.test(out), 'the timeline records the proposal language, not an execution claim');
  assert.strictEqual(r.durable, true); assert.strictEqual(d.T.objectives.length, 1, 'work durability unchanged');
});

check('WORK: opens exactly one bounded Amanda objective and logs request + proposal (session actor)', async () => {
  const d = db(); const m = model(WORK_REPLY);
  const r = await ask(d, m, { text: 'Get Canyon Gate ready for Monday.' });
  assert.strictEqual(r.intent, 'work'); assert.strictEqual(r.model_calls, 1); assert.strictEqual(r.durable, true); assert.strictEqual(r.objective.created, true);
  assert.strictEqual(d.T.objectives.length, 1);
  const o = d.T.objectives[0];
  assert.strictEqual(o.accountable_persona, 'amanda'); assert.strictEqual(o.owner_kind, 'amanda'); assert.strictEqual(o.autonomy_class, 'REVIEW'); assert.strictEqual(o.wake_reason, 'human_request');
  assert.strictEqual(o.community_id, CG, 'community resolved from the text'); assert.strictEqual(o.objective_type, 'board'); assert.strictEqual(o.needs_reasoning, false);
  assert.match(o.subject_key, new RegExp(`^amanda_request:${CG}:[0-9a-f]{16}$`));
  const kinds = d.T.objective_events.map((e) => [e.kind, e.actor]);
  assert.deepStrictEqual(kinds, [['opened', 'amanda'], ['message_in', ACTOR.email], ['message_out', 'amanda']]);
  assert.deepStrictEqual(r.specialists, ['paige', 'emma'], 'unknown specialist keys dropped');
  assert.strictEqual(r.next_dependency, 'Financials for September');
  assert.ok(d.writes.every((w) => ['objectives', 'objective_events'].includes(w.t)));
});

check('WORK repeated (different punctuation / word order / "Amanda,") reuses the same open objective: no duplicate', async () => {
  const d = db(); const m = model(WORK_REPLY);
  await ask(d, m, { text: 'Get Canyon Gate ready for Monday.' });
  const r2 = await ask(d, m, { text: 'Amanda, get Canyon Gate ready for Monday!' });
  const r3 = await ask(d, m, { text: 'Get ready for Monday, Canyon Gate' });
  assert.strictEqual(d.T.objectives.length, 1, 'still one open objective');
  assert.strictEqual(r2.objective.created, false); assert.strictEqual(r3.objective.id, r2.objective.id);
  assert.strictEqual(d.T.objective_events.filter((e) => e.kind === 'message_in').length, 3, 'each request is on the timeline');
  assert.strictEqual(normalizedSubject('Get Canyon Gate ready for Monday.'), normalizedSubject('get ready for monday canyon gate!!'));
});

check('WORK about a record reattaches to that record\'s existing Amanda objective (#27 subject_key), never a second one', async () => {
  const d = db({ objectives: [{ id: u(60), title: 'Past due: Gexa', status: 'open', subject_key: `ap_invoice:${u(7)}`, accountable_persona: 'amanda', community_id: CG }] });
  const m = model({ ...WORK_REPLY, domain: 'ap' });
  const r = await ask(d, m, { text: 'Find out why this invoice is stuck and fix what you safely can.', refs: { kind: 'ap_invoice', id: u(7) } });
  assert.strictEqual(r.objective.id, u(60)); assert.strictEqual(r.objective.created, false); assert.strictEqual(d.T.objectives.length, 1);
  assert.strictEqual(r.destination.href, `/#tab=ap&invoice=${u(7)}`, 'the controlled destination comes back with the proposal');
  assert.strictEqual(subjectKeyFor({ refs: { kind: 'ap_invoice', id: u(7) }, communityId: CG, text: 'x' }), `ap_invoice:${u(7)}`);
});

check('model cannot escalate to an action, and cannot claim one: decision -> routed; "I approved..." is removed', async () => {
  const d = db();
  const r = await ask(d, model({ intent: 'decision', reply: 'Sure' }), { text: 'Mrs. Smith wants this sorted, deal with it' });
  assert.strictEqual(r.intent, 'decision'); assert.strictEqual(r.durable, false); assert.strictEqual(d.T.objectives.length, 0); assert.strictEqual(r.model_calls, 1);
  assert.strictEqual(honestyGuard('I approved the Gexa bill. Next, Paige should finish the packet.'), 'Next, Paige should finish the packet.');
  assert.strictEqual(honestyGuard('I\'ve already sent the letter to the homeowner! Annie can review.'), 'Annie can review.');
});

check('one model call maximum: a failing or unusable model is never retried and writes nothing', async () => {
  for (const reply of [new Error('overloaded'), 'not json at all']) {
    const d = db(); const m = model(reply);
    const r = await ask(d, m, { text: 'Get Canyon Gate ready for Monday.' });
    assert.strictEqual(r.ok, false); assert.strictEqual(m.calls, 1); assert.strictEqual(r.model_calls, 1); assert.strictEqual(d.writes.length, 0);
  }
  const none = await ask(db(), null, { text: 'Why is the Gexa bill late?' }); // (the exact-status family needs no model at all)
  assert.strictEqual(none.ok, false); assert.strictEqual(none.model_calls, 0);
});

check('WORK with a stale / closed objective_id is NOT accepted: tracking_failed, no plan, nothing written', async () => {
  const d = db({ objectives: [{ id: u(70), title: 'Old work', status: 'resolved', subject_key: 'amanda_request:x:y', accountable_persona: 'amanda', community_id: CG }] });
  const m = model(WORK_REPLY);
  const r = await ask(d, m, { text: 'Get Canyon Gate ready for Monday.', objective_id: u(70) });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.error, 'tracking_failed'); assert.strictEqual(r.intent, 'work');
  assert.strictEqual(r.durable, false); assert.strictEqual(r.objective, null);
  assert.deepStrictEqual(r.plan, [], 'the model plan is not presented as accepted work'); assert.deepStrictEqual(r.specialists, []); assert.strictEqual(r.next_dependency, null);
  assert.strictEqual(r.reply, 'I could not track this work, so I have not accepted it. Nothing else was changed.');
  assert.match(r.tracking_reason, /closed or not found/);
  assert.strictEqual(r.model_calls, 1); assert.strictEqual(m.calls, 1, 'no model retry'); assert.strictEqual(d.writes.length, 0);
  const missing = await ask(db(), model(WORK_REPLY), { text: 'Get Canyon Gate ready for Monday.', objective_id: u(71) });
  assert.strictEqual(missing.error, 'tracking_failed');
});

check('WORK whose objective insert fails (not a duplicate) is NOT accepted: tracking_failed, no events, one model call', async () => {
  const d = db({}, { failInsert: { objectives: { code: '42501', message: 'permission denied for table objectives' } } });
  const m = model(WORK_REPLY);
  const r = await ask(d, m, { text: 'Get Canyon Gate ready for Monday.' });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.error, 'tracking_failed'); assert.strictEqual(r.durable, false); assert.deepStrictEqual(r.plan, []);
  assert.match(r.tracking_reason, /could not open the objective: permission denied/);
  assert.strictEqual(d.T.objective_events.length, 0); assert.strictEqual(m.calls, 1);
});

check('WORK tracked but a timeline entry fails: still durable, and the gap is surfaced as an audit warning (never swallowed)', async () => {
  const d = db({}, { failInsert: { objective_events: { code: '42501', message: 'permission denied for table objective_events' } } });
  const r = await ask(d, model(WORK_REPLY), { text: 'Get Canyon Gate ready for Monday.' });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.durable, true); assert.ok(r.objective && r.objective.id);
  assert.ok(Array.isArray(r.audit_warnings) && r.audit_warnings.length === 3, 'opened + message_in + message_out each reported');
  assert.ok(r.audit_warnings.every((w) => /not recorded on the work.s history/.test(w)));
  const ok = await ask(db(), model(WORK_REPLY), { text: 'Get Canyon Gate ready for Monday.' });
  assert.strictEqual(ok.audit_warnings, undefined, 'no warning when everything was recorded');
});

check('UI + API show a tracking failure as a failure, never as tracked work', () => {
  const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'amanda.js'), 'utf8');
  assert.ok(api.includes("out.error === 'tracking_failed' ? 409"), 'tracking_failed is a non-2xx response');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app', 'today.html'), 'utf8').split(String.fromCharCode(13)).join('');
  const js = html.slice(html.indexOf('// ---- Message Amanda (Issue #29 Phase 2A)'), html.indexOf('var feedSeq = 0;'));
  assert.ok(js.includes('var d = r && (r.data || r.body)'), 'reads the body of a non-2xx response');
  const fail = js.indexOf('if (d.ok === false)'); const tracked = js.indexOf('Tracked as new work'); const plan = js.indexOf('d.plan && d.plan.length');
  assert.ok(fail > 0 && fail < tracked && fail < plan, 'the failure branch renders and returns before any plan or Tracked-as text');
  const branch = js.slice(fail, fail + 400);
  assert.ok(js.includes('data-ask-failed=') && branch.includes('tx-err') && branch.includes('return;'));
  assert.ok(js.includes('Audit warning: '), 'audit warnings are shown');
});

check('session actor only; proposals only; no background work; board portal untouched; cost attributed', () => {
  const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'amanda.js'), 'utf8');
  assert.ok(/const actor = \{ email: u\.email, name: u\.full_name \|\| null \}/.test(api), 'actor from the session');
  assert.ok(!/b\.actor|body\.actor|b\.name|req\.body\.email/.test(api), 'no body-supplied actor');
  assert.ok(/requireAdmin\(req, res\)/.test(api) && !/router\.(get|put|patch|delete)\(/.test(api), 'admin-gated, POST only');
  const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'amanda', 'request.js'), 'utf8');
  assert.ok(!/setInterval|setTimeout|scheduler|register\(/.test(lib), 'no background work');
  assert.ok(!/require\([^)]*(graph_send|notifications|\/ap\/|acc\/finalize|enforcement|payments|stripe|email)/.test(lib), 'no action or mail modules');
  assert.ok(!/\.from\('(?!objectives|objective_events|communities)[a-z_]+'\)\.(insert|update|upsert|delete)/.test(lib), 'writes only to objectives / objective_events');
  assert.ok(!/lib\/amanda/.test(fs.readFileSync(path.join(__dirname, '..', 'api', 'board_portal.js'), 'utf8')), 'board Ask Amanda does not use the staff contract');
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'ai', 'routing.config.json'), 'utf8'));
  assert.ok(cfg.workflows['team.amanda_request'], 'routed workflow exists, so every call is attributed to it');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app', 'today.html'), 'utf8');
  assert.ok(/Message Amanda/.test(html) && /Proposals only\. Amanda doesn’t approve, pay, send or change anything from here\./.test(html));
  assert.strictEqual((html.match(/id="th-ask"/g) || []).length, 1, 'one composer, on the existing card');
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, fn] of tests) {
    try { await fn(); pass += 1; console.log(`  ✓ ${n}`); } catch (e) { fail += 1; console.log(`  ✗ ${n}\n    ${String(e.stack).split('\n').slice(0, 4).join('\n    ')}`); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
