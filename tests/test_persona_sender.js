'use strict';
// ============================================================================
// tests/test_persona_sender.js  (Ed 2026-10-19) — every teammate sends AS themselves
// ----------------------------------------------------------------------------
// Scar: Maggie's first website-inquiry draft showed "Sends from claire@" with
// Claire's signature, "Claire suggests", and a Compliance-sensitive banner on a
// plain prospect inquiry. The page and the send route each kept their own persona
// lists with a silent Claire fallback. This suite pins:
//   RESOLVER  every roster teammate -> own mailbox + own signature; Tessa/unknown refused;
//   SEND      the REAL /:id/send route (Graph stubbed) sends Maggie from maggie@ with
//             Maggie's signature, to the form submitter, never the relay address;
//   PAGE      labels come from the server directory; no hardcoded "Claire suggests";
//             the compliance banner only on compliance classes; unsendable = no Send;
//   MAGGIE    the prospect reply standard is a deterministic check with a fallback.
//   node tests/test_persona_sender.js
// ============================================================================
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path'); const vm = require('vm'); const http = require('http');
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_KEY']) process.env[k] = process.env[k] || (k === 'SUPABASE_URL' ? 'http://localhost:1' : 'test-key');
process.env.GRAPH_TENANT_ID = process.env.GRAPH_TENANT_ID || 't'; process.env.GRAPH_CLIENT_ID = process.env.GRAPH_CLIENT_ID || 'c'; process.env.GRAPH_CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET || 's';

let pass = 0, fail = 0; const pending = [];
const check = (name, fn) => pending.push(async () => { try { await fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.log('  ✗', name, '\n     ', e.message); } });
const ROOT = path.join(__dirname, '..');
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

// ---- Graph: real module, sends captured (nothing leaves the machine) ----
const realGS = require('../lib/email/graph_send');
const sends = [];
stub('../lib/email/graph_send', { ...realGS, isConfigured: () => true,
  sendAs: async (o) => { sends.push({ kind: 'sendAs', ...o }); return { ok: true }; },
  sendReplyAs: async (o) => { sends.push({ kind: 'sendReplyAs', ...o }); return { ok: true }; } });
const graphSend = require('../lib/email/graph_send');
const { resolveSender, senderDirectory, DEDICATED_PERSONAS, ROSTER_SIGNED } = require('../lib/email/persona_sender');
const { identity } = require('../lib/email/persona_signature');

const EXPECTED_MAILBOX = {
  claire: 'claire@bedrocktx.com', emma: 'emma@bedrocktx.com', miranda: 'miranda@bedrocktx.com', annie: 'annie@bedrocktx.com',
  paige: 'paige@bedrocktx.com', kat: 'kat@bedrocktx.com', amanda: 'amandaalbright@bedrocktx.com', reese: 'reese@bedrocktx.com',
  isabella: 'isabella@bedrocktx.com', mei: 'mei@bedrocktx.com', priya: 'priya@bedrocktx.com', maggie: 'maggie@bedrocktx.com',
  darby: 'darby@bedrocktx.com', phoebe: 'phoebe@bedrocktx.com', vivian: 'vivian@bedrocktx.com',
};
const ALL = [...DEDICATED_PERSONAS, ...ROSTER_SIGNED];

console.log('Persona sender (resolver)');

check('RESOLVER: every sending teammate is covered by the expectations table (a new teammate must be added here)', () => {
  assert.deepEqual([...ALL].sort(), Object.keys(EXPECTED_MAILBOX).sort());
});

for (const p of Object.keys(EXPECTED_MAILBOX)) {
  check(`RESOLVER: ${p} sends from ${EXPECTED_MAILBOX[p]} with ${p}'s own signature`, () => {
    const s = resolveSender(p);
    assert.equal(s.ok, true, s.reason);
    assert.equal(s.mailbox, EXPECTED_MAILBOX[p]);
    assert.equal(s.mailbox, graphSend.personaMailbox(p), 'resolver and graph_send agree');
    const { html } = s.build('Hello there.', 'Waterview', '');
    const surname = identity(p).name.replace(/"[^"]*"\s*/g, '').trim().split(/\s+/).pop();
    assert.ok(html.includes(surname) || (p === 'claire' && /Claire/.test(html)), `${p}'s signature (${surname}) in the email`);
    if (p !== 'claire') assert.ok(!/claire@bedrocktx\.com/i.test(html), `${p}'s email carries no Claire signature`);
    if (p !== 'claire') assert.notEqual(s.first, 'Claire');
  });
}

