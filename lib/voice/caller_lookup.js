// ============================================================================
// lib/voice/caller_lookup.js — shared caller-ID resolution
// ----------------------------------------------------------------------------
// Resolves an inbound phone number to:
//   - The matching contacts row (by primary/secondary/notification phone)
//   - Their current primary property (via property_residencies)
//   - The property's community
//
// Used by:
//   - api/voice.js POST /incoming         (old Twilio bridge — extracted from
//                                          inline logic for sharing)
//   - api/voice.js POST /vapi-assistant-
//     request                              (Vapi inbound — builds dynamic
//                                          firstMessage + assistantOverrides)
//
// Why a shared helper: the same lookup logic was duplicated across surfaces.
// Phone normalization (last-10-digit match) + multi-field ILIKE + exact-match
// filter is non-trivial and easy to get subtly wrong per-call-site. One
// canonical implementation = one place to fix bugs.
//
// Privacy note (mirrors existing inline doc): caller-ID can be spoofed. The
// result is for greeting/context only. Sensitive operations (AR balance,
// payment, ARC outcomes) still require Claire to verify identity before
// sharing — enforced in the system prompt, not here.
// ============================================================================

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/**
 * Resolve a phone number to its homeowner context.
 *
 * @param {string} phoneE164 — caller's phone, ideally E.164 (e.g. "+18324302956").
 *                              Other formats are normalized to last-10-digit match.
 * @returns {Promise<{
 *   contact: { id, full_name, preferred_name, first_name, primary_phone } | null,
 *   property: { id, street_address, community_id } | null,
 *   community: { id, name } | null
 * }>}
 */
async function resolveCallerByPhone(phoneE164) {
  const empty = { contact: null, property: null, community: null };
  if (!phoneE164) return empty;

  const digits = String(phoneE164).replace(/\D/g, '');
  const last10 = digits.length === 11 && digits.startsWith('1')
    ? digits.slice(1)
    : (digits.length === 10 ? digits : null);
  if (!last10) return empty;

  // ILIKE %last10% catches all common stored formats:
  //   "832-430-2956", "(832) 430-2956", "+18324302956", "8324302956"
  const { data: candidates, error: candErr } = await supabase
    .from('contacts')
    .select('id, full_name, preferred_name, primary_phone, secondary_phone, notification_phone, preferred_language')
    .or(`primary_phone.ilike.%${last10}%,secondary_phone.ilike.%${last10}%,notification_phone.ilike.%${last10}%`)
    .limit(5);
  if (candErr) return empty;

  // Filter to EXACT 10-digit match — guard against substring collisions
  // (e.g., last10="1234567890" matching "+15551234567890").
  const contact = (candidates || []).find((c) => {
    for (const f of ['primary_phone', 'secondary_phone', 'notification_phone']) {
      const d = String(c[f] || '').replace(/\D/g, '').slice(-10);
      if (d === last10) return true;
    }
    return false;
  }) || null;

  if (!contact) return empty;

  // First-name helper — preferred_name if set, else first word of full_name.
  const firstName = (contact.preferred_name || contact.full_name || '').trim().split(/\s+/)[0] || null;

  // Look up their primary property + community via property_residencies.
  // Current residency = end_date IS NULL. Most recent start_date wins if
  // multiple (e.g., split-ownership edge cases).
  let property = null;
  let community = null;
  try {
    const { data: residency } = await supabase
      .from('property_residencies')
      .select(`
        property_id, residency_type,
        properties:property_id(id, street_address, community_id, communities:community_id(id, name))
      `)
      .eq('contact_id', contact.id)
      .is('end_date', null)
      .order('start_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (residency?.properties) {
      property = {
        id: residency.properties.id,
        street_address: residency.properties.street_address,
        community_id: residency.properties.community_id,
      };
      community = residency.properties.communities
        ? { id: residency.properties.communities.id, name: residency.properties.communities.name }
        : null;
    }
  } catch (_) { /* swallow — return what we have */ }

  return {
    contact: {
      id: contact.id,
      full_name: contact.full_name,
      preferred_name: contact.preferred_name,
      first_name: firstName,
      primary_phone: contact.primary_phone,
      // ISO 639-1 language code from contacts.preferred_language. NULL = unknown.
      // Consumed by /api/voice/vapi-assistant-request to pick the right
      // persona (Claire English vs Isabella Spanish vs future Mei/Linh/Jin-Soo).
      preferred_language: contact.preferred_language || null,
    },
    property,
    community,
  };
}

module.exports = { resolveCallerByPhone };
