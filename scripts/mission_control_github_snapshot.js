#!/usr/bin/env node
// Mission Control: snapshot GitHub issue and pull-request state for Platform Buildout.
// GitHub stays the engineering system; this records its state so the deployed app can
// show it without a token or background polling. Re-run after merges, then commit:
//   node scripts/mission_control_github_snapshot.js
// Uses the gh CLI (REST endpoints; the GraphQL API is not needed).
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = process.env.MC_REPO || 'EdGojara/hoa-doc-search';
const gh = (endpoint) => JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
function pages(endpoint, max = 5) {
  const out = [];
  for (let p = 1; p <= max; p++) {
    const sep = endpoint.includes('?') ? '&' : '?';
    const rows = gh(`${endpoint}${sep}per_page=100&page=${p}`);
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}

const issues = {}, pulls = {};
for (const i of pages(`repos/${REPO}/issues?state=all`)) {
  if (i.pull_request) continue;
  issues[i.number] = { title: i.title, state: i.state, labels: (i.labels || []).map((l) => l.name), url: i.html_url, closed_at: i.closed_at };
}
for (const p of pages(`repos/${REPO}/pulls?state=all`)) {
  pulls[p.number] = { title: p.title, state: p.merged_at ? 'merged' : p.state, head: p.head && p.head.ref, url: p.html_url, merged_at: p.merged_at, merge_commit: p.merge_commit_sha };
}
const out = { repo: REPO, generated_at: new Date().toISOString(), issues, pulls };
const file = path.join(__dirname, '..', 'lib', 'mission_control', 'github_snapshot.json');
fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
console.log(`snapshot: ${Object.keys(issues).length} issues, ${Object.keys(pulls).length} pull requests -> ${path.relative(process.cwd(), file)}`);
