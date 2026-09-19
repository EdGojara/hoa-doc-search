// scripts/acc_diagnose_masonry.js — DIAGNOSTIC ONLY (Ed/ChatGPT 2026-09-19).
// The one Miranda-side substantive instability: on 5406 Jay Thrush the stone-
// veneer/contractor item flips APPROVE <-> APPROVE_WITH_CONDITIONS on identical
// evidence. Question to answer (NOT fix): why? Is the varying condition
//   (a) objectively required by a governing document,
//   (b) derived from community precedent,
//   (c) a discretionary/subjective management judgment,
//   (d) redundant/non-material wording, or
//   (e) unsupported/invented?
//
// Method: gather the evidence ONCE and FREEZE it, then run MIRANDA (primary
// only — no verifier) N times on that frozen evidence, capturing the FULL
// structured requirement objects (rule, source_document, resolved_from,
// condition, complies) for the stone-veneer / contractor / permit items.
// Changes NOTHING (no prompt/model/routing edits); writes NOTHING to production.
//   node -r dotenv/config scripts/acc_diagnose_masonry.js [--reps 5]
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const acc = require('../lib/ai/tasks/acc');
const { callModel } = require('../lib/ai/model_client');
const { tier } = require('../lib/ai/tiers');
const { policyFor } = require('../lib/ai/policy');
const { gatherEvidence } = require('../lib/ai/shadow/acc_evidence');
const { getRelevantChunks } = require('../lib/hybrid_retrieval');

const MASONRY_ID = '8bf3775d-ca96-489e-9bd1-ed3d3cd03096'; // 5406 Jay Thrush Dr
const REPS = process.argv.includes('--reps') ? parseInt(process.argv[process.argv.indexOf('--reps') + 1], 10) : 5;
const RELEVANT = /stone|veneer|contractor|permit|licens|insur/i;

(async () => {
  const { data: app, error } = await supabase.from('acc_decisions')
    .select('id, community_id, community_name, homeowner_address, project_summary, application_pdf_storage_path, packet_pdf_storage_path, photo_storage_paths, decision_type')
    .eq('id', MASONRY_ID).single();
  if (error) { console.error('load failed:', error.message); process.exit(1); }

  console.log(`\nMASONRY DIAGNOSTIC — ${app.homeowner_address} (${app.community_name})  reps=${REPS}\n`);
  const ev = await gatherEvidence(app, { supabase, getRelevantChunks, anthropic });
  const frozen = ev.bundle_text;
  console.log('evidence (frozen, identical across runs):', ev.manifest.filter((m) => m.ok).map((m) => m.source).join('+'));

  // Show the governing-doc / precedent text actually available about the varying
  // item, so we can judge objective-vs-discretionary.
  const evLines = frozen.split('\n').filter((l) => RELEVANT.test(l));
  console.log('\n--- evidence lines mentioning stone veneer / contractor / permit / insurance (' + evLines.length + ') ---');
  evLines.slice(0, 40).forEach((l) => console.log('  | ' + l.trim().slice(0, 180)));

  const t = tier(policyFor('acc.review.general').default_tier);
  const prompt = acc.buildPrompt(frozen);
  const runs = [];
  for (let i = 0; i < REPS; i++) {
    const p = await callModel({ provider: t.provider, model: t.model, price: t, system: acc.ACC_SYSTEM, prompt, maxTokens: 8000, kind: 'diag_primary' });
    if (!p.ok) { console.log(`run ${i + 1}: ERROR ${p.error}`); runs.push({ error: p.error }); continue; }
    const pp = acc.parse(p.text);
    if (!pp.ok) { console.log(`run ${i + 1}: PARSE ERROR ${pp.error}`); runs.push({ error: pp.error }); continue; }
    const { struct } = acc.applyDeterministicChecks(pp.value);
    runs.push({ struct });
  }

  console.log('\n=== stone-veneer / contractor / permit item across runs ===');
  runs.forEach((r, i) => {
    if (r.error) { console.log(`\nrun ${i + 1}: (errored)`); return; }
    console.log(`\nrun ${i + 1}: decision=${r.struct.decision}  admin_status=${acc.administrativeStatus(r.struct)}`);
    const items = (r.struct.items || []).filter((it) => RELEVANT.test(it.type));
    if (!items.length) { console.log('   (no stone/contractor/permit item this run)'); }
    for (const it of items) {
      console.log(`   • ${it.type}  ->  ${it.disposition}`);
      for (const req of (it.requirements || [])) {
        console.log(`       rule: ${(req.rule || '?')}  [${req.rule_type || '?'}]  src=${req.source_document || '-'}  resolved_from=${req.resolved_from || '-'}  complies=${req.complies}  admin=${!!req.administrative}`);
        if (req.condition) console.log(`       condition: ${req.condition}`);
      }
    }
  });

  // disposition-of-the-relevant-item summary
  console.log('\n=== relevant-item disposition per run ===');
  runs.forEach((r, i) => {
    if (r.error) return;
    const disp = (r.struct.items || []).filter((it) => RELEVANT.test(it.type)).map((it) => `${it.type.slice(0, 22)}=${it.disposition}`).join(' , ') || '(none)';
    console.log(`  run ${i + 1}: ${disp}`);
  });

  const outDir = path.join(__dirname, '..', 'tmp');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (_) {}
  const outPath = path.join(outDir, `masonry_diag_${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ app: app.homeowner_address, evidence_sources: ev.manifest.filter((m) => m.ok).map((m) => m.source), evidence_lines: evLines, runs }, null, 2));
  console.log('\nfull capture:', outPath, '\n');
})().catch((e) => { console.error('MASONRY DIAG FAILED:', e.message); process.exit(1); });
