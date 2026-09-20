// scripts/acc_shadow_run.js — OUT-OF-BAND shadow evaluation of ACC applications.
// Reads acc_decisions (real applications + the human decision_type), assembles the
// FULL evidence package Miranda should see (PDFs via document-understanding,
// photos via vision, guidelines via retrieval, community precedent) with a
// manifest, runs the lib/ai router in SHADOW, and records what Miranda WOULD have
// decided in acc_shadow_decisions — with the disagreement TYPE, so an evidence gap
// isn't scored as an AI error. Fully decoupled from ACC intake; running or failing
// here cannot affect the live workflow. No execution capability.
//
//   node -r dotenv/config scripts/acc_shadow_run.js --dry --limit 2   # evaluate, DO NOT write
//   node -r dotenv/config scripts/acc_shadow_run.js --limit 20        # evaluate + write (needs migrations 432 + 433)
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const { evaluateApplication } = require('../lib/ai/shadow/acc_shadow');
const { gatherEvidence } = require('../lib/ai/shadow/acc_evidence');
const { getRelevantChunks } = require('../lib/hybrid_retrieval');

const DRY = process.argv.includes('--dry');
const LIMIT = process.argv.includes('--limit') ? parseInt(process.argv[process.argv.indexOf('--limit') + 1], 10) : 10;

(async () => {
  console.log(`\nACC shadow run  ${DRY ? '(DRY — no writes)' : '(WRITES acc_shadow_decisions)'}  limit=${LIMIT}\n`);

  let done = new Set();
  if (!DRY) {
    const { data, error } = await supabase.from('acc_shadow_decisions').select('source_acc_decision_id').limit(100000);
    if (error) { console.error('acc_shadow_decisions not ready — apply migrations 432 + 433 first. (' + error.message + ')'); process.exit(1); }
    done = new Set((data || []).map((r) => r.source_acc_decision_id));
  }

  const { data: apps, error } = await supabase.from('acc_decisions')
    .select('id, community_id, community_name, homeowner_address, project_summary, application_pdf_storage_path, packet_pdf_storage_path, photo_storage_paths, decision_type, created_at')
    .order('created_at', { ascending: false }).limit(500);
  if (error) throw error;
  const todo = (apps || []).filter((a) => a.project_summary && !done.has(a.id)).slice(0, LIMIT);
  console.log(`evaluating ${todo.length} application(s)...\n`);

  for (const app of todo) {
    const ev = await gatherEvidence(app, { supabase, getRelevantChunks, anthropic });
    const rec = await evaluateApplication({
      evidencePackage: ev.package, // frozen, hashed package; gate runs BEFORE reasoning
      applicationAndGuidelines: ev.bundle_text,
      retrieval_complete: ev.manifest.some((m) => m.source === 'governing_docs' && m.state === 'PRESENT_READABLE'),
      input_complete: ev.input_complete,
      input_evidence_manifest: ev.manifest,
      community_id: app.community_id, community_name: app.community_name,
      source_acc_decision_id: app.id, human_decision_type: app.decision_type,
    });

    const readSrc = ev.manifest.filter((m) => m.ok).map((m) => m.source).join('+');
    console.log(`- ${(app.homeowner_address || '').slice(0, 26).padEnd(26)} | shadow:${rec.shadow_status}` +
      (rec.shadow_status === 'ok'
        ? ` | miranda:${rec.business_decision}/${rec.execution}/${rec.reason_code || '-'} | human:${rec.human_decision_type} | match:${rec.overall_match} | agree:${rec.agreement} | evid_complete:${rec.input_complete} | disagree:${rec.disagreement_type || '-'}`
        : ` | ${rec.error}`));
    console.log(`    evidence read: ${readSrc}`);

    if (!DRY) {
      const { error: ie } = await supabase.from('acc_shadow_decisions').insert({
        source_acc_decision_id: rec.source_acc_decision_id, community_id: rec.community_id, community_name: rec.community_name,
        policy_version: rec.policy_version, primary_provider: rec.primary_provider, primary_model: rec.primary_model,
        verifier_provider: rec.verifier_provider, verifier_model: rec.verifier_model,
        primary_decision: rec.primary_decision, primary_structured: rec.primary_structured,
        verifier_decision: rec.verifier_decision, verifier_structured: rec.verifier_structured,
        agreement: rec.agreement, agreement_reasons: rec.agreement_reasons, deterministic_overrides: rec.deterministic_overrides,
        severity: rec.severity, evidence_incomplete: rec.evidence_incomplete,
        business_decision: rec.business_decision, execution: rec.execution, reason_code: rec.reason_code, notification_level: rec.notification_level,
        audit: rec.audit, shadow_status: rec.shadow_status, error: rec.error,
        human_decision_type: rec.human_decision_type, overall_match: rec.overall_match, item_match: rec.item_match, requirement_match: rec.requirement_match,
        input_evidence_manifest: rec.input_evidence_manifest, input_complete: rec.input_complete,
        disagreement_type: rec.disagreement_type, adjudication: rec.adjudication, adjudication_rationale: rec.adjudication_rationale,
      });
      if (ie) console.error('   write failed:', ie.message);
    }
  }
  console.log(`\n${DRY ? 'DRY complete (nothing written).' : 'Done.'}\n`);
})().catch((e) => { console.error('ACC SHADOW RUN FAILED:', e.message); process.exit(1); });
