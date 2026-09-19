// lib/ai/shadow/acc_shadow.selftest.js — proves the two properties Ed/ChatGPT
// required of the shadow path, offline (dependency injection, no API):
//   1) NO EXECUTION CAPABILITY — the module imports nothing that can email, send,
//      render/deliver a letter, mutate ACC status, or otherwise act.
//   2) FAILURE ISOLATION — any model/parse/exception yields shadow_status:'error'
//      and NEVER throws to the caller.
//   node lib/ai/shadow/acc_shadow.selftest.js
const fs = require('fs');
const path = require('path');
const { evaluateApplication } = require('./acc_shadow');

let failed = 0;
const assert = (n, c) => { if (!c) { failed++; console.log('  FAIL: ' + n); } else console.log('  ok:   ' + n); };

console.log('\n=== ACC shadow selftest ===');

// (1) static no-execution-capability check on the module's require() list
const src = fs.readFileSync(path.join(__dirname, 'acc_shadow.js'), 'utf8');
const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
const FORBIDDEN = /(mail|send|resend|letter|graph|notify|sms|status|deliver|supabase|outbound|email)/i;
const bad = requires.filter((r) => FORBIDDEN.test(r));
assert('imports no execution/side-effect modules (' + requires.join(', ') + ')', bad.length === 0);

// fake model callers
const primaryJSON = JSON.stringify({ decision: 'DENY', items: [{ type: 'shed', disposition: 'APPROVE', requirements: [{ rule: '7.4', rule_type: 'NUMERIC', submitted_value: '3ft', submitted_value_num: 3, threshold_num: 5, operator: '>=', complies: false }] }], variance_required: false });
const verifierJSON = JSON.stringify({ decision: 'DENY', items: [{ type: 'shed', disposition: 'DENY', requirements: [{ rule: '7.4', rule_type: 'NUMERIC', submitted_value: '3ft', submitted_value_num: 3, threshold_num: 5, operator: '>=', complies: false }] }], variance_required: false });
const okCaller = async (o) => ({ ok: true, text: o.kind === 'shadow_verify' ? verifierJSON : primaryJSON, usage: { input: 1, output: 1 }, provider: o.provider, model: o.model, latency_ms: 1 });
const errCaller = async () => ({ ok: false, error: 'provider down', provider: 'x', model: 'y', latency_ms: 1 });
const throwCaller = async () => { throw new Error('boom in caller'); };

(async () => {
  // (2a) happy path with injected callers
  const ok = await evaluateApplication({ applicationAndGuidelines: 'app+guidelines', community_name: 'Test', human_decision_type: 'denied', retrieval_complete: true }, { callModel: okCaller });
  assert('happy path -> shadow_status ok', ok.shadow_status === 'ok');
  assert('happy path -> business_decision DENY', ok.business_decision === 'DENY');
  assert('happy path -> GATE_CATASTROPHIC (shed approved over failing setback)', ok.reason_code === 'GATE_CATASTROPHIC');
  assert('happy path -> structured disagreement recorded', ok.agreement === false);
  assert('happy path -> overall_match true (both denied overall)', ok.overall_match === true);

  // manifest + evidence-completeness passthrough
  const withManifest = await evaluateApplication({ applicationAndGuidelines: 'x', community_name: 'T', human_decision_type: 'denied', retrieval_complete: true, input_complete: true, input_evidence_manifest: [{ source: 'application_pdf', ok: true }] }, { callModel: okCaller });
  assert('stores input_evidence_manifest', Array.isArray(withManifest.input_evidence_manifest) && withManifest.input_evidence_manifest.length === 1);
  assert('stores input_complete', withManifest.input_complete === true);

  // disagreement_type classification
  assert('agree with human -> disagreement_type null', withManifest.disagreement_type === null);
  const rDiff = await evaluateApplication({ applicationAndGuidelines: 'x', human_decision_type: 'approved', input_complete: true }, { callModel: okCaller });
  assert('differ w/ complete evidence + model disagreement -> RULE_INTERPRETATION', rDiff.disagreement_type === 'RULE_INTERPRETATION');
  const rEvid = await evaluateApplication({ applicationAndGuidelines: 'x', human_decision_type: 'approved', input_complete: false }, { callModel: okCaller });
  assert('differ + incomplete evidence -> EVIDENCE (not an AI error)', rEvid.disagreement_type === 'EVIDENCE');

  // (2b) provider error -> shadow_status error, no throw
  let threw = false, errRec;
  try { errRec = await evaluateApplication({ applicationAndGuidelines: 'x', human_decision_type: 'denied' }, { callModel: errCaller }); } catch (_) { threw = true; }
  assert('provider error does not throw', !threw);
  assert('provider error -> shadow_status error', errRec && errRec.shadow_status === 'error');

  // (2c) caller throwing -> caught, shadow_status error, no throw
  let threw2 = false, exRec;
  try { exRec = await evaluateApplication({ applicationAndGuidelines: 'x', human_decision_type: 'denied' }, { callModel: throwCaller }); } catch (_) { threw2 = true; }
  assert('caller exception does not throw', !threw2);
  assert('caller exception -> shadow_status error', exRec && exRec.shadow_status === 'error');

  console.log(failed ? `\nACC SHADOW SELFTEST FAILED: ${failed}\n` : '\nACC SHADOW SELFTEST PASSED: no execution capability, failures isolated.\n');
  process.exit(failed ? 1 : 0);
})();
