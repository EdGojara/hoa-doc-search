#!/usr/bin/env node
// ============================================================================
// scripts/check_model_ids.js  (Issue #12): model selection stays central
// ----------------------------------------------------------------------------
// Fails the build when production code bypasses lib/ai/router:
//   1. a hard-coded Anthropic model id ('claude-sonnet-...', 'claude-haiku-...')
//      anywhere in api/, lib/ (outside lib/ai/), server.js, search.js, public/;
//   2. a raw require('@anthropic-ai/sdk') outside lib/ai/ (it would skip the
//      routed client, so no fallback policy and no telemetry);
//   3. an aiRoute('<workflow>') / route('<workflow>') key that is not in
//      lib/ai/routing.config.json;
//   4. an invalid routing config (unknown model alias, a fallback on a
//      high-consequence workflow, ...).
// A line that genuinely must name a model (none today) can carry
// `// model-id-ok` with a reason. Usage: node scripts/check_model_ids.js [root]
// ============================================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const MODEL_ID = /claude-(?:sonnet|opus|haiku|fable|instant)-?[0-9][a-z0-9.-]*|claude-[0-9](?:[.-][0-9])*-(?:sonnet|opus|haiku)/i;
const RAW_SDK = /require\(\s*['"]@anthropic-ai\/sdk['"]\s*\)|from\s+['"]@anthropic-ai\/sdk['"]/;
const ROUTE_KEY = /\b(?:aiRoute|route)\(\s*'([a-z0-9_.]+)'\s*\)/g;

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '.git'].includes(e.name)) continue;
      if (path.relative(ROOT, p).split(path.sep).join('/') === 'lib/ai') continue;
      walk(p, out);
    } else if (/\.(js|mjs|cjs|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = [];
for (const d of ['api', 'lib', 'public']) walk(path.join(ROOT, d), files);
for (const f of ['server.js', 'search.js']) if (fs.existsSync(path.join(ROOT, f))) files.push(path.join(ROOT, f));

let workflows = null;
try { workflows = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'lib/ai/routing.config.json'), 'utf8')).workflows)); }
catch (e) { console.error('✗ lib/ai/routing.config.json missing or invalid:', e.message); process.exit(1); }

const problems = [];
for (const f of files) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  const routedFile = /lib\/ai\/router/.test(lines.join('\n'));
  lines.forEach((ln, i) => {
    if (/model-id-ok/.test(ln)) return;
    if (MODEL_ID.test(ln)) problems.push(`${rel}:${i + 1} hard-coded model id: ${ln.trim().slice(0, 110)}`);
    if (RAW_SDK.test(ln)) problems.push(`${rel}:${i + 1} raw @anthropic-ai/sdk require (use lib/ai/anthropic): ${ln.trim().slice(0, 110)}`);
    if (routedFile) for (const m of ln.matchAll(ROUTE_KEY)) if (!workflows.has(m[1])) problems.push(`${rel}:${i + 1} unknown workflow '${m[1]}' (add it to lib/ai/routing.config.json)`);
  });
}

if (fs.existsSync(path.join(ROOT, 'lib/ai/router.js')) && ROOT === path.resolve(path.join(__dirname, '..'))) {
  const cfgProblems = require(path.join(ROOT, 'lib/ai/router.js')).validateConfig();
  for (const p of cfgProblems) problems.push(`routing.config.json: ${p}`);
}

if (problems.length) {
  console.error(`✗ Model selection bypasses the router in ${problems.length} place(s):`);
  for (const p of problems) console.error('    ' + p);
  console.error('  Name a workflow instead: model: aiRoute(\'<workflow>\') with the client from lib/ai/anthropic; models live in lib/ai/routing.config.json.');
  process.exit(1);
}
console.log(`✓ Model selection is central: ${files.length} production files, no hard-coded model ids, no raw SDK clients, every route key known (${workflows.size} workflows).`);
