// ============================================================================
// lib/applications/extraction/reconcile_unit.js
// ----------------------------------------------------------------------------
// Reconcile the submitted address against the system-of-record via
// community_addresses. FLAG-DON'T-FIX per the brief: on mismatch or no-match
// we raise a block flag and set readyForEvaluation=false. We never auto-
// correct the link.
//
// Returns { unitMatchStatus, unitId, addressOfRecord, matchedRow }.
// ============================================================================

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[.,#]+/g, ' ')
    .replace(/\b(street|st)\.?\b/g, 'st')
    .replace(/\b(drive|dr)\.?\b/g, 'dr')
    .replace(/\b(lane|ln)\.?\b/g, 'ln')
    .replace(/\b(road|rd)\.?\b/g, 'rd')
    .replace(/\b(court|ct)\.?\b/g, 'ct')
    .replace(/\b(boulevard|blvd)\.?\b/g, 'blvd')
    .replace(/\b(avenue|ave)\.?\b/g, 'ave')
    .replace(/\b(circle|cir)\.?\b/g, 'cir')
    .replace(/\b(trail|trl)\.?\b/g, 'trl')
    .replace(/\b(parkway|pkwy)\.?\b/g, 'pkwy')
    .replace(/\bway\b/g, 'way')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Reconcile a submitted address against community_addresses for the given community.
 *
 * @param {object} args
 * @param {string} args.submittedAddress — the address string from the form / first doc
 * @param {string} args.communityId — the community we should be matching within
 * @returns {Promise<{unitMatchStatus, unitId, addressOfRecord, matchedRow}>}
 */
async function reconcileUnit({ submittedAddress, communityId }, opts = {}) {
  const logger = opts.logger || console;
  if (!submittedAddress || !communityId) {
    return { unitMatchStatus: 'not_found', unitId: null, addressOfRecord: null, matchedRow: null };
  }
  const norm = normalize(submittedAddress);

  try {
    // Try exact normalized match first (community_addresses already stores
    // full_address_normalized — fast path)
    const { data: exact } = await supabase
      .from('community_addresses')
      .select('id, community_id, full_address_raw, full_address_normalized, street_number, street_name, street_type, unit_number, city, state, zip_code')
      .eq('community_id', communityId)
      .eq('is_active', true)
      .eq('full_address_normalized', norm)
      .limit(1);
    if (exact && exact.length > 0) {
      const row = exact[0];
      return {
        unitMatchStatus: 'matched',
        unitId: row.id,
        addressOfRecord: row.full_address_raw,
        matchedRow: row,
      };
    }

    // Fuzzy: ILIKE on the street portion (extract first chunk before comma)
    const streetCandidate = norm.split(',')[0].trim();
    if (streetCandidate.length >= 6) {
      const { data: fuzzy } = await supabase
        .from('community_addresses')
        .select('id, community_id, full_address_raw, full_address_normalized')
        .eq('community_id', communityId)
        .eq('is_active', true)
        .ilike('full_address_normalized', `%${streetCandidate}%`)
        .limit(5);
      if (fuzzy && fuzzy.length > 0) {
        // Pick the highest-similarity row — for v1 just pick the first;
        // a Levenshtein/trigram ranking would be a follow-up
        const row = fuzzy[0];
        return {
          unitMatchStatus: 'matched',
          unitId: row.id,
          addressOfRecord: row.full_address_raw,
          matchedRow: row,
        };
      }
    }

    // Try address-not-scoped-to-community: maybe the submitter typed the
    // address but the link is wrong → distinguish "exists elsewhere" (mismatch)
    // from "not found anywhere" (not_found).
    if (streetCandidate.length >= 6) {
      const { data: other } = await supabase
        .from('community_addresses')
        .select('id, community_id, full_address_raw')
        .eq('is_active', true)
        .ilike('full_address_normalized', `%${streetCandidate}%`)
        .neq('community_id', communityId)
        .limit(1);
      if (other && other.length > 0) {
        return {
          unitMatchStatus: 'mismatch',
          unitId: null,
          addressOfRecord: other[0].full_address_raw,
          matchedRow: other[0],
        };
      }
    }

    return { unitMatchStatus: 'not_found', unitId: null, addressOfRecord: null, matchedRow: null };
  } catch (err) {
    logger.warn(`[reconcile_unit] lookup failed: ${err.message}`);
    return { unitMatchStatus: 'not_found', unitId: null, addressOfRecord: null, matchedRow: null, error: err.message };
  }
}

module.exports = { reconcileUnit, normalize };
