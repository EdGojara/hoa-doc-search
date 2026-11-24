// ============================================================================
// lib/acc/effective.js  (Ed 2026-11-24, migration 576)
// ----------------------------------------------------------------------------
// THE EFFECTIVE ACC DECISION. A finalized case keeps its original decision on
// acc_decisions forever; a revised decision is a new acc_finalizations version.
// The latest version is the decision in effect. Every screen, letter, AI
// teammate and send check reads it here, so nothing copies it and nothing drifts.
//
//   revisionsFor(supabase, ids)      Map(case id -> latest revised version row)
//   withEffective(supabase, rows)    rows whose decision was revised come back with
//       decision_type = the decision in effect, original_decision_type, and
//       effective { version, decision_type, finalized_at, finalization_id, reason }.
//       Rows never revised come back unchanged. A lookup failure never blanks a
//       list: the rows come back with effective_error set, so the screen can say
//       the status could not be confirmed.
//   effectiveAuthorityRow(supabase, row, { reconsiderationId })  the case as the
//       authority checks should see it: with the revised decision's own record.
// ============================================================================
const COLS = 'id, acc_decision_id, version, decision_type, finalized_at, letter_text, correction_reason';
const chunk = (a, n) => { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };

async function revisionsFor(supabase, ids) {
  const want = [...new Set((ids || []).filter(Boolean))];
  const map = new Map();
  for (const part of chunk(want, 150)) {
    const { data, error } = await supabase.from('acc_finalizations').select(COLS).in('acc_decision_id', part).gt('version', 1).order('version', { ascending: true });
    if (error) throw new Error(`revised ACC decisions could not be read: ${error.message}`);
    for (const r of data || []) { const cur = map.get(r.acc_decision_id); if (!cur || r.version > cur.version) map.set(r.acc_decision_id, r); }
  }
  return map;
}

function applyEffective(row, rev) {
  if (!rev) return row;
  return { ...row, decision_type: rev.decision_type, original_decision_type: row.decision_type,
    effective: { version: rev.version, decision_type: rev.decision_type, finalized_at: rev.finalized_at, finalization_id: rev.id, reason: rev.correction_reason || null, letter_text: rev.letter_text || null } };
}

async function withEffective(supabase, rows) {
  const list = rows || [];
  if (!list.length) return list;
  try {
    const map = await revisionsFor(supabase, list.map((r) => r.id));
    return list.map((r) => applyEffective(r, map.get(r.id)));
  } catch (e) {
    console.error('[acc effective]', e.message);
    return list.map((r) => ({ ...r, effective_error: 'A later revised decision could not be checked.' }));
  }
}

async function effectiveAuthorityRow(supabase, row, { reconsiderationId = null } = {}) {
  if (!row) return row;
  let rec = null;
  if (reconsiderationId) {
    const r = await supabase.from('acc_reconsiderations').select('*').eq('id', reconsiderationId).maybeSingle();
    if (r.error) throw new Error(r.error.message);
    rec = r.data;
    // Only this case's reconsideration, approved by the owner and being issued.
    if (!rec || rec.acc_decision_id !== row.id || !['issuing', 'issued'].includes(rec.status) || !rec.owner_approval || !rec.decision_record) return { ...row, decision_record: null };
  } else {
    const r = await supabase.from('acc_reconsiderations').select('*').eq('acc_decision_id', row.id).eq('status', 'issued').order('issued_at', { ascending: false }).limit(1);
    if (r.error) { if (/does not exist|schema cache|could not find/i.test(r.error.message || '')) return row; throw new Error(r.error.message); }
    rec = (r.data || [])[0] || null;
    if (!rec) return row;
  }
  return { ...row, decision_type: rec.outcome, decision_record: rec.decision_record,
    letter_body: rec.letter_body, ai_letter_body: null, current_letter_body: null,
    current_ai_recommendation: rec.recommendation, current_review_at: rec.review_at };
}

module.exports = { revisionsFor, withEffective, applyEffective, effectiveAuthorityRow };
