// ============================================================================
// scripts/eval_assessment_accuracy.js
// ----------------------------------------------------------------------------
// Runs the live runAssessment pipeline against historical ACC decisions
// (arc_historical_decisions) and scores the AI's recommendation against
// what Ed actually decided. This is the ground-truth baseline we use to
// drive the "90+ before manager review" target.
//
// Usage:
//   node scripts/eval_assessment_accuracy.js            -> run on all usable cases
//   node scripts/eval_assessment_accuracy.js --limit 20 -> run on 20 cases
//   node scripts/eval_assessment_accuracy.js --community "Canyon Gate at Cinco Ranch"
//   node scripts/eval_assessment_accuracy.js --verbose  -> show full AI summary on each case
//
// Scoring:
//   exact         — AI recommended_action matches the actual decision_type
//   close         — AI said approve when actual was conditional (or vice versa)
//                   — both are approvals, just different intensity
//   wrong         — AI flipped the decision direction (approve vs deny)
//   punt          — AI recommended manual_review or request_more_info
//   held_for_review — Layer 1/2 guards fired
//   error         — pipeline failed
//
// Accuracy = (exact + close) / total. Target = 90%.
//
// IMPORTANT CAVEAT: arc_historical_decisions is ALSO the retrieval source
// for match_arc_decisions, so the AI sees the actual decision in its
// context. This is OPTIMISTIC accuracy — real-world will be slightly
// lower. If we don't hit 90% even with this leak, the system is the
// issue, not just the data.
// ============================================================================

require('dotenv').config({ override: true });
const { createClient } = require('@supabase/supabase-js');
const { runAssessment } = require('../api/applications');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const argv = process.argv.slice(2);
const argLimit = argv.indexOf('--limit') !== -1 ? parseInt(argv[argv.indexOf('--limit') + 1], 10) : null;
const argCommunity = argv.indexOf('--community') !== -1 ? argv[argv.indexOf('--community') + 1] : null;
const argVerbose = argv.includes('--verbose');

// ----------------------------------------------------------------------------
// Score AI's recommended_action vs the actual decision_type
// ----------------------------------------------------------------------------
function scoreDecision(actual, aiAction) {
  if (!aiAction) return 'error';
  if (aiAction === 'manual_review' || aiAction === 'request_more_info') return 'punt';

  // Normalize: AI uses "approve" / "approve_with_conditions" / "deny";
  // historical uses "approved" / "conditional" / "denied".
  const a = actual;
  const ai = aiAction;
  if (a === 'approved' && ai === 'approve') return 'exact';
  if (a === 'conditional' && ai === 'approve_with_conditions') return 'exact';
  if (a === 'denied' && ai === 'deny') return 'exact';
  // Close: both are approvals, just different intensity
  if ((a === 'approved' && ai === 'approve_with_conditions') ||
      (a === 'conditional' && ai === 'approve')) return 'close';
  return 'wrong';
}

// ----------------------------------------------------------------------------
// Build a synthetic application from a historical decision
// ----------------------------------------------------------------------------
function buildSyntheticApplication(historical) {
  return {
    id: `eval-${historical.id}`,                  // not in DB — eval mode skips writes
    community_id: historical.community_id,
    property_address: historical.property_address || '(no address)',
    submitter_name: historical.homeowner_name || 'Eval Applicant',
    submitter_email: 'eval@bedrocktx.com',
    submitter_phone: null,
    application_data: {
      project_type: historical.project_type || 'other',
      project_description: historical.project_description || '',
      // Best-effort field extraction from the description text
      materials: null,
      dimensions: null,
      location_on_property: null,
      contractor: null,
      estimated_cost: null,
    },
  };
}

