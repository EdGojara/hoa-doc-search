// =============================================================================
// lib/entity_resolution.js — resolve text addresses + names to entity rows
// =============================================================================
//
// Phase 3 of project_unified_architecture.md. Connects the four knowledge
// silos (ARC decisions, emails, violations, board packets) to the existing
// entity-graph spine (properties + contacts from migration 049).
//
// Two primary jobs:
//   1. ADDRESS → properties.id     ("123 Forest Ln" / "123 Forest Lane" both
//                                   resolve to the same property row)
//   2. NAME + EMAIL → contacts.id  ("Mary Smith" / "Mary J. Smith" with
//                                   mary@example.com all resolve to one row)
//
// Design discipline:
// - Match-only by default. createIfMissing is opt-in — at runtime we generally
//   want to AVOID creating new entities from messy source data; the canonical
//   property + contact list comes from Vantaca sync. Backfill and runtime
//   save-paths can opt-in to creation explicitly when they have justification.
// - Idempotent. Calling resolveProperty twice with the same input returns the
//   same row. No side-effects in match-only mode.
// - Logs unmatched inputs so the backfill script can produce a manual-review
//   queue rather than silently creating duplicates.
//
// =============================================================================

// ----------------------------------------------------------------------------
// Address normalization
// ----------------------------------------------------------------------------
// Canonical form: lowercase, trimmed, no punctuation, street suffixes
// expanded to canonical full forms. Unit numbers preserved separately.
//
// "123 Forest Ln."     → "123 forest lane"
// "123 FOREST LANE #2A" → "123 forest lane" (unit returned separately)
// "123 Forest Ln, Houston, TX 77079" → "123 forest lane"

const STREET_SUFFIXES = {
  ln: 'lane',         lane: 'lane',
  st: 'street',       street: 'street',         str: 'street',
  ave: 'avenue',      avenue: 'avenue',         av: 'avenue',
  rd: 'road',         road: 'road',
  dr: 'drive',        drive: 'drive',
  blvd: 'boulevard',  boulevard: 'boulevard',
  ct: 'court',        court: 'court',
  cir: 'circle',      circle: 'circle',
  pl: 'place',        place: 'place',
  pkwy: 'parkway',    parkway: 'parkway',
  ter: 'terrace',     terrace: 'terrace',
  trl: 'trail',       trail: 'trail',
  way: 'way',
  hwy: 'highway',     highway: 'highway',
  cv: 'cove',         cove: 'cove',
  loop: 'loop',
  xing: 'crossing',   crossing: 'crossing',
  sq: 'square',       square: 'square',
  bnd: 'bend',        bend: 'bend',
  rdg: 'ridge',       ridge: 'ridge',
  vw: 'view',         view: 'view',
  hl: 'hill',         hill: 'hill',
  mdw: 'meadow',      meadow: 'meadow',
  ext: 'extension',
};

const DIRECTION_TOKENS = new Set(['n', 'north', 's', 'south', 'e', 'east', 'w', 'west',
                                  'ne', 'nw', 'se', 'sw',
                                  'northeast', 'northwest', 'southeast', 'southwest']);

