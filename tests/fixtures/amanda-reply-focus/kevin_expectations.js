// Ed's acceptance criteria for Amanda's reply to Kevin Thoms on the Canyon Gate
// camera thread (2026-10-16). Shared by tests/test_amanda_reply_focus.js and
// scripts/amanda_reply_dry_run.js so the regression test and the live dry run
// grade the reply the same way. Deterministic; returns { ok, results:[{name, ok}] }.
const { GENERIC_ACKS, COMPLETION_CLAIM } = require('../../../lib/amanda/reply_focus');

const CHECKS = [
  ['greets Kevin by name, not a role label', (t) => /^\s*(?:(?:hi|hello|dear|good (?:morning|afternoon|evening)),?\s+)?Kevin\b/i.test(t) && !/^\s*(?:hi|hello|dear|good \w+),?\s+(?:treasurer|president)\b/i.test(t)],
  ['acknowledges his concern', (t) => /\b(?:agree|you'?re right|fair|understand|distinction|concern|valid|well taken|consistent with)\b/i.test(t)],
  ['is not defensive', (t) => !/\b(?:we(?:'re| are) not (?:actually |really )?(?:in )?disagree\w*|there (?:is|was) no (?:real )?disagreement|you(?: may)? (?:have )?(?:misunderstood|misread|misinterpreted))\b/i.test(t)],
  ['clarifies what "proceed" meant', (t) => /\bproceed\b/i.test(t) && /\b(?:meant|mean|intended|to clarify|did not mean|didn'?t mean|was not|wasn'?t)\b/i.test(t)],
  ['says the current proposal is not ready to sign', (t) => /\b(?:not (?:to )?(?:sign|execute|authoriz|accept)\w*|(?:no|nothing)(?:thing)? (?:is |gets |will be )?(?:signed|executed)|not ready to sign|before (?:anything|any contract|the association|it) (?:is )?(?:signed|executed)|before (?:signing|execution|we sign))\b/i.test(t)],
  ['names his protections (final binding proposal, terms, insurance)', (t) => /\bbinding\b|\bexecuted\b/i.test(t) && /\bterms\b/i.test(t) && /\binsur/i.test(t)],
  ['mentions the RFP / final diligence now underway', (t) => /\bRFP\b|request for proposals?|final scope/i.test(t) && /\b(?:now|underway|preparing|prepare|working on|doing that|am building|started)\b/i.test(t)],
  ['does not claim the matter is complete', (t) => !COMPLETION_CLAIM.test(t)],
  ['uses no generic acknowledgement language', (t) => !GENERIC_ACKS.some((re) => re.test(t))],
];

function verifyKevinReply(text) {
  const results = CHECKS.map(([name, fn]) => ({ name, ok: !!fn(String(text || '')) }));
  return { ok: results.every((r) => r.ok), results };
}

module.exports = { verifyKevinReply, CHECKS };
