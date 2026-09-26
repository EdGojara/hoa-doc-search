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
const { teamRequest, parseAgentOutput, teamContextText, validateTeamCase } = require('./team/agent_under_test');
const { checkRouting, validateHandoff } = require('./team/routing_checks');
const { directoryBlock, liveHumans, liveOwnership, rolesNeedingEd } = require('./team/directory');
const { capabilityBlock } = require('./team/capabilities');
const { gateProblems, asViolations, release } = require('./team/release_gate');
const { bodiesFor, governanceBlock } = require('./team/governance');
const { ownerBlock } = require('./team/owner_classifier');
const { NAMES } = require('./team/agent_under_test');

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
  const all = [];
  for (const [dir, team] of [[path.join(__dirname, 'cases'), false], [path.join(__dirname, 'team', 'cases'), true]]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const arr = Array.isArray(raw) ? raw : raw.cases ? raw.cases : [raw];
      for (const c of arr) all.push({ ...c, _file: f, _team: team });
    }
  }
  return all;
}

// Live team context (v1.2): active humans + recorded roles + current ownership.
// Loaded once per run; a failure stops the run rather than silently teaching an
// empty team.
async function loadTeamContext() {
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const humans = await liveHumans({ supabase });
  const ownership = await liveOwnership(supabase);
  return { humans, ownership };
}

