'use strict';
// ============================================================================
// tests/test_website_inquiry.js  (Ed 2026-10-18, PR #224) — verified website inquiries
// ----------------------------------------------------------------------------
// Part 1: the verification + routing rules (pure).
// Part 2: the REAL graph_ingest with Graph, Supabase, the classifier and the drafters
//         stubbed. The classifier stub answers SPAM (what the live model said about real
//         prospective and vendor inquiries) to prove a verified inquiry is still stored
//         visible, owned and drafted, and a forged one is never trusted.
// Synthetic data only.  node tests/test_website_inquiry.js
// ============================================================================
const assert = require('node:assert/strict');
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_KEY']) process.env[k] = process.env[k] || (k === 'SUPABASE_URL' ? 'http://localhost:1' : 'test-key');
process.env.STAFF_REPLY_MAILBOXES = 'none@invalid.example';   // PR #225's Sent Items read is covered by its own tests

let pass = 0, fail = 0; const pending = [];
const check = (name, fn) => pending.push(async () => { try { await fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.log('  ✗', name, '\n     ', e.message); } });

const SENDER = 'notifications@bedrocktxai.com';
const body = (o = {}) => ['New Bedrock website inquiry', `Purpose: ${o.purpose || 'prospective'}`, `Name: ${o.name || 'Pat Example'}`, `Email: ${o.email === undefined ? 'pat@example.com' : o.email}`,
  `Phone: ${o.phone || '555-0100'}`, `Community: ${o.community || '—'}`, `Message: ${o.message || 'looking to learn more about your company'}`].join('\n');
const msg = (o = {}) => ({ mailbox: 'welcome@bedrocktx.com', direction: 'inbound', graph_id: 'g-web', internet_message_id: '<web-1@email.amazonses.com>',
  sender_email: o.sender || SENDER, subject: o.subject || `Bedrock website inquiry: ${o.purpose || 'prospective'}`, body_full: o.body_full || body(o) });
const goodHeaders = (o = {}) => [
  { name: 'Authentication-Results', value: o.ar || 'mx.microsoft.com 1; spf=softfail (sender IP is 8.31.233.216) smtp.mailfrom=send.bedrocktxai.com; dkim=pass (signature was verified) header.d=bedrocktxai.com;dkim=pass (signature was verified) header.d=amazonses.com;dmarc=none action=none header.from=bedrocktxai.com;compauth=pass reason=105' },
  ...(o.extra || []),
  { name: 'From', value: '<notifications@bedrocktxai.com>' }, { name: 'To', value: '<welcome@bedrocktx.com>' },
  { name: 'Reply-To', value: `<${o.replyTo || 'pat@example.com'}>` },
];
const WI = require('../lib/email/website_inquiry');
const verify = (m, headers = goodHeaders()) => WI.verifyWebsiteInquiry(m, { fetchHeaders: async () => { if (headers instanceof Error) throw headers; return headers; } });

console.log('Verified website inquiries (PR #224)');

// ============================ Part 1: rules ============================
check('the real form format (DKIM pass for bedrocktxai.com) verifies; the submitter\'s identity and address are preserved', async () => {
  const v = await verify(msg());
  assert.equal(v.verified, true, JSON.stringify(v.reasons));
  assert.equal(v.email, 'pat@example.com'); assert.equal(v.name, 'Pat Example'); assert.equal(v.phone, '555-0100'); assert.equal(v.community, null);
});

check('a legitimate SHORT prospective inquiry -> Maggie, never spam', async () => {
  const v = await verify(msg({ purpose: 'prospective', message: 'looking to learn more about your company' }));
  assert.equal(v.verified, true); assert.equal(v.owner, 'maggie'); assert.equal(v.intent, 'prospective_management_client');
});

check('a board seeking replacement management -> Maggie, whether they chose Board, Homeowner or Other', async () => {
  for (const purpose of ['board', 'homeowner', 'other']) {
    for (const message of ['Our HOA board is looking for a new management company for 240 homes in Katy.', 'We are unhappy with our current management and want proposals.', 'Our management contract is expiring in March; can you send a proposal?']) {
      const v = await verify(msg({ purpose, message }));
      assert.equal(v.owner, 'maggie', `${purpose}: ${message}`); assert.equal(v.intent, 'board_seeking_new_management');
    }
  }
});

