#!/usr/bin/env node
// ============================================================================
// Amanda's public address (Ed 2026-10-16): amanda@bedrocktx.com is what people
// see; amandaalbright@bedrocktx.com stays the Microsoft 365 mailbox identity.
//   - display strings (signature, roster email, helper) use the alias
//   - Graph URLs (sendMail, createReply) still use the mailbox identity
//   - inbound matching (ingest persona, triage persona, push registry, reply CC
//     and auto-reply loop guard) treats both addresses as Amanda
//   - Reply-To is always the alias; From is the alias only when
//     AMANDA_SEND_FROM_ALIAS is on (Exchange SendFromAliasEnabled)
// No real email: global fetch is stubbed and the demo guard is stubbed open.
// ============================================================================
const assert = require('assert');
const path = require('path');

// Fake Graph credentials so isConfigured() is true; nothing leaves the process.
process.env.GRAPH_TENANT_ID = 'tenant'; process.env.GRAPH_CLIENT_ID = 'client'; process.env.GRAPH_CLIENT_SECRET = 'secret';
delete process.env.AMANDA_SEND_FROM_ALIAS; delete process.env.AMANDA_PUBLIC_ADDRESS; delete process.env.AMANDA_MAILBOX;

const guardPath = require.resolve(path.join(__dirname, '..', 'lib/demo/outbound_guard'));
require.cache[guardPath] = { id: guardPath, filename: guardPath, loaded: true, exports: { guardOutbound: async () => ({ blocked: false }) } };

const calls = [];
global.fetch = async (url, opts = {}) => {
  calls.push({ url: String(url), method: opts.method || 'GET', body: typeof opts.body === 'string' && opts.body.startsWith('{') ? JSON.parse(opts.body) : null });
  const json = (o, status = 200) => ({ ok: status < 300, status, json: async () => o, text: async () => JSON.stringify(o) });
  if (/oauth2\/v2\.0\/token/.test(url)) return json({ access_token: 'tok', expires_in: 3600 });
  if (/\/sendMail$/.test(url)) return json({}, 202);
  if (/\/createReply$/.test(url)) return json({ id: 'draft1', body: { content: '<p>quoted</p>' } });
  if (/\?\$select=toRecipients,ccRecipients/.test(url)) return json({ toRecipients: [{ emailAddress: { address: 'president@hoa.org' } }], ccRecipients: [] });
  return json({}, 202);
};

