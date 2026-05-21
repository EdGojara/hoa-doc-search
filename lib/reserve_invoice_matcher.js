// ============================================================================
// Reserve invoice → component matcher
// ----------------------------------------------------------------------------
// Heuristic matcher that, given an invoice (vendor + description + amount),
// suggests the most likely reserve_component for the community. Returns the
// top match + alternates with a confidence score.
//
// Approach (no LLM — deterministic, fast, explainable):
//   1) Vendor history match: vendors who've billed this community against
//      reserve components in the past get +0.35 confidence; if multiple
//      components were billed by the same vendor, pick the most recent.
//   2) Keyword match: tokenize vendor + description, score against component
//      names (token overlap with TF-style weighting).
//   3) Category boost: pool/asphalt/paving/roof/fence/etc. words in the
//      invoice description boost components in matching categories.
//   4) Amount sanity: if the invoice amount is within 30% of the component's
//      current_cost_estimate or per-phase cost, +0.1 confidence (otherwise no
//      adjustment — high cost variance happens; we don't want to penalize).
//
// Output: ranked array of { component_id, component_name, category,
//   confidence (0-1), reason (human-readable why) }
// ============================================================================

const STOPWORDS = new Set([
  'the','a','an','of','and','to','for','at','in','on','by','with','from','llc',
  'inc','co','company','services','service','management','mgmt','llc.','inc.',
  'corp','corporation','&','+',',','.','/','-','—','–'
]);

// Reserve category keywords → category slug
const CATEGORY_KEYWORDS = {
  pool:        ['pool','splash','plaster','spa','pump','filter','chlorine','aquatic','swim'],
  roof:        ['roof','shingle','metal roofing','flashing','gutter','soffit','fascia'],
  paving:      ['asphalt','seal','sealcoat','striping','striping','concrete','paving','sidewalk','curb','parking lot','driveway'],
  fence:       ['fence','fencing','gate','wrought','chain link','wood fence','steel fence'],
  mechanical:  ['hvac','heat','ac','air condition','boiler','chiller','pump','aerator','equipment','mechanical'],
  landscape:   ['landscape','landscap','irrigation','sod','tree','mulch','pond','garden','flower'],
  common_area: ['clubhouse','pavilion','interior','exterior renovation','door','window','siding','paint'],
  playground:  ['playground','play structure','swing','slide','jungle gym','tot lot'],
  signage:     ['sign','signage','monument'],
  lighting:    ['light','pole','fixture','lamp','illumination'],
  irrigation:  ['irrigation','sprinkler','drip'],
  mailroom:    ['mailbox','cluster box','mailroom','postal'],
};

function tokenize(text) {
  if (!text) return [];
  return String(text).toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t));
}

function inferCategoriesFromText(text) {
  if (!text) return new Set();
  const lower = String(text).toLowerCase();
  const hits = new Set();
  for (const [cat, words] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const w of words) {
      if (lower.includes(w)) { hits.add(cat); break; }
    }
  }
  return hits;
}

// Token-overlap score: how many of A's tokens appear in B's name?
function tokenOverlapScore(invoiceTokens, componentName) {
  const compTokens = new Set(tokenize(componentName));
  if (!compTokens.size) return 0;
  let hits = 0;
  for (const t of invoiceTokens) if (compTokens.has(t)) hits++;
  // Normalize: hits / max-possible (smaller of two sets)
  const denom = Math.min(invoiceTokens.length, compTokens.size);
  if (!denom) return 0;
  return hits / denom;
}

/**
 * Suggest reserve_components for an invoice.
 * @param {Object} args
 * @param {Array}  args.components - all active reserve_components for this community
 * @param {Array}  args.expenditureHistory - past reserve_expenditures rows for this community
 * @param {String} args.vendorName
 * @param {String} args.description
 * @param {Number} args.amountCents
 * @returns {Array} ranked matches: [{component_id, component_name, category, confidence, reason}]
 */
function suggestComponentMatches({ components, expenditureHistory, vendorName, description, amountCents }) {
  if (!Array.isArray(components) || !components.length) return [];

  const invoiceText = [vendorName, description].filter(Boolean).join(' ');
  const invoiceTokens = tokenize(invoiceText);
  const inferredCategories = inferCategoriesFromText(invoiceText);

  // Vendor history: which components did this vendor bill in the past?
  const vendorHistoryByComponent = {};
  if (vendorName && Array.isArray(expenditureHistory)) {
    const vn = vendorName.trim().toLowerCase();
    for (const e of expenditureHistory) {
      if (!e.vendor_name || !e.component_id) continue;
      if (e.vendor_name.trim().toLowerCase() === vn) {
        vendorHistoryByComponent[e.component_id] = (vendorHistoryByComponent[e.component_id] || 0) + 1;
      }
    }
  }

  const scored = components
    .filter(c => c.status === 'active')
    .map(c => {
      const reasons = [];
      let score = 0;

      // 1) Vendor history match
      const vendorHits = vendorHistoryByComponent[c.id] || 0;
      if (vendorHits > 0) {
        score += Math.min(0.35, 0.15 + (vendorHits * 0.1));
        reasons.push(`Same vendor previously billed this component (${vendorHits}×)`);
      }

      // 2) Keyword / name overlap
      const overlap = tokenOverlapScore(invoiceTokens, c.component_name);
      if (overlap > 0) {
        score += overlap * 0.5;
        reasons.push(`Name overlap (${Math.round(overlap * 100)}%)`);
      }

      // 3) Category boost
      if (inferredCategories.has(c.category)) {
        score += 0.15;
        reasons.push(`Category match: ${c.category}`);
      }

      // 4) Amount sanity
      const targetCents = c.current_cost_estimate_cents
        || (c.unit_cost_cents && c.quantity_per_phase ? c.unit_cost_cents * c.quantity_per_phase : null);
      if (amountCents && targetCents) {
        const ratio = amountCents / targetCents;
        if (ratio > 0.7 && ratio < 1.3) {
          score += 0.10;
          reasons.push(`Amount in range (${Math.round(ratio * 100)}% of estimate)`);
        }
      }

      return {
        component_id: c.id,
        component_name: c.component_name,
        category: c.category,
        line_item_number: c.line_item_number || null,
        confidence: Math.min(1, score),
        reason: reasons.length ? reasons.join(' · ') : 'No strong signal',
      };
    })
    .filter(s => s.confidence > 0.05)
    .sort((a, b) => b.confidence - a.confidence);

  return scored.slice(0, 5);
}

/**
 * Classify the expenditure type from invoice keywords. Returns one of:
 * 'full_replacement', 'partial_replacement', 'repair', 'maintenance',
 * 'inspection', 'consulting', 'other'.
 */
function classifyExpenditureType(text) {
  if (!text) return 'other';
  const lower = String(text).toLowerCase();
  if (/replace|replacement|new install|install new/.test(lower)) {
    if (/partial|phase|section/.test(lower)) return 'partial_replacement';
    return 'full_replacement';
  }
  if (/repair|fix|patch|crack/.test(lower)) return 'repair';
  if (/inspect|inspection|assessment/.test(lower)) return 'inspection';
  if (/consult|study|review/.test(lower))           return 'consulting';
  if (/maintain|maintenance|service|clean|chemical|treatment/.test(lower)) return 'maintenance';
  return 'other';
}

module.exports = {
  suggestComponentMatches,
  classifyExpenditureType,
  tokenize,
  inferCategoriesFromText,
};
