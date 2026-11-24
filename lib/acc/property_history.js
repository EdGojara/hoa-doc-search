// ============================================================================
// lib/acc/property_history.js  (Ed 2026-11-19)
// ----------------------------------------------------------------------------
// WHAT TRUSTED ALREADY KNOWS ABOUT THE PROPERTY, for Annie's ACC review.
// Annie's engine used to see only the files attached to the application, so an
// application filed in response to a violation (the inspection photo, the
// courtesy notice, the cited condition) was reviewed as an unrelated new
// request and she asked the homeowner for a photo trustEd already had.
//
// propertyHistory(supabase, { communityId, address, excludeId }) -> string
//   A short block of trustEd records for the lot: open and recent violations
//   (what was cited, when, at what stage) and the other ACC cases at the
//   address. Empty string when nothing is found. Never throws: missing history
//   must never block a routine application.
// ============================================================================
const { normalizeAddress } = require('../entity_resolution');

const canon = (a) => { try { return normalizeAddress(a).canonical || null; } catch (_) { return null; } };
const day = (x) => (x ? String(x).slice(0, 10) : '?');

async function propertyHistory(supabase, { communityId, address, excludeId = null, now = new Date() } = {}) {
  try {
    const target = canon(address);
    const num = target && (target.match(/^\d+/) || [])[0];
    if (!supabase || !communityId || !target || !num) return '';
    const warn = (what, e) => console.warn(`[acc property-history] ${what} failed:`, e && e.message);

    // The lot (physical address), matched on the canonical street address.
    const pr = await supabase.from('properties').select('id, street_address')
      .eq('community_id', communityId).ilike('street_address', `${num} %`).limit(25);
    if (pr.error) { warn('property lookup', pr.error); return ''; }
    const prop = (pr.data || []).find((p) => canon(p.street_address) === target) || null;

    const lines = [];
    if (prop) {
      const since = new Date(now.getTime() - 365 * 86400000).toISOString();
      const vr = await supabase.from('violations')
        .select('id, primary_category_id, current_stage, opened_at, resolved_at, resolved_via, opened_from_observation_id')
        .eq('property_id', prop.id).order('opened_at', { ascending: false }).limit(20);
      if (vr.error) warn('violations', vr.error);
      const viols = (vr.data || []).filter((v) => !v.resolved_at || v.resolved_at >= since);
      if (viols.length) {
        const catIds = [...new Set(viols.map((v) => v.primary_category_id).filter(Boolean))];
        const obsIds = viols.map((v) => v.opened_from_observation_id).filter(Boolean);
        const [cr, or] = await Promise.all([
          catIds.length ? supabase.from('enforcement_categories').select('id, label').in('id', catIds) : { data: [] },
          obsIds.length ? supabase.from('property_observations').select('id, ai_description, created_at').in('id', obsIds) : { data: [] },
        ]);
        if (cr.error) warn('categories', cr.error);
        if (or.error) warn('observations', or.error);
        const cat = new Map((cr.data || []).map((c) => [c.id, c.label]));
        const obs = new Map((or.data || []).map((o) => [o.id, o]));
        lines.push('VIOLATIONS ON THIS LOT (trustEd enforcement records):');
        for (const v of viols) {
          const o = obs.get(v.opened_from_observation_id);
          const state = v.resolved_at ? `closed ${day(v.resolved_at)} (${v.resolved_via || 'resolved'})` : `OPEN, stage ${v.current_stage}`;
          lines.push(`- ${cat.get(v.primary_category_id) || 'violation'}: opened ${day(v.opened_at)}, ${state}${o && o.ai_description ? `. Inspection finding: "${o.ai_description}" (photographed ${day(o.created_at)})` : ''}`);
        }
      }
    }

    // Other ACC applications at the same address.
    const ar = await supabase.from('acc_decisions')
      .select('id, reference_number, status, decision_type, project_summary, created_at, decided_at, homeowner_address')
      .eq('community_id', communityId).ilike('homeowner_address', `${num} %`).order('created_at', { ascending: false }).limit(25);
    if (ar.error) warn('ACC cases', ar.error);
    const accs = await require('./effective').withEffective(supabase, (ar.data || []).filter((a) => a.id !== excludeId && !['withdrawn', 'archived'].includes(a.status) && canon(a.homeowner_address) === target));
    if (accs.length) {
      lines.push('OTHER ACC APPLICATIONS AT THIS ADDRESS:');
      for (const a of accs.slice(0, 10)) {
        lines.push(`- ${a.reference_number || 'case'} (${day(a.created_at)}): "${String(a.project_summary || '').slice(0, 140)}", ${a.status}${a.status === 'decided' ? `, ${a.decision_type || 'decided'} ${day((a.effective && a.effective.finalized_at) || a.decided_at)}${a.effective ? ` (revised; originally ${a.original_decision_type} ${day(a.decided_at)})` : ''}` : ''}`);
      }
    }
    if (!lines.length) return '';
    return `PROPERTY RECORDS IN TRUSTED (internal evidence; use it, never quote it to the homeowner):\n${lines.join('\n')}\n`
      + 'If this application concerns a condition cited above, review it as the response to that violation: say whether it seeks approval of the existing cited condition or proposes a cure, and decide on that basis. An inspection photo of the lot counts as the photo of the home.';
  } catch (e) {
    console.warn('[acc property-history] skipped:', e.message);
    return '';
  }
}

module.exports = { propertyHistory };
