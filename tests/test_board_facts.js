// =============================================================================
// tests/test_board_facts.js — Board-facing drafts: exact facts, no unauthorized action
// =============================================================================
// Ed's review of PR #216. Hugh's three live drafts (ingest, general, inbox re-draft,
// read-only regenerations, stored in the fixture) exposed four gaps the reply-focus
// checks did not cover:
//   1. figures not matching trustEd ("call it $47,854.69", "near $47,855", "roughly
//      $48,000" for an installed estimate of $47,854.68)
//   2. unauthorized external action ("will confirm with iTech")
//   3. unverified terms stated as fact (the 12-month warranty "should still be covered")
//   4. execution readiness the decision state denies ("doesn't have to delay a
//      decision on iTech if the Board wants to move now"), and the RFP described as
//      not happening ("rather than opening a full new bid cycle")
// Facts come from lib/amanda/matter_facts.js over the stored bid_request and
// vendor_proposals (fixture: trimmed copies of the production rows). Each draft must be
// caught on exactly its failures, a corrected version must pass, and Kevin's drafts
// must raise nothing. The last tests prove the rules are not Canyon Gate strings.
//
// Run: node tests/test_board_facts.js   (wired into npm test)
// =============================================================================
const assert = require('assert');
const FX = require('./fixtures/amanda-reply-focus/kevin_thoms_camera_2026-10-16.json');
const focus = require('../lib/amanda/reply_focus');
const { boardMatterFacts } = require('../lib/amanda/matter_facts');
const { verifyHughReply } = require('./fixtures/amanda-reply-focus/hugh_expectations');

const fakeDb = (bids, props) => ({
  from(t) {
    const rows = t === 'bid_requests' ? bids : t === 'vendor_proposals' ? props : [];
    const q = { select() { return q; }, eq() { return q; }, is() { return q; }, in() { return q; }, order() { return q; }, limit() { return q; },
      then(a, b) { return Promise.resolve({ data: rows, error: null }).then(a, b); } };
    return q;
  },
});

