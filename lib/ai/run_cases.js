// lib/ai/run_cases.js — run the standalone router end-to-end against the five
// eval cases (requirement 10). Live model calls; costs a few cents. Touches NO
// production path. Reports the routed { business_decision, execution, reason,
// notification } per case plus the usage summary.
//   node lib/ai/run_cases.js
require('dotenv').config();
const path = require('path');
const { callModel } = require('./model_client');
const { policyFor } = require('./policy');
const { tier } = require('./tiers');
const { extractStructured, runVerifier } = require('./verify');
const { verifierFor } = require('./tiers');
const { route } = require('./decide');
const { buildAuditRecord } = require('./audit');
const usage = require('./usage');
const { scoreOutput } = require('../../evals/lib/score');

// eval case -> routing subclass + task_type. Governance/ACC embed their docs in
// the prompt, so retrieval is complete for this offline exercise.
const MAP = {
  'clma-bid-analysis':            { subclass: 'vendor.bid_analysis',    task_type: 'vendor',     retrieval_complete: true },
  'bank-reconciliation':          { subclass: 'finance.reconciliation', task_type: 'finance',    retrieval_complete: true },
  'acc-review':                   { subclass: 'acc.review.general',     task_type: 'acc',        retrieval_complete: true },
  'governance-tree-requirement':  { subclass: 'governance.interpretation', task_type: 'governance', retrieval_complete: true },
  'board-packet-completeness':    { subclass: 'board.packet',           task_type: 'board',      retrieval_complete: true },
};

async function runOne(caseId) {
  const theCase = require(path.join('../../evals/cases', caseId, 'case.js'));
  const m = MAP[caseId];
  const policy = policyFor(m.subclass);
  const t = tier(policy.default_tier);

  const primaryCall = await callModel({ provider: t.provider, model: t.model, price: t, system: theCase.system, prompt: theCase.prompt, maxTokens: theCase.maxTokens, kind: 'primary' });
  let primary;
  if (!primaryCall.ok) primary = { ok: false, error: primaryCall.error, meta: { provider: primaryCall.provider, model: primaryCall.model } };
  else {
    const sc = scoreOutput(primaryCall.text, theCase.rubric);
    primary = { ok: true, text: primaryCall.text, structured: extractStructured(primaryCall.text, m.task_type), gate: { worst_fail: sc.worst_fail, score: sc.score }, meta: { provider: primaryCall.provider, model: primaryCall.model, latency_ms: primaryCall.latency_ms } };
  }

  let verifier = null;
  if (policy.verify && primary.ok) {
    const vcfg = verifierFor(t.provider);
    verifier = await runVerifier({ taskType: m.task_type, taskPrompt: theCase.prompt, primaryText: primary.text, verifierCfg: vcfg });
  }

  const retrieval = { complete: m.retrieval_complete, document_versions: ['embedded-in-case'] };
  const v = route({ subclass: m.subclass, task_type: m.task_type, policy, retrieval, primary, verifier, action_unsafe: false });
  const audit = buildAuditRecord({ community: 'eval', subclass: m.subclass, task_type: m.task_type, policy, retrieval, primary, verifier, verdict: v });
  return { caseId, subclass: m.subclass, tier: policy.default_tier, verdict: v, primaryGate: primary.ok ? primary.gate.worst_fail : 'n/a', audit };
}

(async () => {
  console.log('\n=== lib/ai router — live run against the five eval cases ===\n');
  console.log('CASE'.padEnd(30) + 'SUBCLASS'.padEnd(26) + 'BUSINESS'.padEnd(10) + 'EXEC'.padEnd(9) + 'REASON'.padEnd(24) + 'NOTIFY');
  console.log('-'.repeat(120));
  const out = [];
  for (const id of Object.keys(MAP)) {
    const r = await runOne(id);
    out.push(r);
    console.log(id.padEnd(30) + r.subclass.padEnd(26) + r.verdict.business_decision.padEnd(10) + r.verdict.execution.padEnd(9) + String(r.verdict.reason_code || '-').padEnd(24) + r.verdict.notification_level);
  }
  const s = usage.summary();
  console.log('\nusage: ' + s.calls + ' calls (' + (s.by_kind.primary ? s.by_kind.primary.calls : 0) + ' primary, ' + (s.by_kind.verify ? s.by_kind.verify.calls : 0) + ' verify), ' + s.errors + ' errors, ' + s.retries + ' retries');
  console.log('cost: ' + (s.cost_known ? '$' + s.cost_usd.toFixed(4) : '$' + s.cost_usd.toFixed(4) + ' (partial — some prices unverified)') + '   total latency ' + s.latency_ms + 'ms');
  // dump one full audit record so its richness is visible
  const acc = out.find((r) => r.caseId === 'acc-review');
  if (acc) { console.log('\n--- sample audit record (acc-review) ---'); console.log(JSON.stringify(acc.audit, null, 2)); }
})().catch((e) => { console.error('RUN FAILED:', e.message); process.exit(1); });