check('existing community board inquiry -> Claire, with the Amanda hint for management matters', async () => {
  const v = await verify(msg({ purpose: 'board', message: 'I am the treasurer at Canyon Gate and need the September financials.', community: 'Canyon Gate' }));
  assert.equal(v.owner, 'claire'); assert.equal(v.intent, 'existing_board_inquiry'); assert.match(v.hint, /Amanda/);
});

check('homeowner -> Claire; closing/title -> Reese; other -> Claire', async () => {
  assert.equal((await verify(msg({ purpose: 'homeowner', message: 'My pool key fob stopped working, how do I get a new one?' }))).owner, 'claire');
  assert.equal((await verify(msg({ purpose: 'closing', message: 'Title company requesting a resale certificate for 123 Main St.' }))).owner, 'reese');
  assert.equal((await verify(msg({ purpose: 'other', message: 'What are your office hours?' }))).owner, 'claire');
});

check('vendor/business -> Claire for intake; an actual payables matter -> Emma', async () => {
  const sales = await verify(msg({ purpose: 'vendor', message: 'We are a landscaping company and would like to bid on your communities.' }));
  assert.equal(sales.owner, 'claire'); assert.equal(sales.intent, 'vendor_business_inquiry');
  const ap = await verify(msg({ purpose: 'vendor', message: 'Invoice 4471 for August landscaping is past due; please confirm payment status.' }));
  assert.equal(ap.owner, 'emma'); assert.equal(ap.intent, 'vendor_payables');
});

check('FORGED notification: right sender and format but DKIM fails -> UNVERIFIED (not exempted)', async () => {
  const v = await verify(msg(), goodHeaders({ ar: 'mx.microsoft.com 1; spf=fail smtp.mailfrom=bedrocktxai.com; dkim=none (message not signed) header.d=none;dmarc=none action=none header.from=bedrocktxai.com' }));
  assert.equal(v.verified, false); assert.ok(v.reasons.includes('dkim_not_pass')); assert.equal(v.owner, undefined); assert.match(v.warning, /not trusted|Not trusted/i);
});

check('FORGED: DKIM passes but for ANOTHER domain, or a lookalike domain -> UNVERIFIED', async () => {
  const other = await verify(msg(), goodHeaders({ ar: 'mx.microsoft.com 1; dkim=pass (signature was verified) header.d=evil.example' }));
  assert.equal(other.verified, false); assert.ok(other.reasons.includes('dkim_domain_not_aligned'));
  const look = await verify(msg(), goodHeaders({ ar: 'mx.microsoft.com 1; dkim=pass (signature was verified) header.d=bedrocktxai.com.evil.example' }));
  assert.equal(look.verified, false);
});

check('FORGED: a planted "dkim=pass" Authentication-Results BELOW the receiving server\'s fail is ignored', async () => {
  const v = await verify(msg(), goodHeaders({ ar: 'mx.microsoft.com 1; dkim=fail header.d=bedrocktxai.com', extra: [{ name: 'Authentication-Results', value: 'attacker.example; dkim=pass header.d=bedrocktxai.com' }] }));
  assert.equal(v.verified, false);
});

check('header lookup failure, missing headers, Reply-To mismatch, purpose mismatch, missing Email -> UNVERIFIED with reasons', async () => {
  assert.ok((await verify(msg(), new Error('Graph 503'))).reasons.includes('header_lookup_failed'));
  assert.ok((await verify(msg(), goodHeaders({ replyTo: 'someone-else@example.com' }))).reasons.includes('reply_to_mismatch'));
  assert.ok((await verify(msg({ subject: 'Bedrock website inquiry: vendor', purpose: 'prospective' }))).reasons.includes('purpose_mismatch'));
  assert.ok((await verify(msg({ email: '' }))).reasons.includes('email_invalid'));
  assert.ok((await verify(msg({ subject: 'Hello from your website' }))).reasons.includes('subject_format'));
});

check('a different sender using the website subject is UNVERIFIED (the claim alone earns nothing)', async () => {
  const v = await verify(msg({ sender: 'promo@spammer.example' }));
  assert.equal(v.verified, false); assert.ok(v.reasons.includes('sender_not_website'));
});

check('ordinary mail never enters this path', () => {
  assert.equal(WI.claimsWebsiteInquiry({ sender_email: 'owner@example.org', subject: 'Pool hours?' }), false);
  assert.equal(WI.claimsWebsiteInquiry({ sender_email: SENDER, subject: 'anything' }), true);
  assert.equal(WI.claimsWebsiteInquiry({ sender_email: 'x@y.z', subject: 'Bedrock website inquiry: homeowner' }), true);
});

