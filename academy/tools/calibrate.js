#!/usr/bin/env node
// academy/tools/calibrate.js - human calibration of the Academy judges.
// ----------------------------------------------------------------------------
//   build:   node academy/tools/calibrate.js build <report.json> [<report.json> ...] --n 30
//            -> academy/calibration/set_v1.json      (responses + judge labels, sealed)
//            -> academy/calibration/labels_v1.json   (BLANK human labels to fill in)
//            -> academy/calibration/packet_v1.md     (blind labeling packet: case + Amanda's
//                                                      verbatim reply, NO judge verdicts)
//   score:   node academy/tools/calibrate.js score
//            -> agreement of each judge (and the merged verdict) with the human labels
//
// Labels are verdicts, never wording: pass | needs_review | fail per dimension,
// plus the critical-failure codes the human sees. The packet hides judge output
// so the human is not anchored.
// ----------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { CATALOG } = require('../lib/critical');
const DIMS = ['expertise', 'judgment', 'relationship', 'execution'];
const DIR = path.join(__dirname, '..', 'calibration');
const casesDir = path.join(__dirname, '..', 'cases');
const CASES = Object.fromEntries(fs.readdirSync(casesDir).filter((f) => f.endsWith('.json')).flatMap((f) => JSON.parse(fs.readFileSync(path.join(casesDir, f), 'utf8'))).map((c) => [c.case_id, c]));
const judgeKey = (j) => (/openai|gpt/i.test(j) ? 'gpt' : 'claude');

function build(reports, n) {
  const pool = [];
  for (const file of reports) {
    const r = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const x of r.results) for (const run of x.runs) {
      if (!run.dimensions) continue;
      const judges = {};
      for (const d of DIMS) for (const [j, v] of Object.entries(run.dimensions[d].by_judge || {})) { const k = judgeKey(j); (judges[k] = judges[k] || { model: j, dims: {}, critical: [] }).dims[d] = v.verdict; }
      for (const f of run.critical_failures || []) for (const fl of f.flags) { const k = /openai|gpt/i.test(fl.judge) ? 'gpt' : /anthropic|claude/i.test(fl.judge) ? 'claude' : null; if (k && judges[k] && !judges[k].critical.includes(f.code)) judges[k].critical.push(f.code); }
      if (!judges.claude || !judges.gpt) continue;   // calibration needs both judges
      pool.push({ source_report: path.relative(path.join(__dirname, '..', '..'), file), mode: r.mode, amanda_model: r.amanda, case_id: x.case_id, case_version: x.version, run: run.run, message: run.message, first_draft: run.guard && run.guard.first_draft ? run.guard.first_draft : null,
        judges, merged: Object.fromEntries(DIMS.map((d) => [d, run.dimensions[d].verdict])), merged_critical: (run.critical_failures || []).filter((f) => f.status === 'confirmed').map((f) => f.code) });
    }
  }
  // Spread across cases and modes: round-robin by case, alternating sources.
  const byCase = {};
  for (const p of pool) (byCase[p.case_id] = byCase[p.case_id] || []).push(p);
  const picked = [];
  let round = 0;
  while (picked.length < n && Object.values(byCase).some((l) => l.length > round)) {
    for (const id of Object.keys(byCase).sort()) { if (picked.length >= n) break; const l = byCase[id]; if (l[round]) picked.push(l[round]); }
    round++;
  }
  const items = picked.map((p, i) => ({ item_id: `CAL-${String(i + 1).padStart(3, '0')}`, ...p }));
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, 'set_v1.json'), JSON.stringify({ set_id: 'calibration_v1', created_at: new Date().toISOString(), n: items.length, items }, null, 2));
  const blank = { set_id: 'calibration_v1', labeler: null, instructions: 'For each item give pass | needs_review | fail per dimension (judge the four independently), list critical failure codes you see (codes in academy/lib/critical.js), and optional notes. Do not look at set_v1.json judge verdicts before labeling.', labels: items.map((it) => ({ item_id: it.item_id, expertise: null, judgment: null, relationship: null, execution: null, critical_failures: [], would_a_board_member_enjoy_this: null, notes: '' })) };
  fs.writeFileSync(path.join(DIR, 'labels_v1.json'), JSON.stringify(blank, null, 2));
  const P = ['# Amanda calibration packet v1 (blind)', '', `${items.length} responses. For each: read the situation, then Amanda's verbatim reply, then label in academy/calibration/labels_v1.json. Judge verdicts are deliberately hidden.`, '', 'Dimensions (independent): **expertise** (correct?), **judgment** (saw what matters, stayed inside authority, unknowns kept unknown?), **relationship** (would a board member or homeowner enjoy working with her?), **execution** (next action, owner, follow-up, no false completion?).', '', `Critical failure codes: ${Object.keys(CATALOG).join(', ')}`, ''];
  for (const it of items) {
    const c = CASES[it.case_id];
    P.push('---', '', `## ${it.item_id} (${c.audience}, ${c.channel})`, '', `**Situation:** ${c.scenario}`, '');
    if ((c.conversation_history || []).length) P.push('**History:**', ...c.conversation_history.map((h) => `> ${h.from}: ${h.text}`), '');
    P.push(`**${c.incoming_message.from} wrote:** ${c.incoming_message.text}`, '', '**Context Amanda had:**', ...c.available_context.map((f) => `- ${f.text}`), '', "**Amanda's reply (verbatim):**", '', '```text', it.message, '```', '');
  }
  fs.writeFileSync(path.join(DIR, 'packet_v1.md'), P.join('\n'));
  console.log(`built ${items.length} items from ${pool.length} candidates -> ${DIR}`);
}

