// The shared reply engine (lib/email/reply_recipient + graph_send.sendReplyAs + api/email_triage send):
// who a Reply / Reply All goes to, and that the recipients a person approves are exactly the ones
// validated, verified and used. Scar (2026-10-14): Melody Hess (NewFirst) replied to Kat; Reply
// was addressed to kat@bedrocktx.com under a "website contact form" warning, and a threaded send
// ignored the corrected To entirely.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'; process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test';
const assert = require('assert');
const R = require('../lib/email/reply_recipient');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + ' :: ' + e.message); } };

// Melody's actual reply (shape): her text, her signature, then the quoted thread with header lines.
const MELODY = `Kat,

Good morning! Below is an answer from our Treasury Management department. It has been removed.

Thank you,
Melody Hess
Vice President/Business Development Officer
NewFirst National Bank
mhess@newfirst.com

From: Katherine "Kat" Reed <kat@bedrocktx.com>
Sent: Wednesday, October 14, 2026 7:42 AM
To: Hess,Melody <MHess@newfirst.com>
Cc: Celina DeLeon <cdeleon@bedrocktx.com>; Ed Gojara <egojara@bedrocktx.com>
Subject: Re: Positive Pay Items Ready For Review

Good morning, While reviewing our Positive Pay notifications, we noticed that accounting@graywoodpropertiesllc.com was recently added...`;
const FORM = `Name: Bich Pham
Email: briantranpham@gmail.com
Phone: 8324367570
Message: Hello, I would like to report a couple of concerns.`;

