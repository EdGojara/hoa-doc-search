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

// ---- v2 (Ed 2026-09-26): 30 blind responses across versions and both suites ----
// One reply per case, rotating sources (baseline, v1.1, v1.2, v1.3) so the set
// spans good and bad work, preferring runs where the two judges split (the
// informative ones). The BLIND file carries only what the agent had and what it
// sent: no case id, title, scenario, answer key, version, ownership decision, or
// judge output. The sealed set_v2.json keeps judge labels for scoring.
const TEAMDIR = path.join(__dirname, '..', 'team', 'cases');
const TEAMCASES = fs.existsSync(TEAMDIR) ? Object.fromEntries(fs.readdirSync(TEAMDIR).filter((f) => f.endsWith('.json')).flatMap((f) => JSON.parse(fs.readFileSync(path.join(TEAMDIR, f), 'utf8')).cases || []).map((c) => [c.case_id, c])) : {};
const AGENT_NAMES = { amanda: 'Amanda (Senior Community Manager)', claire: 'Claire (front office)', paige: 'Paige (Board Operations)', phoebe: 'Phoebe (Community Engagement)' };

function judgesOf(run) {
  const judges = {};
  for (const d of DIMS) for (const [j, v] of Object.entries(run.dimensions[d].by_judge || {})) { const k = judgeKey(j); (judges[k] = judges[k] || { model: j, dims: {}, critical: [] }).dims[d] = v.verdict; }
  for (const f of run.critical_failures || []) for (const fl of f.flags) { const k = /openai|gpt/i.test(fl.judge) ? 'gpt' : /anthropic|claude/i.test(fl.judge) ? 'claude' : null; if (k && judges[k] && !judges[k].critical.includes(f.code)) judges[k].critical.push(f.code); }
  return judges;
}

function blindView(c, run) {
  const who = c.incoming_message.from;
  const role = ((c.people || []).find((p) => p.name === who) || {}).role || (who === 'system' ? 'internal task' : c.audience);
  return {
    agent: AGENT_NAMES[c.agent || 'amanda'], audience: c.audience, channel: c.channel,
    from: who, from_role: role, message: c.incoming_message.text,
    history: (c.conversation_history || []).map((h) => ({ from: h.from, text: h.text })),
    context: (c.available_context || []).map((x) => ({ text: x.text, source: x.source })),
    team_record: (c.shared_work_context || []).map((w) => ({ what: w.what, at: w.at, status: w.status, ref: w.ref })),
    actions_on_record: (c.action_log || []).map((a) => ({ at: a.at, what: a.what })),
    governance_bodies: ((c.community_context || {}).governance_bodies || []).map((b) => ({ name: b.name, scope: b.scope, source: b.source })),
    reply: run.message,
    handoff_package: run.handoff || null,
    commitments: run.commitments && run.commitments.length ? run.commitments : null,
  };
}

function build2(reportFiles, n) {
  const byCase = {};
  for (const file of reportFiles) {
    const r = JSON.parse(fs.readFileSync(file, 'utf8'));
    const label = path.basename(file).replace(/^sample-|\.json$/g, '');
    for (const x of r.results) for (const run of x.runs) {
      if (!run.dimensions) continue;
      const judges = judgesOf(run);
      if (!judges.claude || !judges.gpt) continue;
      const splits = DIMS.filter((d) => judges.claude.dims[d] !== judges.gpt.dims[d]).length;
      (byCase[x.case_id] = byCase[x.case_id] || []).push({ source: label, case_id: x.case_id, run: run.run, splits, run_obj: run, judges });
    }
  }
  const ids = Object.keys(byCase).filter((id) => CASES[id] || TEAMCASES[id]).sort();
  const sources = [...new Set(Object.values(byCase).flat().map((p) => p.source))].sort();
  const picked = [];
  ids.forEach((id, i) => {
    const want = sources[i % sources.length];
    // alternate: half the items where judges split, half where they agreed, so
    // agreement numbers are not skewed toward the hard cases
    const wantSplit = i % 2 === 0;
    const opts = byCase[id].slice().sort((a, b) => (b.source === want) - (a.source === want) || (wantSplit ? b.splits - a.splits : a.splits - b.splits) || a.run - b.run);
    picked.push(opts[0]);
  });
  // keep n, dropping from the most-represented source first
  while (picked.length > n) {
    const counts = {}; for (const p of picked) counts[p.source] = (counts[p.source] || 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    const i = picked.map((p) => p.source).lastIndexOf(top);
    picked.splice(i, 1);
  }
  // shuffle deterministically so neighbours do not reveal version or suite
  const order = picked.map((p, i) => ({ p, k: (i * 7919) % 104729 })).sort((a, b) => a.k - b.k).map((x) => x.p);
  const items = order.map((p, i) => {
    const c = CASES[p.case_id] || TEAMCASES[p.case_id];
    return { item_id: `CAL2-${String(i + 1).padStart(2, '0')}`, source: p.source, case_id: p.case_id, run: p.run, judge_splits: p.splits,
      judges: p.judges, merged: Object.fromEntries(DIMS.map((d) => [d, p.run_obj.dimensions[d].verdict])),
      merged_critical: (p.run_obj.critical_failures || []).filter((f) => f.status === 'confirmed').map((f) => f.code),
      blind: blindView(c, p.run_obj) };
  });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, 'set_v2.json'), JSON.stringify({ set_id: 'calibration_v2', created_at: new Date().toISOString(), n: items.length, sources, items }, null, 2));
  const blind = items.map((it) => ({ item_id: it.item_id, ...it.blind }));
  fs.writeFileSync(path.join(DIR, 'blind_v2.json'), JSON.stringify(blind, null, 2));
  const mix = {}; for (const it of items) mix[it.source] = (mix[it.source] || 0) + 1;
  console.log(`built ${items.length} blind items (${items.filter((i) => i.judge_splits).length} with judge splits) from ${ids.length} cases; mix ${JSON.stringify(mix)}`);
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

