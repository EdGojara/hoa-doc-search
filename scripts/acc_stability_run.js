// scripts/acc_stability_run.js — the ACC DECISION-STABILITY experiment
// (Ed/ChatGPT 2026-09-19). Before any broad V2 re-batch, answer: what KIND of
// nondeterminism do we have? Same/near-identical applications sometimes landed
// APPROVE_WITH_CONDITIONS on one evaluation and ESCALATE on another. A good
// autonomous manager needs consistency, not just defensible outcomes.
//
// METHOD (deliberately tight):
//   * take a small set of representative applications (defaults to the six
//     adjudicated fixtures — they include the Harbor Glen paint + Tuck Trail
//     pool cases that flapped);
//   * gather each application's evidence ONCE and FREEZE it, so we measure
//     decision-stage nondeterminism, NOT evidence-stage nondeterminism;
//   * evaluate each app N times (default 5) on the FROZEN evidence, with
//     identical prompt / policy / models / settings (production settings,
//     repeated — nothing changed between runs);
//   * record, per run: substantive decision, item dispositions, conditions,
//     objective findings, VERIFIER decision, and final ROUTED result;
//   * report Miranda-stability and verifier-stability SEPARATELY, and classify
//     the nondeterminism (harmless generative variation vs must-fix decision
//     instability vs verifier-driven operational instability).
//
// It is out-of-band and writes NOTHING to production — only a JSON report.
//   node -r dotenv/config scripts/acc_stability_run.js --repeats 5
//   node -r dotenv/config scripts/acc_stability_run.js --repeats 3 --limit 2   # cheaper smoke
//   node -r dotenv/config scripts/acc_stability_run.js --ids <id1>,<id2>
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const { evaluateApplication } = require('../lib/ai/shadow/acc_shadow');
const { gatherEvidence } = require('../lib/ai/shadow/acc_evidence');
const { getRelevantChunks } = require('../lib/hybrid_retrieval');
const { summarizeRuns, extractRun } = require('../lib/ai/shadow/acc_stability');

const arg = (flag, def) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : def);
const REPEATS = parseInt(arg('--repeats', '5'), 10);
const LIMIT = parseInt(arg('--limit', '6'), 10);
const idsArg = arg('--ids', null);

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, '../lib/ai/tasks/acc.fixtures.json'), 'utf8')).fixtures;
const expectedById = Object.fromEntries(fixtures.map((f) => [f.source_acc_decision_id, f.expected]));
const targetIds = (idsArg ? idsArg.split(',').map((s) => s.trim()) : fixtures.map((f) => f.source_acc_decision_id)).filter(Boolean).slice(0, LIMIT);

(async () => {
  console.log(`\nACC decision-stability experiment  repeats=${REPEATS}  apps=${targetIds.length}  (frozen evidence; no writes)\n`);

  const { data: apps, error } = await supabase.from('acc_decisions')
    .select('id, community_id, community_name, homeowner_address, project_summary, application_pdf_storage_path, packet_pdf_storage_path, photo_storage_paths, decision_type, created_at')
    .in('id', targetIds);
  if (error) { console.error('load acc_decisions failed:', error.message); process.exit(1); }
  const byId = Object.fromEntries((apps || []).map((a) => [a.id, a]));

  const report = { generated_at: new Date().toISOString(), repeats: REPEATS, apps: [] };
  const rollup = {};

  for (const id of targetIds) {
    const app = byId[id];
    if (!app) { console.log(`- ${id}  MISSING from acc_decisions — skipped`); continue; }
    const label = (app.homeowner_address || app.project_summary || id).slice(0, 34);

    // freeze evidence ONCE
    let ev;
    try { ev = await gatherEvidence(app, { supabase, getRelevantChunks, anthropic }); }
    catch (e) { console.log(`- ${label}  evidence gather FAILED: ${e.message} — skipped`); continue; }
    const frozen = ev.bundle_text;
    const evidenceSources = ev.manifest.filter((m) => m.ok).map((m) => m.source).join('+');

    const recs = [];
    for (let i = 0; i < REPEATS; i++) {
      const rec = await evaluateApplication({
        applicationAndGuidelines: frozen,
        retrieval_complete: ev.manifest.some((m) => m.source === 'governing_docs' && m.ok),
        input_complete: ev.input_complete, input_evidence_manifest: ev.manifest,
        community_id: app.community_id, community_name: app.community_name,
        source_acc_decision_id: app.id, human_decision_type: app.decision_type,
      });
      recs.push(rec);
      process.stdout.write(rec.shadow_status === 'ok'
        ? `    run ${i + 1}/${REPEATS}: ${rec.primary_decision} | verifier:${rec.verifier_decision} | routed:${rec.business_decision}/${rec.reason_code || '-'}\n`
        : `    run ${i + 1}/${REPEATS}: ERROR ${rec.error}\n`);
    }

    const runs = recs.map(extractRun);
    const summary = summarizeRuns(runs, expectedById[id]);
    rollup[summary.classification] = (rollup[summary.classification] || 0) + 1;

    console.log(`- ${label}`);
    console.log(`    evidence: ${evidenceSources} (frozen, identical across runs)`);
    if (summary.n) {
      console.log(`    Miranda:  ${summary.primary.mode} ${summary.primary.mode_count}/${summary.n}  (${summary.primary.stable ? 'STABLE' : 'UNSTABLE: ' + summary.primary.distinct.join(' / ')})`);
      console.log(`    verifier: ${summary.verifier.mode} ${summary.verifier.mode_count}/${summary.n}  (${summary.verifier.stable ? 'STABLE' : 'UNSTABLE: ' + summary.verifier.distinct.join(' / ')})`);
      console.log(`    routed:   ${summary.routing.mode} ${summary.routing.mode_count}/${summary.n}  (${summary.routing.stable ? 'STABLE' : 'UNSTABLE: ' + summary.routing.distinct.join(' / ')})`);
      console.log(`    dispositions ${summary.dispositions.stable ? 'stable' : 'UNSTABLE'} | conditions ${summary.conditions.stable ? 'identical' : 'wording varies'} | objective findings ${summary.objective.stable ? 'stable' : 'VARY'}`);
      if (summary.expected_substantive_decision) console.log(`    vs adjudicated ${summary.expected_substantive_decision}: ${summary.primary_matches_expected ? 'MATCH' : 'differs'}`);
      console.log(`    => ${summary.classification}  [${summary.kind}]  ${summary.explanation}`);
      if (summary.consistent_cross_provider_disagreement) console.log('    NOTE: consistent cross-provider disagreement (both stable, always ESCALATE) — a rule-level split, not instability.');
    } else { console.log('    NO USABLE RUNS (all errored).'); }
    console.log('');

    report.apps.push({ id, label, evidence_sources: evidenceSources, runs, summary });
  }

  report.rollup = rollup;
  console.log('='.repeat(64));
  console.log('  classification roll-up:', JSON.stringify(rollup));
  console.log('='.repeat(64) + '\n');

  const outDir = process.env.CLAUDE_SCRATCH || path.join(__dirname, '..', 'tmp');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (_) {}
  const outPath = path.join(outDir, `acc_stability_${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log('full report:', outPath, '\n');
})().catch((e) => { console.error('ACC STABILITY RUN FAILED:', e.message); process.exit(1); });
