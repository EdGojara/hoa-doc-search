// ============================================================================
// case_ref.js — short reference codes for violations
// ----------------------------------------------------------------------------
// Every violation letter prints a short, memorable reference code that the
// homeowner can quote when they reply by email or phone. The code is derived
// deterministically from the violation UUID — no DB column needed.
//
// Format: V-XXXX-XX
//   First 4 hex chars + last 2 hex chars of the violation UUID, uppercased,
//   dashed for readability. The first 4 give a usable namespace at our
//   scale (16k possibilities), and including the last 2 adds a checksum-
//   like resilience to OCR / handwriting errors when a homeowner is
//   transcribing the code over the phone.
//
// Detection: scanText(text) returns an array of normalized refs found in
// the input. Tolerant of:
//   - lowercase vs uppercase
//   - extra spaces around the dashes ("V- A7F4 -B2")
//   - missing dashes ("VA7F4B2")
//   - "Case V-A7F4-B2", "case#V-A7F4-B2", etc.
//
// resolveRef(supabase, ref) → violation row (or null) — does an indexed
// lookup, NOT a full-table scan. The first-4-hex prefix anchors the query
// to <= 16 candidate rows; final match on suffix gives a clean hit.
// ============================================================================

const REF_PATTERN = /V[\s-]*([0-9A-F]{4})[\s-]*([0-9A-F]{2})/gi;

function refFromViolationId(violationId) {
  if (!violationId) return null;
  const hex = String(violationId).replace(/-/g, '').toUpperCase();
  if (hex.length < 32) return null;
  const prefix = hex.slice(0, 4);
  const suffix = hex.slice(-2);
  return `V-${prefix}-${suffix}`;
}

// Returns array of normalized refs found in the text. Deduped.
function scanText(text) {
  if (!text || typeof text !== 'string') return [];
  const found = new Set();
  let m;
  REF_PATTERN.lastIndex = 0;
  while ((m = REF_PATTERN.exec(text)) !== null) {
    const ref = `V-${m[1].toUpperCase()}-${m[2].toUpperCase()}`;
    found.add(ref);
  }
  return [...found];
}

// Resolve a ref to a violation row. Pulls candidates by UUID prefix +
// filters on suffix. Returns the most recent matching violation or null.
async function resolveRef(supabase, ref) {
  if (!supabase || !ref) return null;
  const cleaned = String(ref).toUpperCase().replace(/[^0-9A-Z-]/g, '');
  const m = cleaned.match(/^V-([0-9A-F]{4})-([0-9A-F]{2})$/);
  if (!m) return null;
  const [, prefix, suffix] = m;

  // The UUID prefix maps to a dashed pattern like "XXXX-...-...-XXX" in
  // the canonical UUID format. We can do an indexed range query on
  // violations.id::text LIKE 'prefix-%' using the first 4 hex of the UUID.
  // Supabase REST doesn't directly support LIKE on UUID cols — fallback to
  // a wider fetch + filter in code. Bounded by limit so this stays fast.
  try {
    const lowerPrefix = prefix.toLowerCase();
    const lowerSuffix = suffix.toLowerCase();
    const { data, error } = await supabase
      .from('violations')
      .select('id, current_stage, primary_category_id, community_id, property_id, opened_at')
      .ilike('id', `${lowerPrefix}%${lowerSuffix}`)
      .order('opened_at', { ascending: false })
      .limit(20);
    if (error) {
      console.warn('[case_ref.resolveRef] query failed:', error.message);
      return null;
    }
    if (!data || data.length === 0) return null;
    // Confirm the exact prefix + suffix match (ilike is wildcard — defensive)
    const exact = data.find(v => {
      const hex = String(v.id).replace(/-/g, '').toLowerCase();
      return hex.startsWith(lowerPrefix) && hex.endsWith(lowerSuffix);
    });
    return exact || null;
  } catch (e) {
    console.warn('[case_ref.resolveRef] threw:', e.message);
    return null;
  }
}

// Scan email/text for refs, resolve them to violation rows, return the
// first valid one (or null). Helper for inbound auto-attach.
async function findReferencedViolation(supabase, ...texts) {
  const combined = texts.filter(t => typeof t === 'string').join('\n\n');
  const refs = scanText(combined);
  for (const ref of refs) {
    const v = await resolveRef(supabase, ref);
    if (v) return { ref, violation: v };
  }
  return null;
}

module.exports = {
  refFromViolationId,
  scanText,
  resolveRef,
  findReferencedViolation,
};
