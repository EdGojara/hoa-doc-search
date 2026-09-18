// ============================================================================
// lib/enforcement/health.js — ONE source of truth for enforcement data health.
// ----------------------------------------------------------------------------
// The enforcement state machine (observation -> confirm -> letter -> escalate ->
// cure) is written by several paths and drifts SILENTLY. We kept finding the
// drift one class at a time, so "Eaglewood is at zero" only ever meant zero of
// the one metric measured that day (Ed 2026-09-18: "why does this keep changing,
// you need a better way to track these"). This computes EVERY known divergence
// class at once, per community, so there is a single number to drive to zero and
// keep at zero. The admin health page and the CLI audit both call this — no
// second definition to drift.
//
// Classes tracked (each is a bug when > 0):
//   dup_risk           pending obs whose own case's first notice was ALREADY MAILED
//                      (confirming would send a duplicate)
//   category_phantom   open violation whose category != its observation's current
//                      category (category changed after auto-open); split into
//                      void_safe (corrected category already open -> void) and
//                      needs_recategorize (no corrected case -> re-point)
//   rejected_open      open violation whose originating observation was REJECTED
//                      (should have been voided)
//   orphan_drafts      draft/live letter sitting on a terminal (voided/cured) violation
//   open_no_letter     open courtesy_1 with no letter of any kind
//   stale_pending      observation pending older than STALE_DAYS
// Plus context counts: pending, open_violations.
// ============================================================================
const STALE_DAYS = 30;

async function _aliasCanon(supabase) {
  const { data } = await supabase.from('enforcement_category_aliases')
    .select('alias_category_id, canonical_category_id').eq('status', 'confirmed');
  const m = {}; (data || []).forEach((a) => { m[a.alias_category_id] = a.canonical_category_id; });
  return (c) => m[c] || c;
}

