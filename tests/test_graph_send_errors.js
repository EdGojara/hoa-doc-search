#!/usr/bin/env node
// ============================================================================
// Graph mail send/reply failures are normalized: the raw Graph blob never reaches
// staff, a temporary mailbox state (ErrorMailboxMoveInProgress) gets a plain
// message, and nothing is retried. PROD = the exact 2026-09-24 miranda@ error.
// Issue #29 (2026-10-04): that error, carrying "Cross Server access is not
// allowed", is a CROSS-MAILBOX reply (message id from info@ used under the
// persona mailbox), reproduced on demand: deterministic, non-retryable. A genuine
// move (MOVE, without that phrase) stays temporary. And the send path never asks
// one mailbox to reply to another mailbox's message.
// ============================================================================
require('dotenv').config({ quiet: true });
const assert = require('assert');
const { graphSendError } = require('../lib/email/graph_errors');
const { safeErrorMessage } = require('../api/_safe_error');

const PROD = '{"error":{"code":"ErrorMailboxMoveInProgress","message":"Mailbox move in progress. Try again later., Cross Server access is not allowed for mailbox 5bcbd794-9d45-4aaa-8a20-95a36dbd9326"}}';
const MOVE = '{"error":{"code":"ErrorMailboxMoveInProgress","message":"Mailbox move in progress. Try again later."}}';
const MSG = 'Microsoft is temporarily moving this mailbox. Your message was not sent. Please try again later.';
const CROSS_MSG = 'This email is stored in a different mailbox than the one replying, so Microsoft refused the reply. Nothing was sent. Retrying will not help; this needs a fix in TrustEd, not a wait.';
let failed = 0;
function sendRouteBlock() {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'api/email_triage.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf("router.post('/:id/send'");
  return src.slice(start, src.indexOf('\n});', start));
}
const t = async (name, fn) => { try { await fn(); console.log('PASS  ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); } };

(async () => {
  await t('"Cross Server access is not allowed" -> cross-mailbox, NOT temporary, plain message, no raw JSON for staff', () => {
    const e = graphSendError('createReply', 503, PROD);
    assert.strictEqual(e.code, 'cross_mailbox_access');
    assert.strictEqual(e.graphCode, 'ErrorMailboxMoveInProgress');
    assert.strictEqual(e.temporary, false, 'retrying later never fixes a cross-mailbox request');
    assert.strictEqual(safeErrorMessage(e), CROSS_MSG);
    assert.ok(!/\{|ErrorMailbox|5bcbd794/.test(safeErrorMessage(e)), 'raw Graph detail leaked');
    assert.ok(/createReply failed \(503\) ErrorMailboxMoveInProgress/.test(e.message), 'server log keeps the detail');
  });
  await t('a genuine mailbox move (no cross-server phrase) stays temporary at any step', () => {
    for (const step of ['createReply', 'sendMail', 'patch reply', 'send reply']) {
      const e = graphSendError(step, 503, MOVE);
      assert.strictEqual(e.code, 'mailbox_move_in_progress'); assert.strictEqual(e.temporary, true); assert.strictEqual(safeErrorMessage(e), MSG);
    }
  });
  await t('other Graph errors stay generic (not labelled temporary)', () => {
    const e = graphSendError('sendMail', 400, '{"error":{"code":"ErrorInvalidRecipients","message":"bad address"}}');
    assert.strictEqual(e.temporary, false);
    assert.strictEqual(e.userMessage, null);
    assert.strictEqual(e.code, 'graph_send_failed');
    const n = graphSendError('sendMail', 500, 'not json at all');
    assert.strictEqual(n.graphCode, null);
  });
  await t('sendReplyAs NEVER calls Graph when the message lives in another mailbox (or the source mailbox is missing)', async () => {
    const graphSend = require('../lib/email/graph_send');
    const realFetch = global.fetch; const calls = [];
    global.fetch = async (url) => { calls.push(String(url)); return new Response('{}', { status: 200 }); };
    try {
      for (const sourceMailbox of ['info@bedrocktx.com', 'accounting@bedrocktx.com', undefined]) {
        await assert.rejects(() => graphSend.sendReplyAs({ from: graphSend.CLAIRE_MAILBOX, sourceMailbox, sourceGraphId: 'AAMk-info', html: '<p>hi</p>' }),
          (e) => e.code === 'cross_mailbox_reply' && e.temporary === false && !!e.userMessage);
      }
      assert.strictEqual(calls.length, 0, 'no Graph call at all: ' + calls.join(', '));
    } finally { global.fetch = realFetch; }
    assert.strictEqual(graphSend.sameMailbox('Claire@BedrockTX.com ', 'claire@bedrocktx.com'), true);
    assert.strictEqual(graphSend.sameMailbox('info@bedrocktx.com', 'claire@bedrocktx.com'), false);
  });
  await t('sendReplyAs: a 503 mailbox move throws the normalized error and makes NO further Graph calls', async () => {
    const graphSend = require('../lib/email/graph_send');
    if (!graphSend.isConfigured()) return console.log('      (skipped: Graph not configured locally)');
    const realFetch = global.fetch; const calls = [];
    global.fetch = async (url, opts) => {
      calls.push(String(url));
      if (/login\.microsoftonline|oauth2/.test(String(url))) return new Response(JSON.stringify({ access_token: 'x', expires_in: 3600 }), { status: 200 });
      if (/createReply/.test(String(url))) return new Response(MOVE, { status: 503 });
      return new Response('{}', { status: 200 });
    };
    try {
      await assert.rejects(() => graphSend.sendReplyAs({ from: graphSend.MIRANDA_MAILBOX, sourceMailbox: graphSend.MIRANDA_MAILBOX, sourceGraphId: 'AAMk-test', html: '<p>hi</p>' }),
        (e) => e.code === 'mailbox_move_in_progress' && e.temporary === true);
      assert.ok(!calls.some((u) => /\/send$|\/messages\/[^/]+$/.test(u)), 'no patch/send after the failure: ' + calls.join(', '));
      assert.strictEqual(calls.filter((u) => /createReply/.test(u)).length, 1, 'no automatic retry');
    } finally { global.fetch = realFetch; }
  });
  await t('triage /:id/send returns 503 + sent:false for a temporary mailbox state, and marks nothing before the send', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'api/email_triage.js'), 'utf8').replace(/\r\n/g, '\n');
    const start = src.indexOf("router.post('/:id/send'");
    const block = src.slice(start, src.indexOf('\n});', start));
    assert.ok(/res\.status\(err && err\.temporary \? 503 : 500\)/.test(block));
    assert.ok(/sent: false/.test(block));
    const iSend = block.indexOf('graphSend.sendReplyAs(');
    const iHandled = block.indexOf("triage_status: 'handled'");
    const iOutbound = block.indexOf("direction: 'outbound'");
    assert.ok(iSend > 0 && iHandled > iSend && iOutbound > iSend, 'handled/outbound must come after the send');
  });

  await t('triage /:id/send: in-thread ONLY when the message lives in the sending mailbox; otherwise a fresh reply from the persona mailbox with the history inline', () => {
    const block = sendRouteBlock();
    assert.match(block, /const replyFrom = graphSend\.personaMailbox\(persona\);/);
    assert.match(block, /const threaded = !!m\.graph_id && graphSend\.sameMailbox\(m\.mailbox, replyFrom\);/);
    assert.match(block, /const inlineQuote = threaded \? '' : quoted;/, 'the fresh-reply fallback carries the history');
    assert.match(block, /if \(threaded && graphSend\.sameMailbox\(fromMailbox, replyFrom\)\) \{/);
    assert.match(block, /sendReplyAs\(\{ from: fromMailbox, sourceMailbox: m\.mailbox, sourceGraphId: m\.graph_id/);
    assert.match(block, /graphSend\.sendAs\(\{ from: fromMailbox, to: recipient/, 'fallback sends from the persona mailbox');
    assert.ok(!/from: m\.mailbox/.test(block), 'never silently sends as the shared mailbox');
  });
  await t('personaMailbox() matches every persona branch of the send route; shared-inbox mail is never threaded across mailboxes', () => {
    const graphSend = require('../lib/email/graph_send');
    const block = sendRouteBlock();
    const pairs = [...block.matchAll(/persona === '(\w+)'\) \{[\s\S]*?fromMailbox = graphSend\.(\w+_MAILBOX)/g)].map((x) => [x[1], x[2]]).filter(([q]) => !['isabella', 'mei', 'priya'].includes(q));   // language branch uses L[]; checked below
    assert.ok(pairs.length >= 7, 'found persona branches: ' + pairs.length);
    for (const [persona, constant] of pairs) assert.strictEqual(graphSend.personaMailbox(persona), graphSend[constant], persona);
    for (const q of ['isabella', 'mei', 'priya']) assert.strictEqual(graphSend.personaMailbox(q), graphSend[q.toUpperCase() + '_MAILBOX'], q);
    assert.strictEqual(graphSend.personaMailbox('claire'), graphSend.CLAIRE_MAILBOX); assert.strictEqual(graphSend.personaMailbox(undefined), graphSend.CLAIRE_MAILBOX);
    for (const [persona, source] of [['claire', 'info@bedrocktx.com'], ['emma', 'info@bedrocktx.com'], ['kat', 'accounting@bedrocktx.com'], ['miranda', 'violations@bedrocktx.com']]) {
      assert.strictEqual(graphSend.sameMailbox(source, graphSend.personaMailbox(persona)), false, persona + ' <- ' + source);
    }
    assert.strictEqual(graphSend.sameMailbox('amandaalbright@bedrocktx.com', graphSend.personaMailbox('amanda')), true, 'Amanda mail in her own mailbox stays threaded');
    assert.strictEqual(graphSend.sameMailbox('claire@bedrocktx.com', graphSend.personaMailbox('claire')), true, 'Claire mail in claire@ stays threaded');
  });

  console.log(failed ? `\n${failed} failure(s)` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})();
