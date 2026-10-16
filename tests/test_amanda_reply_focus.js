// =============================================================================
// tests/test_amanda_reply_focus.js — Amanda answers the latest sender's point
// =============================================================================
// Regression for Kevin Thoms (Canyon Gate Treasurer), 2026-10-16. His reply to
// Amanda's camera recommendation disagreed with "proceed" if it meant acting
// before a fully executed final proposal, terms and conditions, and an insurance
// certificate naming the HOA. The draft waiting for him was "Hi Treasurer, Thank
// you for getting Camera Proposals set up ... We're all set on our end".
//
// Fixture: tests/fixtures/amanda-reply-focus/kevin_thoms_camera_2026-10-16.json,
// his real message (with the quoted recommendation under it), Hugh's RFP request
// and the Board roster, read from production. No model call, no database: the
// drafter runs end to end against a scripted model and an in-memory store.
//
// Run: node tests/test_amanda_reply_focus.js   (wired into npm test)
// =============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const FX = require('./fixtures/amanda-reply-focus/kevin_thoms_camera_2026-10-16.json');
const { verifyKevinReply } = require('./fixtures/amanda-reply-focus/kevin_expectations');
const focus = require('../lib/amanda/reply_focus');
const thanks = require('../lib/email/completion_thanks');

const BAD = FX.bad_draft_as_stored.body;
const EXPECTED = `Kevin,

I agree with the distinction you're making. My recommendation to proceed was intended to mean move forward with iTech as the preferred direction and complete the remaining diligence, not sign the current proposal or authorize work. I agree that the final binding proposal, terms and conditions, insurance and the other open items need to be resolved before anything is executed.

Hugh has asked me to scrub the numbers and prepare an RFP quickly, so I'm doing that now and will bring the Board back a final comparison and approval package before anything is signed.`;

