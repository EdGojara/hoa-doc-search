// ============================================================================
// lib/enforcement/latest_evidence.js  (Ed 2026-09-08)
// ----------------------------------------------------------------------------
// A violation notice must show the property as it looks NOW, not the photo from
// the first notice. A Second Notice for 527 Shady Brook rendered the Aug 3 photo
// and "follow-up inspection conducted on August 3" even though the property was
// re-driven Sept 1 and a fresh Sept 1 photo was captured — so the letter could
// not tell anyone whether the owner had cured it (he had cut the branches back),
// and we were one click from escalating an already-fixed violation.
//
// Every letter path fetched evidence from the violation's OPENING observation
// (opened_from_observation_id). This resolves the FRESHEST evidence instead: the
// most recent re-inspection (violation_continuations, newest noted_at) with its
// own inspection photo + capture date, falling back to the opening observation
// only when there has been no continuation.
// ============================================================================

/**
 * @param supabase
 * @param violationId
 * @param openingObservation  the row already loaded for opened_from_observation_id,
 *   shape { created_at, inspection_photos: { captured_at, storage_path, paired_wide_photo_id } }
 * @returns { storage_path, captured_at, paired_wide_photo_id, source: 'continuation'|'opening' }
 */
async function latestEvidence(supabase, violationId, openingObservation) {
  try {
    const { data: cont } = await supabase.from('violation_continuations')
      .select('inspection_photo_id, noted_at')
      .eq('violation_id', violationId)
      .order('noted_at', { ascending: false }).limit(1);
    const c = cont && cont[0];
    if (c && c.inspection_photo_id) {
      const { data: ph } = await supabase.from('inspection_photos')
        .select('storage_path, captured_at, paired_wide_photo_id')
        .eq('id', c.inspection_photo_id).maybeSingle();
      if (ph && ph.storage_path) {
        return {
          inspection_photo_id: c.inspection_photo_id,
          storage_path: ph.storage_path,
          captured_at: ph.captured_at || c.noted_at,
          paired_wide_photo_id: ph.paired_wide_photo_id || null,
          source: 'continuation',
        };
      }
    }
  } catch (_) { /* fall back to the opening observation */ }
  const p = openingObservation && openingObservation.inspection_photos;
  return {
    inspection_photo_id: (openingObservation && openingObservation.inspection_photo_id) || null,
    storage_path: (p && p.storage_path) || null,
    captured_at: (p && p.captured_at) || (openingObservation && openingObservation.created_at) || null,
    paired_wide_photo_id: (p && p.paired_wide_photo_id) || null,
    source: 'opening',
  };
}

module.exports = { latestEvidence };
