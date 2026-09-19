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

  // pull summaries + human condition text (letter_body/review_text) for subclass +
  // condition-level comparison
  const ids = [...new Set(rows.map((r) => r.source_acc_decision_id).filter(Boolean))];
  const sums = {}; const humanCond = {};
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await s.from('acc_decisions').select('id, project_summary, letter_body, review_text').in('id', ids.slice(i, i + 200));
    (data || []).forEach((a) => { sums[a.id] = a.project_summary; humanCond[a.id] = (a.letter_body || '') + '\n' + (a.review_text || ''); });
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

  // ---- CONDITION-LEVEL agreement (top-level match is NOT enough) ----
  // 79/86 human outcomes are approved_with_conditions, so agreeing on the
  // top-level disposition proves little. Compare the actual conditions. Human
  // conditions live in prose (letter_body/review_text), not structured fields —
  // so this is a best-effort objective-token comparison, and the limitation is
  // stated, not hidden. A rigorous condition match needs a model judge (next step
  // if warranted) — not built yet by design.
  const OBJ = (text) => {
    const t = String(text || '').toLowerCase();
    const toks = new Set();
    (t.match(/\d+(?:\.\d+)?\s?(?:ft|feet|'|"|inch|inches|sq|%)/g) || []).forEach((x) => toks.add(x.replace(/\s+/g, '')));
    ['brick', 'stone', 'stucco', 'cedar', 'wrought iron', 'board-on-board', 'masonry', 'shingle', 'metal', 'vinyl', 'composite', 'setback', 'height', 'gray', 'grey', 'beige', 'tan', 'white', 'black', 'earth tone', 'palette', 'match existing', 'screen', 'not visible', 'side street']
      .forEach((w) => { if (t.includes(w)) toks.add(w); });
    return toks;
  };
  const mirandaConditionText = (struct) => {
    if (!struct) return '';
    return (struct.items || []).flatMap((i) => (i.requirements || []).map((r) => `${i.type} ${r.requirement || ''} ${r.submitted_value || ''} ${r.threshold_num != null ? r.operator + r.threshold_num : ''}`)).join(' ');
  };
  const ftVals = (text) => new Set((String(text).toLowerCase().match(/\d+(?:\.\d+)?\s?(?:ft|feet|')/g) || []).map((x) => x.replace(/\s|feet|ft|'/g, '')));
  // Three-way, per ChatGPT: low overlap is NOT a disagreement. Only call a conflict
  // when objective values actually clash on the same dimension.
  const classifyCondition = (hText, struct) => {
    const hTok = OBJ(hText), mTok = OBJ(mirandaConditionText(struct));
    const overlap = [...mTok].filter((x) => hTok.has(x));
    const granular = String(hText).replace(/\s/g, '').length > 200 && hTok.size > 0;
    if (!granular) return { cls: 'INDETERMINATE', overlap, hTok: hTok.size, mTok: mTok.size };
    if (overlap.length) return { cls: 'CONFIRMED_MATCH', overlap, hTok: hTok.size, mTok: mTok.size };
    // conflict only if both cite the same dimension AND give differing ft values
    const dim = (t) => /setback|height/.test(String(t).toLowerCase());
    const mText = mirandaConditionText(struct);
    if (dim(hText) && dim(mText)) {
      const hf = ftVals(hText), mf = ftVals(mText);
      if (hf.size && mf.size && ![...hf].some((x) => mf.has(x))) return { cls: 'CONFIRMED_DISAGREEMENT', overlap, hTok: hTok.size, mTok: mTok.size };
    }
    return { cls: 'INDETERMINATE', overlap, hTok: hTok.size, mTok: mTok.size };
  };
  const matchedAWC = comparable.filter((r) => r.overall_match && /condition/i.test(r.human_decision_type || '') && r.business_decision === 'APPROVE');
  const condCls = { CONFIRMED_MATCH: 0, CONFIRMED_DISAGREEMENT: 0, INDETERMINATE: 0 }; const condRows = [];
  for (const r of matchedAWC) {
    const hText = humanCond[r.source_acc_decision_id] || '';
    const c = classifyCondition(hText, r.primary_structured);
    condCls[c.cls]++;
    condRows.push({ sub: r._subclass, summary: (sums[r.source_acc_decision_id] || '').slice(0, 46), cls: c.cls, hChars: hText.replace(/\s/g, '').length, overlap: c.overlap });
  }
  console.log('\n---- CONDITION-LEVEL AGREEMENT (top-level match is NOT enough) ----');
  console.log(`matched approved-with-conditions cases: ${matchedAWC.length}`);
  console.log(`  condition_evidence_overlap classification (NOT pass/fail):`);
  console.log(`    CONFIRMED_MATCH (objective details align):        ${condCls.CONFIRMED_MATCH}`);
  console.log(`    CONFIRMED_DISAGREEMENT (objective values clash):  ${condCls.CONFIRMED_DISAGREEMENT}`);
  console.log(`    INDETERMINATE (human prose too thin to tell):    ${condCls.INDETERMINATE}`);
  console.log('  NOTE: heuristic token/value comparison, not a match verdict. Human conditions are prose,');
  console.log('        not structured. A rigorous condition match would need a model judge (not built yet, by design).');
  condRows.slice(0, 10).forEach((c) => console.log(`     [${c.sub}] ${c.summary} | ${c.cls} | humanCondChars:${c.hChars} overlap:${c.overlap.join(',') || '-'}`));

  console.log('\n========================================================\n');
})().catch((e) => { console.error(e.message); process.exit(1); });