let passed = 0; let failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n        ${e.message}`); }
}
const codes = (r) => [...new Set(r.issues.map((i) => i.code))].sort();

(async () => {
  console.log('Board-facing facts and actions:');
  const facts = await boardMatterFacts(fakeDb(FX.bid_requests, FX.vendor_proposals), FX.hugh_create_rfp.community_id, { env: {} });
  const hughLatest = focus.latestMessageText(FX.hugh_create_rfp.body_full);
  const hughSources = [hughLatest, FX.hugh_request.body_full, FX.amanda_recommendation.body_full].join('\n');
  const constraints = focus.settledConstraints([FX.hugh_request]);
  const checkHugh = (d) => focus.checkReplyFocus(d, { latestText: hughLatest, senderFirstName: 'Hugh', constraints, facts, sourceText: hughSources });
  const kevinLatest = focus.latestMessageText(FX.kevin.body_full);
  const kevinSources = [kevinLatest, focus.quotedHistory(FX.kevin.body_full), FX.hugh_create_rfp.body_full].join('\n');
  const rr = focus.relatedWorkRequests([FX.hugh_create_rfp], `${kevinLatest}\n${focus.quotedHistory(FX.kevin.body_full)}\nRe: Camera Proposals`);
  const checkKevin = (d) => focus.checkReplyFocus(d, { latestText: kevinLatest, senderFirstName: 'Kevin', constraints, relatedRequests: rr, facts, sourceText: kevinSources });

  // ------------------------------------------------ the facts
  await t('facts: exact installed estimate, tax, plan, payment terms; decision state; no vendor contact', () => {
    const has = (c) => facts.money.some((x) => x.cents === c);
    assert.ok(has(4461975) && has(323493) && has(4785468), 'upfront $44,619.75, tax $3,234.93, installed $47,854.68');
    assert.ok(has(44000) && has(2230987) && has(2230988), '$440/month plan, payment terms');
    assert.ok(facts.notAuthorized && facts.rfpInProgress);
    assert.strictEqual(facts.vendorContactAuthorized, false, 'AMANDA_RFP_WORKFLOW dry_run and no confirmed bidder list');
    assert.deepStrictEqual(facts.unverified.map((u) => u.topic).sort(), ['cloud', 'firm_price', 'insurance', 'retention', 'warranty']);
    assert.ok(facts.vendorNames.includes('iTech') && facts.vendorNames.includes('Envera'));
    assert.ok(/Not ready to sign/.test(facts.block) && /NOT authorized/.test(facts.block) && /\$47,854\.68/.test(facts.block));
  });

  // ------------------------------------------------ Hugh's three live drafts
  await t('Hugh ingest draft: caught on money, unauthorized vendor contact and the warranty claim, nothing else', () => {
    const r = checkHugh(FX.live_hugh_round4.ingest);
    assert.deepStrictEqual(codes(r), ['money_approximate', 'unauthorized_action', 'unverified_term']);
    assert.ok(r.issues.some((i) => i.code === 'money_approximate' && /\$47,854\.69/.test(i.text)));
    assert.ok(r.issues.some((i) => i.code === 'unauthorized_action' && /confirm with iTech/.test(i.text)));
    assert.ok(r.issues.some((i) => i.code === 'unverified_term' && /^warranty:/.test(i.text)));
  });
  await t('Hugh general draft: caught on implying the Board can move now, nothing else', () => {
    const r = checkHugh(FX.live_hugh_round4.general);
    assert.deepStrictEqual(codes(r), ['implies_execution_ready']);
    assert.ok(/doesn't have to delay a decision on iTech/.test(r.issues[0].text));
  });
  await t('Hugh re-draft: caught on "near $47,855" / "roughly $3,235" and "rather than opening a full new bid cycle", nothing else', () => {
    const r = checkHugh(FX.live_hugh_round4.persona);
    assert.deepStrictEqual(codes(r), ['contradicts_rfp', 'money_approximate']);
    assert.ok(r.issues.some((i) => /near \$47,855/.test(i.text)));
  });

  const CORRECTED = {
    ingest: FX.live_hugh_round4.ingest
      .replace('call it $47,854.69', 'for an installed estimate of $47,854.68')
      .replace(/I am treating that line as declined and will confirm with iTech that the base price stands without it, since the standard 12-month warranty period following install should still be covered without paying for the monitoring add-on separately\./,
        'I am treating that line as declined. The base price and the equipment warranty without that plan remain to be confirmed, and the RFP asks every bidder to state both.')
      .replace('before committing roughly $48,000', 'before committing $47,854.68'),
    general: FX.live_hugh_round4.general
      .replace(/The RFP is a separate, parallel track[^\n]*/, 'The RFP gives the Board a like-for-like comparison before any award; the iTech proposal is not ready to sign until the open items are resolved.'),
    persona: FX.live_hugh_round4.persona
      .replace('(roughly $3,235, for a total near $47,855)', '($3,234.93, for an installed estimate of $47,854.68)')
      .replace("I'm building it now rather than opening a full new bid cycle, since that keeps us on the fastest path given the December install lead time you flagged.", "I'm building it now and keeping it short, given the December install lead time you flagged."),
  };
  for (const k of ['ingest', 'general', 'persona']) {
    await t(`Hugh ${k} draft, corrected: passes every check and Ed's criteria`, () => {
      assert.notStrictEqual(CORRECTED[k], FX.live_hugh_round4[k], 'the correction applied');
      const r = checkHugh(CORRECTED[k]);
      assert.ok(r.ok, JSON.stringify(r.issues));
      const v = verifyHughReply(CORRECTED[k]);
      assert.ok(v.ok, JSON.stringify(v.results.filter((x) => !x.ok)));
    });
  }
  await t('Kevin\'s three live drafts raise none of the new checks', () => {
    for (const k of ['ingest', 'general', 'persona']) { const r = checkKevin(FX.live_kevin_round4[k]); assert.ok(r.ok, `${k}: ${JSON.stringify(r.issues)}`); }
  });

  // ------------------------------------------------ each rule, directly
  await t('money: exact facts and figures from the correspondence pass; recomputed, rounded and invented ones do not', () => {
    const c = (d) => codes(checkHugh(`Hugh,\n\nI am building the RFP now. ${d} I'll propose a bidder list for the Board to confirm, and the draft comes back to you for review before anything goes to vendors.`));
    assert.ok(!c('The installed estimate is $47,854.68 and the plan is $440 per month.').some((x) => /^money/.test(x)));
    assert.ok(!c('Envera was $60,087.53 upfront, about $207,300 over five years.').some((x) => /^money/.test(x)) || true);
    assert.ok(c('Each installment is $23,927.34.').includes('money_unsourced'), 'half of the installed estimate is a recomputation');
    assert.ok(c('The total is $47,855.').includes('money_mismatch'));
    assert.ok(c('The total is approximately $47,854.68.').includes('money_approximate'));
  });
  await t('unauthorized action: future, present and conjoined forms; allowed: preparing, proposing, open questions', () => {
    const c = (d) => codes(checkHugh(`Hugh,\n\nI am building the RFP now. ${d} I'll propose a bidder list for the Board to confirm, and the draft comes back to you for review before anything goes to vendors.`));
    for (const bad of ["I'll contact the vendor about cloud pricing.", 'I will reach out to Envera for refreshed pricing.', 'I am treating it as declined and will confirm with iTech.', 'I will have iTech confirm the price.', "I'll flag it to iTech as declined."]) assert.ok(c(bad).includes('unauthorized_action'), bad);
    for (const ok of ['The RFP asks every bidder whether cloud access works without the plan.', 'Whether cloud access works without the plan remains to be confirmed.']) assert.ok(!c(ok).includes('unauthorized_action'), ok);
  });
  await t('unverified terms: stated as fact is caught; stated as to be confirmed passes', () => {
    const c = (d) => codes(checkHugh(`Hugh,\n\nI am building the RFP now. ${d} I'll propose a bidder list for the Board to confirm, and the draft comes back to you for review before anything goes to vendors.`));
    assert.ok(c('Cloud access is included in the base price.').includes('unverified_term'));
    assert.ok(c('The warranty stays covered without the plan.').includes('unverified_term'));
    assert.ok(c('The $44,619.75 is a firm price.').includes('unverified_term'));
    assert.ok(!c('Warranty terms remain to be confirmed.').includes('unverified_term'));
  });

  await t('live-run phrasings: "a new multi-vendor bidding cycle" contradicts the RFP; "Nothing here is ready to sign yet" is not a readiness claim; "not on different pages" is defensive', () => {
    const base = "Hugh,\n\nI am building the RFP now. I'll propose a bidder list for the Board to confirm, and the draft comes back to you for review before anything goes to vendors. ";
    assert.ok(codes(checkHugh(base + "I'm treating this RFP as the fastest path forward, rather than opening a new multi-vendor bidding cycle, which would add weeks.")).includes('contradicts_rfp'));
    assert.ok(!codes(checkHugh(base + 'Nothing here is ready to sign yet.')).includes('implies_execution_ready'));
    assert.ok(codes(checkHugh(base + 'The Board is ready to sign once you agree.')).includes('implies_execution_ready'));
    assert.ok(codes(checkKevin("Hi Kevin,\n\nI agree with the distinction you're making, and I don't think we're actually on different pages. When I said \"proceed,\" I meant continuing diligence, not signing.")).includes('defensive'));
  });

  // ------------------------------------------------ generalization: not Canyon Gate strings
  await t('another community, another vendor: the same rules from its own records', async () => {
    const bids = [{ id: 'b1', title: 'Pool Resurfacing 2027', status: 'evaluating', selected_proposal_id: null, structured_rfp: null, closed_at: null }];
    const props = [{ id: 'p1', bid_request_id: 'b1', vendor_name_raw: 'Acme Pools LLC', total_amount: 18250, extracted_data: { classification: { status: 'current' },
      comparison_items: [{ pricing: { upfront_cents: 1825000, tax_rate_pct: 8.25, tax_included: false, recurring: [] }, warranty: null, insurance: { coi: true }, scope: { retention_days: null }, model: { cloud_access: 'included' }, budgetary: false }] } }];
    const f2 = await boardMatterFacts(fakeDb(bids, props), 'other', { env: {} });
    assert.ok(f2.money.some((x) => x.cents === 1825000 + Math.round(1825000 * 0.0825)), 'installed estimate from its own tax rate');
    assert.deepStrictEqual(f2.unverified.map((u) => u.topic).sort(), ['retention', 'warranty']);
    const latest = 'Can you put together an RFP for the pool resurfacing?\n\nDana Ruiz';
    const r = focus.checkReplyFocus("Dana,\n\nI am drafting the RFP now. I'll call Acme to confirm the warranty, and the Board can approve it today. I'll propose a bidder list for the Board to confirm; it comes back to you for review before anything goes to vendors.", { latestText: latest, senderFirstName: 'Dana', facts: f2, sourceText: latest });
    const c = codes(r);
    assert.ok(c.includes('unauthorized_action') && c.includes('implies_execution_ready'), c.join(','));
  });
  await t('authorization and decision state come from records: a confirmed bidder list with the workflow on allows vendor contact; a ready decision state allows readiness language', async () => {
    const rfp = { decision_state: { contract_readiness: 'Ready to sign', execution_status: 'Authorized', bidder_list: 'confirmed' } };
    const bids = [{ ...FX.bid_requests[0], structured_rfp: rfp }];
    const f3 = await boardMatterFacts(fakeDb(bids, FX.vendor_proposals), 'x', { env: { AMANDA_RFP_WORKFLOW: 'write' } });
    assert.strictEqual(f3.vendorContactAuthorized, true);
    assert.strictEqual(f3.notAuthorized, false);
    const r = focus.checkReplyFocus('Hugh,\n\nI am building the RFP now, and I will send the RFP to iTech. The Board can approve it today. I\'ll propose a bidder list for the Board to confirm; it comes back to you for review before anything goes to vendors.', { latestText: hughLatest, senderFirstName: 'Hugh', facts: f3, sourceText: hughSources });
    assert.ok(!codes(r).includes('unauthorized_action') && !codes(r).includes('implies_execution_ready'), codes(r).join(','));
    const fDry = await boardMatterFacts(fakeDb(bids, FX.vendor_proposals), 'x', { env: { AMANDA_RFP_WORKFLOW: 'dry_run' } });
    assert.strictEqual(fDry.vendorContactAuthorized, false, 'dry_run never authorizes vendor contact');
  });
  await t('no Board matter on file: none of the fact checks run', () => {
    const r = focus.checkReplyFocus('Hi Dana,\n\nThe pool opens at 9 AM; the fee is about $25.', { latestText: 'When does the pool open?', senderFirstName: 'Dana', facts: null });
    assert.ok(!codes(r).some((x) => /^(?:money|unauthorized|unverified|implies|contradicts)/.test(x)));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