check('RESOLVER: the shared general queue (or no owner) answers as Claire, the front office', () => {
  for (const p of ['general', '', null, undefined, 'CLAIRE']) { const s = resolveSender(p); assert.equal(s.ok, true); assert.equal(s.mailbox, 'claire@bedrocktx.com'); assert.equal(s.first, 'Claire'); }
});

check('RESOLVER: Tessa and an unknown persona are REFUSED, never sent as Claire', () => {
  const t = resolveSender('tessa'); assert.equal(t.ok, false); assert.match(t.reason, /Tessa/);
  const u = resolveSender('zelda'); assert.equal(u.ok, false); assert.match(u.reason, /Nothing was sent/);
});

check('RESOLVER: Maggie is "Maggie Sullivan", maggie@, label not Claire', () => {
  const s = resolveSender('maggie');
  assert.equal(s.name, 'Maggie Sullivan'); assert.equal(s.first, 'Maggie'); assert.match(s.label, /^Maggie Sullivan/);
});

check('DIRECTORY: the page directory is the resolver (same name and mailbox for every teammate; tessa unsendable)', () => {
  const d = senderDirectory();
  for (const p of Object.keys(EXPECTED_MAILBOX)) { assert.equal(d[p].sendable, true, p); assert.equal(d[p].mailbox, EXPECTED_MAILBOX[p], p); assert.equal(d[p].name, resolveSender(p).name, p); }
  assert.equal(d.general.mailbox, 'claire@bedrocktx.com');
  assert.equal(d.tessa.sendable, false);
});

// ---- the REAL send route, Supabase faked, Graph captured ----
const OWNER_EMAIL = 'egojara@bedrocktx.com';
stub('../api/_require_admin', {
  OWNER_EMAIL,
  getAuthedUser: async () => ({ id: 'u1', role: 'admin', email: OWNER_EMAIL }),
  requireAdmin: async () => ({ id: 'u1', role: 'admin', email: OWNER_EMAIL }),
  requireStaff: async () => ({ id: 'u1', role: 'admin', email: OWNER_EMAIL }),
  requireOwner: async () => ({ id: 'u1', role: 'admin', email: OWNER_EMAIL }),
});
stub('../lib/email/proofread', { proofreadEmailBody: async (t) => ({ text: t }) });
let ROW = null; const writes = [];
function fakeQuery(table) {
  const st = { table, op: 'select', single: false };
  const done = () => {
    if (st.op !== 'select') { writes.push({ table, op: st.op, payload: st.payload }); return { data: st.op === 'insert' ? { id: 'out-1' } : null, error: null }; }
    if (table === 'email_messages' && st.single) return { data: ROW, error: null };
    return { data: st.single ? null : [], error: null };
  };
  const q = new Proxy({}, { get(_, k) {
    if (k === 'then') return (res, rej) => Promise.resolve(done()).then(res, rej);
    if (k === 'maybeSingle' || k === 'single') return () => { st.single = true; return q; };
    if (['insert', 'update', 'upsert', 'delete'].includes(k)) return (payload) => { st.op = k; st.payload = payload; return q; };
    return () => q;
  } });
  return q;
}
const fakeSupabase = { from: (t) => fakeQuery(t), rpc: () => fakeQuery('rpc'), storage: { from: () => ({ download: async () => ({ data: null, error: { message: 'none' } }), upload: async () => ({ error: null }) }) } };
const realSB = require('@supabase/supabase-js');
stub('@supabase/supabase-js', { ...realSB, createClient: () => fakeSupabase });

const express = require('express');
const { router } = require('../api/email_triage');
const app = express(); app.use('/api/email-triage', router);
let base;
async function call(method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, j };
}
const MSG_ID = '11111111-2222-3333-4444-555555555555';
const websiteRow = () => ({
  persona: 'maggie', sender_email: 'notifications@bedrocktxai.com', sender_name: 'Bedrock Website', subject: 'Website contact: Prospective management client',
  body_preview: 'Purpose: Prospective management client', body_full: 'Website contact\nPurpose: Prospective management client\nName: Pat Doe\nEmail: pat@example.com\nMessage: We are looking for a new manager.',
  classification: 'website_inquiry', community_id: null, mailbox: 'welcome@bedrocktx.com', graph_id: 'g1', internet_message_id: '<x@y>', conversation_id: 'c1', received_at: '2026-10-18T15:00:00Z',
  extracted: { website_inquiry: { claimed: true, verified: true, owner: 'maggie', intent: 'prospective_management_client', name: 'Pat Doe', email: 'pat@example.com' }, draft: { persona: 'maggie', careful: false } },
  community: null,
});

