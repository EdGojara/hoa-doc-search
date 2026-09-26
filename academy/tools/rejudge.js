#!/usr/bin/env node
// academy/tools/rejudge.js
// ----------------------------------------------------------------------------
// Fill in a judge that failed (API error / unparseable output) on runs in an
// existing report. Amanda's saved responses are re-graded; Amanda is NOT called
// again, so the run is completed rather than restarted. Every re-judged run is
// logged in report.rejudge_log. The original file is kept as <name>.pre-rejudge.json.
//
//   node academy/tools/rejudge.js academy/reports/sample-baseline.json [anthropic:claude-sonnet-5]
// ----------------------------------------------------------------------------
require('dotenv').config({ quiet: true, path: require('path').join(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');
const { judgePrompt, parseJudge, mergeJudges, RUBRIC } = require('../lib/rubric');
const { runDetectors } = require('../lib/critical');
const { callModel } = require('../../lib/ai/model_client');

const { directoryBlock, liveHumans, liveOwnership } = require('../team/directory');
const { capabilityBlock } = require('../team/capabilities');

// Amanda cases and team cases (team files wrap their cases in { cases: [...] }).
const CASES = {};
for (const [dir, team] of [[path.join(__dirname, '..', 'cases'), false], [path.join(__dirname, '..', 'team', 'cases'), true]]) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const c of (Array.isArray(raw) ? raw : raw.cases || [raw])) CASES[c.case_id] = { ...c, _team: team };
  }
}

// Rebuild a judge's full result object from what the merged run stored.
function storedResult(run, judge) {
  const r = { critical_failures: [] };
  for (const d of Object.keys(RUBRIC)) {
    const v = run.dimensions[d].by_judge[judge];
    if (!v) return null;
    r[d] = { verdict: v.verdict, explanation: v.explanation, evidence: v.evidence, expected: v.expected };
  }
  for (const f of run.critical_failures || []) for (const fl of f.flags) if (fl.judge === judge) r.critical_failures.push({ code: f.code, evidence: fl.evidence, why: fl.why });
  return r;
}

async function main() {
  const file = process.argv[2];
  const want = process.argv[3] || 'anthropic:claude-sonnet-5';
  const [provider, model] = want.split(':');
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  const backup = file.replace(/\.json$/, '.pre-rejudge.json');
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, JSON.stringify(report, null, 2));
  report.rejudge_log = report.rejudge_log || [];
  const allJudges = report.judges;
  // v1.2 reports: judges must get the same organizational context the agent had.
  let team = null;
  if (report.candidate_version) {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    team = { humans: await liveHumans({ supabase }), ownership: await liveOwnership(supabase) };
  }
  for (const x of report.results) {
    const c = CASES[x.case_id];
    for (const run of x.runs) {
      if (!run.dimensions || run.dimensions.expertise.by_judge[want]) continue;
      let result = null, error = null;
      for (let attempt = 1; attempt <= 2 && !result; attempt++) {
        const agent = c.agent || 'amanda';
        const extras = team ? { orgContext: directoryBlock(agent, team) + '\n\n' + capabilityBlock(agent), commitments: run.commitments || [], handoff: run.handoff || null } : {};
        const jr = await callModel({ provider, model, system: 'You are a strict, fair evaluator. Output only JSON.', prompt: judgePrompt(c, { message: run.message, internal: run.internal }, extras), maxTokens: 10000, kind: 'judge' });
        if (!jr.ok) { error = jr.error; continue; }
        try { result = parseJudge(jr.text); } catch (e) { error = 'unparseable judge output: ' + e.message; }
      }
      const judgments = allJudges.filter((j) => j !== want).map((j) => ({ judge: j, result: storedResult(run, j) })).filter((j) => j.result);
      if (result) judgments.push({ judge: want, result });
      const merged = mergeJudges(judgments);
      const det = runDetectors(c, run.message);
      for (const d of det.critical) {
        const hit = merged.critical_failures.find((f) => f.code === d.code);
        if (hit) { hit.flags.push({ judge: d.source, evidence: d.evidence, why: d.note }); if (hit.status === 'disputed') hit.status = 'confirmed'; }
        else merged.critical_failures.push({ code: d.code, label: d.code, status: 'detector_only', flags: [{ judge: d.source, evidence: d.evidence, why: d.note }] });
      }
      // keep the action guard's surviving violations, as run.js merged them
      for (const v of (run.guard && run.guard.final_violations) || []) {
        const hit = merged.critical_failures.find((f) => f.code === v.code);
        if (hit) { hit.flags.push({ judge: 'action_guard', evidence: v.sentence, why: v.detail }); if (hit.status === 'disputed') hit.status = 'confirmed'; }
        else merged.critical_failures.push({ code: v.code, label: v.code, status: 'detector_only', flags: [{ judge: 'action_guard', evidence: v.sentence, why: v.detail }] });
      }
      const before = Object.fromEntries(Object.entries(run.dimensions).map(([d, v]) => [d, v.verdict]));
      Object.assign(run, merged, { judge_errors: result ? [] : [{ judge: want, error }] });
      const after = Object.fromEntries(Object.entries(run.dimensions).map(([d, v]) => [d, v.verdict]));
      report.rejudge_log.push({ at: new Date().toISOString(), case_id: x.case_id, run: run.run, judge: want, ok: !!result, error: result ? null : error, before, after });
      console.log(`${x.case_id} run ${run.run}: ${result ? 'rejudged' : 'STILL FAILED: ' + error} ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    }
    const ok = x.runs.filter((r) => r.dimensions);
    x.consistency = Object.fromEntries(Object.keys(RUBRIC).map((d) => { const vs = ok.map((r) => r.dimensions[d].verdict); return [d, { verdicts: vs, consistent: vs.every((v) => v === vs[0]) }]; }));
  }
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log('updated', path.resolve(file), '| backup', path.resolve(backup));
}

main().catch((e) => { console.error('FAILED', e.stack || e.message); process.exit(1); });
