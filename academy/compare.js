#!/usr/bin/env node
// academy/compare.js - did Amanda improve or regress between two runs?
//   node academy/compare.js academy/reports/before.json academy/reports/after.json
// Compares per case, per dimension (never an overall score) and critical
// failures. Use after any model / prompt / tool / knowledge / memory change.
const fs = require('fs');
const RANK = { fail: 0, needs_review: 1, pass: 2 };

function load(p) {
  const r = JSON.parse(fs.readFileSync(p, 'utf8'));
  const m = {};
  for (const x of r.results) {
    const runs = x.runs.filter((y) => y.dimensions);
    if (!runs.length) continue;
    const dims = {};
    for (const d of Object.keys(runs[0].dimensions)) dims[d] = runs.map((y) => y.dimensions[d].verdict).sort((a, b) => RANK[a] - RANK[b])[0]; // worst run
    m[`${x.case_id}@v${x.version}`] = { dims, critical: [...new Set(runs.flatMap((y) => y.critical_failures.filter((f) => f.status !== 'disputed').map((f) => f.code)))] };
  }
  return { meta: { at: r.at, amanda: r.amanda, mode: r.mode, fingerprint: r.live_prompt_fingerprint }, m };
}

const [a, b] = process.argv.slice(2).map(load);
if (!a || !b) { console.error('usage: compare.js before.json after.json'); process.exit(1); }
console.log(`before: ${JSON.stringify(a.meta)}\nafter:  ${JSON.stringify(b.meta)}\n`);
let regressions = 0;
for (const k of Object.keys(b.m).sort()) {
  const x = a.m[k], y = b.m[k];
  if (!x) { console.log(`${k}: new case`); continue; }
  const changes = Object.keys(y.dims).filter((d) => x.dims[d] !== y.dims[d]).map((d) => {
    const dir = RANK[y.dims[d]] > RANK[x.dims[d]] ? 'IMPROVED' : 'REGRESSED';
    if (dir === 'REGRESSED') regressions++;
    return `${d} ${x.dims[d]} -> ${y.dims[d]} (${dir})`;
  });
  const newCrit = y.critical.filter((c) => !x.critical.includes(c));
  const goneCrit = x.critical.filter((c) => !y.critical.includes(c));
  if (newCrit.length) regressions += newCrit.length;
  if (changes.length || newCrit.length || goneCrit.length) console.log(`${k}: ${changes.join('; ')}${newCrit.length ? ` | NEW critical: ${newCrit.join(',')}` : ''}${goneCrit.length ? ` | cleared: ${goneCrit.join(',')}` : ''}`);
}
console.log(`\n${regressions} regression(s)`);
process.exitCode = regressions ? 2 : 0;