console.log('Persona sender (real send route)');

check('SEND: an approved Maggie reply goes FROM maggie@ with Maggie\'s signature, TO the form submitter', async () => {
  ROW = websiteRow(); sends.length = 0;
  const r = await call('POST', `/api/email-triage/${MSG_ID}/send`, { body: 'Hi Pat,\n\nThank you for reaching out.' });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(sends.length, 1, 'exactly one send');
  const s = sends[0];
  assert.equal(s.from, 'maggie@bedrocktx.com');
  assert.equal(s.to, 'pat@example.com');
  assert.ok(/Sullivan/.test(s.html), 'Maggie\'s signature');
  assert.ok(!/claire@bedrocktx\.com/i.test(s.html), 'no Claire signature');
  assert.equal(s.kind, 'sendAs', 'fresh reply (the source lives in welcome@, not maggie@)');
  assert.equal(s.subject, require('../lib/email/website_inquiry').REPLY_SUBJECT);
});

check('SEND: the website relay address is refused as a recipient, nothing is sent', async () => {
  ROW = websiteRow(); sends.length = 0;
  const r = await call('POST', `/api/email-triage/${MSG_ID}/send`, { body: 'Hi', to: 'notifications@bedrocktxai.com' });
  assert.equal(r.status, 409); assert.equal(r.j.error, 'relay_recipient'); assert.equal(sends.length, 0);
});

for (const p of Object.keys(EXPECTED_MAILBOX)) {
  check(`SEND: a reply owned by ${p} goes from ${EXPECTED_MAILBOX[p]}`, async () => {
    ROW = { ...websiteRow(), persona: p, classification: 'general_inquiry', extracted: {}, sender_email: 'owner@example.com', sender_name: 'Owner', mailbox: 'info@bedrocktx.com' };
    sends.length = 0;
    const r = await call('POST', `/api/email-triage/${MSG_ID}/send`, { body: 'Hello.', to: 'owner@example.com' });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    assert.equal(sends.length, 1); assert.equal(sends[0].from, EXPECTED_MAILBOX[p]);
  });
}

check('SEND: Tessa or an unknown persona is refused with 409 and nothing is sent (no Claire fallback)', async () => {
  for (const p of ['tessa', 'zelda']) {
    ROW = { ...websiteRow(), persona: p, extracted: {}, sender_email: 'owner@example.com' }; sends.length = 0;
    const r = await call('POST', `/api/email-triage/${MSG_ID}/send`, { body: 'Hello.', to: 'owner@example.com' });
    assert.equal(r.status, 409, p); assert.equal(r.j.error, 'no_sender_for_persona'); assert.equal(sends.length, 0, p);
  }
});

check('SEND: GET /personas serves the resolver\'s directory (past the GET /:id route)', async () => {
  const r = await call('GET', '/api/email-triage/personas');
  assert.equal(r.status, 200); assert.equal(r.j.personas.maggie.mailbox, 'maggie@bedrocktx.com'); assert.equal(r.j.personas.tessa.sendable, false);
});

check('SEND: the send route has no hand-written persona chain left (one resolver)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'api/email_triage.js'), 'utf8');
  const i = src.indexOf("router.post('/:id/send'"); const block = src.slice(i, src.indexOf('\nrouter.', i + 10));
  assert.ok(/persona_sender'\)\.resolveSender\(persona\)/.test(block));
  assert.ok(!/senderLabel = 'Claire \(Bedrock AI\)'/.test(block), 'no silent Claire fallback');
  assert.ok(!/persona === 'maggie'/.test(block));
});

// ---- the page ----
console.log('Persona sender (page)');
const html = fs.readFileSync(path.join(ROOT, 'public/communications.html'), 'utf8');
function extract(src, start, endMarker) { const i = src.indexOf(start); assert.ok(i >= 0, 'missing ' + start); const j = src.indexOf(endMarker, i); assert.ok(j > i, 'missing end ' + endMarker); return src.slice(i, j); }
const pageSrc = extract(html, 'const PNAME = ', 'let openPersona = null;') + '\n' + extract(html, 'function draftBoxHtml(', '\n// The reply recipient.');
function pageSandbox(msgs) {
  const ctx = { window: { _msgs: msgs || [] }, JSON, Object, console, Promise,
    esc: (s) => String(s == null ? '' : s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c])),
    loadUnsent: () => null, recipientByMsg: {}, attachByMsg: {}, toRowHtml: () => '', attachRowHtml: () => '',
    af: async (u) => { assert.equal(u, '/api/email-triage/personas'); return { ok: true, json: async () => ({ personas: senderDirectory() }) }; } };
  vm.createContext(ctx); vm.runInContext(pageSrc + '\nthis.draftBoxHtml = draftBoxHtml; this.loadPersonaDirectory = loadPersonaDirectory; this.senderInfo = senderInfo;', ctx);
  return ctx;
}

