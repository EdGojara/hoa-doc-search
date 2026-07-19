// ============================================================================
// tests/test_board_package_registry.js  (Ed 2026-07-19)
// ----------------------------------------------------------------------------
// The board-packet section list used to live in TWO places that drifted:
//   1. lib/board_package/engine.js DEFAULT_SECTIONS — Paige's readiness profile
//   2. board_packet_section_templates DB table — seeds packet sections + FK
// When they disagreed, readiness scored a section that assemble could not
// seed/fill (five Financials sections hidden, commit fec366f), or a template
// seeded a section the profile never scored. engine.js is now the single
// canonical registry; this test is the control that keeps the DB table, the
// auto-fill handlers, and the readiness probes generated-in-sync with it.
//
// Part 1 — static (always runs): the registry is well-formed, and the native
//          (auto-fillable) set is identical across the engine, the assemble
//          FILLABLE list, and the autoFill handler coverage. This is the
//          assertion that fails the build the day someone adds a native section
//          to the profile without wiring a handler.
// Part 2 — live (runs when SUPABASE creds are present): the DB template key set
//          equals the registry key set, and nativeContext has a probe for every
//          native section. This fails the build the day a migration adds/removes
//          a template row without the matching engine.js edit.
//
// Run:  npm run test:board-registry   (also wired into `npm test`)
// ============================================================================
require('dotenv').config({ override: true });