function normalizeAddress(addressText) {
  if (addressText == null) return { canonical: null, unit: null };
  let s = String(addressText).toLowerCase().trim();
  if (!s) return { canonical: null, unit: null };

  // Strip everything after the first comma (city/state/zip)
  s = s.split(',')[0].trim();

  // Strip trailing punctuation
  s = s.replace(/[.;:]+$/g, '').trim();

  // Extract unit if present (e.g., "#2A", "Apt 5", "Unit B")
  let unit = null;
  const unitMatch = s.match(/(?:^|\s)(?:#|apt\.?|apartment|unit|ste\.?|suite)\s*([0-9a-z\-]+)\s*$/i);
  if (unitMatch) {
    unit = unitMatch[1].toUpperCase();
    s = s.slice(0, unitMatch.index).trim();
  } else {
    // Trailing "# 2A" without keyword
    const hashMatch = s.match(/\s+#\s*([0-9a-z\-]+)\s*$/i);
    if (hashMatch) {
      unit = hashMatch[1].toUpperCase();
      s = s.slice(0, hashMatch.index).trim();
    }
  }

  // Tokenize, normalize each token
  const tokens = s.split(/\s+/).filter(Boolean).map((t) => t.replace(/\.+$/, ''));

  // Expand street suffix on the LAST token (most common case)
  if (tokens.length > 0) {
    const last = tokens[tokens.length - 1];
    if (STREET_SUFFIXES[last]) {
      tokens[tokens.length - 1] = STREET_SUFFIXES[last];
    }
  }
  // Some addresses have suffix in second-to-last position before a directional
  // (e.g., "123 Main St N") — expand there too
  if (tokens.length >= 2 && DIRECTION_TOKENS.has(tokens[tokens.length - 1])) {
    const secondToLast = tokens[tokens.length - 2];
    if (STREET_SUFFIXES[secondToLast]) {
      tokens[tokens.length - 2] = STREET_SUFFIXES[secondToLast];
    }
  }

  return { canonical: tokens.join(' '), unit };
}

// ----------------------------------------------------------------------------
// Name normalization
// ----------------------------------------------------------------------------
// For matching, we lowercase + strip punctuation + handle "Last, First" → "First Last".
// Returns:
//   canonical: cleaned name string for direct compare
//   tokens:    array of tokens for fuzzy compare (first + last)

function normalizeName(nameText) {
  if (nameText == null) return { canonical: null, tokens: [], first: null, last: null };
  let s = String(nameText).toLowerCase().trim();
  if (!s) return { canonical: null, tokens: [], first: null, last: null };

  // Strip salutations
  s = s.replace(/^(mr|mrs|ms|dr|miss|rev|prof)\.?\s+/i, '');
  // Strip suffixes (Jr, Sr, III, etc.) — keep for display, not for matching
  s = s.replace(/\s+(jr|sr|ii|iii|iv|esq)\.?$/i, '');
  // Punctuation
  s = s.replace(/[.,;]/g, ' ').replace(/\s+/g, ' ').trim();

  // "Last, First" → "First Last"
  const commaMatch = nameText && String(nameText).match(/^([^,]+),\s+(.+)$/);
  if (commaMatch) {
    s = `${commaMatch[2]} ${commaMatch[1]}`.toLowerCase().replace(/[.,;]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  const tokens = s.split(/\s+/).filter(Boolean);
  const first = tokens[0] || null;
  const last = tokens[tokens.length - 1] || null;

  return { canonical: tokens.join(' '), tokens, first, last };
}

function namesAreEquivalent(a, b) {
  if (!a || !b) return false;
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na.canonical || !nb.canonical) return false;
  if (na.canonical === nb.canonical) return true;
  // First + last match, ignoring middle initials/names — common case
  if (na.first && nb.first && na.last && nb.last
      && na.first === nb.first && na.last === nb.last) return true;
  // First initial + last match (less confident but useful)
  if (na.first && nb.first && na.last && nb.last
      && na.last === nb.last
      && (na.first[0] === nb.first[0] && (na.first.length === 1 || nb.first.length === 1))) return true;
  return false;
}

// ----------------------------------------------------------------------------
// Property resolution
// ----------------------------------------------------------------------------

/**
 * Find a property matching the address text in a given community.
 * Match-only — returns null when no candidate matches. Use resolveProperty
 * with createIfMissing for create-on-miss semantics.
 */
async function findProperty(supabase, communityId, addressText) {
  if (!supabase || !communityId || !addressText) return null;
  const { canonical, unit } = normalizeAddress(addressText);
  if (!canonical) return null;

  // Pull all candidates in the community — properties tables are small
  // (one row per home; at portfolio scale ~10k rows max).
  const { data: candidates, error } = await supabase
    .from('properties')
    .select('id, street_address, unit, community_id, vantaca_account_id')
    .eq('community_id', communityId);

  if (error || !candidates) return null;

  // Exact normalized match
  for (const c of candidates) {
    const norm = normalizeAddress(c.street_address);
    if (norm.canonical === canonical) {
      // If we extracted a unit and the candidate has one, require unit match too.
      if (unit && c.unit && String(c.unit).toUpperCase() !== unit) continue;
      return { ...c, match_method: 'exact_normalized', match_confidence: 'high' };
    }
  }

  // Suffix-agnostic fallback: staff often type (or a scan reads) an address
  // WITHOUT the street suffix — "4935 Ivory Meadows" for "4935 Ivory Meadows
  // Lane". The exact match above fails because "lane" is missing. Match on house
  // number + street name ignoring the suffix, and accept it only when exactly
  // ONE property in the community fits (so we never guess between "… Lane" and
  // "… Court").
  const SUFFIX_VALUES = new Set(Object.values(STREET_SUFFIXES));
  const streetCore = (canon) => {
    const toks = (canon || '').split(' ').filter(Boolean);
    if (toks.length > 2 && SUFFIX_VALUES.has(toks[toks.length - 1])) toks.pop();
    return toks.join(' ');
  };
  const inCore = streetCore(canonical);
  if (inCore && /^\d/.test(inCore)) {
    const near = candidates.filter((c) => streetCore(normalizeAddress(c.street_address).canonical) === inCore);
    if (near.length === 1) {
      const c = near[0];
      if (!(unit && c.unit && String(c.unit).toUpperCase() !== unit)) {
        return { ...c, match_method: 'suffix_agnostic', match_confidence: 'medium' };
      }
    }
  }
  return null;
}

/**
 * Match-or-create. createIfMissing creates a new properties row with the
 * canonical address; useful at runtime when source data is trusted (e.g.,
 * Vantaca-sourced ARC submissions). Avoid in backfill — log unmatched rows
 * for manual review instead.
 */
async function resolveProperty(supabase, communityId, addressText, options = {}) {
  const matched = await findProperty(supabase, communityId, addressText);
  if (matched) return matched;
  if (!options.createIfMissing) return null;

  const { canonical, unit } = normalizeAddress(addressText);
  if (!canonical) return null;

  // Display form: title-case the canonical
  const display = canonical.replace(/\b\w/g, (m) => m.toUpperCase());

  const { data: created, error } = await supabase
    .from('properties')
    .insert({
      community_id:   communityId,
      street_address: display,
      unit:           unit || null,
      notes:          options.creationNote || `Created via entity_resolution from "${addressText}".`,
    })
    .select('id, street_address, unit, community_id')
    .single();
  if (error) {
    console.warn('[entity_resolution] property create failed:', error.message);
    return null;
  }
  return { ...created, match_method: 'created', match_confidence: 'medium' };
}

// ----------------------------------------------------------------------------
// Contact resolution
// ----------------------------------------------------------------------------

/**
 * Find a contact by email first (highest confidence), name+community fallback.
 *
 * opts: { email, name, communityId, propertyId }
 *
 * If communityId or propertyId is provided, name-matching restricts to
 * contacts already linked to that community via property_ownerships /
 * property_residencies — much higher signal than raw name match.
 */
async function findContact(supabase, opts) {
  const { email, name, communityId, propertyId } = opts || {};
  if (!supabase) return null;

  // 1. Email match — highest confidence
  if (email && String(email).trim()) {
    const lower = String(email).toLowerCase().trim();
    const { data: hits } = await supabase
      .from('contacts')
      .select('id, full_name, primary_email, secondary_email')
      .or(`primary_email.eq.${lower},secondary_email.eq.${lower}`)
      .limit(2);
    if (hits && hits.length === 1) {
      return { ...hits[0], match_method: 'email', match_confidence: 'high' };
    }
    if (hits && hits.length > 1) {
      // Email collision — extremely rare but possible. Fall through to name match.
    }
  }

  if (!name || !String(name).trim()) return null;

  // 2. Name + property scope (highest non-email confidence)
  if (propertyId) {
    const { data: ownerHits } = await supabase
      .from('property_ownerships')
      .select('contact_id, contacts:contact_id(id, full_name, primary_email)')
      .eq('property_id', propertyId)
      .is('end_date', null);
    for (const r of ownerHits || []) {
      const c = r.contacts;
      if (c && namesAreEquivalent(c.full_name, name)) {
        return { ...c, match_method: 'name_via_property', match_confidence: 'high' };
      }
    }
    const { data: residentHits } = await supabase
      .from('property_residencies')
      .select('contact_id, contacts:contact_id(id, full_name, primary_email)')
      .eq('property_id', propertyId)
      .is('end_date', null);
    for (const r of residentHits || []) {
      const c = r.contacts;
      if (c && namesAreEquivalent(c.full_name, name)) {
        return { ...c, match_method: 'name_via_residency', match_confidence: 'high' };
      }
    }
  }

  // 3. Name + community scope (medium confidence)
  if (communityId) {
    const { data: communityContacts } = await supabase
      .from('property_ownerships')
      .select('contact_id, contacts:contact_id(id, full_name, primary_email), properties:property_id(community_id)')
      .is('end_date', null);
    const inCommunity = (communityContacts || []).filter(
      (r) => r.properties && r.properties.community_id === communityId
    );
    for (const r of inCommunity) {
      const c = r.contacts;
      if (c && namesAreEquivalent(c.full_name, name)) {
        return { ...c, match_method: 'name_via_community', match_confidence: 'medium' };
      }
    }
  }

  // 4. Cross-community name match (lowest confidence) — only when nothing else
  //    narrows the scope. Returns the FIRST match; logs ambiguity for review.
  const { data: anyMatch } = await supabase
    .from('contacts')
    .select('id, full_name, primary_email')
    .ilike('full_name', `%${String(name).split(/\s+/)[0]}%`)
    .limit(20);
  const exactName = (anyMatch || []).filter((c) => namesAreEquivalent(c.full_name, name));
  if (exactName.length === 1) {
    return { ...exactName[0], match_method: 'name_global_unique', match_confidence: 'low' };
  }
  if (exactName.length > 1) {
    return { ambiguous: true, candidates: exactName.slice(0, 5), match_method: 'name_global_ambiguous' };
  }

  return null;
}

/**
 * Match-or-create. createIfMissing creates a new contacts row.
 * Sparingly used — emails arriving with no community context shouldn't
 * create contacts at runtime; let staff review-and-assign instead.
 */
async function resolveContact(supabase, opts) {
  const result = await findContact(supabase, opts);
  if (result && !result.ambiguous) return result;
  if (!opts || !opts.createIfMissing) return result; // may be null or ambiguous

  const { name, email } = opts;
  if (!name || !String(name).trim()) return null;

  const { data: created, error } = await supabase
    .from('contacts')
    .insert({
      full_name:      String(name).trim(),
      primary_email:  email ? String(email).toLowerCase().trim() : null,
      notes:          opts.creationNote || 'Created via entity_resolution.',
    })
    .select('id, full_name, primary_email')
    .single();
  if (error) {
    console.warn('[entity_resolution] contact create failed:', error.message);
    return null;
  }
  return { ...created, match_method: 'created', match_confidence: 'medium' };
}

// ----------------------------------------------------------------------------
// Exports
// ----------------------------------------------------------------------------
module.exports = {
  normalizeAddress,
  normalizeName,
  namesAreEquivalent,
  findProperty,
  resolveProperty,
  findContact,
  resolveContact,
};
