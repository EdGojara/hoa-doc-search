#!/usr/bin/env node
// ============================================================================
// Amanda's public outputs read ONE setting (Ed 2026-10-16). With
// AMANDA_PUBLIC_EMAIL set to a distinct test value, render everything people see
// from Amanda and fail if the mailbox identity (amandaalbright@) appears, or if
// the configured public address does not:
//   - her signature
//   - a Board email and a vendor email (headers + body as sent to Graph)
//   - a threaded reply
//   - compose defaults and "Sends from" in the browser pages (/team-identity.js)
//   - the platform-knowledge answer about her address
// Plus the static guard (scripts/check_amanda_address.js) catches a planted
// literal and ignores comments. No real email: fetch and the demo guard are stubbed.
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PUBLIC = 'amanda.public@bedrocktx.com';   // distinct, so a stale default can't pass
process.env.AMANDA_PUBLIC_EMAIL = PUBLIC;
delete process.env.AMANDA_PUBLIC_ADDRESS; delete process.env.AMANDA_MAILBOX; delete process.env.AMANDA_SEND_FROM_ALIAS;
process.env.GRAPH_TENANT_ID = 'tenant'; process.env.GRAPH_CLIENT_ID = 'client'; process.env.GRAPH_CLIENT_SECRET = 'secret';

const guardPath = require.resolve(path.join(__dirname, '..', 'lib/demo/outbound_guard'));
require.cache[guardPath] = { id: guardPath, filename: guardPath, loaded: true, exports: { guardOutbound: async () => ({ blocked: false }) } };
const calls = [];
global.fetch = async (url, opts = {}) => {
  calls.push({ url: String(url), method: opts.method || 'GET', body: typeof opts.body === 'string' && opts.body.startsWith('{') ? JSON.parse(opts.body) : null });
  const json = (o, status = 200) => ({ ok: status < 300, status, json: async () => o, text: async () => JSON.stringify(o) });
  if (/oauth2\/v2\.0\/token/.test(url)) return json({ access_token: 'tok', expires_in: 3600 });
  if (/\/createReply$/.test(url)) return json({ id: 'd1', body: { content: '<p>quoted</p>' } });
  if (/\$select=toRecipients,ccRecipients/.test(url)) return json({ toRecipients: [{ emailAddress: { address: 'vendor@itech.example' } }], ccRecipients: [] });
  return json({}, 202);
};