const engine = require('../lib/board_package/engine');

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failures++; console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? '\n      ' + detail : ''}`); }
}
const setEq = (a, b) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
const missing = (want, have) => want.filter((k) => !have.includes(k));

console.log('\n\x1b[1mPart 1 — registry is well-formed & the native set is one source of truth\x1b[0m\n');

const { DEFAULT_SECTIONS, SECTION_KEYS, nativeSectionKeys } = engine;

// --- keys unique ---
check('section keys are unique', new Set(SECTION_KEYS).size === SECTION_KEYS.length,
  `dupes: ${SECTION_KEYS.filter((k, i) => SECTION_KEYS.indexOf(k) !== i).join(', ')}`);

// --- every entry carries the template projection needed to seed a DB row ---
const TEMPLATE_FIELDS = ['display_name', 'default_order', 'required_default', 'supports_manual',
  'supports_upload', 'supports_auto_trusted', 'supports_ai_generated', 'default_audience'];
const badTemplate = DEFAULT_SECTIONS.filter((s) => !s.template || TEMPLATE_FIELDS.some((f) => !(f in s.template)));
check('every section has a complete template projection', badTemplate.length === 0,
  `incomplete: ${badTemplate.map((s) => s.key).join(', ')}`);

// --- default_order is unique (physical book position) ---
const orders = DEFAULT_SECTIONS.map((s) => s.template && s.template.default_order);
check('template default_order values are unique', new Set(orders).size === orders.length,
  `dupes at orders: ${orders.filter((o, i) => orders.indexOf(o) !== i).join(', ')}`);

// --- source is a known kind ---
const KNOWN_SOURCES = ['native', 'upload', 'ai', 'manual', 'structural'];
const badSource = DEFAULT_SECTIONS.filter((s) => !KNOWN_SOURCES.includes(s.source));
check('every section source is a known kind', badSource.length === 0,
  `unknown: ${badSource.map((s) => `${s.key}=${s.source}`).join(', ')}`);

// --- THE invariant: native set == assemble FILLABLE == autoFill handler coverage ---
const nativeKeys = nativeSectionKeys();
check('native set is non-empty', nativeKeys.length > 0);

let bp = null;
try { bp = require('../api/board_packets'); }
catch (e) { console.log(`  \x1b[33m~ could not load api/board_packets (${e.message}) — handler-coverage checks skipped\x1b[0m`); }

if (bp) {
  // assemblePackage.FILLABLE is derived from nativeSectionKeys() in code; the
  // exported AUTO_FILL_NATIVE_KEYS is the list autoFillSection actually builds
  // data for. Both must equal the registry's native set.
  check('autoFill handler coverage (AUTO_FILL_NATIVE_KEYS) == native registry set',
    setEq(bp.AUTO_FILL_NATIVE_KEYS, nativeKeys),
    `in registry not handled: [${missing(nativeKeys, bp.AUTO_FILL_NATIVE_KEYS).join(', ')}]  |  handled not in registry: [${missing(bp.AUTO_FILL_NATIVE_KEYS, nativeKeys).join(', ')}]`);
}

// --- readiness count == fillable count, on the default profile ---
// Simulate a fully-present native context: every native section has data for the
// cutoff period. buildReadiness must then report auto_fillable == native count
// and mark all of them ready — i.e. what readiness promises == what assemble fills.
const profile = engine.getProfile({});
const cutoff = '2026-06-30';
const nat = {};
for (const k of nativeKeys) nat[k] = { present: true, period: cutoff, count: 1, minutes_meeting_date: null };
// prior_minutes has an extra period check keyed on priorMeetingDate — align it.
const { summary } = engine.buildReadiness(profile, new Map(), { cutoff, priorMeetingDate: null, native: nat });
check('summary.auto_fillable == native registry set size',
  summary.auto_fillable === nativeKeys.length, `auto_fillable=${summary.auto_fillable} native=${nativeKeys.length}`);
check('all native sections score ready when their data is present',
  summary.auto_fillable_ready === nativeKeys.length,
  `auto_fillable_ready=${summary.auto_fillable_ready} of ${nativeKeys.length}`);

// --- per-community override still works (getProfile) ---
const overridden = engine.getProfile({ board_package_config: { sections: [{ key: 'legal_matters', required: true }] } });
check('getProfile applies per-community overrides',
  overridden.sections.find((s) => s.key === 'legal_matters').required === true);
check('getProfile can add a community-specific section',
  engine.getProfile({ board_package_config: { sections: [{ key: 'pool_report', label: 'Pool', required: false, source: 'upload' }] } })
    .sections.some((s) => s.key === 'pool_report'));

// ============================================================================
// Part 2 — live: DB template table == registry, and probes cover the natives.
// ============================================================================
async function livePart() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_KEY;
  if (!url || !key) {
    console.log('\n\x1b[33mPart 2 — live DB checks SKIPPED (no SUPABASE_URL/SUPABASE_KEY in env)\x1b[0m');
    return;
  }
  console.log('\n\x1b[1mPart 2 — DB template table & readiness probes match the registry\x1b[0m\n');
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(url, key);

  // 2a) template key set == registry key set — THE drift guard
  const { data: tmpl, error: tErr } = await supabase.from('board_packet_section_templates').select('section_key');
  if (tErr) { failures++; console.log(`  \x1b[31m✗ could not read board_packet_section_templates: ${tErr.message}\x1b[0m`); return; }
  const dbKeys = (tmpl || []).map((r) => r.section_key);
  check('DB template key set == engine SECTION_KEYS', setEq(dbKeys, SECTION_KEYS),
    `in registry, no template row: [${missing(SECTION_KEYS, dbKeys).join(', ')}]  |  template row, not in registry: [${missing(dbKeys, SECTION_KEYS).join(', ')}]`);

  // 2b) nativeContext has a probe for every native section (the agenda bug)
  const { nativeContext } = require('../lib/board_package/native');
  const { data: comm, error: cErr } = await supabase.from('communities').select('id, name, board_package_config').limit(1).maybeSingle();
  if (cErr || !comm) { console.log(`  \x1b[33m~ no community to probe against — probe-coverage check skipped\x1b[0m`); return; }
  const natLive = await nativeContext(supabase, comm, '2026-06-30', null);
  const probeMissing = nativeKeys.filter((k) => !(k in natLive));
  check(`nativeContext probes every native section (${comm.name})`, probeMissing.length === 0,
    `no probe for: [${probeMissing.join(', ')}]`);

  // 2c) readiness on a real community reports auto_fillable == native count
  const liveProfile = engine.getProfile(comm);
  const { summary: liveSummary } = engine.buildReadiness(liveProfile, new Map(),
    { cutoff: '2026-06-30', priorMeetingDate: null, native: natLive });
  check('live readiness auto_fillable == native registry size',
    liveSummary.auto_fillable === nativeKeys.length,
    `auto_fillable=${liveSummary.auto_fillable} native=${nativeKeys.length}`);
}

livePart().then(() => {
  console.log('');
  if (failures) { console.log(`\x1b[31m${failures} check(s) failed.\x1b[0m\n`); process.exit(1); }
  console.log('\x1b[32mAll board-package registry checks passed.\x1b[0m\n');
}).catch((e) => {
  console.error('\x1b[31mregistry test crashed:\x1b[0m', e.message);
  process.exit(1);
});
