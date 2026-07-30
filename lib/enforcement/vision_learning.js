// ============================================================================
// lib/enforcement/vision_learning.js  (Ed 2026-07-30)
// ----------------------------------------------------------------------------
// Step 2 of the photo-AI learning loop. Step 1 (scorecard) captured the signal:
// property_observations.ai_suggested_category_id = what the AI guessed, and
// reviewer_status (confirmed/rejected) + category_id = what it actually was.
// This turns that history into a compact "learned corrections" block that gets
// injected into the vision prompt, so every correction a reviewer makes teaches
// the next inspection. Two signals:
//   - REJECTED observations       -> the AI over-flagged that category (false positive)
//   - CONFIRMED but recategorized -> the AI picked the wrong category (X should be Y)
// Community-scoped, recent-weighted, capped so the prompt stays lean. This is
// the loop that compounds accuracy as drone/field volume grows.
// ============================================================================

const LOOKBACK_DAYS = 120;
const MAX_LINES = 10;

// Build the learned-corrections text for a community. Returns '' when there is
// nothing to teach yet (so the prompt is unchanged for fresh communities).
async function buildLearnedCorrections(supabase, communityId, opts = {}) {
  if (!supabase || !communityId) return '';
  const lookback = opts.lookbackDays || LOOKBACK_DAYS;
  try {
    // Recent inspections for this community (bounded).
    const sinceIso = new Date(Date.now() - lookback * 86400000).toISOString();
    const { data: insps } = await supabase
      .from('inspections').select('id').eq('community_id', communityId)
      .gte('created_at', sinceIso).order('created_at', { ascending: false }).limit(500);
    const inspIds = (insps || []).map((i) => i.id);
    if (!inspIds.length) return '';

    // Observations with a captured AI guess that a human then confirmed or rejected.
    const obs = [];
    for (let i = 0; i < inspIds.length; i += 100) {
      const { data } = await supabase
        .from('property_observations')
        .select('category_id, ai_suggested_category_id, reviewer_status')
        .in('inspection_id', inspIds.slice(i, i + 100))
        .not('ai_suggested_category_id', 'is', null)
        .in('reviewer_status', ['confirmed', 'rejected']);
      obs.push(...(data || []));
    }
    if (!obs.length) return '';

    // Category id -> label.
    const catIds = [...new Set(obs.flatMap((o) => [o.ai_suggested_category_id, o.category_id]).filter(Boolean))];
    const labelById = {};
    for (let i = 0; i < catIds.length; i += 100) {
      const { data: cats } = await supabase.from('enforcement_categories').select('id, label').in('id', catIds.slice(i, i + 100));
      (cats || []).forEach((c) => { labelById[c.id] = c.label; });
    }

    // Tally the two signals.
    const rejected = {};      // ai_suggested label -> count of false positives
    const recategorized = {}; // "X -> Y" -> count
    for (const o of obs) {
      const guess = labelById[o.ai_suggested_category_id];
      if (!guess) continue;
      if (o.reviewer_status === 'rejected') {
        rejected[guess] = (rejected[guess] || 0) + 1;
      } else if (o.reviewer_status === 'confirmed' && o.category_id && o.category_id !== o.ai_suggested_category_id) {
        const to = labelById[o.category_id];
        if (to) { const k = `${guess}=>${to}`; recategorized[k] = (recategorized[k] || 0) + 1; }
      }
    }

    const lines = [];
    Object.entries(recategorized).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => {
      const [from, to] = k.split('=>');
      lines.push({ n, text: `When a condition looks like "${from}" but fits "${to}" better, choose "${to}" — reviewers corrected "${from}" to "${to}" ${n}x recently here.` });
    });
    Object.entries(rejected).sort((a, b) => b[1] - a[1]).forEach(([label, n]) => {
      if (n < 2) return; // one-off rejections are noise
      lines.push({ n, text: `Be strict with "${label}" — reviewers rejected it as a false positive ${n}x recently here. Only flag it when the photo clearly meets its definition.` });
    });
    if (!lines.length) return '';

    const top = lines.sort((a, b) => b.n - a.n).slice(0, MAX_LINES).map((l) => '- ' + l.text);
    return [
      '',
      'LEARNED FROM RECENT INSPECTIONS IN THIS COMMUNITY (real reviewer corrections — apply these; they override a first-glance guess):',
      ...top,
    ].join('\n');
  } catch (e) {
    console.warn('[vision_learning] buildLearnedCorrections failed (non-fatal):', e.message);
    return '';
  }
}

module.exports = { buildLearnedCorrections };