const gs = require('../lib/email/graph_send');
const ALIAS = 'amanda@bedrocktx.com';
const MAILBOX = 'amandaalbright@bedrocktx.com';
let failed = 0;
const t = async (name, fn) => { try { await fn(); console.log('PASS  ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); } };

(async () => {
  await t('one source of truth: public address is the alias, mailbox stays the identity', () => {
    assert.strictEqual(gs.AMANDA_PUBLIC_ADDRESS, ALIAS);
    assert.strictEqual(gs.AMANDA_MAILBOX, MAILBOX);
    assert.strictEqual(gs.amandaDisplayAddress(), 'Amanda Albright <amanda@bedrocktx.com>');
    assert.strictEqual(gs.publicAddressFor(MAILBOX), ALIAS);
    assert.strictEqual(gs.publicAddressFor('claire@bedrocktx.com'), 'claire@bedrocktx.com', 'other teammates unchanged');
    assert.strictEqual(gs.personaMailbox('amanda'), MAILBOX, 'Graph sends still use the identity');
    assert.ok(gs.TEAM_INGEST_MAILBOXES.includes(MAILBOX) && !gs.TEAM_INGEST_MAILBOXES.includes(ALIAS), 'ingest pulls the identity, never the alias');
  });

  await t('signature and roster show amanda@, never amandaalbright@', () => {
    const { buildAmandaEmail } = require('../lib/email/amanda_signature');
    const out = buildAmandaEmail('Hello Board,\n\nThank you.', 'Canyon Gate');
    const html = out.html || String(out);
    assert.ok(html.includes(ALIAS), 'signature has the alias');
    assert.ok(!html.toLowerCase().includes(MAILBOX), 'signature never shows the mailbox identity');
    // team_roster (loads Supabase) builds the email from self_mailbox, so check the source.
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'lib/email/team_roster.js'), 'utf8');
    assert.ok(/self_mailbox/.test(src), 'team roster email is built from self_mailbox (amanda@)');
    const r = require('../lib/team/roster');
    const a = (r.ROSTER || r.TEAM || []).find((m) => m.persona === 'amanda');
    if (a) assert.strictEqual(a.self_mailbox, 'amanda@');
  });

  await t('inbound matching accepts both addresses as Amanda', () => {
    for (const a of [ALIAS, MAILBOX, 'Amanda@BedrockTX.com', ' AmandaAlbright@bedrocktx.com ']) assert.strictEqual(gs.isAmandaAddress(a), true, a);
    for (const a of ['amanda.fake@bedrocktx.com', 'claire@bedrocktx.com', '', null]) assert.strictEqual(gs.isAmandaAddress(a), false, String(a));
    const { personaForMessage } = require('../lib/email/persona');
    assert.strictEqual(personaForMessage({ mailbox: MAILBOX, classification: 'internal' }), 'amanda');
    assert.strictEqual(personaForMessage({ mailbox: ALIAS, classification: 'internal' }), 'amanda');
  });

  await t('push registry maps the alias to the mailbox identity', () => {
    const { resolveRegistry } = require('../lib/email/graph_push');
    const r = resolveRegistry('amanda@bedrocktx.com, amandaalbright@bedrocktx.com');
    const boxes = (r.mailboxes || []).map((m) => String(m.mailbox || m).toLowerCase());
    assert.deepStrictEqual([...new Set(boxes)], [MAILBOX], JSON.stringify(r));
  });

  await t('reply CC and the auto-reply loop guard drop both Amanda addresses', () => {
    const ib = require('../lib/amanda/email_inbox');
    const r = ib.replyRecipients({ reply: { to: 'president@hoa.org', reply_all_cc: ['treasurer@hoa.org', ALIAS, MAILBOX] } }, { mode: 'all' });
    assert.deepStrictEqual(r.cc, ['treasurer@hoa.org']);
    const { aiMailboxes } = require('../lib/amanda/reply_policy');
    if (aiMailboxes) { const s = aiMailboxes(); assert.ok(s.has(ALIAS) && s.has(MAILBOX)); }
  });

  await t('capability flag: off -> Reply-To alias only; on -> From and Reply-To alias', () => {
    const off = gs.publicIdentityFields(MAILBOX, {});
    assert.deepStrictEqual(off, { replyTo: [{ emailAddress: { address: ALIAS, name: 'Amanda Albright' } }] });
    const on = gs.publicIdentityFields(MAILBOX, { AMANDA_SEND_FROM_ALIAS: 'on' });
    assert.strictEqual(on.from.emailAddress.address, ALIAS);
    assert.strictEqual(on.replyTo[0].emailAddress.address, ALIAS);
    assert.deepStrictEqual(gs.publicIdentityFields('claire@bedrocktx.com', { AMANDA_SEND_FROM_ALIAS: 'on' }), {}, 'no other teammate is touched');
  });

  await t('sendAs from Amanda: Graph URL uses the mailbox, message carries Reply-To alias, no From override while flag is off', async () => {
    calls.length = 0;
    await gs.sendAs({ from: gs.AMANDA_MAILBOX, to: 'president@hoa.org', subject: 'Hi', html: '<p>x</p>' });
    const send = calls.find((c) => /\/sendMail$/.test(c.url));
    assert.ok(send.url.includes('/users/' + encodeURIComponent(MAILBOX) + '/sendMail'), send.url);
    assert.ok(!send.url.includes(encodeURIComponent(ALIAS)), 'never a /users/{alias} URL (Graph 404s on aliases)');
    assert.strictEqual(send.body.message.replyTo[0].emailAddress.address, ALIAS);
    assert.strictEqual(send.body.message.from, undefined);
  });

  await t('sendAs with AMANDA_SEND_FROM_ALIAS=on sets From to the alias, URL unchanged', async () => {
    calls.length = 0; process.env.AMANDA_SEND_FROM_ALIAS = 'on';
    try { await gs.sendAs({ from: gs.AMANDA_MAILBOX, to: 'president@hoa.org', subject: 'Hi', html: '<p>x</p>' }); }
    finally { delete process.env.AMANDA_SEND_FROM_ALIAS; }
    const send = calls.find((c) => /\/sendMail$/.test(c.url));
    assert.ok(send.url.includes(encodeURIComponent(MAILBOX)));
    assert.strictEqual(send.body.message.from.emailAddress.address, ALIAS);
  });

  await t('threaded reply from Amanda PATCHes Reply-To alias under the mailbox URL', async () => {
    calls.length = 0;
    await gs.sendReplyAs({ from: MAILBOX, sourceMailbox: MAILBOX, sourceGraphId: 'm1', to: 'president@hoa.org', html: '<p>x</p>' });
    const patch = calls.find((c) => c.method === 'PATCH');
    assert.ok(patch.url.includes('/users/' + encodeURIComponent(MAILBOX) + '/'), patch.url);
    assert.strictEqual(patch.body.replyTo[0].emailAddress.address, ALIAS);
    assert.strictEqual(patch.body.from, undefined);
  });

  await t('other teammates send exactly as before (no replyTo, no from)', async () => {
    calls.length = 0;
    await gs.sendAs({ from: gs.CLAIRE_MAILBOX, to: 'owner@example.com', subject: 'Hi', text: 'x' });
    const send = calls.find((c) => /\/sendMail$/.test(c.url));
    assert.strictEqual(send.body.message.replyTo, undefined);
    assert.strictEqual(send.body.message.from, undefined);
  });

  if (failed) { console.log(`\n${failed} failing`); process.exit(1); }
  console.log('\nall amanda public-address checks pass');
})();
