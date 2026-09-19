// scripts/acc_shadow_report.js — read acc_shadow_decisions and report the ACC
// shadow batch BY SUBCLASS (project type), plus the buckets that matter for
// adjudication. Read-only. (Ed/ChatGPT 2026-09-19.)
//   node -r dotenv/config scripts/acc_shadow_report.js
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const acc = require('../lib/ai/tasks/acc');

function subclassOf(summary) {
  const t = String(summary || '').toLowerCase();
  if (/solar|photovolt|\bpv\b/.test(t)) return 'solar';
  if (/fence/.test(t)) return 'fence';
  if (/pergola|patio cover|arbor|gazebo|awning|louvered/.test(t)) return 'patio_cover';
  if (/roof|shingle/.test(t)) return 'roof';
  if (/masonry|brick|stone|veneer|stucco/.test(t)) return 'masonry';
  if (/paint|repaint|\bcolor\b/.test(t)) return 'paint';
  if (/shed|accessory structure|storage building/.test(t)) return 'shed';
  if (/pool|spa|hot tub/.test(t)) return 'pool';
  if (/generator/.test(t)) return 'generator';
  if (/window|door/.test(t)) return 'windows_doors';
  if (/driveway|walkway|concrete|paver|hardscape|patio\b/.test(t)) return 'hardscape';
  if (/tree|landscap|sod|turf|planting|garden|flower bed|mulch/.test(t)) return 'landscape';
  return 'other';
}

// Does Miranda have an objective cited-rule basis for a denial? (an item DENIED on
// an evaluable requirement that objectively fails) -> if she also disagrees with
// the human, that's a PRIORITY adjudication case (the human may be wrong).
function hasObjectiveDenyBasis(struct) {
  if (!struct) return false;
  return (struct.items || []).some((i) => i.disposition === 'DENY'
    && (i.requirements || []).some((r) => acc.evidenceOk(r) && r.complies === false));
}

function pct(n, d) { return d ? (100 * n / d).toFixed(0) + '%' : '-'; }
function tally(arr) { const m = {}; arr.forEach((x) => { const k = x == null ? '(null)' : x; m[k] = (m[k] || 0) + 1; }); return m; }

(async () => {
  const { data: rows, error } = await s.from('acc_shadow_decisions').select('*').limit(100000);
  if (error) { console.error('read failed:', error.message); process.exit(1); }
  if (!rows.length) { console.log('no shadow rows yet — run scripts/acc_shadow_run.js first.'); return; }

  // pull summaries for subclass classification
  const ids = [...new Set(rows.map((r) => r.source_acc_decision_id).filter(Boolean))];
  const sums = {};
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await s.from('acc_decisions').select('id, project_summary').in('id', ids.slice(i, i + 200));
    (data || []).forEach((a) => { sums[a.id] = a.project_summary; });
  }
  rows.forEach((r) => { r._subclass = subclassOf(sums[r.source_acc_decision_id]); });

  const ok = rows.filter((r) => r.shadow_status === 'ok');
  const failed = rows.filter((r) => r.shadow_status !== 'ok');
  const comparable = ok.filter((r) => r.overall_match !== null);

  console.log('\n================ ACC SHADOW BATCH REPORT ================');
  console.log(`rows: ${rows.length}  | ok: ${ok.length}  | system/parse failures: ${failed.length}`);
  console.log(`comparable to a human outcome: ${comparable.length}  | overall match: ${comparable.filter((r) => r.overall_match).length} (${pct(comparable.filter((r) => r.overall_match).length, comparable.length)})`);
  const withVer = ok.filter((r) => r.agreement !== null);
  console.log(`cross-provider verifier agreement: ${withVer.filter((r) => r.agreement).length}/${withVer.length} (${pct(withVer.filter((r) => r.agreement).length, withVer.length)})`);
  console.log(`evidence complete: ${ok.filter((r) => r.input_complete).length}/${ok.length}`);

  // ---- by subclass ----
  const bySub = {};
  ok.forEach((r) => { (bySub[r._subclass] = bySub[r._subclass] || []).push(r); });
  console.log('\n---- BY SUBCLASS ----');
  console.log('subclass'.padEnd(14) + 'n'.padEnd(4) + 'match'.padEnd(8) + 'verAgree'.padEnd(10) + 'evidOk'.padEnd(8) + 'miranda decisions');
  for (const sub of Object.keys(bySub).sort((a, b) => bySub[b].length - bySub[a].length)) {
    const g = bySub[sub];
    const comp = g.filter((r) => r.overall_match !== null);
    const ver = g.filter((r) => r.agreement !== null);
    const dec = tally(g.map((r) => r.business_decision));
    console.log(
      sub.padEnd(14) + String(g.length).padEnd(4) +
      pct(comp.filter((r) => r.overall_match).length, comp.length).padEnd(8) +
      pct(ver.filter((r) => r.agreement).length, ver.length).padEnd(10) +
      pct(g.filter((r) => r.input_complete).length, g.length).padEnd(8) +
      Object.entries(dec).map(([k, v]) => `${k}:${v}`).join(' ')
    );
  }

  console.log('\ndisagreement_type:', JSON.stringify(tally(ok.map((r) => r.disagreement_type))));
  console.log('reason_code:', JSON.stringify(tally(ok.map((r) => r.reason_code))));
  console.log('human outcomes:', JSON.stringify(tally(rows.map((r) => r.human_decision_type))));

  // ---- adjudication buckets ----
  const disagree = comparable.filter((r) => r.overall_match === false);
  const evidenceExplained = disagree.filter((r) => r.disagreement_type === 'EVIDENCE' || r.input_complete === false);
  const trueReasoning = disagree.filter((r) => r.input_complete && !['EVIDENCE'].includes(r.disagreement_type));
  const priorityAdjud = disagree.filter((r) => hasObjectiveDenyBasis(r.primary_structured));

  console.log('\n---- ADJUDICATION BUCKETS (disagreements are cases, not AI errors) ----');
  console.log(`total disagreements (overall_match=false): ${disagree.length}`);
  console.log(`  evidence-explained (Miranda had less / EVIDENCE): ${evidenceExplained.length}`);
  console.log(`  true reasoning disagreement (complete evidence): ${trueReasoning.length}`);
  console.log(`  PRIORITY adjudication (Miranda denied on an OBJECTIVE cited rule — human may be wrong): ${priorityAdjud.length}`);

  const show = (label, list) => {
    if (!list.length) return;
    console.log(`\n  · ${label}:`);
    list.slice(0, 5).forEach((r) => console.log(`     [${r._subclass}] ${(sums[r.source_acc_decision_id] || '').slice(0, 70)} | miranda:${r.business_decision} human:${r.human_decision_type} type:${r.disagreement_type} agree:${r.agreement}`));
  };
  show('most instructive PRIORITY adjudication cases', priorityAdjud);
  show('most instructive true reasoning disagreements', trueReasoning);
  if (failed.length) show('system/parse failures', failed.map((r) => ({ ...r, _subclass: r._subclass || '?' })));
  console.log('\n========================================================\n');
})().catch((e) => { console.error(e.message); process.exit(1); });