async function main() {
  const o = args();
  const cases = loadCases();
  const ids = new Set();
  let bad = 0;
  for (const c of cases) {
    const errs = c._team ? validateTeamCase(c) : validateCase(c);
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
      const r = c._team ? teamRequest(c, { team: {} }) : buildRequest(c, { mode: o.mode });
      console.log(`\n===== ${c.case_id} (${o.mode}) SYSTEM (${r.system.length} chars) =====\n${r.system.slice(0, 600)}\n...\n===== USER =====\n${r.prompt}`);
    }
    return;
  }

  const { callModel } = require('../lib/ai/model_client');
  const usage = require('../lib/ai/usage');
  const amanda = spec(o.amanda);
  const judges = o.judges.split(',').map(spec);
  const needTeam = o.mode === 'candidate' || selected.some((c) => c._team);
  const team = needTeam ? await loadTeamContext() : {};
  const report = { harness: 'amanda-academy v1.3', candidate_version: needTeam ? 'v1.3' : null, at: new Date().toISOString(), mode: o.mode, amanda: o.amanda, judges: o.judges.split(','), runs: o.runs, live_prompt_fingerprint: live.fingerprint,
    // counts only: no staff names in reports (the repo is public)
    team_context: needTeam ? { active_humans: team.humans.length, humans_without_recorded_role: rolesNeedingEd(team.humans).length, open_items: Object.values(team.ownership).reduce((a, v) => a + v.length, 0) } : null,
    results: [] };

  // Checkpoint after every case so a stopped run (machine off, sleep) resumes
  // where it left off instead of losing finished, paid-for cases.
  const out = o.out || path.join(__dirname, 'reports', `${report.at.replace(/[:.]/g, '-')}.json`);
  const partial = out.replace(/\.json$/, '.partial.json');
  if (fs.existsSync(partial)) {
    const prev = JSON.parse(fs.readFileSync(partial, 'utf8'));
    const want = new Set(selected.map((c) => c.case_id));
    report.results = prev.results.filter((r) => want.has(r.case_id) && r.runs.length === o.runs && r.runs.every((x) => x.dimensions));
    report.at = prev.at; report.resumed = true;
    const done = new Set(report.results.map((r) => r.case_id));
    selected = selected.filter((c) => !done.has(c.case_id));
    console.log(`resuming from checkpoint: ${done.size} case(s) already done, ${selected.length} to go`);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });

  for (const c of selected) {
    const agent = c.agent || 'amanda';
    const layered = c._team || o.mode === 'candidate';   // v1.2 team layers + guard
    const req = c._team ? teamRequest(c, { team }) : buildRequest(c, { mode: o.mode, team });
    const ctx = c._team ? teamContextText(c) : contextText(c);
    const owner = req.owner || null;   // step 1 of the flow: decided before drafting
    const bodies = bodiesFor(c.community_context || {});
    // judges get the same context the agent had, including the ownership decision
    const orgContext = layered ? directoryBlock(agent, team) + '\n\n' + capabilityBlock(agent) + '\n\n' + governanceBlock(c.community_context || {}) + (owner ? '\n\n' + ownerBlock(owner, { names: NAMES() }) : '') : null;
    const runs = [];
    for (let n = 1; n <= o.runs; n++) {
      const a = await callModel({ ...amanda, system: req.system, prompt: req.prompt, maxTokens: o.mode === 'contract' ? 2600 : layered ? 2000 : 1400, kind: 'amanda' });
      if (!a.ok) { runs.push({ run: n, error: a.error }); console.error(`${c.case_id} run ${n}: agent call failed: ${a.error}`); continue; }
      let resp; let out = { commitments: [], handoff: null, parse_errors: [] };
      if (layered) { out = parseAgentOutput(a.text); resp = { message: out.message, internal: null, contract_ok: null }; }
      else resp = parseResponse(a.text, o.mode);
      // Integrity + capability guard; ONE natural revision if it fires.
      let guardInfo = null;
      if (layered) {
        const g = (m, cm) => guard({ message: m, actionLog: c.action_log || [], contextText: ctx, agent, commitments: cm, governanceBodies: bodies });
        const first = g(resp.message, out.commitments);
        // release gate: a required handoff needs a valid package before release
        const gateFirst = gateProblems(owner, out.handoff);
        guardInfo = { intent: req.intent, owner, prompt_source: req.prompt_source || 'amanda v1.3 candidate', first_violations: first, gate_first: gateFirst, revised: false };
        const toFix = [...first, ...asViolations(gateFirst, owner || {})];
        if (toFix.length) {
          const rv = await callModel({ ...amanda, system: req.system, prompt: `${req.prompt}\n\nYOUR DRAFT:\n${a.text}\n\n${revisionRequest(toFix)}`, maxTokens: 2000, kind: 'amanda_revision' });
          if (rv.ok) {
            guardInfo.first_draft = resp.message; guardInfo.first_commitments = out.commitments;
            const r2 = parseAgentOutput(rv.text);
            out = { commitments: r2.commitments, handoff: r2.handoff || out.handoff, parse_errors: [...out.parse_errors, ...r2.parse_errors] };
            resp.message = r2.message; guardInfo.revised = true;
          } else guardInfo.revision_error = rv.error;
          guardInfo.final_violations = g(resp.message, out.commitments);
        } else guardInfo.final_violations = [];
        guardInfo.capability_first = first.filter((v) => v.rule === 'CAPABILITY');
        guardInfo.capability_final = guardInfo.final_violations.filter((v) => v.rule === 'CAPABILITY');
        guardInfo.release = release(owner, out.handoff);   // held = never sent
      }
      let routing = null;
      if (c._team) {
        routing = {
          violations: checkRouting({ response: resp.message, expected: c.expected_routing, sharedWork: c.shared_work_context || [], handoff: out.handoff }),
          classifier: { owner_class: owner && owner.owner_class, owner: owner && owner.owner, expected_owner: c.expected_routing.owner },
          handoff_present: !!out.handoff,
          handoff_problems: c.expected_handoff ? validateHandoff(out.handoff, c.expected_handoff) : [],
        };
      }
      const detectors = runDetectors(c, resp.message);
      const judgments = [];
      for (const j of judges) {
        const jr = await callModel({ ...j, system: 'You are a strict, fair evaluator. Output only JSON.', prompt: judgePrompt(c, resp, layered ? { orgContext, commitments: out.commitments, handoff: out.handoff } : {}), maxTokens: 6000, kind: 'judge' });
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
      runs.push({ run: n, message: resp.message, internal: resp.internal, contract_ok: resp.contract_ok, commitments: out.commitments, handoff: out.handoff, output_parse_errors: out.parse_errors, routing, detectors, guard: guardInfo, ...merged, judge_errors: judgments.filter((x) => x.error).map((x) => ({ judge: x.judge, error: x.error })) });
      const v = Object.fromEntries(Object.entries(merged.dimensions).map(([d, x]) => [d, x.verdict + (x.agreement === 'disagree' ? '*' : '')]));
      console.log(`${c.case_id} run ${n}: ${JSON.stringify(v)} critical=${merged.critical_failures.map((f) => f.code + ':' + f.status).join(',') || 'none'}${guardInfo ? ` owner=${owner ? owner.owner_class + ':' + owner.owner : '-'} release=${guardInfo.release.status} capability=${guardInfo.capability_first.length}->${guardInfo.capability_final.length}` : ''}${routing ? ` routing=${routing.violations.map((x) => x.code).concat(routing.handoff_problems.map((x) => x.code)).join(',') || 'ok'}` : ''}`);
    }
    const ok = runs.filter((r) => r.dimensions);
    const consistency = Object.fromEntries(Object.keys(RUBRIC).map((d) => {
      const vs = ok.map((r) => r.dimensions[d].verdict);
      return [d, { verdicts: vs, consistent: vs.length <= 1 || vs.every((x) => x === vs[0]) }];
    }));
    report.results.push({ case_id: c.case_id, version: c.version, title: c.title, agent, suite: c._team ? 'team_routing' : 'amanda', audience: c.audience, domain: c.domain, runs, consistency });
    fs.writeFileSync(partial, JSON.stringify(report, null, 2));
  }
  report.usage = usage.summary();
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  if (fs.existsSync(partial)) fs.unlinkSync(partial);
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