const gs = require('../lib/email/graph_send');
const IDENTITY = /amandaalbright@/i;
let failed = 0;
const t = async (name, fn) => { try { await fn(); console.log('PASS  ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); } };
const visible = (msg) => JSON.stringify({ from: msg.from, replyTo: msg.replyTo, body: msg.body });

(async () => {
  await t('the setting drives the public address; the mailbox stays the Graph identity', () => {
    assert.strictEqual(gs.AMANDA_PUBLIC_EMAIL, PUBLIC);
    assert.strictEqual(gs.AMANDA_PUBLIC_ADDRESS, PUBLIC, 'read-through alias');
    assert.strictEqual(gs.amandaDisplayAddress(), 'Amanda Albright <' + PUBLIC + '>');
    assert.ok(IDENTITY.test(gs.AMANDA_MAILBOX));
  });

  const { buildAmandaEmail } = require('../lib/email/amanda_signature');
  await t('signature shows the configured public address, never the mailbox', () => {
    const html = buildAmandaEmail('Hello,\n\nThank you.', 'Canyon Gate').html;
    assert.ok(html.includes(PUBLIC)); assert.ok(!IDENTITY.test(html));
  });

  for (const [label, to, body] of [
    ['Board email', 'president@canyongate.example', 'Dear Board,\n\nThe camera RFP is ready for your review.\n\nThank you.'],
    ['vendor email', 'bids@itech.example', 'Hello,\n\nPlease send questions and bids to me by the deadline.\n\nThank you.'],
    ['homeowner email', 'owner@example.com', 'Hi,\n\nThanks for reaching out.\n\nBest.'],
  ]) {
    await t(label + ': what the recipient sees carries the public address, never amandaalbright@', async () => {
      calls.length = 0;
      const { html, attachments } = buildAmandaEmail(body, 'Canyon Gate');
      await gs.sendAs({ from: gs.personaMailbox('amanda'), to, subject: 'Canyon Gate', html, attachments });
      const send = calls.find((c) => /\/sendMail$/.test(c.url));
      assert.ok(send.url.includes(encodeURIComponent(gs.AMANDA_MAILBOX)), 'Graph URL uses the mailbox identity');
      const seen = visible(send.body.message);
      assert.ok(seen.includes(PUBLIC), 'public address present'); assert.ok(!IDENTITY.test(seen), 'mailbox identity leaked: ' + seen.slice(0, 200));
    });
  }

  await t('threaded reply: Reply-To and body carry the public address only', async () => {
    calls.length = 0;
    await gs.sendReplyAs({ from: gs.AMANDA_MAILBOX, sourceMailbox: gs.AMANDA_MAILBOX, sourceGraphId: 'm1', to: 'vendor@itech.example', html: buildAmandaEmail('Hi,\n\nThanks.\n\nBest.', 'Canyon Gate').html });
    const patch = calls.find((c) => c.method === 'PATCH');
    const seen = visible(patch.body);
    assert.ok(seen.includes(PUBLIC)); assert.ok(!IDENTITY.test(seen));
  });

  await t('compose defaults and "Sends from" in the pages read /team-identity.js', () => {
    const { identityScript, teamIdentity } = require('../lib/email/public_identity');
    const js = identityScript(); const win = {}; new Function('window', js)(win);
    assert.strictEqual(win.TEAM_IDENTITY.amanda.email, PUBLIC);
    assert.strictEqual(win.TEAM_IDENTITY.amanda.display, 'Amanda Albright <' + PUBLIC + '>');
    assert.deepStrictEqual(teamIdentity().amanda.addresses.sort(), [PUBLIC, gs.AMANDA_MAILBOX].sort(), 'both addresses for the never-CC-Amanda check');
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.ok(/app\.get\('\/team-identity\.js'/.test(server), 'server serves /team-identity.js');
    for (const page of ['public/communications.html', 'public/draft-queue.html', 'public/tessa.html', 'public/app/today.html']) {
      const src = fs.readFileSync(path.join(__dirname, '..', page), 'utf8');
      assert.ok(src.includes('<script src="/team-identity.js"></script>'), page + ' loads /team-identity.js');
      assert.ok(!/amandaalbright@|amanda@bedrocktx\.com/i.test(src.replace(/\/\/.*$/gm, '')), page + ' has no hard-coded Amanda address');
    }
    const comm = fs.readFileSync(path.join(__dirname, '..', 'public/communications.html'), 'utf8');
    assert.ok(/amanda:AMANDA_ID\.email/.test(comm) && /mail:AMANDA_ID\.email/.test(comm), 'PMAIL ("Sends from") and the New email compose default read the setting');
  });

  await t('platform-knowledge answer interpolates the setting', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts/seed_platform_knowledge.js'), 'utf8');
    assert.ok(/require\('\.\.\/lib\/email\/graph_send'\)/.test(src) && /' \+ AMANDA_PUBLIC_EMAIL \+ '/.test(src));
  });

  await t('static guard: repo is clean; a planted literal fails; comments and the allowlist pass', () => {
    const { scan } = require('../scripts/check_amanda_address');
    assert.deepStrictEqual(scan(), [], 'repo has a hard-coded Amanda address');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amanda-guard-'));
    try {
      fs.mkdirSync(path.join(dir, 'lib/vendors'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'lib/email'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'scripts/plans'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'lib/vendors/rfp_document.js'), "// questions go to amandaalbright@ (comment, fine)\nconst submitTo = 'amandaalbright@bedrocktx.com';\n");
      fs.writeFileSync(path.join(dir, 'lib/vendors/rfp_document_render.js'), "const c = 'amanda@bedrocktx.com';\nconst ok = 'amanda@bedrocktx.com'; // amanda-address-ok: test\n");
      fs.writeFileSync(path.join(dir, 'lib/email/graph_send.js'), "const AMANDA_MAILBOX = 'amandaalbright@bedrocktx.com';\n");
      fs.writeFileSync(path.join(dir, 'scripts/plans/rfp.json'), '{ "submit_to_email": "amandaalbright@bedrocktx.com" }\n');
      const p = scan(dir).map((s) => s.split(' ')[0]).sort();
      assert.deepStrictEqual(p, ['lib/vendors/rfp_document.js:2', 'lib/vendors/rfp_document_render.js:1', 'scripts/plans/rfp.json:1']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  if (failed) { console.log(`\n${failed} failing`); process.exit(1); }
  console.log('\nall amanda public-output checks pass');
})();
