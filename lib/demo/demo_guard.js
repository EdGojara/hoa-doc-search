// ============================================================================
// lib/demo/demo_guard.js  (Ed 2026-09-20)
// ----------------------------------------------------------------------------
// THE canonical demo predicate. One source of truth for "is this a demo
// organization?", replacing the hardcoded KNOWN_DEMO_COMMUNITY_IDS UUID lists
// that were duplicated across portal.js and demo_watermark.js.
//
// A community is DEMO when EITHER signal is true (defense in depth):
//   - it belongs to the dedicated demo tenant (management_company_id = DEMO), OR
//   - its is_demo flag is true.
// After the tenant move both hold for demo orgs; either alone still classifies.
//
// The demo community-id set is cached (small, changes rarely) with a short TTL so
// callers can check synchronously in hot paths after a warm-up. Reads fail SAFE:
// on a query error we keep the last known set rather than "nothing is demo".
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const { BEDROCK_MGMT_CO_ID, DEMO_MGMT_CO_ID } = require('../company');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const TTL_MS = 60 * 1000;
let _ids = new Set();          // demo community ids
let _loadedAt = 0;
let _loading = null;

function isDemoMgmtCo(mgmtCoId) { return String(mgmtCoId || '') === DEMO_MGMT_CO_ID; }

// A row-level synchronous check when the community row (or the fields) is already
// in hand. Never hits the DB. Use this at points that already loaded the community.
function isDemoCommunityRow(row) {
  if (!row) return false;
  return row.is_demo === true || isDemoMgmtCo(row.management_company_id);
}

async function _refresh() {
  const { data, error } = await supabase.from('communities')
    .select('id')
    .or(`is_demo.eq.true,management_company_id.eq.${DEMO_MGMT_CO_ID}`);
  if (error) { console.warn('[demo_guard] refresh failed, keeping cache:', error.message); return; } // fail safe
  _ids = new Set((data || []).map((r) => r.id));
  _loadedAt = Date.now();
}

async function ensureLoaded() {
  if (Date.now() - _loadedAt < TTL_MS && _loadedAt) return;
  if (_loading) { await _loading; return; }
  _loading = _refresh().finally(() => { _loading = null; });
  await _loading;
}

// The authoritative async check. Warm the cache, then test membership.
async function isDemoCommunity(communityId) {
  if (!communityId) return false;
  await ensureLoaded();
  return _ids.has(communityId);
}

// The cached set of demo community ids, for excluding demo from unfiltered
// "all rows" queries. Callers should `await ensureLoaded()` first (or accept a
// possibly-cold empty set on the very first call before warm-up).
function demoCommunityIdsSync() { return [..._ids]; }
async function demoCommunityIds() { await ensureLoaded(); return [..._ids]; }

// Reserved, non-routable demo recipients. Demo organizations seed fictional
// contacts on these, so an outbound to one of them is structurally a demo action
// even when no community id was threaded to the send point. This is a DATA
// backstop to the org/context signals, not the only line of defense.
const DEMO_EMAIL_RE = /@([a-z0-9-]+\.)*(demo|invalid|example|test)$|@(demo|dramacreekhoa|dramacreek)\./i;
function recipientEmailIsDemo(addr) {
  const a = String(addr || '').trim().toLowerCase();
  return !!a && DEMO_EMAIL_RE.test(a);
}
// Reserved test SMS range (North American +1 555-01xx is never assignable).
function recipientPhoneIsDemo(num) {
  const d = String(num || '').replace(/[^0-9]/g, '');
  return /^1?555015\d\d$/.test(d) || /^1?555(01\d\d)$/.test(d);
}
function recipientIsDemo(to) {
  if (!to) return false;
  const s = String(to);
  return s.includes('@') ? recipientEmailIsDemo(s) : recipientPhoneIsDemo(s);
}

// Exclude demo communities from an "all rows" supabase query on a community-id
// column. This is the belt for the unfiltered staff surfaces and jobs that do NOT
// scope by management_company_id (the tenant boundary already excludes demo from
// everything that does). Await it, so the demo-id set is loaded before the filter.
async function excludeDemo(query, col = 'community_id') {
  const ids = await demoCommunityIds();
  if (!ids.length) return query;
  return query.not(col, 'in', '(' + ids.join(',') + ')');
}

module.exports = {
  BEDROCK_MGMT_CO_ID, DEMO_MGMT_CO_ID,
  isDemoMgmtCo, isDemoCommunityRow, isDemoCommunity,
  ensureLoaded, demoCommunityIds, demoCommunityIdsSync, excludeDemo,
  recipientIsDemo, recipientEmailIsDemo, recipientPhoneIsDemo,
};
