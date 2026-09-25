#!/usr/bin/env node
// academy/run.js - Amanda Academy sandbox harness.
// ----------------------------------------------------------------------------
// Runs Academy cases against Amanda (her LIVE production system prompt, read
// from source, never modified) and grades each response on four independent
// dimensions with two judges from different providers. Critical failures are
// flagged separately. Nothing is written to the database; nothing is sent.
//
//   node academy/run.js --validate                      validate all cases, no API calls
//   node academy/run.js --dry --cases AA-REL-007        print exactly what Amanda would receive
//   node academy/run.js --cases AA-REL-006,AA-TEC-004 --runs 2
//   node academy/run.js --all --mode contract
//
// Options:
//   --mode baseline|contract   baseline = live prompt, message only (default)
//                              contract = live prompt + internal response contract
//   --amanda anthropic:claude-sonnet-4-5   Amanda's model (default = production's)
//   --judges anthropic:claude-sonnet-5,openai:gpt-5.6-terra
//   --runs N                   repeat Amanda N times per case (consistency)
//   --out path                 report path (default academy/reports/<stamp>.json)
// ----------------------------------------------------------------------------
require('dotenv').config({ quiet: true, path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { validateCase } = require('./lib/case_schema');
const { buildRequest, parseResponse, contextText } = require('./lib/amanda_under_test');
const { guard, revisionRequest } = require('./lib/action_guard');
const { judgePrompt, parseJudge, mergeJudges, RUBRIC } = require('./lib/rubric');
const { runDetectors } = require('./lib/critical');
const { loadLivePrompts } = require('./lib/live_prompt');

const PRICES = {
  'claude-sonnet-4-5': { price_in: 3, price_out: 15 }, 'claude-sonnet-5': { price_in: 2, price_out: 10 },
  'claude-opus-5': { price_in: 5, price_out: 25 }, 'claude-haiku-4-5': { price_in: 1, price_out: 5 },
  'gpt-5.6-terra': { price_in: 2, price_out: 12 }, 'gpt-6-astra': { price_in: 10, price_out: 50 },
};

function args() {
  const a = process.argv.slice(2); const o = { mode: 'baseline', runs: 1, amanda: 'anthropic:claude-sonnet-4-5', judges: 'anthropic:claude-sonnet-5,openai:gpt-5.6-terra' };
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    if (k === '--validate' || k === '--dry' || k === '--all') o[k.slice(2)] = true;
    else if (k.startsWith('--')) o[k.slice(2)] = a[++i];
  }
  o.runs = Math.max(1, parseInt(o.runs, 10) || 1);
  return o;
}
const spec = (s) => { const [provider, model] = s.split(':'); return { provider, model, price: PRICES[model] }; };

function loadCases() {
  const dir = path.join(__dirname, 'cases');
  const all = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const arr = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const c of (Array.isArray(arr) ? arr : [arr])) all.push({ ...c, _file: f });
  }
  return all;
}