check('persona: a verified inquiry is owned by its assigned teammate; an unverified claim goes to the shared general queue', async () => {
  const persona = require('../lib/email/persona');
  const v = await verify(msg({ purpose: 'closing', message: 'resale certificate please' }));
  assert.equal(persona.personaForMessage({ mailbox: 'welcome@bedrocktx.com', classification: 'website_inquiry', extracted: { website_inquiry: WI.publicRecord(v) } }), 'reese');
  const f = await verify(msg(), new Error('x'));
  assert.equal(persona.personaForMessage({ mailbox: 'welcome@bedrocktx.com', classification: 'spam', extracted: { website_inquiry: WI.publicRecord(f) } }), 'general');
  assert.equal(persona.personaForMessage({ mailbox: 'welcome@bedrocktx.com', classification: 'homeowner_request', sender_email: 'a@b.com' }), 'claire');
});

check('reply recipient resolves to the form submitter, never the relay address', () => {
  const { suggestReplyTo } = require('../lib/email/reply_recipient');
  const r = suggestReplyTo({ senderEmail: SENDER, bodyText: body(), replyTo: ['pat@example.com'], mailbox: 'welcome@bedrocktx.com' });
  assert.equal(r.email, 'pat@example.com'); assert.equal(r.source, 'form_body');
});

// ============================ Part 2: the real ingest ============================
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const db = { email_messages: [], other: [] };
function q(table) {
  const st = { table, op: 'select', row: null };
  const api = {
    select() { return api; }, eq() { return api; }, in() { return Promise.resolve({ data: [], error: null }); }, not() { return api; }, is() { return api; },
    gte() { return api; }, lt() { return api; }, order() { return api; }, limit() { return api; }, range() { return api; }, or() { return api; }, ilike() { return api; },
    maybeSingle() { return Promise.resolve({ data: null, error: null }); },
    single() { if (st.op === 'insert' && table === 'email_messages') { const id = `row-${db.email_messages.length + 1}`; db.email_messages.push({ id, ...st.row }); return Promise.resolve({ data: { id }, error: null }); } return Promise.resolve({ data: null, error: null }); },
    insert(r) { st.op = 'insert'; st.row = r; if (table !== 'email_messages') db.other.push({ table, r }); return api; },
    update() { st.op = 'update'; return api; }, delete() { st.op = 'delete'; return api; }, upsert() { return api; },
    then(res, rej) { return Promise.resolve({ data: [], error: null, count: 0 }).then(res, rej); },
  };
  return api;
}
stub('@supabase/supabase-js', { createClient: () => ({ from: (t) => q(t), rpc: async () => ({ data: null, error: null }), storage: { from: () => ({ upload: async () => ({}), download: async () => ({}) }) } }) });
const seen = { classify: [], resolve: [], draftReply: [], maggie: [] };
let classifyImpl = async (e) => { seen.classify.push(e); return { classification: 'spam', is_spam: true, summary: 'website inquiry', classification_confidence: 'high' }; };
stub('../lib/email/triage', { classifyAndExtract: (e) => classifyImpl(e), resolveEntities: async (ex, e) => { seen.resolve.push(e.sender_email); return { community_id: null, contact_id: null, property_id: null, vendor_id: null, confidence: 'none', candidates: [] }; } });
stub('../lib/email/draft_reply', { draftReply: async (a) => { seen.draftReply.push(a); return { draftable: true, subject: 'Re: x', body: `Draft for ${a.email.sender_email} as ${a.persona}`, careful: false }; }, DRAFTABLE: new Set(), CAREFUL: new Set(), NO_DRAFT: new Set() });
stub('../lib/team/bedrock_ops_reply', { draftBedrockOpsReply: async (cfg, a) => { seen.maggie.push(a); return { draftable: true, careful: true, persona: 'maggie', subject: 'Re: Inquiry', body: `Hi ${a.contactName}, Maggie here.`, review_hint: 'Maggie growth' }; } });
stub('../lib/email/graph_move', { getInboxId: async () => 'INBOX', fileMessage: async () => ({ moved: true }) });
const gs = require('../lib/email/graph_send'); gs.getToken = async () => 'token';
let pageMsgs = []; let headersFor = {};
global.fetch = async (url) => {
  const u = decodeURIComponent(String(url));
  if (/\/messages\/([^?]+)\?\$select=internetMessageHeaders/.test(u)) {
    const id = u.match(/\/messages\/([^?]+)\?/)[1];
    const h = headersFor[id];
    if (h instanceof Error) return { ok: false, status: 503, text: async () => 'down', json: async () => ({}) };
    return { ok: true, json: async () => ({ internetMessageHeaders: h || [] }) };
  }
  if (/\/messages\?/.test(u)) return { ok: true, json: async () => ({ value: pageMsgs }) };
  return { ok: true, json: async () => ({ value: [] }), text: async () => '' };
};
process.env.GRAPH_TENANT_ID = 't'; process.env.GRAPH_CLIENT_ID = 'c'; process.env.GRAPH_CLIENT_SECRET = 's';
const graphMsg = (id, o = {}) => ({ id, internetMessageId: `<${id}@email.amazonses.com>`, conversationId: `conv-${id}`, subject: o.subject || `Bedrock website inquiry: ${o.purpose || 'prospective'}`,
  bodyPreview: '', body: { contentType: 'text', content: o.body || body(o) }, from: { emailAddress: { address: o.sender || SENDER, name: 'Bedrock Website' } },
  sender: { emailAddress: { address: o.sender || SENDER } }, toRecipients: [{ emailAddress: { address: 'welcome@bedrocktx.com' } }], receivedDateTime: '2026-10-18T22:27:50Z', sentDateTime: '2026-10-18T22:27:48Z', hasAttachments: false, parentFolderId: 'INBOX' });

