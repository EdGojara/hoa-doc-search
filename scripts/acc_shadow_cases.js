// scripts/acc_shadow_cases.js — read-only deep dive into the shadow batch.
// Pulls representative cases side-by-side (evidence / Miranda / verifier / human /
// comparison), aggregates WHICH phrases drove SUBJECTIVE_JUDGMENT, and shows
// whether primary vs verifier structured disagreement is material or cosmetic.
// No fixes, no writes.  node -r dotenv/config scripts/acc_shadow_cases.js
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const acc = require('../lib/ai/tasks/acc');

const clip = (t, n) => String(t == null ? '' : t).replace(/\s+/g, ' ').slice(0, n);
function items(struct) {
  if (!struct || !struct.items) return '(no items)';
  return struct.items.map((i) => {
    const reqs = (i.requirements || []).map((r) => `${r.rule_type || '?'}«${clip(r.rule, 40)}»${r.complies === false ? '=FAIL' : r.complies === true ? '=ok' : '=?'}`).join('; ');
    return `    - ${i.type}: ${i.disposition}  [${reqs || 'no reqs'}]`;
  }).join('\n');
}
function subjReqs(struct) {
  if (!struct) return [];
  return (struct.items || []).flatMap((i) => (i.requirements || []).filter((r) => r.rule_type === 'SUBJECTIVE').map((r) => ({ item: i.type, rule: r.rule, requirement: r.requirement })));
}
function hasObjectiveDenyBasis(struct) {
  if (!struct) return false;
  return (struct.items || []).some((i) => i.disposition === 'DENY' && (i.requirements || []).some((r) => acc.evidenceOk(r) && r.complies === false));
}

(async () => {
  const { data: rows, error } = await s.from('acc_shadow_decisions').select('*').eq('shadow_status', 'ok').limit(100000);
  if (error) { console.error(error.message); process.exit(1); }
  const ids = [...new Set(rows.map((r) => r.source_acc_decision_id))];
  const accById = {};
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await s.from('acc_decisions').select('id, project_summary, decision_type, letter_body, review_text').in('id', ids.slice(i, i + 200));
    (data || []).forEach((a) => { accById[a.id] = a; });
  }
  const A = (r) => accById[r.source_acc_decision_id] || {};

  function render(title, r) {
    const a = A(r);
    const man = (r.input_evidence_manifest || []).map((m) => `${m.source}${m.ok ? '' : '(FAIL)'}`).join(', ');
    console.log('\n============================================================');
    console.log('CASE: ' + title);
    console.log('  project: ' + clip(a.project_summary, 120));
    console.log('  EVIDENCE read: ' + man + '  | input_complete: ' + r.input_complete);
    console.log('  -- MIRANDA (primary ' + r.primary_model + '): decision=' + r.primary_decision + '  business=' + r.business_decision + '  exec/reason=' + r.execution + '/' + r.reason_code);
    console.log(items(r.primary_structured));
    const sj = subjReqs(r.primary_structured);
    if (sj.length) console.log('    SUBJECTIVE flagged: ' + sj.map((x) => `${x.item}«${clip(x.rule, 40)}: ${clip(x.requirement, 50)}»`).join(' | '));
    if (r.primary_structured && r.primary_structured.rationale) console.log('    rationale: ' + clip(r.primary_structured.rationale, 260));
    console.log('  -- VERIFIER (' + r.verifier_model + '): decision=' + r.verifier_decision + '  structured-agree=' + r.agreement + (r.agreement_reasons && r.agreement_reasons.length ? '  diffs: ' + r.agreement_reasons.slice(0, 4).join(' | ') : ''));
    console.log(items(r.verifier_structured));
    console.log('  -- HUMAN: ' + a.decision_type + '  conditions(letter_body): ' + clip(a.letter_body || a.review_text, 300));
    console.log('  -- COMPARISON: top_level_match=' + r.overall_match + '  disagreement_type=' + r.disagreement_type);
  }

  // selection
  const niApproved = rows.filter((r) => r.business_decision === 'NEED_INFO' && /condition|approv/i.test(A(r).decision_type || ''));
  const subj = rows.filter((r) => r.disagreement_type === 'SUBJECTIVE_JUDGMENT');
  // "should have decided": subjective punt on an app that also has objective numeric reqs
  const subjShouldDecide = subj.filter((r) => (r.primary_structured && (r.primary_structured.items || []).some((i) => (i.requirements || []).some((x) => x.rule_type === 'NUMERIC'))));
  const matched = rows.filter((r) => r.overall_match === true);
  const priority = rows.filter((r) => r.overall_match === false && hasObjectiveDenyBasis(r.primary_structured));

  const pick = (arr, n, used) => { const out = []; for (const r of arr) { if (out.length >= n) break; if (!used.has(r.id)) { out.push(r); used.add(r.id); } } return out; };
  const used = new Set();
  const sel = [];
  pick(niApproved, 2, used).forEach((r) => sel.push(['NEED_INFO vs human approved-with-conditions', r]));
  pick(subjShouldDecide.length ? subjShouldDecide : subj, 2, used).forEach((r) => sel.push(['SUBJECTIVE_JUDGMENT (had objective reqs too — should she have decided?)', r]));
  pick(matched, 1, used).forEach((r) => sel.push(['MATCHED human (condition-level check)', r]));
  pick(priority.length ? priority : [], 1, used).forEach((r) => sel.push(['PRIORITY adjudication (objective cited-rule basis)', r]));

  console.log('################ SIX REPRESENTATIVE CASES ################');
  sel.forEach(([t, r]) => render(t, r));

  // aggregate: which phrases drive SUBJECTIVE
  console.log('\n\n################ WHY "SUBJECTIVE"? (all ok rows) ################');
  const phrases = {};
  rows.forEach((r) => subjReqs(r.primary_structured).forEach((x) => { const k = clip(x.rule, 60).toLowerCase(); phrases[k] = (phrases[k] || 0) + 1; }));
  const sorted = Object.entries(phrases).sort((a, b) => b[1] - a[1]);
  console.log('rows classified SUBJECTIVE_JUDGMENT: ' + subj.length + ' / ' + rows.length);
  console.log('top rules Miranda tagged rule_type=SUBJECTIVE (count):');
  sorted.slice(0, 15).forEach(([k, v]) => console.log('  ' + v + '  ' + k));

  // explain 10%: material vs cosmetic
  console.log('\n\n################ STRUCTURED AGREEMENT: material or cosmetic? ################');
  const disag = rows.filter((r) => r.agreement === false).slice(0, 6);
  disag.forEach((r) => {
    const reasons = r.agreement_reasons || [];
    const decDiff = r.primary_decision !== r.verifier_decision;
    console.log(`\n  [${clip(A(r).project_summary, 40)}] decisions ${r.primary_decision} vs ${r.verifier_decision} (${decDiff ? 'DECISION DIFFERS' : 'same decision'})`);
    console.log('    diff reasons: ' + (reasons.slice(0, 6).join(' | ') || '(none recorded)'));
  });
})().catch((e) => { console.error(e.message); process.exit(1); });
