#!/usr/bin/env node
// academy/tools/calibration_rejudge.js - re-grade calibration replies with
// TODAY's judge rubric, reusing the exact saved replies (the agent is never
// called again), so judge agreement can be compared apples to apples.
//
//   node academy/tools/calibration_rejudge.js --items older|all --tag <name>
//     older = items whose source report predates the v1.2 rules (baseline, v1.1)
//   -> academy/calibration/rejudged_<tag>.json  { item_id: { judges: {claude, gpt} } }
//   node academy/tools/calibrate.js score2 academy/calibration/labels_v2_raw --judges rejudged_<tag>.json
//
// Judges get today's context: Bedrock rules, the team directory, the agent's
// capability registry, the community's governance bodies, and the ownership
// decision when the agent itself had one (v1.3 runs).
require('dotenv').config({ quiet: true, path: require('path').join(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');
const { judgePrompt, parseJudge, RUBRIC } = require('../lib/rubric');
const { directoryBlock, liveHumans, liveOwnership } = require('../team/directory');
const { capabilityBlock } = require('../team/capabilities');
const { governanceBlock } = require('../team/governance');
const { ownerBlock } = require('../team/owner_classifier');
const { NAMES } = require('../team/agent_under_test');
const { callModel } = require('../../lib/ai/model_client');
const usage = require('../../lib/ai/usage');

const ROOT = path.join(__dirname, '..');
const DIMS = Object.keys(RUBRIC);
const JUDGES = [{ provider: 'anthropic', model: 'claude-sonnet-5', key: 'claude' }, { provider: 'openai', model: 'gpt-5.6-terra', key: 'gpt' }];
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };

function loadCases() {
  const out = {};
  for (const f of fs.readdirSync(path.join(ROOT, 'cases')).filter((x) => x.endsWith('.json'))) { const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'cases', f), 'utf8')); for (const c of (raw.cases || raw)) out[c.case_id] = c; }
  for (const f of fs.readdirSync(path.join(ROOT, 'team', 'cases')).filter((x) => x.endsWith('.json'))) for (const c of JSON.parse(fs.readFileSync(path.join(ROOT, 'team', 'cases', f), 'utf8')).cases) out[c.case_id] = { ...c, _team: true };
  return out;
}

async function main() {
  const which = arg('--items', 'older');
  const tag = arg('--tag', which);
  const set = JSON.parse(fs.readFileSync(path.join(ROOT, 'calibration', 'set_v2.json'), 'utf8'));
  const cases = loadCases();
  const items = set.items.filter((it) => which === 'all' || !/v1_2|v1_3/.test(it.source));
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const team = { humans: await liveHumans({ supabase }), ownership: await liveOwnership(supabase) };
  const outFile = path.join(ROOT, 'calibration', `rejudged_${tag}.json`);
  const out = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : {};   // resumable
  for (const it of items) {
    if (out[it.item_id] && out[it.item_id].judges.claude && out[it.item_id].judges.gpt) continue;
    const c = cases[it.case_id];
    const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports', `sample-${it.source}.json`), 'utf8'));
    const run = report.results.find((r) => r.case_id === it.case_id).runs.find((r) => r.run === it.run);
    if (run.message !== it.blind.reply) throw new Error(`${it.item_id}: saved reply does not match the calibration reply`);   // same text, always
    const agent = c.agent || 'amanda';
    const owner = run.guard && run.guard.owner;
    const orgContext = directoryBlock(agent, team) + '\n\n' + capabilityBlock(agent) + '\n\n' + governanceBlock(c.community_context || {}) + (owner ? '\n\n' + ownerBlock(owner, { names: NAMES() }) : '');
    const prompt = judgePrompt(c, { message: run.message, internal: run.internal }, { orgContext, commitments: run.commitments || [], handoff: run.handoff || null });
    const judges = {};
    for (const j of JUDGES) {
      for (let attempt = 1; attempt <= 2 && !judges[j.key]; attempt++) {
        const r = await callModel({ provider: j.provider, model: j.model, system: 'You are a strict, fair evaluator. Output only JSON.', prompt, maxTokens: 10000, kind: 'judge' });
        if (!r.ok) continue;
        try {
          const p = parseJudge(r.text);
          judges[j.key] = { model: `${j.provider}:${j.model}`, dims: Object.fromEntries(DIMS.map((d) => [d, p[d].verdict])), critical: [...new Set(p.critical_failures.map((f) => f.code))], explanations: Object.fromEntries(DIMS.map((d) => [d, p[d].explanation])) };
        } catch (_) { /* retry once */ }
      }
    }
    out[it.item_id] = { case_id: it.case_id, source: it.source, judged_at: new Date().toISOString(), judges };
    fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
    const f = (x) => ({ pass: 'P', needs_review: 'R', fail: 'F' }[x] || '-');
    console.log(`${it.item_id} ${it.source}: claude ${DIMS.map((d) => f(judges.claude && judges.claude.dims[d])).join('')} gpt ${DIMS.map((d) => f(judges.gpt && judges.gpt.dims[d])).join('')}`);
  }
  console.log(`written ${outFile}\ncost: ${JSON.stringify(usage.summary())}`);
}
main().catch((e) => { console.error('FAILED', e.stack || e.message); process.exit(1); });