(async () => {
  console.log('who a reply goes to');
  await t('ordinary external email: the sender', () => {
    const s = R.suggestReplyTo({ senderEmail: 'jane@gmail.com', senderName: 'Jane', bodyText: 'Hi, my fence is broken. Thanks, Jane', mailbox: 'claire@bedrocktx.com' });
    assert.deepStrictEqual([s.email, s.source, s.warnings.length], ['jane@gmail.com', 'sender', 0]);
  });
  await t('THE SCAR: a reply quoting its thread ("From: ... kat@bedrocktx.com") goes to Melody, not to us, with no form warning', () => {
    const s = R.suggestReplyTo({ senderEmail: 'MHess@newfirst.com', senderName: 'Hess,Melody', bodyText: MELODY, mailbox: 'kat@bedrocktx.com' });
    assert.strictEqual(s.email, 'MHess@newfirst.com'); assert.strictEqual(s.source, 'sender'); assert.strictEqual(s.warnings.length, 0);
    assert.strictEqual(R.isContactForm({ senderEmail: 'MHess@newfirst.com', bodyText: MELODY }), false);
  });
  await t('"From:" / "Sender:" header lines are never read as a form field', () => {
    assert.strictEqual(R.extractFormContact('From: e@f.net\nSent: today').email, null);
    assert.strictEqual(R.extractFormContact('Sender: g@h.org').email, null);
  });
  await t('a real website contact form (relay sender + labeled form block): the person who wrote in', () => {
    const s = R.suggestReplyTo({ senderEmail: 'mkessler@bedrocktx.com', senderName: 'Eaglewood Community', bodyText: FORM, mailbox: 'claire@bedrocktx.com' });
    assert.deepStrictEqual([s.email, s.source], ['briantranpham@gmail.com', 'form_body']);
  });
  await t('a form-looking body from an ordinary external sender is NOT a form (no relay)', () => {
    const s = R.suggestReplyTo({ senderEmail: 'jane@gmail.com', bodyText: 'Name: Jane\nEmail: other@x.com\nMessage: hi' });
    assert.deepStrictEqual([s.email, s.source], ['jane@gmail.com', 'sender']);
  });
  await t('a no-reply web relay with a form block is a form', () => {
    assert.strictEqual(R.suggestReplyTo({ senderEmail: 'no-reply@wix-forms.com', bodyText: FORM }).source, 'form_body');
  });
  await t('Reply-To from the same organization is honored', () => {
    const s = R.suggestReplyTo({ senderEmail: 'mhess@newfirst.com', bodyText: 'see below', replyTo: ['treasury.team@newfirst.com'], mailbox: 'kat@bedrocktx.com' });
    assert.deepStrictEqual([s.email, s.source], ['treasury.team@newfirst.com', 'reply_to']);
  });
  await t('Reply-To at a DIFFERENT organization is not followed silently: the sender, with a warning', () => {
    const s = R.suggestReplyTo({ senderEmail: 'billing@superiorlawncare.com', bodyText: 'Invoice', replyTo: ['pay@another-domain.co'], mailbox: 'emma@bedrocktx.com' });
    assert.strictEqual(s.email, 'billing@superiorlawncare.com'); assert.strictEqual(s.source, 'sender'); assert.ok(/different organization/.test(s.warnings[0]));
  });
  await t('Reply-To from a relay sender (newsletter / form system) is honored', () => {
    assert.strictEqual(R.suggestReplyTo({ senderEmail: 'noreply@mailchimp.com', bodyText: 'x', replyTo: ['manager@hoa-board.org'] }).email, 'manager@hoa-board.org');
  });
  await t('never our own mailbox for an external sender, even if a Reply-To or form says so', () => {
    assert.strictEqual(R.suggestReplyTo({ senderEmail: 'mhess@newfirst.com', bodyText: 'x', replyTo: ['kat@bedrocktx.com'], mailbox: 'kat@bedrocktx.com' }).email, 'mhess@newfirst.com');
  });
  await t('forwarded mail from a colleague: reply to the colleague (the forwarded-from address is history)', () => {
    const fwd = 'FYI see below\n\n---------- Forwarded message ---------\nFrom: Vendor <ap@vendor.com>\nDate: Oct 1\nSubject: Invoice\n\nEmail: ap@vendor.com';
    const s = R.suggestReplyTo({ senderEmail: 'cdeleon@bedrocktx.com', bodyText: fwd, mailbox: 'emma@bedrocktx.com' });
    assert.deepStrictEqual([s.email, s.source], ['cdeleon@bedrocktx.com', 'sender']);
  });
  await t('the sender is the replying mailbox itself: no default, the person chooses', () => {
    const s = R.suggestReplyTo({ senderEmail: 'kat@bedrocktx.com', bodyText: 'x', mailbox: 'kat@bedrocktx.com' });
    assert.deepStrictEqual([s.email, s.source], [null, 'none']);
  });

  console.log('reply all');
  await t('everyone else on the message, never ourselves, our AI mailboxes, the primary again, or an excluded address', () => {
    const cc = R.replyAllCc({ primary: 'mhess@newfirst.com', senderEmail: null, to: ['kat@bedrocktx.com', 'MHess@newfirst.com'], cc: ['cdeleon@bedrocktx.com', 'egojara@bedrocktx.com', 'accounting@graywoodpropertiesllc.com', 'claire@bedrocktx.com', 'not-an-email'], mailbox: 'kat@bedrocktx.com', exclude: ['claire@bedrocktx.com', 'accounting@graywoodpropertiesllc.com'] });
    assert.deepStrictEqual(cc, ['cdeleon@bedrocktx.com', 'egojara@bedrocktx.com']);
  });
  await t('when Reply-To redirected the reply, the original sender is kept on Cc', () => {
    assert.deepStrictEqual(R.replyAllCc({ primary: 'treasury.team@newfirst.com', senderEmail: 'mhess@newfirst.com', to: ['kat@bedrocktx.com'], cc: [], mailbox: 'kat@bedrocktx.com' }), ['mhess@newfirst.com']);
  });

  console.log('the send uses exactly the approved recipients, verified first');
  const path = require('path'); const Module = require('module');
  const fakeFetch = (behaviour) => { const calls = []; let draft = { toRecipients: [{ emailAddress: { address: 'MHess@newfirst.com' } }], ccRecipients: [] };
    const fn = async (url, opt = {}) => { let body = null; try { body = opt.body ? JSON.parse(opt.body) : null; } catch (_) { body = String(opt.body); } calls.push([opt.method || 'GET', url, body]);
      if (/oauth2|login.microsoftonline/.test(url)) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
      if (/createReply$/.test(url)) return { ok: true, json: async () => ({ id: 'd1', body: { content: '<p>quoted</p>' } }) };
      if (opt.method === 'PATCH') { const b = JSON.parse(opt.body); if (behaviour !== 'graph_ignores_to' && b.toRecipients) draft.toRecipients = b.toRecipients; if (b.ccRecipients) draft.ccRecipients = b.ccRecipients; return { ok: true, json: async () => ({}) }; }
      if (/\?\$select=toRecipients,ccRecipients(,internetMessageId)?$/.test(url)) return { ok: true, json: async () => draft };
      if (opt.method === 'DELETE') return { ok: true, status: 204 };
      if (/\/send$/.test(url)) return { ok: true, status: 202 };
      return { ok: true, json: async () => ({}) }; };
    return { fn, calls }; };
  const load = () => { const p = require.resolve('../lib/email/graph_send'); delete require.cache[p];
    const og = Module._load; Module._load = function (r) { if (/outbound_guard/.test(r)) return { guardOutbound: async () => ({ blocked: false }) }; return og.apply(this, arguments); };
    process.env.GRAPH_TENANT_ID = process.env.GRAPH_TENANT_ID || 't'; process.env.GRAPH_CLIENT_ID = process.env.GRAPH_CLIENT_ID || 'c'; process.env.GRAPH_CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET || 's';
    const G = require('../lib/email/graph_send'); Module._load = og; return G; };
  await t('threaded reply: the To/Cc the person approved replace createReply\'s choice, are read back, and only then sent', async () => {
    const G = load(); const f = fakeFetch('ok'); global.fetch = f.fn; G.getToken = async () => 'tok';
    const origTok = G.getToken;
    const r = await G.sendReplyAs({ from: 'kat@bedrocktx.com', sourceMailbox: 'kat@bedrocktx.com', sourceGraphId: 'm1', to: 'mhess@newfirst.com', cc: 'cdeleon@bedrocktx.com, egojara@bedrocktx.com', html: '<p>hi</p>', getTokenOverride: origTok }).catch((e) => { throw e; });
    const patch = f.calls.find((c) => c[0] === 'PATCH')[2];
    assert.deepStrictEqual(patch.toRecipients.map((x) => x.emailAddress.address), ['mhess@newfirst.com']);
    assert.deepStrictEqual(patch.ccRecipients.map((x) => x.emailAddress.address), ['cdeleon@bedrocktx.com', 'egojara@bedrocktx.com']);
    const order = f.calls.map((c) => (c[0] === 'GET' && /select=toRecipients/.test(c[1]) ? 'VERIFY' : /\/send$/.test(c[1]) ? 'SEND' : c[0]));
    assert.ok(order.indexOf('VERIFY') > -1 && order.indexOf('VERIFY') < order.indexOf('SEND'), order.join(','));
    assert.deepStrictEqual(r.recipients, { to: ['mhess@newfirst.com'], cc: ['cdeleon@bedrocktx.com', 'egojara@bedrocktx.com'] });
  });
  await t('if the draft\'s recipients do not match what was approved, it is deleted and NOTHING is sent', async () => {
    const G = load(); const f = fakeFetch('graph_ignores_to'); global.fetch = f.fn;
    await assert.rejects(G.sendReplyAs({ from: 'kat@bedrocktx.com', sourceMailbox: 'kat@bedrocktx.com', sourceGraphId: 'm1', to: 'someone.else@newfirst.com', html: '<p>hi</p>' }), (e) => e.code === 'recipient_verification_failed');
    assert.ok(f.calls.some((c) => c[0] === 'DELETE') && !f.calls.some((c) => /\/send$/.test(c[1])));
  });
  await t('no Cc approved: the draft carries none (Graph defaults are cleared)', async () => {
    const G = load(); const f = fakeFetch('ok'); global.fetch = f.fn;
    await G.sendReplyAs({ from: 'kat@bedrocktx.com', sourceMailbox: 'kat@bedrocktx.com', sourceGraphId: 'm1', to: 'mhess@newfirst.com', html: '<p>hi</p>' });
    assert.deepStrictEqual(f.calls.find((c) => c[0] === 'PATCH')[2].ccRecipients, []);
  });

  console.log('the send endpoint');
  const src = require('fs').readFileSync(require.resolve('../api/email_triage'), 'utf8');
  await t('the edited To is validated (a real address, not the sending mailbox, not under investigation) and passed to the threaded send', () => {
    assert.ok(/error: 'invalid_recipient'/.test(src) && /error: 'recipient_is_sender'/.test(src) && /error: 'unexpected_recipient'/.test(src));
    assert.ok(/sendReplyAs\(\{ from: fromMailbox, sourceMailbox: m\.mailbox, sourceGraphId: m\.graph_id, to: recipient, cc: ccList/.test(src));
  });
  await t('an invalid Cc stops the send instead of being silently dropped', () => assert.ok(/error: 'invalid_cc'/.test(src)));
  await t('the sent record lists the recipients verified on the draft', () => assert.ok(/recipients: verifiedRecipients \|\|/.test(src)));
  await t('Draft reply and Reply All use the shared resolver with the real Reply-To', () => assert.ok((src.match(/replyTo: \(await messageHeaders\(m\)\)\.replyTo/g) || []).length >= 2 && /replyAllCc\(\{ primary/.test(src)));
  const ui = require('fs').readFileSync(require.resolve('../public/communications.html'), 'utf8');
  await t('the contact-form note appears only for a real form; resolver warnings are shown', () => assert.ok(/const fromForm = r\.source === 'form_body';/.test(ui) && /r\.warnings \|\| \[\]\)\.length/.test(ui)));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