let passed = 0; let failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n        ${e.message}`); }
}

// ---------------------------------------------------------- in-memory store
// Just enough of the PostgREST builder for the drafter's reads. Filters that
// matter to the behavior under test are applied; everything resolves {data, error}.
function fakeSupabase(tables) {
  return {
    from(table) {
      let rows = (tables[table] || []).slice();
      const q = {
        select() { return q; },
        eq(col, val) { rows = rows.filter((r) => r[col] === undefined || r[col] === val); return q; },
        ilike(col, val) { rows = rows.filter((r) => String(r[col] || '').toLowerCase() === String(val).toLowerCase()); return q; },
        neq() { return q; }, gte() { return q; }, lte() { return q; }, in() { return q; }, or() { return q; },
        order() { return q; }, limit() { return q; }, range() { return q; },
        maybeSingle() { return Promise.resolve({ data: rows[0] || null, error: null }); },
        single() { return Promise.resolve({ data: rows[0] || null, error: null }); },
        then(res, rej) { return Promise.resolve({ data: rows, error: null }).then(res, rej); },
      };
      return q;
    },
  };
}
const STORE = () => fakeSupabase({
  board_members: FX.board_members,
  email_messages: [FX.hugh_request, FX.amanda_recommendation, FX.hugh_create_rfp],   // Kevin's own row is not inserted yet (ingest)
  playbook: [], amanda_guidance: [], learned_guidance: [],
});

// The message exactly as graph_ingest hands it to the drafter: body_full, no body, no id.
const kevinAtIngest = () => {
  const k = { ...FX.kevin }; delete k.id; return k;
};

// --------------------------------------------- the drafter with a scripted model
function loadDrafter(script) {
  const root = path.join(__dirname, '..');
  const calls = [];
  const anthropicPath = require.resolve(path.join(root, 'lib/ai/anthropic'));
  require.cache[anthropicPath] = { id: anthropicPath, filename: anthropicPath, loaded: true,
    exports: class { constructor() { this.messages = { create: async (req) => { calls.push(req); const text = script[Math.min(calls.length - 1, script.length - 1)]; return { content: [{ type: 'text', text }] }; } }; } } };
  const core = require(path.join(root, 'lib/team/operator_core'));
  // Retrieval and account context are not under test; keep them offline.
  core.assembleGrounding = async () => ({ docContext: '', profileBlock: '' });
  core.propertyContext = async () => ({ violations: [], ar_balance: null, acc: [], flags: [] });
  core.boardDataContext = async () => '';
  const lg = require(path.join(root, 'lib/team/learned_guidance'));
  lg.loadApprovedGuidance = async () => [];
  const drPath = require.resolve(path.join(root, 'lib/amanda/decision_ready'));
  require(drPath).boardDecisionFacts = async () => 'AS OF 2026-10-16. (test fixture)';
  const arPath = require.resolve(path.join(root, 'lib/community/amanda_reply'));
  delete require.cache[arPath];
  return { draftAmandaReply: require(arPath).draftAmandaReply, calls };
}

(async () => {
  console.log('amanda reply focus (Kevin Thoms regression):');
  const latest = focus.latestMessageText(FX.kevin.body_full);

  // ------------------------------------------------ what the drafter saw
  await t('latest text is Kevin\'s new words only; the quoted recommendation is cut off', () => {
    assert.ok(/I disagree with the recommendation to proceed immediately/.test(latest));
    assert.ok(/insurance certificate naming the HOA as an additional insured/.test(latest), 'the part body_preview cut off is present');
    assert.ok(!/I completed my review/.test(latest), 'quoted Amanda reply is not part of his message');
    assert.ok(/I completed my review/.test(focus.quotedHistory(FX.kevin.body_full)), 'quoted history kept separately as context');
  });
  await t('the stored preview really was cut before the insurance certificate (the evidence)', () => {
    assert.ok(!/insurance/i.test(FX.kevin.body_preview));
  });
  await t('his message is substantive: a disagreement and a condition', () => {
    const s = focus.substantiveSignals(latest);
    assert.ok(s.substantive);
    assert.ok(s.kinds.includes('disagreement') && s.kinds.includes('condition'), s.kinds.join(','));
  });

  // ------------------------------------------------ salutation
  await t('"Treasurer HOA" is a role label, never a name; the signature gives Kevin', () => {
    assert.ok(focus.isRoleLabel('Treasurer HOA'));
    assert.ok(focus.isRoleLabel('President HOA') && focus.isRoleLabel('Vice President HOA'));
    assert.ok(!focus.isRoleLabel('Kevin Thoms') && !focus.isRoleLabel('Hugh Durlam'));
    assert.strictEqual(focus.senderFirstName(FX.kevin), 'Kevin');
    assert.strictEqual(focus.senderFirstName(FX.hugh_request), 'Hugh', 'Hugh signs "Hugh Durlam, President"');
  });
  await t('no signature: the Board roster by position names the role mailbox', async () => {
    const e = { sender_email: 'treasurer@canyongateatcincoranch.com', sender_name: 'Treasurer HOA', body_full: 'Agreed.' };
    assert.strictEqual(focus.senderFirstName(e), null);
    assert.strictEqual(await focus.resolveSenderFirstName(STORE(), FX.kevin.community_id, e), 'Kevin');
  });
  await t('operator_core.greetingName never returns a role label', () => {
    const { greetingName } = require('../lib/team/operator_core');
    assert.strictEqual(greetingName(FX.kevin, null), 'Kevin');
    assert.strictEqual(greetingName({ sender_name: 'President HOA', body_full: 'Thanks' }, null), 'there');
    assert.strictEqual(greetingName({ sender_name: 'Lorena Diaz' }, 'Maria & William De Slavick'), 'Lorena');
  });

  // ------------------------------------------------ the check
  await t('the stored bad draft fails every relevant check', () => {
    const r = focus.checkReplyFocus(BAD, { latestText: latest, senderFirstName: 'Kevin' });
    const codes = new Set(r.issues.map((i) => i.code));
    for (const c of ['role_salutation', 'generic_ack', 'point_not_addressed', 'point_not_first', 'misread_not_clarified']) assert.ok(codes.has(c), `missing ${c}; got ${[...codes]}`);
  });
  await t('Ed\'s expected substance passes the check', () => {
    const r = focus.checkReplyFocus(EXPECTED, { latestText: latest, senderFirstName: 'Kevin' });
    assert.ok(r.ok, JSON.stringify(r.issues));
  });
  await t('a generic acknowledgement is fine when the sender raised nothing', () => {
    const r = focus.checkReplyFocus('Hi Dana,\n\nThank you, we\'re all set on our end.', { latestText: 'Done, the gate code is updated.\n\nDana Ruiz', senderFirstName: 'Dana' });
    assert.ok(r.ok, JSON.stringify(r.issues));
  });
  await t('claiming the matter is complete is flagged when items are open', () => {
    const r = focus.checkReplyFocus('Kevin,\n\nI agree on the insurance certificate and binding proposal terms. This matter is now complete.', { latestText: latest, senderFirstName: 'Kevin' });
    assert.ok(r.issues.some((i) => i.code === 'claims_complete'));
  });
  await t('a defensive opening is flagged (the first live dry run opened "We are not in disagreement.")', () => {
    const live1 = 'Good morning Kevin,\n\nWe are not in disagreement. When I used the word "proceed," I meant proceeding with iTech as the preferred vendor and continuing the diligence, not signing the current proposal or authorizing any work.';
    const r = focus.checkReplyFocus(live1, { latestText: latest, senderFirstName: 'Kevin' });
    assert.ok(r.issues.some((i) => i.code === 'defensive'), JSON.stringify(r.issues));
    assert.ok(!verifyKevinReply(live1).results.find((x) => x.name === 'is not defensive').ok);
  });
  await t('wrong name in the greeting is flagged', () => {
    const r = focus.checkReplyFocus('Hi Hugh,\n\nI agree.', { latestText: latest, senderFirstName: 'Kevin' });
    assert.ok(r.issues.some((i) => i.code === 'wrong_name'));
  });
  await t('the retry note names the sender, his point and the misread', () => {
    const r = focus.checkReplyFocus(BAD, { latestText: latest, senderFirstName: 'Kevin' });
    const note = focus.retryNote(r.issues, { latestText: latest, senderFirstName: 'Kevin' });
    assert.ok(/"Kevin"/.test(note) && /insurance certificate/.test(note) && /what you meant/.test(note));
  });

  // ------------------------------------------------ Ed's acceptance criteria
  await t('acceptance criteria: the bad draft fails, Ed\'s expected substance passes', () => {
    const bad = verifyKevinReply(BAD); const good = verifyKevinReply(EXPECTED);
    assert.ok(!bad.ok);
    assert.ok(good.ok, JSON.stringify(good.results.filter((r) => !r.ok)));
  });

  // ------------------------------------------------ the completion thank-you
  await t('Kevin\'s reply is NOT a completion acknowledgement (the root cause)', () => {
    assert.strictEqual(thanks.isCompletionAck(FX.kevin), false);
  });
  await t('a genuine wrap-up still is, and the thank-you never uses a role or the subject', () => {
    const e = { direction: 'inbound', sender_email: 'treasurer@canyongateatcincoranch.com', sender_name: 'Treasurer HOA', subject: 'Re: Camera Proposals',
      body_full: 'All set, the vendor W-9 is uploaded.\n\nKevin Thoms\ntreasurer@canyongateatcincoranch.com' };
    assert.strictEqual(thanks.isCompletionAck(e), true);
    const body = thanks.draftThankYouBody(e);
    assert.ok(/^Hi Kevin,/.test(body), body);
    assert.ok(!/Camera Proposals|set up|Treasurer/.test(body), body);
    assert.ok(/^Hello,/.test(thanks.draftThankYouBody({ sender_name: 'President HOA', body_full: 'Done.' })));
  });
  await t('ingest never lets the template replace Amanda\'s draft', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'email', 'graph_ingest.js'), 'utf8');
    assert.ok(/isCompletionAck\(email\) && !\(draft && draft\.persona === 'amanda'\)/.test(src));
  });

  // ------------------------------------------------ audience + history at ingest
  await t('a Board officer on the role mailbox is audience board', async () => {
    const { resolveAudience } = require('../lib/team/operator_core');
    assert.strictEqual(await resolveAudience({ email: FX.kevin, supabase: STORE(), communityId: FX.kevin.community_id }), 'board');
    const outsider = { sender_email: 'treasurer@some-other-hoa.org' };
    assert.strictEqual(await resolveAudience({ email: outsider, supabase: STORE(), communityId: FX.kevin.community_id }), 'other', 'another domain is never Board');
  });
  await t('thread history works before the row exists (conversation id fallback)', async () => {
    const { threadHistory } = require('../lib/team/operator_core');
    const h = await threadHistory(STORE(), undefined, { conversationId: FX.kevin.conversation_id, senderEmail: FX.kevin.sender_email, excludeGraphId: FX.kevin.graph_id });
    assert.ok(/subject to several final scope and contract confirmations before the Association signs/.test(h), 'Amanda\'s recommendation reaches the drafter');
  });
  await t('Hugh\'s "Create RFP" instruction (another thread) is found as related', async () => {
    const r = await focus.relatedRecentInstructions(STORE(), { mailbox: FX.kevin.mailbox, communityId: FX.kevin.community_id, conversationId: FX.kevin.conversation_id, senderEmail: FX.kevin.sender_email, receivedAt: FX.kevin.received_at });
    assert.ok(/scrub the numbers on this proposal and create an RFP/.test(r), r);
  });

  // ------------------------------------------------ end to end, scripted model
  await t('drafter: sees the whole message, history and Hugh\'s instruction; a bad first draft is retried once', async () => {
    const { draftAmandaReply, calls } = loadDrafter([BAD, EXPECTED]);
    const d = await draftAmandaReply({ email: kevinAtIngest(), supabase: STORE(), communityId: FX.kevin.community_id, communityName: 'Canyon Gate at Cinco Ranch', contactName: null, diagnostic: true });
    const prompt = calls[0].messages[0].content;
    const text = typeof prompt === 'string' ? prompt : prompt.map((b) => b.text || '').join('');
    assert.ok(/greet them as Kevin/.test(text), 'greets Kevin');
    assert.ok(/insurance certificate naming the HOA/.test(text), 'the full message, not the preview');
    assert.ok(/subject to several final scope and contract confirmations/.test(text), 'Amanda\'s prior recommendation');
    assert.ok(/create an RFP/.test(text), 'Hugh\'s instruction');
    assert.ok(/ANSWER THE LATEST SENDER FIRST/.test(calls[0].system), 'the rule is in the system prompt');
    assert.strictEqual(d.audience, 'board');
    assert.strictEqual(calls.length, 2, 'one corrective retry');
    assert.ok(/REVISE YOUR DRAFT \(answer the latest sender first\)/.test(calls[1].messages[0].content), 'retry carries the reply-focus note');
    assert.strictEqual(d.body, EXPECTED.trim());
    assert.deepStrictEqual(d.focus_issues, []);
    assert.ok(verifyKevinReply(d.body).ok);
  });
  await t('drafter: a draft still failing after the retry is flagged and held, never auto', async () => {
    const { draftAmandaReply, calls } = loadDrafter([BAD, BAD]);
    const d = await draftAmandaReply({ email: kevinAtIngest(), supabase: STORE(), communityId: FX.kevin.community_id, communityName: 'Canyon Gate at Cinco Ranch', contactName: null });
    assert.strictEqual(calls.length, 2, 'exactly one retry');
    assert.ok(d.focus_issues.includes('generic_ack') && d.focus_issues.includes('role_salutation'), d.focus_issues.join(','));
    assert.strictEqual(d.disposition, 'needs_review');
    assert.ok(/reply-focus: generic_ack/.test(d.review_hint), d.review_hint);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