async function runIngest(msgs, headers) {
  db.email_messages.length = 0; for (const k of Object.keys(seen)) seen[k].length = 0;
  pageMsgs = msgs; headersFor = headers;
  const { ingestMailbox } = require('../lib/email/graph_ingest');
  const stats = await ingestMailbox('welcome@bedrocktx.com', { sinceISO: '2026-10-11T00:00:00Z', light: false, onlyLinked: false, max: 50 });
  return { stats, rows: db.email_messages.slice() };
}

check('INGEST: a verified short prospective inquiry the AI calls spam is stored VISIBLE, owned by Maggie, with Maggie\'s draft to the submitter', async () => {
  const { stats, rows } = await runIngest([graphMsg('p1')], { p1: goodHeaders() });
  assert.equal(rows.length, 1, JSON.stringify(stats));
  const r = rows[0];
  assert.equal(r.classification, 'website_inquiry'); assert.notEqual(r.triage_status, 'spam'); assert.equal(r.triage_status, 'needs_review');
  assert.equal(r.persona, 'maggie'); assert.equal(r.extracted.ai_classification, 'spam', 'the model\'s verdict is kept for the record');
  assert.equal(r.extracted.website_inquiry.verified, true); assert.equal(r.extracted.website_inquiry.email, 'pat@example.com');
  assert.equal(r.extracted.draft.persona, 'maggie'); assert.equal(r.extracted.draft.status, 'pending'); assert.equal(r.extracted.draft.to, 'pat@example.com');
  assert.equal(r.extracted.draft.subject, WI.REPLY_SUBJECT);
  assert.equal(seen.maggie.length, 1); assert.equal(seen.draftReply.length, 0, 'Claire does not also draft it');
  assert.deepEqual(seen.resolve, ['pat@example.com'], 'the person is resolved by the submitter, not the relay');
});

check('INGEST: a board seeking new management (chose Board) -> Maggie; an existing board question -> Claire, drafted to the submitter', async () => {
  const { rows } = await runIngest([graphMsg('b1', { purpose: 'board', message: 'Our board is looking for a new management company.' }), graphMsg('b2', { purpose: 'board', message: 'Need the September financials for Canyon Gate.', community: 'Canyon Gate' })],
    { b1: goodHeaders(), b2: goodHeaders() });
  const byId = Object.fromEntries(rows.map((r) => [r.internet_message_id, r]));
  assert.equal(byId['<b1@email.amazonses.com>'].persona, 'maggie');
  const b2 = byId['<b2@email.amazonses.com>'];
  assert.equal(b2.persona, 'claire'); assert.equal(b2.extracted.draft.to, 'pat@example.com'); assert.match(b2.extracted.draft.review_hint || '', /Amanda/);
  const call = seen.draftReply.find((a) => a.email.sender_email === 'pat@example.com');
  assert.ok(call, 'Claire drafts with the submitter as the correspondent'); assert.equal(call.classification, 'homeowner_request');
});