// ----------------------------------------------------------------------------
// Main eval loop
// ----------------------------------------------------------------------------
async function main() {
  // Pull historical decisions with final outcomes (skip 'pending')
  let q = supabase
    .from('arc_historical_decisions')
    .select('id, community_id, property_address, homeowner_name, project_type, project_description, decision_type, conditions, reasoning, decided_at, community:communities(name)')
    .in('decision_type', ['approved', 'conditional', 'denied']);
  if (argCommunity) {
    const { data: comm } = await supabase.from('communities').select('id').eq('name', argCommunity).maybeSingle();
    if (comm) q = q.eq('community_id', comm.id);
  }
  q = q.order('created_at', { ascending: false });
  if (argLimit) q = q.limit(argLimit);
  const { data: cases, error } = await q;
  if (error) throw error;

  if (!cases || cases.length === 0) {
    console.log('No usable historical decisions found.');
    process.exit(0);
  }

  // Filter: must have community + project_type + decent description + address
  const usable = cases.filter((c) =>
    c.community_id && c.project_type && (c.project_description || '').length >= 30 && c.property_address
  );
  console.log(`Running eval on ${usable.length} historical decisions (${cases.length - usable.length} skipped for missing fields)...\n`);

  const tally = { exact: 0, close: 0, wrong: 0, punt: 0, held_for_review: 0, error: 0 };
  const byCommunity = {};
  const byDecisionType = {};
  const misses = [];
  const t0 = Date.now();

  for (let i = 0; i < usable.length; i += 1) {
    const h = usable[i];
    const app = buildSyntheticApplication(h);
    process.stdout.write(`[${i + 1}/${usable.length}] ${(h.community?.name || '?').padEnd(28)} ${(h.project_type || '?').padEnd(12)} actual=${h.decision_type.padEnd(11)} `);
    let result;
    try {
      result = await runAssessment(app, { evalMode: true, triggerSource: 'gold_standard_test' });
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      tally.error += 1;
      continue;
    }

    let outcome;
    if (!result.ok) {
      outcome = result.held_for_review ? 'held_for_review' : 'error';
    } else if (result.held_for_review) {
      outcome = 'held_for_review';
    } else {
      const aiAction = result.assessment?.recommended_action;
      outcome = scoreDecision(h.decision_type, aiAction);
    }
    tally[outcome] = (tally[outcome] || 0) + 1;

    // Per-community tally
    const cname = h.community?.name || '?';
    byCommunity[cname] = byCommunity[cname] || { total: 0, exact: 0, close: 0, wrong: 0, punt: 0, held_for_review: 0, error: 0 };
    byCommunity[cname].total += 1;
    byCommunity[cname][outcome] = (byCommunity[cname][outcome] || 0) + 1;

    // Per-decision-type tally
    byDecisionType[h.decision_type] = byDecisionType[h.decision_type] || { total: 0, exact: 0, close: 0, wrong: 0, punt: 0, held_for_review: 0, error: 0 };
    byDecisionType[h.decision_type].total += 1;
    byDecisionType[h.decision_type][outcome] = (byDecisionType[h.decision_type][outcome] || 0) + 1;

    console.log(`ai=${(result.assessment?.recommended_action || '?').padEnd(24)} -> ${outcome}`);
    if (argVerbose && result.assessment?.summary) {
      console.log(`     summary: ${result.assessment.summary.slice(0, 180)}`);
    }

    if (outcome === 'wrong' || outcome === 'punt') {
      misses.push({
        community: cname,
        property: h.property_address,
        project_type: h.project_type,
        actual: h.decision_type,
        ai_action: result.assessment?.recommended_action,
        outcome,
        ai_summary: result.assessment?.summary || '',
        actual_reasoning: h.reasoning || '',
        actual_conditions: h.conditions || '',
        guards_fired: result.guards || [],
      });
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const total = Object.values(tally).reduce((s, n) => s + n, 0);

  // ----------------------------------------------------------------------------
  // Report
  // ----------------------------------------------------------------------------
  console.log('\n========================================================================');
  console.log('SUMMARY');
  console.log('========================================================================');
  const accuracy = ((tally.exact + tally.close) / total * 100).toFixed(1);
  const exactRate = ((tally.exact / total) * 100).toFixed(1);
  console.log(`Total cases:      ${total}    (elapsed: ${elapsed}s, ~${(elapsed / total).toFixed(1)}s per case)`);
  console.log(`Accuracy:         ${accuracy}%   (target: 90%)`);
  console.log(`Exact match rate: ${exactRate}%   (AI got the exact decision)`);
  console.log('');
  console.log(`  exact:           ${tally.exact}      AI matched the actual decision`);
  console.log(`  close:           ${tally.close}      AI was on the same side (approve vs deny) but different intensity`);
  console.log(`  wrong:           ${tally.wrong}      AI flipped the decision direction (approve vs deny)`);
  console.log(`  punt:            ${tally.punt}      AI recommended manual_review or request_more_info`);
  console.log(`  held_for_review: ${tally.held_for_review}      Layer 1/2 guards fired — AI output blocked`);
  console.log(`  error:           ${tally.error}      Pipeline failed`);

  console.log('\nBY COMMUNITY:');
  for (const [c, t] of Object.entries(byCommunity).sort((a, b) => b[1].total - a[1].total)) {
    const acc = ((t.exact + t.close) / t.total * 100).toFixed(0);
    console.log(`  ${c.padEnd(32)} total=${String(t.total).padStart(3)}  accuracy=${acc}%   (exact=${t.exact} close=${t.close} wrong=${t.wrong} punt=${t.punt} held=${t.held_for_review} err=${t.error})`);
  }

  console.log('\nBY DECISION TYPE:');
  for (const [d, t] of Object.entries(byDecisionType).sort((a, b) => b[1].total - a[1].total)) {
    const acc = ((t.exact + t.close) / t.total * 100).toFixed(0);
    console.log(`  ${d.padEnd(14)} total=${String(t.total).padStart(3)}  accuracy=${acc}%   (exact=${t.exact} close=${t.close} wrong=${t.wrong} punt=${t.punt} held=${t.held_for_review} err=${t.error})`);
  }

  if (misses.length > 0) {
    console.log('\n========================================================================');
    console.log(`MISSES (${misses.length}) — review these to find systematic issues:`);
    console.log('========================================================================');
    misses.slice(0, 25).forEach((m, i) => {
      console.log(`\n${i + 1}. [${m.outcome.toUpperCase()}] ${m.community} — ${m.property} — ${m.project_type}`);
      console.log(`   Actual:  ${m.actual}${m.actual_conditions ? ' / ' + m.actual_conditions.slice(0, 100) : ''}`);
      console.log(`   AI:      ${m.ai_action}`);
      console.log(`   AI says: ${m.ai_summary.slice(0, 200)}`);
      if (m.actual_reasoning) console.log(`   Actual reasoning: ${m.actual_reasoning.slice(0, 200)}`);
      if (m.guards_fired && m.guards_fired.length > 0) {
        console.log(`   Guards: ${m.guards_fired.map(g => g.code).join(', ')}`);
      }
    });
    if (misses.length > 25) console.log(`\n...and ${misses.length - 25} more.`);
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('Eval failed:', e);
  process.exit(1);
});
