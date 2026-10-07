// ============================================================================
// lib/ap/vendor_name.js — the ONE vendor-name normalizer (pure, no database).
// Used by AP intake (lib/ap/intake.js re-exports it) and by the conversion plan
// (lib/onboarding/conversion_plan.js), which must not load a database client.
// Lowercases, drops legal / filler suffixes (LLC, Inc, Co, Corp, Ltd, Company,
// Services, The) and punctuation: "A-BEAUTIFUL POOLS, INC." = "A-Beautiful Pools".
// A match on the normalized name is only ever accepted when it is the ONLY match.
// ============================================================================
const normName = (s) => String(s || '').toLowerCase().replace(/\b(llc|inc|co|corp|ltd|company|services|service|the)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

module.exports = { normName };