check('PAGE: a Maggie draft says Maggie\'s draft, sends from maggie@, send button as Maggie, never Claire', async () => {
  const c = pageSandbox([{ id: 'm1', classification: 'website_inquiry' }]); await c.loadPersonaDirectory();
  const out = c.draftBoxHtml('m1', 'Re: x', 'Hi', false, 'maggie', [], [], 'pat@example.com', {});
  assert.ok(out.includes("Maggie's draft")); assert.ok(out.includes('maggie@bedrocktx.com')); assert.ok(out.includes('send as Maggie'));
  assert.ok(!/Claire/.test(out), 'no Claire anywhere on Maggie\'s draft');
});

check('PAGE: every directory teammate is labelled and addressed exactly as the server sends', async () => {
  const c = pageSandbox([{ id: 'm1', classification: 'general_inquiry' }]); await c.loadPersonaDirectory();
  for (const p of Object.keys(EXPECTED_MAILBOX)) {
    const out = c.draftBoxHtml('m1', '', 'Hi', false, p, [], [], 'x@example.com', {});
    const s = resolveSender(p);
    assert.ok(out.includes(`${s.first}'s draft`), `${p} label`); assert.ok(out.includes(s.mailbox), `${p} mailbox`);
    assert.ok(out.includes(`send as ${s.first}`), `${p} send button`);
  }
});

check('PAGE: even before the directory loads, Maggie is never shown as Claire', () => {
  const c = pageSandbox([{ id: 'm1' }]);
  const out = c.draftBoxHtml('m1', '', 'Hi', false, 'maggie', [], [], '', {});
  assert.ok(out.includes("Maggie's draft") && out.includes('maggie@bedrocktx.com') && !/Claire/.test(out));
});

