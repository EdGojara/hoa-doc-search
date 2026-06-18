// ============================================================================
// lib/enforcement/match_violation_from_text.js
// ----------------------------------------------------------------------------
// Ed 2026-06-18: when Claire logs an inbound call (or an email comes in), the
// note should attach to the open violation the caller is actually talking
// about — "they called about the fence" lands on the fence case — so it shows
// inline on the drive instead of in a flat timeline.
//
// Pure, deterministic, no I/O. Given the call's free text (concern + next step)
// and the property's OPEN violations, score each case by how many of its
// category "signal terms" appear in the text, and return the single best match
// ONLY when it is unambiguous. When nothing matches, or two cases tie, return
// null — we never guess a case onto a note. A wrong auto-tag is worse than no
// tag: it makes the timeline lie about what the homeowner said.
// ============================================================================

// Synonym groups for the common HOA violation vocabulary. Each group is a set
// of interchangeable terms; if ANY term appears in BOTH the violation's
// category text and the call text, that's a hit. Keep terms lowercase and
// singular-ish; the tokenizer strips trailing 's'. This is intentionally
// conservative — only well-known equivalences, so we don't over-match.
const SYNONYM_GROUPS = [
  ['fence', 'fencing'],
  ['lawn', 'mow', 'mowing', 'grass', 'turf', 'yard', 'edge', 'edging'],
  ['weed', 'weeds'],
  ['trash', 'garbage', 'can', 'bin', 'recycle', 'recycling', 'container', 'cart'],
  ['mildew', 'mold', 'mould'],
  ['paint', 'painting', 'repaint'],
  ['tree', 'shrub', 'plant', 'bush', 'hedge', 'landscape', 'landscaping', 'flowerbed', 'flowerbeds', 'border', 'sod', 'mulch', 'prune', 'pruning', 'stump', 'dead'],
  ['vehicle', 'car', 'truck', 'boat', 'trailer', 'rv', 'inoperable', 'parking', 'parked', 'atv', 'motorcycle'],
  ['basketball', 'hoop', 'goal'],
  ['powerwash', 'pressure', 'wash', 'driveway', 'sidewalk'],
  ['storage', 'stored', 'clutter', 'items'],
  ['light', 'lighting', 'lamp'],
  ['holiday', 'decoration', 'decorations', 'christmas'],
  ['garage', 'door'],
  ['shutter', 'shutters'],
  ['window', 'windows'],
  ['gutter', 'gutters', 'downspout'],
  ['address', 'numbers'],
  ['pool'],
  ['roof', 'shingle', 'shingles'],
];

// Words that carry no discriminating signal — ignore them when tokenizing so a
// category like "Storage Of Unapproved Items" doesn't match on "of"/"items"
// alone against unrelated chatter.
const STOPWORDS = new Set([
  'of', 'the', 'a', 'an', 'and', 'or', 'for', 'to', 'in', 'on', 'at', 'is',
  'are', 'was', 'about', 'regarding', 're', 'my', 'your', 'their', 'this',
  'that', 'it', 'unapproved', 'other', 'general', 'property', 'maintenance',
  'notice', 'violation', 'hoa', 'please', 'called', 'call', 'calling',
  // 'item'/'items' carry no signal — the tokenizer de-plurals 'items'→'item',
  // so both must be listed or "a few items to discuss" false-matches
  // "Storage Of Unapproved Items".
  'item', 'items', 'thing', 'things', 'stuff',
]);

function _tokens(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/s$/, ''))   // crude de-plural: fences→fence, weeds→weed
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

// Expand a token set to include every synonym-group member reachable from any
// token in it. So "fence" pulls in "fencing", "grass" pulls in "lawn"/"mow"/etc.
function _expand(tokenSet) {
  const out = new Set(tokenSet);
  for (const group of SYNONYM_GROUPS) {
    const stems = group.map((g) => g.replace(/s$/, ''));
    if (stems.some((s) => tokenSet.has(s))) {
      for (const s of stems) out.add(s);
    }
  }
  return out;
}

/**
 * Pick the open violation a piece of text is most likely about.
 *
 * @param {string} text  the call concern / next-step / subject, concatenated.
 * @param {Array} openViolations  [{ id, category_label, category_slug }]
 * @param {Object} [opts]
 * @param {number} [opts.minScore=1]  minimum overlapping signal terms to accept.
 * @returns {{ violation_id, score, matched_label, ambiguous } | null}
 *   null when nothing clears the bar OR the top two cases tie (ambiguous).
 */
function matchViolationFromText(text, openViolations, opts = {}) {
  const minScore = opts.minScore == null ? 1 : opts.minScore;
  const list = Array.isArray(openViolations) ? openViolations : [];
  if (!text || list.length === 0) return null;

  const textTerms = _expand(new Set(_tokens(text)));

  const scored = list.map((v) => {
    const catTerms = _expand(new Set([..._tokens(v.category_label), ..._tokens(v.category_slug)]));
    let score = 0;
    for (const t of catTerms) if (textTerms.has(t)) score += 1;
    return { violation_id: v.id, score, matched_label: v.category_label || v.category_slug || null };
  }).sort((a, b) => b.score - a.score);

  // Auto-tag ONLY when exactly one open case clears the bar. If the caller
  // referenced two different open violations (both score ≥ minScore), we can't
  // honestly attribute the note to one — leave it general. A wrong tag makes
  // the timeline lie about what the homeowner said; a missing tag just leaves
  // the note in the flat timeline where it's still visible.
  const candidates = scored.filter((s) => s.score >= minScore);
  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    return { violation_id: null, score: candidates[0].score, matched_label: null, ambiguous: true };
  }
  return { ...candidates[0], ambiguous: false };
}

module.exports = { matchViolationFromText, SYNONYM_GROUPS };
