// =============================================================================
// tests/test_reply_focus_shared_paths.js — every ordinary reply path gets the fix
// =============================================================================
// Ed 2026-10-16: "the root cause must be fixed in the shared ordinary email reply
// path, not patched for Kevin and Hugh only." Amanda's ingest drafter is covered in
// tests/test_amanda_reply_focus.js. This proves the two other ordinary drafters run
// the same reply-focus context and check with one corrective retry:
//   lib/email/draft_reply.js     Claire and every specialist lane, the inbox
//                                "Draft reply" / "Rewrite with my notes" button,
//                                Kat's bank correspondence
//   lib/email/persona_reply.js   the re-draft for Kat / Amanda / Reese / Paige
// Kevin's and Hugh's real emails (tests/fixtures/amanda-reply-focus/), a scripted
// model, an in-memory database. No network, no model call.
//
// Run: node tests/test_reply_focus_shared_paths.js   (wired into npm test)
// =============================================================================
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:9';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test';

const FX = require('./fixtures/amanda-reply-focus/kevin_thoms_camera_2026-10-16.json');
const { verifyKevinReply } = require('./fixtures/amanda-reply-focus/kevin_expectations');
const { verifyHughReply } = require('./fixtures/amanda-reply-focus/hugh_expectations');

// ------------------------------------------------------------- stubs
const TABLES = {
  board_members: FX.board_members,
  email_messages: [FX.hugh_request, FX.amanda_recommendation, FX.hugh_create_rfp],
  bid_requests: FX.bid_requests,
};
function fakeClient() {
  return {
    from(table) {
      let rows = (TABLES[table] || []).slice();
      const q = {
        select() { return q; },
        eq(c, v) { rows = rows.filter((r) => r[c] === undefined || r[c] === v); return q; },
        ilike(c, v) { rows = rows.filter((r) => String(r[c] || '').toLowerCase() === String(v).toLowerCase()); return q; },
        is(c, v) { rows = rows.filter((r) => r[c] === undefined || r[c] === v); return q; },
        neq() { return q; }, gte() { return q; }, lte() { return q; }, in() { return q; }, or() { return q; }, not() { return q; },
        order() { return q; }, limit() { return q; }, range() { return q; },
        maybeSingle() { return Promise.resolve({ data: rows[0] || null, error: null }); },
        single() { return Promise.resolve({ data: rows[0] || null, error: null }); },
        then(res, rej) { return Promise.resolve({ data: rows, error: null }).then(res, rej); },
      };
      return q;
    },
    rpc() { return Promise.resolve({ data: null, error: { message: 'stub' } }); },
  };
}
const stub = (rel, exportsObj) => { const p = require.resolve(path.join(root, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj }; };
const supaPath = require.resolve('@supabase/supabase-js', { paths: [root] });
require.cache[supaPath] = { id: supaPath, filename: supaPath, loaded: true, exports: { createClient: () => fakeClient() } };
stub('lib/hybrid_retrieval', { getRelevantChunks: async () => '' });
stub('lib/email/graph_attachments', { fetchAttachmentBlocks: async () => ({ blocks: [], summary: '' }), fetchMessageText: async () => '' });

// Scripted model: drafting calls (with a system prompt) take the next scripted body;
// helper calls (retrieval query) get a one-liner. Every drafting request is recorded.
let SCRIPT = []; const CALLS = [];
const anthropicPath = require.resolve(path.join(root, 'lib/ai/anthropic'));
require.cache[anthropicPath] = { id: anthropicPath, filename: anthropicPath, loaded: true,
  exports: class { constructor() { this.messages = { create: async (req) => {
    if (!req.system) return { content: [{ type: 'text', text: 'camera proposal' }] };
    CALLS.push(req); const text = SCRIPT[Math.min(CALLS.length - 1, SCRIPT.length - 1)];
    return { content: [{ type: 'text', text }] };
  } }; } } };

const { draftReply } = require('../lib/email/draft_reply');
const { draftPersonaReply } = require('../lib/email/persona_reply');
const promptText = (req) => { const c = req.messages[0].content; return typeof c === 'string' ? c : c.map((b) => b.text || '').join(''); };

const KEVIN_GOOD = `Kevin,

I agree with the distinction you're making. My recommendation to proceed was intended to mean move forward with iTech as the preferred direction and complete the remaining diligence, not sign the current proposal or authorize work. I agree that the final binding proposal, terms and conditions, insurance and the other open items need to be resolved before anything is executed.

Hugh has asked me to scrub the numbers and prepare an RFP quickly, so I'm doing that now and will bring the Board back a final comparison and approval package before anything is signed.`;
const HUGH_GOOD = FX.live_hugh_dry_run_passing;
const kevinEmail = () => { const e = { ...FX.kevin }; delete e.id; return e; };
const hughEmail = () => { const e = { ...FX.hugh_create_rfp }; delete e.id; return e; };

let passed = 0; let failed = 0;
async function t(name, fn) {
  try { SCRIPT = []; CALLS.length = 0; await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n        ${e.message}`); }
}

(async () => {
  console.log('reply focus on the shared ordinary reply paths:');

  await t('draft_reply (Claire / specialists / Draft reply button): Kevin gets the latest text, his name, one retry, a passing reply', async () => {
    SCRIPT = [FX.bad_draft_as_stored.body, KEVIN_GOOD];
    const d = await draftReply({ email: kevinEmail(), classification: 'homeowner_request', communityId: FX.kevin.community_id, communityName: 'Canyon Gate at Cinco Ranch', contactName: 'Treasurer HOA', force: true, persona: 'amanda' });
    const p = promptText(CALLS[0]);
    assert.ok(/THE LATEST MESSAGE \(answer THIS sender's point first; greet them as Kevin\)/.test(p), 'latest message first, greeted as Kevin');
    assert.ok(/first name: Kevin/.test(p) && !/first name: Treasurer/.test(p), 'never "Treasurer"');
    assert.ok(/insurance certificate naming the HOA/.test(p), 'the whole new message');
    assert.ok(/ANSWER THE LATEST SENDER FIRST/.test(CALLS[0].system));
    assert.strictEqual(CALLS.length, 2, 'one corrective retry');
    assert.deepStrictEqual(d.focus_issues, []);
    assert.ok(verifyKevinReply(d.body).ok, JSON.stringify(verifyKevinReply(d.body).results.filter((r) => !r.ok)));
  });

  await t('draft_reply: Hugh gets the settled no-monitoring constraint and the RFP record; the bad draft is retried', async () => {
    SCRIPT = [FX.bad_hugh_rfp_draft_as_stored.body, HUGH_GOOD];
    const d = await draftReply({ email: hughEmail(), classification: 'homeowner_request', communityId: FX.hugh_create_rfp.community_id, communityName: 'Canyon Gate at Cinco Ranch', contactName: 'President HOA', force: true, persona: 'amanda' });
    const p = promptText(CALLS[0]);
    assert.ok(/SETTLED CONSTRAINTS[\s\S]*not interested in any monitoring/.test(p), 'no monitoring is a hard constraint');
    assert.ok(/Security Camera System 2026[\s\S]*not drafted yet/.test(p), 'the RFP record');
    assert.strictEqual(CALLS.length, 2);
    assert.ok(/You asked about something the Board already decided/.test(promptText(CALLS[1])));
    assert.deepStrictEqual(d.focus_issues, []);
    assert.ok(verifyHughReply(d.body).ok);
  });

  await t('draft_reply: a draft still failing after the retry is flagged and marked careful', async () => {
    SCRIPT = [FX.bad_draft_as_stored.body, FX.bad_draft_as_stored.body];
    const d = await draftReply({ email: kevinEmail(), classification: 'homeowner_request', communityId: FX.kevin.community_id, communityName: 'Canyon Gate at Cinco Ranch', contactName: null, force: true });
    assert.strictEqual(CALLS.length, 2, 'exactly one retry');
    assert.ok(d.focus_issues.includes('generic_ack'));
    assert.strictEqual(d.careful, true);
    assert.ok(/reply-focus: /.test(d.review_hint || ''), d.review_hint);
  });

  await t('persona_reply (Kat / Amanda / Reese / Paige re-draft): Kevin gets the same context and check', async () => {
    SCRIPT = [FX.bad_draft_as_stored.body, KEVIN_GOOD];
    const d = await draftPersonaReply({ persona: 'amanda', email: { ...FX.kevin }, context: { communityId: FX.kevin.community_id, communityName: 'Canyon Gate at Cinco Ranch', contactName: 'Treasurer HOA' } });
    const p = promptText(CALLS[0]);
    assert.ok(/greet them as Kevin/.test(p), 'greets Kevin');
    assert.ok(/subject to several final scope and contract confirmations/.test(p) || /QUOTED BELOW THEIR MESSAGE/.test(p), 'the recommendation he is answering');
    assert.ok(/ANSWER THE LATEST SENDER FIRST/.test(CALLS[0].system));
    assert.strictEqual(CALLS.length, 2, 'one corrective retry');
    assert.deepStrictEqual(d.focus_issues, []);
    assert.ok(verifyKevinReply(d.body).ok);
  });

  await t('persona_reply: Hugh gets the settled constraints; a still-failing draft is flagged careful', async () => {
    SCRIPT = [FX.bad_hugh_rfp_draft_as_stored.body, FX.bad_hugh_rfp_draft_as_stored.body];
    const d = await draftPersonaReply({ persona: 'amanda', email: { ...FX.hugh_create_rfp }, context: { communityId: FX.hugh_create_rfp.community_id, communityName: 'Canyon Gate at Cinco Ranch', contactName: 'President HOA' } });
    assert.ok(/SETTLED CONSTRAINTS[\s\S]*not interested in any monitoring/.test(promptText(CALLS[0])));
    assert.strictEqual(CALLS.length, 2);
    assert.ok(d.focus_issues.includes('reasks_settled') && d.focus_issues.includes('asks_permission'), d.focus_issues.join(','));
    assert.strictEqual(d.careful, true);
  });

  await t('privacy: a homeowner (not Board) never gets other threads or "settled constraints" pulled in', async () => {
    SCRIPT = ['Hi Dana,\n\nThe pool opens at 9 AM on weekends this season, per the posted amenity schedule.'];
    const e = { direction: 'inbound', mailbox: FX.kevin.mailbox, sender_email: 'dana@gmail.com', sender_name: 'Dana Ruiz', subject: 'Pool hours', body_full: 'What time does the pool open on weekends?\n\nDana Ruiz', conversation_id: 'conv-dana', received_at: FX.kevin.received_at, community_id: FX.kevin.community_id };
    await draftReply({ email: e, classification: 'homeowner_request', communityId: FX.kevin.community_id, communityName: 'Canyon Gate at Cinco Ranch', contactName: 'Dana Ruiz', force: true });
    const p = promptText(CALLS[0]);
    assert.ok(!/SETTLED CONSTRAINTS|RELATED RECENT MESSAGES|RFP RECORDS/.test(p), 'no Board-only context for a homeowner');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
