// evals/run.js — the trustEd model eval harness.
// ---------------------------------------------------------------------------
// Runs a case against every enabled model, scores each against the case rubric,
// records cost + latency, then runs the CROSS-CHECK: a second model independently
// verifies the cheapest model's answer. The headline it produces is the one Ed
// cares about — "cheap model alone" vs "cheap model + a cross-check" coverage,
// and what that check costs. Model-agnostic: to test a new/cheaper model, add it
// to models.json and re-run. Nothing in the product changes.
//
//   node evals/run.js                         # default case, all enabled models
//   node evals/run.js --case clma-bid-analysis
//   node evals/run.js --models haiku-4-5,sonnet-5
//   node evals/run.js --no-crosscheck
// ---------------------------------------------------------------------------
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { callModel } = require('./lib/model_client');
const { costUSD, fmtUSD } = require('./lib/cost');
const { scoreOutput } = require('./lib/score');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return (v && !v.startsWith('--')) ? v : true;
}

async function main() {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'models.json'), 'utf8'));
  const caseId = arg('case', 'clma-bid-analysis');
  const theCase = require(path.join(__dirname, 'cases', caseId, 'case.js'));
  const onlyModels = arg('models', null);
  const doCrossCheck = arg('no-crosscheck', false) === false;

  let models = cfg.models.filter((m) => m.enabled);
  if (onlyModels && onlyModels !== true) {
    const want = String(onlyModels).split(',').map((s) => s.trim());
    models = cfg.models.filter((m) => want.includes(m.key));
  }
  if (!models.length) { console.error('No enabled models to run. Edit evals/models.json.'); process.exit(1); }

  console.log(`\n=== trustEd eval: ${theCase.title} (${caseId}) ===`);
  console.log(`models: ${models.map((m) => m.key).join(', ')}\n`);

  const runs = [];
  for (const m of models) {
    process.stdout.write(`running ${m.key} ...`);
    const r = await callModel({ provider: m.provider, model: m.model, system: theCase.system, prompt: theCase.prompt, maxTokens: theCase.maxTokens });
    if (r.error) { console.log(` ERROR: ${r.error}`); runs.push({ m, error: r.error }); continue; }
    const sc = scoreOutput(r.text, theCase.rubric);
    const cost = costUSD(r.usage, m);
    console.log(` score ${(sc.score * 100).toFixed(0)}%  ${fmtUSD(cost)}  ${r.latency_ms}ms`);
    runs.push({ m, out: r, score: sc, cost });
  }

  // ---- table ----
  console.log('\n' + 'MODEL'.padEnd(14) + 'SCORE'.padEnd(8) + 'COST'.padEnd(12) + 'LATENCY'.padEnd(10) + 'MISSED');
  console.log('-'.repeat(88));
  for (const run of runs) {
    if (run.error) { console.log(run.m.key.padEnd(14) + 'ERROR — ' + run.error.slice(0, 60)); continue; }
    const missed = run.score.results.filter((x) => !x.ok).map((x) => x.id).join(', ') || '(none)';
    console.log(
      run.m.key.padEnd(14) +
      ((run.score.score * 100).toFixed(0) + '%').padEnd(8) +
      fmtUSD(run.cost).padEnd(12) +
      (run.out.latency_ms + 'ms').padEnd(10) +
      missed
    );
  }

  // ---- cross-check: cheapest model's answer, verified by the cross-check model ----
  let crossReport = null;
  const ok = runs.filter((r) => !r.error);
  if (doCrossCheck && ok.length) {
    const primary = ok.slice().sort((a, b) => (a.cost || 0) - (b.cost || 0))[0]; // cheapest that ran
    const checker = cfg.models.find((m) => m.key === cfg.cross_check_model && m.enabled)
      || ok.map((r) => r.m).sort((a, b) => (b.price_in || 0) - (a.price_in || 0))[0]; // else strongest enabled
    if (checker && primary) {
      console.log(`\n--- cross-check: ${checker.key} verifying ${primary.m.key}'s answer ---`);
      const checkPrompt =
        `A colleague produced the analysis below for this task. Independently verify it against the task. ` +
        `List every concrete problem: wrong numbers (recompute them), a scope gap it missed, an insurance shortfall it missed, ` +
        `or any unsupported claim. If a specific figure is wrong, give the correct one. If it is fully correct, say "No issues found."\n\n` +
        `=== TASK ===\n${theCase.prompt}\n\n=== COLLEAGUE'S ANALYSIS ===\n${primary.out.text}`;
      // Disable thinking on the verifier so it returns its findings as text in a
      // modest budget (adaptive thinking can otherwise eat the whole cap). Haiku
      // has no thinking by default, so only send the flag for other Anthropic models.
      const noThink = (checker.provider === 'anthropic' && checker.key !== 'haiku-4-5') ? { type: 'disabled' } : undefined;
      // 2500 so a reasoning verifier (OpenAI gpt-5.x, or an Anthropic thinking
      // model) has room for reasoning tokens AND the written findings.
      const cr = await callModel({ provider: checker.provider, model: checker.model, system: 'You are a meticulous independent reviewer. Be specific and terse.', prompt: checkPrompt, maxTokens: 2500, thinking: noThink });
      if (cr.error) { console.log('cross-check ERROR:', cr.error); }
      else if (!cr.text) { console.log('cross-check returned no text (thinking may have consumed the budget).'); }
      else {
        const combinedScore = scoreOutput(primary.out.text + '\n' + cr.text, theCase.rubric);
        const crCost = costUSD(cr.usage, checker);
        console.log(cr.text.trim());
        console.log(`\ncoverage: ${primary.m.key} alone ${(primary.score.score * 100).toFixed(0)}%  ->  ${primary.m.key} + ${checker.key} cross-check ${(combinedScore.score * 100).toFixed(0)}%`);
        console.log(`cross-check cost: ${fmtUSD(crCost)}  (combined ${fmtUSD((primary.cost || 0) + (crCost || 0))} vs strongest single-model run ${fmtUSD(Math.max(...ok.map((r) => r.cost || 0)))})`);
        crossReport = { primary: primary.m.key, checker: checker.key, primary_score: primary.score.score, combined_score: combinedScore.score, cross_text: cr.text, cross_cost: crCost };
      }
    }
  }

  // ---- persist ----
  const report = {
    generated_at: new Date().toISOString(),
    case: caseId,
    runs: runs.map((r) => r.error ? { model: r.m.key, error: r.error } : {
      model: r.m.key, provider: r.m.provider, model_id: r.m.model,
      score: r.score.score, results: r.score.results, cost_usd: r.cost,
      latency_ms: r.out.latency_ms, usage: r.out.usage, output: r.out.text,
    }),
    cross_check: crossReport,
  };
  const dir = path.join(__dirname, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${caseId}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\nreport saved: ${path.relative(process.cwd(), file)}\n`);
}

main().catch((e) => { console.error('EVAL RUN FAILED:', e.message); process.exit(1); });
