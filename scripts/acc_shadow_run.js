// scripts/acc_shadow_run.js — OUT-OF-BAND shadow evaluation of ACC applications.
// Reads acc_decisions (the real applications + the human decision_type), runs the
// lib/ai router in SHADOW, and writes what Miranda WOULD have decided to
// acc_shadow_decisions for comparison. It is completely decoupled from ACC intake:
// running or failing here cannot affect the live ACC workflow. It imports no
// execution/side-effect code beyond reading applications, retrieving guidelines,
// and writing the shadow table.
//
//   node -r dotenv/config scripts/acc_shadow_run.js --dry --limit 1   # evaluate, DO NOT write
//   node -r dotenv/config scripts/acc_shadow_run.js --limit 20        # evaluate + write (needs migration 432)
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const { evaluateApplication } = require('../lib/ai/shadow/acc_shadow');
const { getRelevantChunks } = require('../lib/hybrid_retrieval');

const DRY = process.argv.includes('--dry');
const LIMIT = process.argv.includes('--limit') ? parseInt(process.argv[process.argv.indexOf('--limit') + 1], 10) : 10;

async function guidelinesFor(communityName) {
  try {
    const q = 'architectural guidelines fence height setback shed accessory structure paint approved color palette';
    const chunks = await getRelevantChunks(q, communityName);
    return String(chunks || '');
  } catch (e) { return ''; }
}

(async () => {
  console.log(`\nACC shadow run  ${DRY ? '(DRY — no writes)' : '(WRITES to acc_shadow_decisions)'}  limit=${LIMIT}\n`);

  // already-shadowed source ids (skip). If the table is missing, tell the operator.
  let done = new Set();
  if (!DRY) {
    const { data, error } = await supabase.from('acc_shadow_decisions').select('source_acc_decision_id').limit(100000);
    if (error) { console.error('acc_shadow_decisions not ready — apply migration 432 first. (' + error.message + ')'); process.exit(1); }
    done = new Set((data || []).map((r) => r.source_acc_decision_id));
  }

  const { data: apps, error } = await supabase.from('acc_decisions')
    .select('id, community_id, community_name, homeowner_address, project_summary, decision_type, created_at')
    .order('created_at', { ascending: false }).limit(500);
  if (error) throw error;
  const todo = (apps || []).filter((a) => a.project_summary && !done.has(a.id)).slice(0, LIMIT);
  console.log(`evaluating ${todo.length} application(s)...\n`);

  for (const app of todo) {
    const guidelines = await guidelinesFor(app.community_name);
    const applicationAndGuidelines =
      `Community: ${app.community_name}\nProperty: ${app.homeowner_address || '(address n/a)'}\n\n` +
      `APPLICATION:\n${app.project_summary}\n\n` +
      `COMMUNITY ARCHITECTURAL GUIDELINES (retrieved):\n${guidelines || '(none retrieved)'}`;

    const rec = await evaluateApplication({
      applicationAndGuidelines,
      retrieval_complete: !!guidelines,
      community_id: app.community_id, community_name: app.community_name,
      source_acc_decision_id: app.id, human_decision_type: app.decision_type,
    });

    console.log(`- ${app.community_name} | ${(app.homeowner_address || '').slice(0, 28).padEnd(28)} | shadow:${rec.shadow_status}` +
      (rec.shadow_status === 'ok'
        ? ` | miranda:${rec.business_decision}/${rec.execution}/${rec.reason_code || '-'} | human:${rec.human_decision_type || '-'} | match:${rec.overall_match} | agree:${rec.agreement}`
        : ` | ${rec.error}`));

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
      });
      if (ie) console.error('   write failed:', ie.message);
    }
  }
  console.log(`\n${DRY ? 'DRY complete (nothing written).' : 'Done.'}\n`);
})().catch((e) => { console.error('ACC SHADOW RUN FAILED:', e.message); process.exit(1); });