check('PAGE: a teammate the server cannot send as gets a warning and NO Send button', async () => {
  const c = pageSandbox([{ id: 'm1' }]); await c.loadPersonaDirectory();
  for (const p of ['tessa', 'zelda']) {
    const out = c.draftBoxHtml('m1', '', 'Hi', false, p, [], [], '', {});
    assert.ok(!/Approve &amp; send/.test(out), `${p}: no send button`); assert.ok(/can't be sent as/.test(out), `${p}: warning`);
    assert.ok(!/claire@bedrocktx\.com/.test(out), `${p}: not shown as Claire's mailbox`);
  }
});

check('PAGE: the compliance banner shows only for compliance classes, not a careful prospect inquiry', async () => {
  const c = pageSandbox([{ id: 'w', classification: 'website_inquiry' }, { id: 'v', classification: 'violation_report' }, { id: 'l', classification: 'legal_privileged' }, { id: 'a', classification: 'acc_request' }, { id: 'f', classification: 'vendor_financial' }, { id: 'g', classification: 'general_inquiry' }]);
  await c.loadPersonaDirectory();
  const banner = (id, careful) => /Compliance-sensitive/.test(c.draftBoxHtml(id, '', 'Hi', careful, 'maggie', [], [], '', {}));
  assert.equal(banner('w', true), false, 'careful website prospect: no banner');
  assert.equal(banner('g', true), false, 'careful general: no banner');
  for (const id of ['v', 'l', 'a', 'f']) { assert.equal(banner(id, true), true, id); assert.equal(banner(id, false), false, id + ' not careful'); }
  assert.ok(/doSend\('w', this, false/.test(c.draftBoxHtml('w', '', 'Hi', true, 'maggie', [], [], '', {})), 'send confirm follows the banner');
});

check('PAGE: "Claire suggests" is no longer hardcoded; the hint names the owning teammate', () => {
  assert.ok(!/<strong>Claire suggests:<\/strong>/.test(html));
  assert.ok(/\$\{esc\(senderInfo\(m\.persona\)\.first\)\} suggests:/.test(html));
  assert.ok(!/PNAME\[[^\]]+\]\s*\|\|\s*'Claire'/.test(html), 'no PNAME[...]||\'Claire\' fallback left');
  assert.ok(!/PMAIL\[[^\]]+\]\s*\|\|\s*'claire@/.test(html), 'no PMAIL[...]||claire@ fallback left');
});

check('PAGE: the directory loads before the list renders (bounded wait)', () => {
  assert.ok(/Promise\.race\(\[loadPersonaDirectory\(\), new Promise\(r=>setTimeout\(r,3000\)\)\]\)\.finally\(loadList\)/.test(html));
});

// ---- Maggie's prospect reply standard ----
console.log('Maggie prospect reply');
const MP = require('../lib/team/maggie_prospect_reply');
const GOOD = 'Hi Pat,\n\nThank you for reaching out to Bedrock Association Management. We manage associations across the Houston area with responsive service for homeowners and clear, timely information for boards.\n\nCould you tell me a little about your community, such as its name and roughly how many homes it has? I would be glad to set up a short conversation at a time that works for you.\n\nWarm regards,';

check('MAGGIE: a good reply passes the standard', () => { assert.deepEqual(MP.validateProspectDraft(GOOD), []); });

check('MAGGIE: the approved fallback passes its own standard and has no AI self-description', () => {
  for (const n of ['Pat Doe', null]) { const f = MP.fallbackProspectReply(n); assert.deepEqual(MP.validateProspectDraft(f), [], f); assert.ok(!/\bAI\b/.test(f)); }
});

check('MAGGIE: banned content is caught', () => {
  const cases = {
    'We are an AI-native management company.': /AI-native/,
    "I'm Bedrock's AI assistant and can help.": /self-description/,
    "I'll send you a sample packet.": /promises/,
    'Unlike other management companies, we answer.': /other management/,
    'We respond fast — always.': /em dash/,
    'We use machine learning to triage.': /jargon/,
    'Pricing is attached.': /promises/,
  };
  for (const [txt, re] of Object.entries(cases)) { const v = MP.validateProspectDraft(`${GOOD}\n${txt}`); assert.ok(v.some((x) => re.test(x)), `${txt} -> ${v.join('; ')}`); }
  assert.ok(MP.validateProspectDraft(GOOD.replace(/\?/g, '.')).some((x) => /no question/.test(x)));
  assert.ok(MP.validateProspectDraft('How many homes? What city? Who manages? When?\nLet us talk.').some((x) => /questions/.test(x)));
  assert.ok(MP.validateProspectDraft(GOOD.replace(/conversation/g, 'note')).some((x) => /conversation/.test(x)));
});

check('MAGGIE: a model draft that breaks the rules is retried once, then the approved fallback; careful is false', async () => {
  let n = 0;
  const bad = async () => { n++; return { body: 'We are AI-native! Here is a sample packet.' }; };
  const d = await MP.draftMaggieProspectReply({ name: 'Pat Doe', message: 'Need a manager', draftFn: bad });
  assert.equal(n, 2); assert.equal(d.careful, false); assert.equal(d.persona, 'maggie'); assert.equal(d.quality.source, 'approved_fallback');
  assert.deepEqual(MP.validateProspectDraft(d.body), []);
  let m = 0; const good = async (_cfg, args) => { m++; assert.match(args.contextHint, /REPLY STANDARD/); return { body: GOOD }; };
  const g = await MP.draftMaggieProspectReply({ name: 'Pat Doe', message: 'Need a manager', draftFn: good });
  assert.equal(m, 1); assert.equal(g.body, GOOD); assert.equal(g.quality.source, 'model'); assert.equal(g.careful, false);
});

check('MAGGIE: ingest drafts the website prospect with the standard, careful:false, to the submitter', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/email/graph_ingest.js'), 'utf8');
  const i = src.indexOf("webInq.verified && webInq.owner === 'maggie') {"); const block = src.slice(i, src.indexOf('\n    }\n', i));
  assert.ok(/draftMaggieProspectReply/.test(block)); assert.ok(/careful: false/.test(block)); assert.ok(!/careful: true/.test(block));
  assert.ok(/draft = \{ \.\.\.draft, to: webInq\.email, subject: require\('\.\/website_inquiry'\)\.REPLY_SUBJECT/.test(src), 'draft addressed to the submitter');
});

check('MAGGIE: Draft reply on a verified Maggie prospect uses the standard and suggests the submitter', () => {
  const src = fs.readFileSync(path.join(ROOT, 'api/email_triage.js'), 'utf8');
  const i = src.indexOf('A verified website prospect (owner Maggie)'); const block = src.slice(i, i + 2000);
  assert.ok(/draftMaggieProspectReply/.test(block)); assert.ok(/suggested_recipient: w\.email/.test(block)); assert.ok(/to: w\.email/.test(block));
});

(async () => {
  const server = http.createServer(app); await new Promise((r) => server.listen(0, r)); base = 'http://127.0.0.1:' + server.address().port;
  for (const t of pending) await t();
  server.close();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
