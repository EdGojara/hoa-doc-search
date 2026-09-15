// ============================================================================
// lib/enforcement/notices_not_sent.js  (Ed 2026-09-15)
// ----------------------------------------------------------------------------
// The ONE authoritative "who never got a notice" metric, defined once so the
// number can't drift between surfaces (the failure Ed called out: hand-computed
// counts that moved every time).
//
// A CASE = one property + one violation category that has an OPEN,
// trustEd-native violation and NO courtesy or certified notice EVER SENT for
// that property+category. Decisions baked in:
//   - trustEd-native ONLY. Vantaca-era imports (source='vantaca_import') are
//     excluded: their notices were handled inside Vantaca, so they are not a
//     trustEd gap.
//   - Deduped to ONE row per (property, category). Continuation / alias /
//     duplicate violation rows for the same case never inflate the count.
//   - "Notice sent" is category-specific: a sent letter covers the case only for
//     the property+category of its own violation. A lawn notice does not cover a
//     new storage case on the same property.
//   - Grouped by the earliest open date (the drive that logged the case) so a
//     single drive that left holes is visible at a glance.
//
// Returns an array of cases: { property_id, category_id, opened_at }. The caller
// enriches with address / owner / category label for display.
// ============================================================================
const { fetchAllQuery } = require('../db/fetch_all');

const LETTER_TYPES = ['letter_courtesy_1', 'letter_courtesy_2', 'letter_209'];

async function noticesNotSent(supabase, communityId) {
  if (!communityId) return [];

  // 1) Open, native violations for the community (paginated — 1000-row scar).
  const open = await fetchAllQuery(() => supabase.from('violations')
    .select('id, property_id, primary_category_id, opened_at, source')
    .eq('community_id', communityId)
    .not('current_stage', 'in', '(cured,closed,voided)')
    .is('resolved_at', null), { orderBy: 'opened_at' });
  const native = open.filter((v) =>
    (v.source || 'trustEd_native') === 'trustEd_native' && v.property_id && v.primary_category_id);
  if (!native.length) return [];

  // 2) Every SENT notice, resolved to the property+category of its violation.
  const sentLetters = await fetchAllQuery(() => supabase.from('interactions')
    .select('violation_id')
    .eq('community_id', communityId).in('type', LETTER_TYPES)
    .not('sent_at', 'is', null), { orderBy: 'id' });
  const letterVids = [...new Set(sentLetters.map((l) => l.violation_id).filter(Boolean))];
  const covered = new Set(); // `${property_id}|${category_id}` with a sent notice
  for (let i = 0; i < letterVids.length; i += 300) {
    const { data, error } = await supabase.from('violations')
      .select('id, property_id, primary_category_id').in('id', letterVids.slice(i, i + 300));
    if (error) throw error;
    for (const v of (data || [])) {
      if (v.property_id && v.primary_category_id) covered.add(`${v.property_id}|${v.primary_category_id}`);
    }
  }

  // 3) Dedup native open cases by property+category; keep those never covered,
  //    stamped with the earliest open date (the originating drive).
  const cases = new Map();
  for (const v of native) {
    const key = `${v.property_id}|${v.primary_category_id}`;
    if (covered.has(key)) continue;
    const prev = cases.get(key);
    if (!prev || String(v.opened_at) < String(prev.opened_at)) {
      cases.set(key, { property_id: v.property_id, category_id: v.primary_category_id, opened_at: v.opened_at });
    }
  }
  return [...cases.values()].sort((a, b) => String(a.opened_at).localeCompare(String(b.opened_at)));
}

module.exports = { noticesNotSent, LETTER_TYPES };