async function main() {
  const o = args();
  const cases = loadCases();
  const ids = new Set();
  let bad = 0;
  for (const c of cases) {
    const errs = validateCase(c);
    if (ids.has(c.case_id)) errs.push('duplicate case_id');
    ids.add(c.case_id);
    if (errs.length) { bad++; console.error(`INVALID ${c.case_id || '(no id)'} [${c._file}]: ${errs.join('; ')}`); }
  }
  const live = loadLivePrompts();
  console.log(`cases: ${cases.length} (${bad} invalid) | live Amanda prompt fingerprint ${live.fingerprint}`);
  if (bad) process.exit(1);
  if (o.validate) return;

  let selected = cases.filter((c) => c.status === 'active');
  if (o.cases) { const want = new Set(o.cases.split(',')); selected = cases.filter((c) => want.has(c.case_id)); }
  else if (!o.all) { console.error('choose --cases ID,ID or --all'); process.exit(1); }

  if (o.dry) {
    for (const c of selected) {
      const r = buildRequest(c, { mode: o.mode });
      console.log(`\n===== ${c.case_id} (${o.mode}) SYSTEM (${r.system.length} chars) =====\n${r.system.slice(0, 600)}\n...\n===== USER =====\n${r.prompt}`);
    }
    return;
  }

  const { callModel } = require('../lib/ai/model_client');
  const usage = require('../lib/ai/usage');
  const amanda = spec(o.amanda);
  const judges = o.judges.split(',').map(spec);
  const report = { harness: 'amanda-academy v1', at: new Date().toISOString(), mode: o.mode, amanda: o.amanda, judges: o.judges.split(','), runs: o.runs, live_prompt_fingerprint: live.fingerprint, results: [] };

  for (const c of selected) {
    const req = buildRequest(c, { mode: o.mode });
    const runs = [];
    for (let n = 1; n <= o.runs; n++) {
      const a = await callModel({ ...amanda, system: req.system, prompt: req.prompt, maxTokens: o.mode === 'contract' ? 2600 : 1400, kind: 'amanda' });
      if (!a.ok) { runs.push({ run: n, error: a.error }); console.error(`${c.case_id} run ${n}: Amanda call failed: ${a.error}`); continue; }
      const resp = parseResponse(a.text, o.mode === 'candidate' ? 'baseline' : o.mode);
      // v1.1 candidate: machine-checkable integrity guard; ONE revision if it fires.
      let guardInfo = null;
      if (o.mode === 'candidate') {
        const ctx = contextText(c);
        const first = guard({ message: resp.message, actionLog: c.action_log || [], contextText: ctx });
        guardInfo = { intent: req.intent, first_violations: first, revised: false };
        if (first.length) {
          const rv = await callModel({ ...amanda, system: req.system, prompt: `${req.prompt}\n\nYOUR DRAFT:\n${resp.message}\n\n${revisionRequest(first)}`, maxTokens: 1400, kind: 'amanda_revision' });
          if (rv.ok) { guardInfo.first_draft = resp.message; resp.message = rv.text.trim(); guardInfo.revised = true; }
          else guardInfo.revision_error = rv.error;
          guardInfo.final_violations = guard({ message: resp.message, actionLog: c.action_log || [], contextText: ctx });
        } else guardInfo.final_violations = [];
      }
      const detectors = runDetectors(c, resp.message);
      const judgments = [];
      for (const j of judges) {
        const jr = await callModel({ ...j, system: 'You are a strict, fair evaluator. Output only JSON.', prompt: judgePrompt(c, resp), maxTokens: 6000, kind: 'judge' });
        if (!jr.ok) { judgments.push({ judge: `${j.provider}:${j.model}`, error: jr.error }); continue; }
        try { judgments.push({ judge: `${j.provider}:${j.model}`, result: parseJudge(jr.text) }); }
        catch (e) { judgments.push({ judge: `${j.provider}:${j.model}`, error: 'unparseable judge output: ' + e.message }); }
      }
      const merged = mergeJudges(judgments);
      for (const d of detectors.critical) {
        const hit = merged.critical_failures.find((f) => f.code === d.code);
        if (hit) { hit.flags.push({ judge: d.source, evidence: d.evidence, why: d.note }); if (hit.status === 'disputed') hit.status = 'confirmed'; }
        else merged.critical_failures.push({ code: d.code, label: d.code, status: 'detector_only', flags: [{ judge: d.source, evidence: d.evidence, why: d.note }] });
      }
      // merged.judges lists the judges that succeeded; failures are kept separately
      // (a bug here once overwrote them, hiding single-judge verdicts).
      for (const v of (guardInfo && guardInfo.final_violations) || []) {
        const hit = merged.critical_failures.find((f) => f.code === v.code);
        if (hit) { hit.flags.push({ judge: 'action_guard', evidence: v.sentence, why: v.detail }); if (hit.status === 'disputed') hit.status = 'confirmed'; }
        else merged.critical_failures.push({ code: v.code, label: v.code, status: 'detector_only', flags: [{ judge: 'action_guard', evidence: v.sentence, why: v.detail }] });
      }
      runs.push({ run: n, message: resp.message, internal: resp.internal, contract_ok: resp.contract_ok, detectors, guard: guardInfo, ...merged, judge_errors: judgments.filter((x) => x.error).map((x) => ({ judge: x.judge, error: x.error })) });
      const v = Object.fromEntries(Object.entries(merged.dimensions).map(([d, x]) => [d, x.verdict + (x.agreement === 'disagree' ? '*' : '')]));
      console.log(`${c.case_id} run ${n}: ${JSON.stringify(v)} critical=${merged.critical_failures.map((f) => f.code + ':' + f.status).join(',') || 'none'}`);
    }
    const ok = runs.filter((r) => r.dimensions);
    const consistency = Object.fromEntries(Object.keys(RUBRIC).map((d) => {
      const vs = ok.map((r) => r.dimensions[d].verdict);
      return [d, { verdicts: vs, consistent: vs.length <= 1 || vs.every((x) => x === vs[0]) }];
    }));
    report.results.push({ case_id: c.case_id, version: c.version, title: c.title, audience: c.audience, domain: c.domain, runs, consistency });
  }
  report.usage = usage.summary();
  const out = o.out || path.join(__dirname, 'reports', `${report.at.replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  fs.writeFileSync(out.replace(/\.json$/, '.md'), summarize(report));
  console.log(`\nreport: ${out}\ncost: ${JSON.stringify(report.usage)}`);
}

function summarize(r) {
  const dims = Object.keys(RUBRIC);
  const lines = [`# Amanda Academy run ${r.at}`, '', `Mode ${r.mode} | Amanda ${r.amanda} | judges ${r.judges.join(', ')} | runs ${r.runs} | live prompt ${r.live_prompt_fingerprint}`, '', `| Case | ${dims.join(' | ')} | Critical failures |`, `|---|${dims.map(() => '---').join('|')}|---|`];
  for (const x of r.results) {
    const run = x.runs.find((y) => y.dimensions);
    if (!run) { lines.push(`| ${x.case_id} | ${dims.map(() => 'error').join(' | ')} | |`); continue; }
    const cells = dims.map((d) => { const v = run.dimensions[d]; const cons = x.consistency[d].consistent ? '' : ' (inconsistent across runs)'; return `${v.verdict}${v.agreement === 'disagree' ? ' (judges split)' : ''}${cons}`; });
    lines.push(`| ${x.case_id} ${x.title} | ${cells.join(' | ')} | ${run.critical_failures.map((f) => `${f.code} (${f.status})`).join('; ') || 'none'} |`);
  }
  lines.push('', '* needs_review can come from a judge verdict or from judges disagreeing. Verdicts are never averaged.');
  return lines.join('\n');
}

main().catch((e) => { console.error('FAILED', e.stack || e.message); process.exit(1); });
