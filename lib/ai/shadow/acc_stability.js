// lib/ai/shadow/acc_stability.js — pure stats for the ACC decision-stability
// experiment (Ed/ChatGPT 2026-09-19). NO API, NO DB — it summarizes N repeated
// evaluations of the SAME application on IDENTICAL frozen evidence and tells us
// WHAT KIND of nondeterminism we have.
//
// The distinction that matters (GPT): APPROVE_WITH_CONDITIONS every run with
// slightly different WORDING is harmless generative variation; a decision that
// swings APPROVE_WITH_CONDITIONS -> ESCALATE -> DENY is decision instability and
// must be solved before any autonomy. And critically, measure the PAIR —
// Miranda (primary) stability SEPARATELY from verifier stability — because a
// steady Miranda with a flip-flopping verifier is OPERATIONAL instability caused
// by the verifier, not by Miranda.

function normCond(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function distinct(arr) { return [...new Set(arr)]; }
function mode(arr) {
  const c = {}; let best = null, bestN = 0;
  for (const v of arr) { const k = String(v); c[k] = (c[k] || 0) + 1; if (c[k] > bestN) { bestN = c[k]; best = k; } }
  return { value: best, count: bestN };
}

// Map a shadow rec (from evaluateApplication) to the six dimensions we track.
function extractRun(rec) {
  const ps = rec.primary_structured || {};
  const items = (ps.items || []).map((i) => ({ type: String(i.type || ''), disposition: String(i.disposition || '') }));
  const conditions = [];
  const objective = [];
  for (const i of (ps.items || [])) {
    for (const r of (i.requirements || [])) {
      if (r.condition && String(r.condition).trim()) conditions.push(normCond(r.condition));
      if (typeof r.complies === 'boolean' && !r.administrative) objective.push(`${normCond(r.rule)}=${r.complies}`);
    }
  }
  return {
    primary_decision: rec.primary_decision || null,
    verifier_decision: rec.verifier_decision || null,
    business_decision: rec.business_decision || null,
    reason_code: rec.reason_code || null,
    execution: rec.execution || null,
    gate_severity: rec.severity || 'none', // 'catastrophic' | 'none' — the deterministic safety gate's read of THIS run
    administrative_status: rec.administrative_status || null,
    shadow_status: rec.shadow_status || null,
    items,
    item_signature: items.map((x) => `${x.type}:${x.disposition}`).sort().join(' | '),
    conditions: conditions.sort(),
    condition_signature: conditions.slice().sort().join(' || '),
    objective_signature: distinct(objective).sort().join(' , '),
  };
}

// runs: array of extractRun() outputs (all for ONE application). Returns the
// per-application stability summary + a classification of the nondeterminism.
function summarizeRuns(runs, expected) {
  const ok = runs.filter((r) => r.shadow_status === 'ok');
  const n = ok.length;
  if (!n) return { n: 0, usable: 0, classification: 'NO_USABLE_RUNS', kind: 'error' };

  const axis = (vals) => { const m = mode(vals); const d = distinct(vals); return { mode: m.value, mode_count: m.count, distinct: d, stable: d.length === 1, stability: +(m.count / n).toFixed(3) }; };

  const primary = axis(ok.map((r) => r.primary_decision));
  const verifier = axis(ok.map((r) => r.verifier_decision));
  const routing = axis(ok.map((r) => r.business_decision));
  const reasonCode = axis(ok.map((r) => r.reason_code));
  const execution = axis(ok.map((r) => r.execution));
  const gateSeverity = axis(ok.map((r) => r.gate_severity));
  const admin = axis(ok.map((r) => r.administrative_status));
  const dispositions = axis(ok.map((r) => r.item_signature));
  const conditions = axis(ok.map((r) => r.condition_signature));
  const objective = axis(ok.map((r) => r.objective_signature));

  const primaryStable = primary.stable;
  const verifierStable = verifier.stable;
  const routingStable = routing.stable;
  const dispStable = dispositions.stable;
  const wordingVaries = !conditions.stable || !objective.stable;
  // The safety gate is the axis that matters most: did the SAME evidence trip
  // GATE_CATASTROPHIC on some runs and not others? That means one run let an
  // uncured objective violation stand while another cured it — the gate caught
  // it every time (nothing executes in shadow), but a nondeterministic gate is
  // unacceptable before autonomy. Distinct from a stable business_decision that
  // hides it (the smoke case: AWC both runs, EVIDENCE_INCOMPLETE vs CATASTROPHIC).
  const intermittentCatastrophic = !gateSeverity.stable && gateSeverity.distinct.includes('catastrophic');
  const gateFlipped = !reasonCode.stable || !execution.stable || !gateSeverity.stable;

  // classification + severity of the nondeterminism
  let classification, kind, explanation;
  if (!primaryStable) {
    classification = 'DECISION_INSTABILITY_PRIMARY'; kind = 'must_fix';
    explanation = `Miranda's own substantive decision varied across identical runs (${primary.distinct.join(' / ')}). This must be solved before autonomy.`;
  } else if (intermittentCatastrophic) {
    classification = 'GATE_SEVERITY_INSTABILITY'; kind = 'must_fix';
    explanation = `Top-line decision held (${primary.mode}), but the deterministic safety gate fired GATE_CATASTROPHIC on ${ok.filter((r) => r.gate_severity === 'catastrophic').length}/${n} identical runs and not the rest — on some runs an item was approved-with-conditions over an objective violation WITHOUT a curing condition. The gate caught it every time (nothing executes), but a nondeterministic safety outcome must be solved before autonomy. Usually driven by item-structure/condition variation underneath a stable headline.`;
  } else if (!dispStable) {
    classification = 'ITEM_DISPOSITION_INSTABILITY'; kind = 'must_fix';
    explanation = 'Same top-level decision, but per-item dispositions varied run to run.';
  } else if (!routingStable && !verifierStable) {
    classification = 'OPERATIONAL_INSTABILITY_FROM_VERIFIER'; kind = 'must_fix';
    explanation = `Miranda was steady (${primary.mode} ${primary.mode_count}/${n}); the VERIFIER flip-flopped (${verifier.distinct.join(' / ')}), intermittently tripping VERIFY_DISAGREEMENT and changing the routed outcome. The instability is the verifier's, not Miranda's.`;
  } else if (!routingStable && verifierStable) {
    classification = 'ROUTING_INSTABILITY_UNEXPECTED'; kind = 'must_fix';
    explanation = 'Both models were individually stable yet the routed outcome varied — investigate the gate inputs.';
  } else if (!verifierStable) {
    classification = 'VERIFIER_VARIES_ROUTING_ABSORBS'; kind = 'watch';
    explanation = `The verifier varied (${verifier.distinct.join(' / ')}) but the routed outcome held steady (${routing.mode}). No operational impact yet, but the verifier is a latent source of flapping.`;
  } else if (gateFlipped) {
    // decision, dispositions, routing and verifier all stable, yet the routed
    // rationale/execution still varied — a subtle gate-input nondeterminism.
    classification = 'GATE_RATIONALE_INSTABILITY'; kind = 'must_fix';
    explanation = `Decision, dispositions and routed outcome held, but the rationale/execution varied (reason_code: ${reasonCode.distinct.join(' / ')}; execution: ${execution.distinct.join(' / ')}).`;
  } else if (wordingVaries) {
    classification = 'GENERATIVE_VARIATION_ONLY'; kind = 'harmless';
    explanation = 'Every decision, disposition, verifier call and routed outcome was identical across runs; only condition/finding WORDING differed. This is normal generative variation.';
  } else {
    classification = 'FULLY_STABLE'; kind = 'harmless';
    explanation = 'Identical across all runs on every tracked dimension.';
  }

  // consistent cross-provider disagreement is a distinct finding from instability:
  // both stable, but always ESCALATE via VERIFY_DISAGREEMENT.
  const consistentDisagreement = primaryStable && verifierStable && routingStable
    && routing.mode === 'ESCALATE' && ok.every((r) => r.reason_code === 'VERIFY_DISAGREEMENT');

  const out = { n, usable: n, primary, verifier, routing, reason_code: reasonCode, execution, gate_severity: gateSeverity, admin, dispositions, conditions, objective, classification, kind, explanation, intermittent_catastrophic: intermittentCatastrophic, gate_flipped: gateFlipped, consistent_cross_provider_disagreement: consistentDisagreement };
  if (expected && expected.substantive_decision) {
    out.expected_substantive_decision = expected.substantive_decision;
    out.primary_matches_expected = primary.mode === expected.substantive_decision;
  }
  return out;
}

module.exports = { summarizeRuns, extractRun, _mode: mode, _normCond: normCond };