check('INGEST: homeowner -> Claire, closing -> Reese, vendor sales -> Claire, vendor payables -> Emma; none is spam, all visible with an owner', async () => {
  const cases = { h1: ['homeowner', 'My gate remote stopped working.', 'claire'], c1: ['closing', 'Resale certificate for 123 Main St.', 'reese'], v1: ['vendor', 'We would like to bid on landscaping.', 'claire'], v2: ['vendor', 'Invoice 4471 is past due, please confirm payment.', 'emma'] };
  const { rows } = await runIngest(Object.entries(cases).map(([id, [purpose, message]]) => graphMsg(id, { purpose, message })), Object.fromEntries(Object.keys(cases).map((id) => [id, goodHeaders()])));
  assert.equal(rows.length, 4);
  for (const r of rows) {
    const id = r.internet_message_id.slice(1, 3);
    assert.equal(r.persona, cases[id][2], `${id}`); assert.equal(r.triage_status, 'needs_review'); assert.equal(r.classification, 'website_inquiry');
  }
});

check('INGEST: a FORGED notification is never trusted (no owner routing, no draft) yet stays visible with the reasons, not silently dismissed', async () => {
  const { rows } = await runIngest([graphMsg('f1')], { f1: goodHeaders({ ar: 'mx.microsoft.com 1; dkim=none header.d=none' }) });
  const r = rows[0];
  assert.equal(r.extracted.website_inquiry.verified, false); assert.ok(r.extracted.website_inquiry.reasons.includes('dkim_not_pass'));
  assert.equal(r.persona, 'general'); assert.equal(r.triage_status, 'needs_review'); assert.ok(!r.extracted.draft, 'no draft for an unverified claim');
  assert.equal(seen.maggie.length + seen.draftReply.length, 0);
});

check('INGEST: header lookup failure leaves a genuine-looking inquiry UNVERIFIED but visible (fail safe, explicit)', async () => {
  const { rows } = await runIngest([graphMsg('e1')], { e1: new Error('graph down') });
  assert.equal(rows[0].extracted.website_inquiry.verified, false); assert.ok(rows[0].extracted.website_inquiry.reasons.includes('header_lookup_failed'));
  assert.equal(rows[0].triage_status, 'needs_review');
});

check('INGEST: ordinary welcome@ mail is untouched by this path (no header fetch, normal classification)', async () => {
  const ordinary = { ...graphMsg('o1'), subject: 'Question about my gate', body: { contentType: 'text', content: 'Hi, my gate code is not working.' }, from: { emailAddress: { address: 'owner@example.org' } }, sender: { emailAddress: { address: 'owner@example.org' } } };
  const { rows } = await runIngest([ordinary], {});
  assert.equal(rows[0].extracted.website_inquiry, undefined); assert.equal(rows[0].classification, 'spam', 'the (stub) classifier decides ordinary mail as before');
});

check('INGEST: a classifier failure is recorded on the row and the message is kept for review, never dismissed', async () => {
  const orig = classifyImpl;
  classifyImpl = async () => { throw new Error('model timeout'); };
  try {
    const ordinary = { ...graphMsg('x1'), subject: 'Question', body: { contentType: 'text', content: 'Hello' }, from: { emailAddress: { address: 'owner@example.org' } }, sender: { emailAddress: { address: 'owner@example.org' } } };
    const { rows } = await runIngest([ordinary], {});
    assert.match(rows[0].extracted.classification_error, /model timeout/); assert.notEqual(rows[0].triage_status, 'spam'); assert.notEqual(rows[0].triage_status, 'dismissed');
  } finally { classifyImpl = orig; }
});

// ============================ wiring (static) ============================
const fs = require('fs'); const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
check('send paths: Maggie sends from maggie@ with her own signature; website replies use the customer-facing subject', () => {
  const t = read('api/email_triage.js');
  assert.ok(/persona === 'maggie'[\s\S]{0,400}buildPersonaEmail\('maggie'[\s\S]{0,200}MAGGIE_MAILBOX/.test(t));
  assert.ok(/website_inquiry[\s\S]{0,200}REPLY_SUBJECT/.test(t));
  assert.ok(/maggie:\s+\{ mailbox: graphSend\.MAGGIE_MAILBOX/.test(read('api/email_drafts.js')));
  assert.equal(require('../lib/email/graph_send').personaMailbox('maggie'), 'maggie@bedrocktx.com');
});

(async () => { for (const t of pending) await t(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); })();
