// lib/ai/tasks/acc.livecheck.js — confirm live models honor the ACC JSON contract
// and that the full structured path (parse -> deterministic checks -> severity ->
// cross-provider verifier -> structured agreement -> route) works end to end.
// Live calls (~2). Touches no production path.  node lib/ai/tasks/acc.livecheck.js
require('dotenv').config();
const path = require('path');
const acc = require('./acc');
const { callModel } = require('../model_client');
const { tier, verifierFor } = require('../tiers');
const { policyFor } = require('../policy');
const { route } = require('../decide');

(async () => {
  const theCase = require(path.join('../../../evals/cases/acc-review/case.js'));
  const t = tier(policyFor('acc.review.general').default_tier);
  const prompt = acc.buildPrompt(theCase.prompt);

  const p = await callModel({ provider: t.provider, model: t.model, price: t, system: acc.ACC_SYSTEM, prompt, maxTokens: 2600, kind: 'primary' });
  if (!p.ok) { console.log('primary error:', p.error); process.exit(1); }
  const pp = acc.parse(p.text);
  console.log('\nprimary JSON valid:', pp.ok, pp.ok ? '' : pp.error);
  if (!pp.ok) { console.log(p.text.slice(0, 400)); process.exit(1); }
  const { struct: pStruct, overrides } = acc.applyDeterministicChecks(pp.value);
  console.log('primary decision:', pStruct.decision, '| items:', (pStruct.items || []).map((i) => `${i.type}:${i.disposition}`).join(', '));
  console.log('deterministic overrides (model miscalled a number):', JSON.stringify(overrides));
  console.log('severity (action-based):', acc.severity(pStruct));

  const vcfg = verifierFor(t.provider);
  const v = await callModel({ provider: vcfg.provider, model: vcfg.model, price: vcfg, system: acc.ACC_SYSTEM + '\nIndependent reviewer from a different provider.', prompt, maxTokens: 2600, kind: 'verify' });
  const vp = v.ok ? acc.parse(v.text) : { ok: false, error: v.error };
  console.log('\nverifier JSON valid:', vp.ok, vp.ok ? '' : vp.error);
  let verifier = null, agreement = null;
  if (vp.ok) {
    const { struct: vStruct } = acc.applyDeterministicChecks(vp.value);
    console.log('verifier decision:', vStruct.decision, '| items:', (vStruct.items || []).map((i) => `${i.type}:${i.disposition}`).join(', '));
    agreement = acc.agree(pStruct, vStruct);
    console.log('structured agreement:', agreement.agree, agreement.agree ? '' : '-> ' + agreement.reasons.join('; '));
    verifier = { ran: true, ok: true, structured: { business_decision: vStruct.decision }, meta: { provider: v.provider, model: v.model } };
  } else { verifier = { ran: true, ok: false, reason: vp.error }; }

  const verdict = route({
    subclass: 'acc.review.general', task_type: 'acc', policy: policyFor('acc.review.general'),
    retrieval: { complete: true },
    primary: { ok: true, text: p.text, structured: { business_decision: pStruct.decision, basis: (pStruct.subjective_judgments && pStruct.subjective_judgments.length) ? 'subjective' : 'objective' }, gate: { worst_fail: acc.severity(pStruct) }, meta: { provider: p.provider, model: p.model } },
    verifier, action_unsafe: false,
  });
  console.log('\nROUTED:', JSON.stringify(verdict));
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
