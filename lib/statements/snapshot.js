// ============================================================================
// lib/statements/snapshot.js  (Ed 2026-10-09, month-end close PR C)
// ----------------------------------------------------------------------------
// The native board-packet statement snapshot: what a board packet stores for its
// balance_sheet / income_statement sections so we can reproduce EXACTLY what the
// board received. It is the statement model(s) themselves (lib/statements/model.js),
// versioned, with a sha256 over them, never rendered HTML.
//
//   buildSectionSnapshot(supabase, { community_id, section_key, cutoff })
//       -> input_data { source, model_version, section_key, generated_at,
//                       models: [...], snapshot_sha256, ... }
//   isSnapshot(input_data)
//   mappingBlockers(section)        unmapped balance-sheet accounts in a snapshot
//   packetFinalizationGate(supabase, packet_id)
//       -> { ok, blockers: [{ section_key, snapshot_sha256, unmapped, overridden }] }
//
// The gate (Ed 2026-10-09): unmapped accounts never block a DRAFT. A packet
// cannot be marked final or distributed while a balance-sheet snapshot has
// unmapped accounts, unless the OWNER recorded an override for that exact
// snapshot (statement_mapping_overrides, migration 505). A native statement
// section still in the pre-v1 format also blocks (Ed 2026-10-10); re-pulling
// it is the only fix, so there is no override for that.
//
// CLOSED PERIOD (Ed 2026-10-10): mapping-complete is not final-ready. A packet
// with native statements may be final / distributed only when the financial
// period is CLOSED under the month-end close (migration 502) AND the stored
// snapshot itself recorded that closed state when it was pulled. A snapshot
// pulled while the period was open stays blocked after the live period closes
// until it is pulled again; a period reopened after the pull blocks too. No
// owner override applies to the period requirement.
// ============================================================================

const crypto = require('crypto');
const M = require('./model');

const SNAPSHOT_SOURCE = 'trusted_statement_model';
const STATEMENT_SECTIONS = ['balance_sheet', 'income_statement'];

function snapshotSha(models) {
  return crypto.createHash('sha256').update(models.map((m) => `${m.model_version}:${m.snapshot_sha256}`).join('|')).digest('hex');
}

// Funds to present on the income statement: active funds, Operating first.
async function incomeFunds(supabase, community_id) {
  const { data, error } = await supabase.from('account_funds').select('fund_code, is_active').eq('community_id', community_id).limit(50);
  if (error) throw Object.assign(new Error(`account_funds: ${error.message}`), { code: error.code });
  const codes = [...new Set((data || []).filter((f) => f.is_active !== false).map((f) => f.fund_code).filter(Boolean))];
  return codes.sort((a, b) => (a === 'OPR' ? -1 : b === 'OPR' ? 1 : a.localeCompare(b)));
}

async function buildSectionSnapshot(supabase, { community_id, section_key, cutoff, now = new Date() }) {
  if (!STATEMENT_SECTIONS.includes(section_key)) throw Object.assign(new Error('not_a_statement_section'), { code: 'invalid_input' });
  let models;
  if (section_key === 'balance_sheet') {
    models = [await M.buildBalanceSheetModel(supabase, { community_id, as_of: cutoff, view: 'consolidated', now })];
  } else {
    models = [];
    for (const fund of await incomeFunds(supabase, community_id)) {
      const m = await M.buildIncomeBudgetModel(supabase, { community_id, period_end: cutoff, fund, now });
      if (m.sections.some((s) => s.groups.length)) models.push(m);   // a fund with no revenue or expense lines is not presented
    }
    if (!models.length) models = [await M.buildIncomeBudgetModel(supabase, { community_id, period_end: cutoff, fund: 'all', now })];
  }
  return {
    source: SNAPSHOT_SOURCE, model_version: M.MODEL_VERSION, section_key,
    ...(section_key === 'balance_sheet' ? { as_of_date: cutoff } : { period_start: `${cutoff.slice(0, 7)}-01`, period_end: cutoff }),
    generated_at: new Date(now).toISOString(),
    models, snapshot_sha256: snapshotSha(models),
  };
}

const isSnapshot = (d) => !!(d && d.source === SNAPSHOT_SOURCE && Array.isArray(d.models) && d.models.length);

// A native statement section stored BEFORE trusted.statement.v1: the raw engine
// result trustEd auto-fill wrote ({ statement, source: 'trusted_gl' }), or a
// section claiming the model source without a usable model. No renderer reads
// it, so it can never be what the board receives; it must be pulled again.
// Uploaded Vantaca PDF sections (assets[] / line_items[], no trustEd source) and
// empty sections are not native and are not matched.
function isStaleNative(section) {
  if (!section || !STATEMENT_SECTIONS.includes(section.section_key)) return false;
  const d = section.input_data;
  if (!d || typeof d !== 'object') return false;
  if (d.source === 'trusted_gl') return true;
  if (d.source === SNAPSHOT_SOURCE && !isSnapshot(d)) return true;
  return false;
}