// ---- v2 scoring: agreement, false positives/negatives, recurring judge bias ----
// Labels come from the grading page's db ("labels" collection), saved with
// ArtifactData list + out_dir into <dir>/labels/<item_id>.json, or from a
// single labels_v2.json { labels: [...] }.
const RANK = { pass: 0, needs_review: 1, fail: 2 };
function loadLabels2(src) {
  if (fs.statSync(src).isDirectory()) {
    const d = fs.existsSync(path.join(src, 'labels')) ? path.join(src, 'labels') : src;
    return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => { const j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); return j.data || j; });
  }
  return JSON.parse(fs.readFileSync(src, 'utf8')).labels;
}
function score2(src) {
  const set = JSON.parse(fs.readFileSync(path.join(DIR, 'set_v2.json'), 'utf8'));
  const human = Object.fromEntries(loadLabels2(src).filter((l) => l && l.item_id && DIMS.every((d) => l[d])).map((l) => [l.item_id, l]));
  const items = set.items.filter((it) => human[it.item_id]);
  if (!items.length) { console.log('no completed human labels yet'); return; }
  const out = { set_id: set.set_id, labeled: items.length, of: set.items.length, dimensions: {}, bias: {}, critical: {}, recurring: [] };
  for (const d of DIMS) {
    out.dimensions[d] = {};
    for (const who of ['claude', 'gpt', 'merged']) {
      const pairs = items.map((it) => [who === 'merged' ? it.merged[d] : it.judges[who].dims[d], human[it.item_id][d], it]);
      const n = pairs.length;
      const fp = pairs.filter(([j, h]) => j !== 'pass' && h === 'pass');
      const fn = pairs.filter(([j, h]) => j === 'pass' && h !== 'pass');
      out.dimensions[d][who] = {
        exact_agreement: +(pairs.filter(([a, b]) => a === b).length / n).toFixed(3),
        kappa: kappa(pairs.map(([a, b]) => [a, b])),
        pass_vs_not_agreement: +(pairs.filter(([a, b]) => (a === 'pass') === (b === 'pass')).length / n).toFixed(3),
        false_positives: fp.length, false_negatives: fn.length,
        severe_misses: pairs.filter(([j, h]) => j === 'pass' && h === 'fail').length,
        false_positive_items: fp.map(([j, h, it]) => `${it.item_id} judge=${j} human=${h}`),
        false_negative_items: fn.map(([j, h, it]) => `${it.item_id} judge=${j} human=${h}`),
      };
    }
  }
  // Bias: mean severity offset (judge minus human; + = stricter), by dimension
  // and by agent/audience, so a recurring lean shows up as a pattern, not a case.
  for (const who of ['claude', 'gpt']) {
    const b = { by_dimension: {}, by_audience: {}, by_agent: {} };
    const acc = (bucket, key, v) => { (bucket[key] = bucket[key] || []).push(v); };
    for (const it of items) for (const d of DIMS) {
      const off = RANK[it.judges[who].dims[d]] - RANK[human[it.item_id][d]];
      acc(b.by_dimension, d, off); acc(b.by_audience, it.blind.audience, off); acc(b.by_agent, it.blind.agent.split(' ')[0], off);
    }
    for (const k of Object.keys(b)) b[k] = Object.fromEntries(Object.entries(b[k]).map(([g, v]) => [g, { mean_offset: +(v.reduce((a, x) => a + x, 0) / v.length).toFixed(2), stricter: v.filter((x) => x > 0).length, more_lenient: v.filter((x) => x < 0).length, n: v.length }]));
    out.bias[who] = b;
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
  // Recurring bias: any judge x dimension with |offset| >= 0.3 across >= 5 items,
  // and any critical code a judge raises falsely >= 2 times or misses >= 2 times.
  for (const who of ['claude', 'gpt']) {
    for (const [d, v] of Object.entries(out.bias[who].by_dimension)) if (Math.abs(v.mean_offset) >= 0.3 && v.n >= 5) out.recurring.push(`${who} is ${v.mean_offset > 0 ? 'stricter' : 'more lenient'} than the human on ${d} (mean offset ${v.mean_offset}, ${v.stricter} stricter / ${v.more_lenient} more lenient of ${v.n})`);
    for (const [code, r] of Object.entries(out.critical)) {
      if (r[who].false_positive >= 2) out.recurring.push(`${who} raises ${code} when the human does not (${r[who].false_positive} items)`);
      if (r[who].false_negative >= 2) out.recurring.push(`${who} misses ${code} that the human flags (${r[who].false_negative} items)`);
    }
  }
  const f = path.join(DIR, 'calibration_report_v2.json');
  fs.writeFileSync(f, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ labeled: out.labeled, recurring: out.recurring }, null, 1));
  console.log('full report:', f);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'score2') { score2(rest[0] || path.join(DIR, 'labels_v2.json')); process.exit(0); }
if (cmd === 'build2') { const ni = rest.indexOf('--n'); const n = ni >= 0 ? parseInt(rest[ni + 1], 10) : 30; build2(rest.filter((x, i) => x !== '--n' && i !== ni + 1), n); }
else if (cmd === 'build') { const ni = rest.indexOf('--n'); const n = ni >= 0 ? parseInt(rest[ni + 1], 10) : 30; build(rest.filter((x, i) => x !== '--n' && i !== ni + 1), n); }
else if (cmd === 'score') score();
else { console.error('usage: calibrate.js build <report.json>... [--n 30] | score'); process.exit(1); }
