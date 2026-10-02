// ============================================================================
// lib/onboarding/adapters/index.js  (Issue #15) — provider adapter interface
// ----------------------------------------------------------------------------
// A provider adapter turns one legacy system's reports/exports into canonical
// rows. Contract (validated by assertAdapter):
//   provider            short id ('vantaca', 'cinc', 'c3', 'tops', 'appfolio', 'quickbooks', 'spreadsheet', ...)
//   version             semver; recorded on every normalization result
//   artifact_types      the report/export types it can read
//   parse(type, input, artifact, opts) -> { artifact_type, rows: canonical[], defects: [], printed: {} }
//   extractionControls(parsedByType) -> control results (parsed vs the report's own printed totals)
//   mechanicsControls(parsedByType, opts) -> control results for provider presentation rules (optional)
// Adapters are PURE: they receive text/bytes, never a database client, so an
// adapter cannot read or write Trusted. Core logic never branches on provider.
// ============================================================================
const REQUIRED = ['provider', 'version', 'artifact_types', 'parse', 'extractionControls'];

function assertAdapter(a) {
  for (const k of REQUIRED) if (!a || a[k] === undefined) throw new Error(`adapter missing ${k}`);
  if (!Array.isArray(a.artifact_types) || !a.artifact_types.length) throw new Error('adapter artifact_types must be a non-empty array');
  if (typeof a.parse !== 'function' || a.parse.length > 4) throw new Error('adapter parse(type, input, artifact, opts) must be a function');
  return a;
}

const REGISTRY = new Map();
function register(adapter) { assertAdapter(adapter); REGISTRY.set(adapter.provider, adapter); return adapter; }
function get(provider) { const a = REGISTRY.get(String(provider || '').toLowerCase()); if (!a) throw new Error(`no adapter for provider ${provider}`); return a; }
function providers() { return [...REGISTRY.keys()].sort(); }

register(require('./vantaca'));

module.exports = { assertAdapter, register, get, providers };
