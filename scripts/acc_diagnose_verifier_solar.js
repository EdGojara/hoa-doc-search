// scripts/acc_diagnose_verifier_solar.js — DIAGNOSTIC ONLY (Ed/ChatGPT 2026-09-19).
// The one VERIFIER-driven instability: on 6019 Water Violet (solar) Miranda was
// stable NEED_INFO 5/5, but the independent verifier (gpt-terra) varied and
// dragged routing to ESCALATE 4/5. Question to answer (NOT fix): is the verifier
// actually disagreeing about a governing requirement / evidence FACT, or just
// reaching different OVERALL decisions from substantially identical findings?
//
// Method: gather the solar evidence ONCE and FREEZE it, then run the VERIFIER
// ALONE N=10 times on that frozen evidence (same system+prompt+model+settings
// acc_shadow uses — nothing changed). Do NOT run Miranda; do NOT regather
// evidence between runs. Report the verifier decision distribution AND the
// material assertions (missing_information, per-requirement complies findings)
// so we can see whether the FINDINGS are constant while the DECISION varies.
//
// NOTE: the batch didn't persist the exact frozen bundle, so this re-freezes the
// solar evidence once now; the experiment still fully isolates the verifier
// because all 10 verifier runs share one frozen evidence package. Changes
// NOTHING (no prompt/model/routing/threshold edits); writes NOTHING to prod.
//   node -r dotenv/config scripts/acc_diagnose_verifier_solar.js [--reps 10]
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const acc = require('../lib/ai/tasks/acc');
const { callModel } = require('../lib/ai/model_client');
const { tier, verifierFor } = require('../lib/ai/tiers');
const { policyFor } = require('../lib/ai/policy');
const { gatherEvidence } = require('../lib/ai/shadow/acc_evidence');
const { getRelevantChunks } = require('../lib/hybrid_retrieval');

const SOLAR_ID = 'cde66d02-651c-44b4-af88-be959076b4d7'; // 6019 Water Violet Ln
const REPS = process.argv.includes('--reps') ? parseInt(process.argv[process.argv.indexOf('--reps') + 1], 10) : 10;

// the verifier's system prompt EXACTLY as acc_shadow.js issues it — unchanged.
const VERIFIER_SYSTEM = acc.ACC_SYSTEM + '\nYou are an INDEPENDENT reviewer from a different provider; reach your own decision.';

(async () => {
  const { data: app, error } = await supabase.from('acc_decisions')
    .select('id, community_id, community_name, homeowner_address, project_summary, application_pdf_storage_path, packet_pdf_storage_path, photo_storage_paths, decision_type')
    .eq('id', SOLAR_ID).single();
  if (error) { console.error('load failed:', error.message); process.exit(1); }

  console.log(`\nVERIFIER DIAGNOSTIC — ${app.homeowner_address} (${app.community_name})  verifier reps=${REPS}\n`);
  const ev = await gatherEvidence(app, { supabase, getRelevantChunks, anthropic });
  const frozen = ev.bundle_text;
  console.log('evidence (frozen, identical across all verifier runs):', ev.manifest.filter((m) => m.ok).map((m) => m.source).join('+'));

  const t = tier(policyFor('acc.review.general').default_tier);
  const vcfg = verifierFor(t.provider);
  console.log(`verifier: ${vcfg.provider}/${vcfg.model}  (Miranda is NOT run; her decision was NEED_INFO 5/5 on the batch)\n`);
  const prompt = acc.buildPrompt(frozen);

  const runs = [];
  for (let i = 0; i < REPS; i++) {
    const v = await callModel({ provider: vcfg.provider, model: vcfg.model, price: vcfg, system: VERIFIER_SYSTEM, prompt, maxTokens: 8000, kind: 'diag_verify' });
    if (!v.ok) { console.log(`run ${i + 1}: ERROR ${v.error}`); runs.push({ error: v.error }); continue; }
    const vp = acc.parse(v.text);
    if (!vp.ok) { console.log(`run ${i + 1}: PARSE ERROR ${vp.error}`); runs.push({ error: vp.error }); continue; }
    const { struct } = acc.applyDeterministicChecks(vp.value);
    // material assertions: what does the verifier claim about evidence/requirements?
    const findings = [];
    for (const it of (struct.items || [])) {
      for (const r of (it.requirements || [])) {
        findings.push(`${(r.rule || it.type || '?')}::complies=${r.complies}::resolved_from=${r.resolved_from || '-'}`);
      }
    }
    const rec = {
      decision: struct.decision,
      items: (struct.items || []).map((it) => `${it.type}=${it.disposition}`),
      missing_information: struct.missing_information || [],
      subjective_judgments: struct.subjective_judgments || [],
      findings: [...new Set(findings)].sort(),
    };
    runs.push(rec);
    console.log(`run ${i + 1}: ${rec.decision}  | missing=${(rec.missing_information || []).length}  | items: ${rec.items.join(', ').slice(0, 90)}`);
  }

  // decision distribution
  const ok = runs.filter((r) => !r.error);
  const dist = {};
  ok.forEach((r) => { dist[r.decision] = (dist[r.decision] || 0) + 1; });
  console.log('\n=== verifier decision distribution ===');
  console.log('  ', JSON.stringify(dist), ` (n=${ok.length})`);

  // are the FINDINGS constant while the DECISION varies?
  const findingSigs = new Set(ok.map((r) => r.findings.join(' | ')));
  const missingSigs = new Set(ok.map((r) => (r.missing_information || []).map((m) => String(m).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).sort().join(' ; ')));
  console.log('\n=== stability of the verifier\'s MATERIAL ASSERTIONS ===');
  console.log(`  distinct finding-sets across runs: ${findingSigs.size} of ${ok.length}`);
  console.log(`  distinct missing_information-sets:  ${missingSigs.size} of ${ok.length}`);
  console.log('\n  interpretation:');
  console.log('   - if decisions vary but finding/missing sets are ~constant => Terra is an unreliable');
  console.log('     DECISION oracle (same facts, different verdict) — argues for narrow assertion-checking.');
  console.log('   - if the finding/missing sets themselves vary => Terra genuinely disagrees about the facts.');

  console.log('\n=== each run: decision <- missing_information ===');
  ok.forEach((r, i) => console.log(`  ${String(i + 1).padStart(2)}: ${r.decision.padEnd(22)} <- missing: ${(r.missing_information || []).join(' | ').slice(0, 120) || '(none)'}`));

  const outDir = path.join(__dirname, '..', 'tmp');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (_) {}
  const outPath = path.join(outDir, `verifier_solar_diag_${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ app: app.homeowner_address, verifier: `${vcfg.provider}/${vcfg.model}`, evidence_sources: ev.manifest.filter((m) => m.ok).map((m) => m.source), decision_distribution: dist, distinct_finding_sets: findingSigs.size, distinct_missing_sets: missingSigs.size, runs }, null, 2));
  console.log('\nfull capture:', outPath, '\n');
})().catch((e) => { console.error('VERIFIER DIAG FAILED:', e.message); process.exit(1); });