// A snapshot whose stored models no longer hash to what was recorded has been
// altered after generation; it must not be finalized on.
function snapshotIntact(d) {
  if (!isSnapshot(d)) return false;
  return d.models.every((m) => M.modelSha(m) === m.snapshot_sha256) && snapshotSha(d.models) === d.snapshot_sha256;
}

function mappingBlockers(section) {
  const d = section && section.input_data;
  if (!isSnapshot(d)) return null;
  const unmapped = []; let unavailable = false;
  for (const m of d.models) {
    if (m.kind !== 'balance_sheet') continue;
    if (!m.mapping || !m.mapping.available) unavailable = true;
    for (const u of (m.mapping && m.mapping.unmapped) || []) unmapped.push(u);
  }
  if (!unmapped.length && !unavailable) return null;
  return { section_key: section.section_key, snapshot_sha256: d.snapshot_sha256, unmapped, mapping_unavailable: unavailable };
}

async function packetFinalizationGate(supabase, packet_id) {
  const { data: sections, error } = await supabase.from('board_packet_sections').select('section_key, input_data, status')
    .eq('packet_id', packet_id).in('section_key', STATEMENT_SECTIONS).limit(10);
  if (error) throw Object.assign(new Error(`board_packet_sections: ${error.message}`), { code: error.code });
  const blockers = [];
  for (const s of sections || []) {
    if (isStaleNative(s)) {
      blockers.push({ section_key: s.section_key, problem: 'stale_native_format', overridden: false });
      continue;
    }
    if (isSnapshot(s.input_data) && !snapshotIntact(s.input_data)) {
      blockers.push({ section_key: s.section_key, snapshot_sha256: s.input_data.snapshot_sha256, problem: 'snapshot_altered', overridden: false });
      continue;
    }
    for (const pb of await periodBlockers(supabase, s)) blockers.push(pb);
    const b = mappingBlockers(s); if (!b) continue;
    const { data: ovr, error: oe } = await supabase.from('statement_mapping_overrides').select('id, owner_actor, reason, created_at')
      .eq('packet_id', packet_id).eq('section_key', s.section_key).eq('snapshot_sha256', b.snapshot_sha256).order('created_at', { ascending: false }).limit(1);
    if (oe) throw Object.assign(new Error(`statement_mapping_overrides: ${oe.message}`), { code: oe.code });
    const o = (ovr || [])[0] || null;
    blockers.push({ ...b, problem: 'unmapped_accounts', overridden: !!o, override: o });
  }
  const open = blockers.filter((b) => !b.overridden);
  return { ok: open.length === 0, blockers, open };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = (d) => `${MONTHS[Number(String(d).slice(5, 7)) - 1]} ${String(d).slice(0, 4)}`;

// Period blockers for one native snapshot section: the snapshot must have been
// pulled with its period CLOSED, covering its statement date, and the period
// must still be closed now. Live state is read only to choose the message and to
// catch a reopen; it never turns an open-period snapshot into a final one.
async function periodBlockers(supabase, section) {
  const d = section && section.input_data;
  if (!isSnapshot(d)) return [];
  const out = [];
  const seen = new Set();
  for (const m of d.models) {
    const date = (m.period && (m.period.as_of || m.period.period_end)) || null;
    if (!date || seen.has(date)) continue;
    seen.add(date);
    const lc = m.lifecycle || {};
    const live = await liveClosed(supabase, m.community && m.community.id, date);
    const base = { section_key: section.section_key, snapshot_sha256: d.snapshot_sha256, period_date: date, period_label: monthLabel(date), overridden: false };
    if (lc.status !== 'closed' || !(lc.closed_through && String(lc.closed_through).slice(0, 10) >= date)) {
      out.push({ ...base, problem: live ? 'snapshot_pulled_open' : 'period_not_closed' });
    } else if (!live) {
      out.push({ ...base, problem: 'period_reopened' });
    }
  }
  return out;
}

// Is the month containing `date` closed right now (accounting_periods, migration 502)?
async function liveClosed(supabase, community_id, date) {
  if (!community_id) return false;
  const { data, error } = await supabase.from('accounting_periods').select('status, period_start, period_end')
    .eq('community_id', community_id).lte('period_start', date).gte('period_end', date).limit(5);
  if (error) throw Object.assign(new Error(`accounting_periods: ${error.message}`), { code: error.code });
  return (data || []).some((p) => ['closed', 'locked'].includes(p.status));
}

module.exports = { SNAPSHOT_SOURCE, periodBlockers, STATEMENT_SECTIONS, buildSectionSnapshot, isSnapshot, isStaleNative, snapshotIntact, mappingBlockers, packetFinalizationGate, snapshotSha };
