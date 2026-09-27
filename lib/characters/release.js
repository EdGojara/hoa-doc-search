// ============================================================================
// lib/characters/release.js  (Ed 2026-09-26)  Trusted Character System
// ----------------------------------------------------------------------------
// Pure helpers for releases: a release is a frozen map of component -> one
// component version. These mirror the database functions exactly so the page
// and scripts can preview a derive/rollback before it is written, and verify a
// stored release's signature afterwards.
// ============================================================================
const { sha256Hex } = require('./hash');
const { COMPONENTS } = require('./spec');

// Same override rule as character_derive_release(): value null removes a component.
function deriveComponents(base, overrides) {
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(overrides || {})) {
    if (!COMPONENTS.includes(k)) throw new Error(`deriveComponents: unknown component "${k}"`);
    if (v === null) delete out[k]; else out[k] = v;
  }
  return out;
}

// Which components changed between two releases' component maps.
function diffComponents(a, b) {
  const keys = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].sort();
  return keys.filter((k) => (a || {})[k] !== (b || {})[k])
    .map((k) => ({ component: k, from: (a || {})[k] || null, to: (b || {})[k] || null }));
}

// Mirrors character_create_release(): sorted "component:version_id:spec_sha256;".
// entries: [{ component, component_version_id, spec_sha256 }]
function releaseSignature(entries) {
  const sig = [...entries].sort((x, y) => (x.component < y.component ? -1 : x.component > y.component ? 1 : 0))
    .map((e) => `${e.component}:${e.component_version_id}:${e.spec_sha256};`).join('');
  return sha256Hex(Buffer.from(sig, 'utf8'));
}

// Status is always the latest status-bearing event for a subject (mirrors character_subject_status()).
const STATUS_EVENTS = new Set(['proposed', 'approved', 'rejected', 'promoted', 'retired', 'restored']);
function statusFromEvents(events, subjectId) {
  let best = null;
  for (const e of events || []) {
    if (e.subject_id !== subjectId || !STATUS_EVENTS.has(e.event)) continue;
    if (!best || Number(e.id) > Number(best.id)) best = e;
  }
  return best ? best.event : null;
}

module.exports = { deriveComponents, diffComponents, releaseSignature, statusFromEvents };
