// ============================================================================
// lib/enforcement/legal_flag.js  (Ed 2026-07-01)
// ----------------------------------------------------------------------------
// The account-level legal/bankruptcy flag surfaced to STAFF during DRV review
// (never on a letter). Single source of truth = property_enforcement_states
// (migration 202): the durable, deliberately-set status with attorney +
// bankruptcy detail. Falls back to the latest owner_ar_snapshots flag only if
// no durable state exists yet, so a property flagged solely by an AR import
// still surfaces. Shared by the inspect modal + community-map panel so the
// banner logic can't diverge.
// ============================================================================

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// The states that raise a red banner, with the label shown. 'current' and
// 'on_payment_plan' are NOT legal states — no banner.
const LEGAL_STATES = {
  at_legal:       'ACCOUNT AT LEGAL',
  in_bankruptcy:  'IN BANKRUPTCY — 11 U.S.C. §362 STAY',
  lien_filed:     'LIEN FILED',
  judgment:       'JUDGMENT ENTERED',
  in_collections: 'IN COLLECTIONS',
};

async function getLegalFlag(propertyId) {
  if (!propertyId) return null;
  try {
    const { data: st } = await supabase.from('property_enforcement_states')
      .select('state, attorney_name, attorney_firm, bankruptcy_chapter, bankruptcy_case_number, effective_at')
      .eq('property_id', propertyId).is('ended_at', null).maybeSingle();
    if (st && LEGAL_STATES[st.state]) {
      return {
        state: st.state,
        label: LEGAL_STATES[st.state],
        at_legal: st.state === 'at_legal',
        in_collections: st.state === 'in_collections',
        in_bankruptcy: st.state === 'in_bankruptcy',
        lien_filed: st.state === 'lien_filed',
        judgment: st.state === 'judgment',
        attorney_name: st.attorney_name || st.attorney_firm || null,
        bankruptcy_chapter: st.bankruptcy_chapter || null,
        bankruptcy_case_number: st.bankruptcy_case_number || null,
        as_of: st.effective_at || null,
        source: 'enforcement_state',
      };
    }
    // Fallback — a property flagged only by an AR aging import, no durable state.
    const { data: ar } = await supabase.from('owner_ar_snapshots')
      .select('at_legal, in_collections, snapshot_date').eq('property_id', propertyId)
      .order('snapshot_date', { ascending: false }).limit(1).maybeSingle();
    if (ar && (ar.at_legal || ar.in_collections)) {
      return {
        state: ar.at_legal ? 'at_legal' : 'in_collections',
        label: ar.at_legal ? LEGAL_STATES.at_legal : LEGAL_STATES.in_collections,
        at_legal: !!ar.at_legal, in_collections: !!ar.in_collections,
        in_bankruptcy: false, lien_filed: false, judgment: false,
        attorney_name: null, as_of: ar.snapshot_date, source: 'ar_snapshot',
      };
    }
  } catch (e) { console.warn('[legal_flag] lookup failed:', e.message); }
  return null;
}

module.exports = { getLegalFlag, LEGAL_STATES };