function kappa(pairs) {
  const cats = ['pass', 'needs_review', 'fail'];
  const n = pairs.length; if (!n) return null;
  const po = pairs.filter(([a, b]) => a === b).length / n;
  const pe = cats.reduce((s, c) => s + (pairs.filter(([a]) => a === c).length / n) * (pairs.filter(([, b]) => b === c).length / n), 0);
  return pe === 1 ? 1 : +((po - pe) / (1 - pe)).toFixed(3);
}

function score() {
  const set = JSON.parse(fs.readFileSync(path.join(DIR, 'set_v1.json'), 'utf8'));
  const lab = JSON.parse(fs.readFileSync(path.join(DIR, 'labels_v1.json'), 'utf8'));
  const human = Object.fromEntries(lab.labels.filter((l) => DIMS.every((d) => l[d])).map((l) => [l.item_id, l]));
  const items = set.items.filter((it) => human[it.item_id]);
  if (!items.length) { console.log('no completed human labels yet; fill academy/calibration/labels_v1.json first'); return; }
  const out = { labeled: items.length, of: set.items.length, labeler: lab.labeler, dimensions: {}, critical: {}, judge_vs_judge: {} };
  for (const d of DIMS) {
    out.dimensions[d] = {};
    for (const who of ['claude', 'gpt', 'merged']) {
      const pairs = items.map((it) => [who === 'merged' ? it.merged[d] : it.judges[who].dims[d], human[it.item_id][d]]);
      const fp = pairs.filter(([j, h]) => j !== 'pass' && h === 'pass').length;   // judge flags a problem the human did not see
      const fn = pairs.filter(([j, h]) => j === 'pass' && h !== 'pass').length;   // judge passes what the human flagged
      out.dimensions[d][who] = { exact_agreement: +(pairs.filter(([a, b]) => a === b).length / pairs.length).toFixed(3), kappa: kappa(pairs), pass_vs_not_agreement: +(pairs.filter(([a, b]) => (a === 'pass') === (b === 'pass')).length / pairs.length).toFixed(3), false_positives: fp, false_negatives: fn, severe_misses: pairs.filter(([j, h]) => j === 'pass' && h === 'fail').length };
    }
    const jj = items.map((it) => [it.judges.claude.dims[d], it.judges.gpt.dims[d]]);
    out.judge_vs_judge[d] = { agreement: +(jj.filter(([a, b]) => a === b).length / jj.length).toFixed(3), kappa: kappa(jj), disagreements: items.filter((it) => it.judges.claude.dims[d] !== it.judges.gpt.dims[d]).map((it) => ({ item: it.item_id, case: it.case_id, claude: it.judges.claude.dims[d], gpt: it.judges.gpt.dims[d], human: human[it.item_id][d] })) };
  }
  for (const code of Object.keys(CATALOG)) {
    const row = {};
    for (const who of ['claude', 'gpt', 'merged']) {
      let tp = 0, fp = 0, fn = 0;
      for (const it of items) { const j = (who === 'merged' ? it.merged_critical : it.judges[who].critical).includes(code); const h = (human[it.item_id].critical_failures || []).includes(code); if (j && h) tp++; else if (j) fp++; else if (h) fn++; }
      row[who] = { true_positive: tp, false_positive: fp, false_negative: fn };
    }
    if (Object.values(row).some((v) => v.true_positive + v.false_positive + v.false_negative)) out.critical[code] = row;
  }
  const f = path.join(DIR, 'calibration_report_v1.json');
  fs.writeFileSync(f, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out.dimensions, null, 1));
  console.log('full report:', f);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'build') { const ni = rest.indexOf('--n'); const n = ni >= 0 ? parseInt(rest[ni + 1], 10) : 30; build(rest.filter((x, i) => x !== '--n' && i !== ni + 1), n); }
else if (cmd === 'score') score();
else { console.error('usage: calibrate.js build <report.json>... [--n 30] | score'); process.exit(1); }