// One community's health. Returns a metrics object; `clean` true iff no bug class > 0.
async function communityHealth(supabase, community, canon) {
  const cid = community.id;
  const page = async (t, sel, f) => {
    let out = [], fr = 0;
    for (;;) {
      let q = supabase.from(t).select(sel).eq('community_id', cid).order('id', { ascending: true }).range(fr, fr + 999);
      if (f) q = f(q);
      const { data, error } = await q;
      if (error) throw new Error(t + ': ' + error.message);
      out = out.concat(data); if (data.length < 1000) break; fr += 1000;
    }
    return out;
  };

  const pend = await page('property_observations', 'id, category_id, created_at', (q) => q.eq('reviewer_status', 'pending'));
  const vios = await page('violations', 'id, property_id, primary_category_id, current_stage, resolved_at, opened_from_observation_id');
  const openV = vios.filter((v) => !['cured', 'closed', 'voided'].includes(v.current_stage) && !v.resolved_at);

  // observation lookups we need
  const obsIds = [...new Set([
    ...pend.map((o) => o.id),
    ...openV.map((v) => v.opened_from_observation_id).filter(Boolean),
  ])];
  const obs = {};
  for (let i = 0; i < obsIds.length; i += 200) {
    const { data } = await supabase.from('property_observations').select('id, category_id, reviewer_status').in('id', obsIds.slice(i, i + 200));
    (data || []).forEach((o) => { obs[o.id] = o; });
  }

  // letters: sent + live drafts, per violation
  const vioIds = vios.map((v) => v.id);
  const sentVio = new Set(); const liveDraftVio = new Set(); const c1MailedVio = new Set();
  for (let i = 0; i < vioIds.length; i += 200) {
    const { data } = await supabase.from('interactions')
      .select('violation_id, status, type, mailed_at').in('violation_id', vioIds.slice(i, i + 200)).ilike('type', 'letter%');
    (data || []).forEach((l) => {
      if (l.status === 'sent') { sentVio.add(l.violation_id); if (l.type === 'letter_courtesy_1') c1MailedVio.add(l.violation_id); }
      if (l.mailed_at && l.type === 'letter_courtesy_1') c1MailedVio.add(l.violation_id);
      if (['draft', 'awaiting_approval', 'approved', 'printed'].includes(l.status)) liveDraftVio.add(l.violation_id);
    });
  }

  const byPC = {}; openV.forEach((v) => (byPC[v.property_id + '|' + canon(v.primary_category_id)] = byPC[v.property_id + '|' + canon(v.primary_category_id)] || []).push(v));

  // dup_risk: pending obs whose own-case violation already mailed its first notice
  const pendIds = new Set(pend.map((o) => o.id));
  const ownCase = openV.filter((v) => v.opened_from_observation_id && pendIds.has(v.opened_from_observation_id));
  const dup_risk = ownCase.filter((v) => c1MailedVio.has(v.id) || (v.current_stage && v.current_stage !== 'courtesy_1')).length;

  // category_phantom: open violation whose category != its observation's category
  let phantom_void_safe = 0, phantom_needs_recat = 0;
  openV.forEach((v) => {
    const o = v.opened_from_observation_id && obs[v.opened_from_observation_id];
    if (!o || !o.category_id) return;
    if (canon(o.category_id) === canon(v.primary_category_id)) return;
    const correct = canon(o.category_id);
    const others = (byPC[v.property_id + '|' + correct] || []).filter((x) => x.id !== v.id);
    if (others.length) phantom_void_safe++; else phantom_needs_recat++;
  });

  // rejected_open: open violation whose originating observation is rejected
  const rejected_open = openV.filter((v) => v.opened_from_observation_id && obs[v.opened_from_observation_id] && obs[v.opened_from_observation_id].reviewer_status === 'rejected').length;

  // orphan_drafts: live letter on a terminal violation
  const terminal = new Set(vios.filter((v) => ['voided', 'cured', 'closed'].includes(v.current_stage) || v.resolved_at).map((v) => v.id));
  let orphan_drafts = 0;
  const termIds = [...terminal];
  for (let i = 0; i < termIds.length; i += 200) {
    const { data } = await supabase.from('interactions').select('id').in('violation_id', termIds.slice(i, i + 200)).ilike('type', 'letter%').in('status', ['draft', 'awaiting_approval', 'approved', 'printed']);
    orphan_drafts += (data || []).length;
  }

  // open_no_letter: open courtesy_1 with no letter at all
  const anyLetterVio = new Set([...sentVio, ...liveDraftVio]);
  const open_no_letter = openV.filter((v) => v.current_stage === 'courtesy_1' && !anyLetterVio.has(v.id)).length;

  // stale_pending
  const cutoff = Date.now() - STALE_DAYS * 864e5;
  const stale_pending = pend.filter((o) => o.created_at && new Date(o.created_at).getTime() < cutoff).length;

  const bugs = { dup_risk, phantom_void_safe, phantom_needs_recat, rejected_open, orphan_drafts, open_no_letter };
  const problems = Object.values(bugs).reduce((a, b) => a + b, 0);
  return {
    community_id: cid, name: community.name,
    pending: pend.length, open_violations: openV.length,
    ...bugs,
    problems,
    clean: problems === 0,
  };
}

// All communities (or one). Returns { generated_at, stale_days, communities:[...], totals:{...}, clean }
async function enforcementHealth(supabase, { communityId = null } = {}) {
  const canon = await _aliasCanon(supabase);
  let comms;
  if (communityId) { const { data } = await supabase.from('communities').select('id, name').eq('id', communityId); comms = data || []; }
  else { const { data } = await supabase.from('communities').select('id, name').order('name'); comms = data || []; }
  const rows = [];
  for (const c of comms) rows.push(await communityHealth(supabase, c, canon));
  const totals = {};
  for (const k of ['pending', 'open_violations', 'dup_risk', 'phantom_void_safe', 'phantom_needs_recat', 'rejected_open', 'orphan_drafts', 'open_no_letter', 'problems']) {
    totals[k] = rows.reduce((a, r) => a + (r[k] || 0), 0);
  }
  return { generated_at: new Date().toISOString(), stale_days: STALE_DAYS, communities: rows, totals, clean: totals.problems === 0 };
}

module.exports = { enforcementHealth, communityHealth, STALE_DAYS };
