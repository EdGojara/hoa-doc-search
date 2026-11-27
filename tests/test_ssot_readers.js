// ============================================================================
// tests/test_ssot_readers.js  (Ed 2026-11-27)
// Balance and ACC readers use the authoritative records:
//   balance -> v_current_owner_balance via lib/ar/current_owner_ledger
//              (current owner only, one row per lot), never the old
//              v_homeowner_current_balance (mixes former owners, can return
//              several rows per lot, has no as_of column).
//   ACC     -> acc_decisions by community + canonical address
//              (lib/acc/address_cases), valid statuses, decision in effect.
// Run: node tests/test_ssot_readers.js
// ============================================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failures = 0;
const check = (name, cond, detail) => { if (cond) console.log(`  \x1b[32m✓\x1b[0m ${name}`); else { failures++; console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? '\n      ' + detail : ''}`); } };

// A PostgREST-shaped fake: records every table read, supports the filters the
// readers use, and fails loudly on an unknown table.
function fakeDb(tables, log = []) {
  return { from(t) {
    log.push(t);
    const st = { filters: [], head: false, count: false, range: null, order: null };
    const q = {
      select(_c, opts) { if (opts && opts.head) st.head = true; if (opts && opts.count) st.count = true; return q; },
      order(k, o) { if (!st.order) st.order = [k, !o || o.ascending !== false]; return q; },
      limit() { return q; },
      eq(k, v) { st.filters.push((r) => r[k] === v); return q; },
      in(k, vs) { st.filters.push((r) => vs.includes(r[k])); return q; },
      gt(k, v) { st.filters.push((r) => r[k] > v); return q; },
      not(k, op, list) { const vs = String(list).replace(/[()]/g, '').split(','); st.filters.push((r) => !vs.includes(r[k])); return q; },
      is(k, v) { st.filters.push((r) => (r[k] == null) === (v == null)); return q; },
      ilike(k, pat) { const rx = new RegExp('^' + pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$', 'i'); st.filters.push((r) => rx.test(String(r[k] || ''))); return q; },
      range(a, b) { st.range = [a, b]; return q; },
      maybeSingle() { st.single = true; return q; },
      then(res, rej) {
        if (!(t in tables)) return Promise.resolve({ data: null, error: { message: `relation "${t}" does not exist` } }).then(res, rej);
        let rows = tables[t].filter((r) => st.filters.every((f) => f(r)));
        if (st.order) { const [k, asc] = st.order; rows = [...rows].sort((a, b) => (String(a[k]) < String(b[k]) ? -1 : String(a[k]) > String(b[k]) ? 1 : 0) * (asc ? 1 : -1)); }
        if (st.range) rows = rows.slice(st.range[0], st.range[1] + 1);
        if (st.head) return Promise.resolve({ data: null, count: rows.length, error: null }).then(res, rej);
        if (st.single) return Promise.resolve({ data: rows[0] || null, error: rows.length > 1 ? { message: 'multiple rows' } : null }).then(res, rej);
        return Promise.resolve({ data: rows, error: null }).then(res, rej);
      },
    };
    return q;
  } };
}

const C = 'wv';
const tables = {
  properties: [{ id: 'p1', community_id: C, street_address: '100 Example Way' }],
  // The current owner owes $125.00. The old view would also carry the seller's row.
  v_current_owner_balance: [
    { community_id: C, property_id: 'p1', tenure_id: 't2', balance_cents: '12500', most_recent_txn_date: '2026-11-01', txn_count: 4 },
    { community_id: C, property_id: 'p2', tenure_id: 't9', balance_cents: '90000', most_recent_txn_date: '2026-10-01', txn_count: 2 },
    { community_id: C, property_id: 'p3', tenure_id: 't8', balance_cents: '-500', most_recent_txn_date: '2026-10-01', txn_count: 1 },
  ],
  acc_decisions: [
    { id: 'a1', community_id: C, reference_number: 'WAT-1', status: 'pending_review', decision_type: null, project_summary: 'Fence', created_at: '2026-11-10', homeowner_address: '100 Example Way, Sampletown, TX 77000' },
    { id: 'a2', community_id: C, reference_number: 'WAT-2', status: 'decided', decision_type: 'approved', decided_at: '2026-03-01', project_summary: 'Patio', created_at: '2026-02-20', homeowner_address: '100 EXAMPLE WAY' },
    { id: 'a3', community_id: C, reference_number: 'WAT-3', status: 'withdrawn', project_summary: 'Dup', created_at: '2026-11-11', homeowner_address: '100 Example Way' },
    { id: 'a4', community_id: C, reference_number: 'WAT-4', status: 'archived', project_summary: 'Old', created_at: '2025-01-01', homeowner_address: '100 Example Way' },
    { id: 'a5', community_id: C, reference_number: 'WAT-5', status: 'awaiting_info', project_summary: 'Pergola', created_at: '2026-11-12', homeowner_address: '100 Example Way' },
    { id: 'a6', community_id: C, reference_number: 'WAT-6', status: 'pending_review', project_summary: 'Neighbor', created_at: '2026-11-12', homeowner_address: '100 Other Lane' },
    { id: 'a7', community_id: 'other', reference_number: 'X-7', status: 'pending_review', project_summary: 'Other HOA', created_at: '2026-11-12', homeowner_address: '100 Example Way' },
    { id: 'a8', community_id: C, reference_number: 'WAT-8', status: 'finalizing', project_summary: 'Paint', created_at: '2026-11-13', homeowner_address: '100 Example Way', community_application_id: 'ca1' },
  ],
  acc_finalizations: [{ id: 'f1', acc_decision_id: 'a2', version: 2, decision_type: 'denied', finalized_at: '2026-04-01', letter_text: 'rev', correction_reason: 'error' }],
  violations: [], property_ownerships: [],
};

(async () => {
  const L = require('../lib/ar/current_owner_ledger');
  const { accCasesForAddress, ACC_OPEN_STATUSES } = require('../lib/acc/address_cases');

  console.log('\nCurrent-owner balance helpers');
  const log = [];
  const all = await L.currentOwnerBalancesForCommunity(fakeDb(tables, log), C);
  check('community helper reads v_current_owner_balance only', log.length && log.every((t) => t === 'v_current_owner_balance'), log.join(','));
  check('community helper returns numeric cents', all.length === 3 && all.every((r) => typeof r.balance_cents === 'number'));
  check('community helper is community-scoped', (await L.currentOwnerBalancesForCommunity(fakeDb(tables), 'nope')).length === 0);
  let threw = false;
  try { await L.currentOwnerBalancesForCommunity(fakeDb({}), C); } catch (_) { threw = true; }
  check('an unreadable balance view throws, never reads as zero', threw);

  console.log('\nACC cases at an address');
  const cases = await accCasesForAddress(fakeDb(tables), { communityId: C, address: '100 Example Way, Sampletown, TX 77000' });
  const ids = cases.map((c) => c.id);
  check('canonical address match (case and suffix insensitive), this community only', ids.includes('a1') && ids.includes('a2') && !ids.includes('a6') && !ids.includes('a7'), ids.join(','));
  check('withdrawn and archived never returned', !ids.includes('a3') && !ids.includes('a4'));
  check('newest first', ids[0] === 'a8', ids.join(','));
  const rev = cases.find((c) => c.id === 'a2');
  check('the decision in effect is applied (withEffective)', rev && rev.decision_type === 'denied' && rev.original_decision_type === 'approved');
  const open = await accCasesForAddress(fakeDb(tables), { communityId: C, address: '100 Example Way', openOnly: true });
  check('openOnly keeps pending_review / awaiting_info / finalizing', open.map((c) => c.id).sort().join(',') === 'a1,a5,a8', open.map((c) => c.id).join(','));
  check('open statuses are the valid acc_decisions statuses', ACC_OPEN_STATUSES.join(',') === 'pending_review,awaiting_info,finalizing');
  check('no address: empty', (await accCasesForAddress(fakeDb(tables), { communityId: C, address: null })).length === 0);
  let accThrew = false;
  try { await accCasesForAddress(fakeDb({}), { communityId: C, address: '100 Example Way' }); } catch (_) { accThrew = true; }
  check('an unreadable ACC record throws, never reads as "no cases"', accThrew);

  console.log('\nReaders wired to the SSOT');
  const oc = require('../lib/team/operator_core');
  if (typeof oc.propertyContext === 'function') {
    const ctx = await oc.propertyContext(fakeDb(tables), { propertyId: 'p1' });
    check('operator propertyContext: current owner balance', ctx.ar_balance === 125, String(ctx.ar_balance));
    check('operator propertyContext: open ACC cases by address', ctx.acc.map((a) => a.id).sort().join(',') === 'a1,a5,a8', JSON.stringify(ctx.acc.map((a) => a.id)));
  } else check('operator_core exports propertyContext', false);
  if (typeof oc.boardDataContext === 'function') {
    const txt = await oc.boardDataContext(fakeDb(tables), C);
    check('board context: delinquency from current owners, largest first', /DELINQUENCY: \$1,025\.00 outstanding across 2 account\(s\)\. Largest balances: \$900\.00, \$125\.00/.test(txt), txt.split('\n')[0]);
    check('board context: open ACC count uses valid statuses', /OPEN ACC \/ ARCHITECTURAL: 4 pending review/.test(txt), (txt.match(/OPEN ACC.*/) || [''])[0]);
  } else check('operator_core exports boardDataContext', false);

  // Static: none of the switched readers reference the old view. The allowed
  // remaining readers are deliberate (see the list): account-only fallback, GL
  // control (whole ledger), proration (an Ed decision), and a presence check.
  const SWITCHED = ['api/board_portal.js', 'api/email_triage.js', 'lib/claire/caller_context.js', 'lib/email/draft_reply.js', 'lib/team/operator_core.js', 'api/homeowner_360.js', 'lib/acc/property_history.js'];
  for (const f of SWITCHED) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    check(`${f} does not read v_homeowner_current_balance`, !/from\(\s*['"]v_homeowner_current_balance['"]/.test(src));
  }
  const ALLOWED = new Set(['lib/ar/resolve_current_ar.js', 'lib/ar/ar_control.js', 'lib/ar/ledger_identity.js', 'lib/board_package/native.js']);
  const offenders = [];
  const walk = (d) => { for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
    const rel = path.posix.join(d, e.name);
    if (e.isDirectory()) { if (!['node_modules', 'fixtures'].includes(e.name)) walk(rel); continue; }
    if (!rel.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (/from\(\s*['"]v_homeowner_current_balance['"]/.test(src) && !ALLOWED.has(rel)) offenders.push(rel);
  } };
  ['api', 'lib'].forEach(walk);
  check('no application reader outside the allowed list uses the old balance view', offenders.length === 0, offenders.join(', '));

  // ACC readers: no query of acc_decisions by property_id, no invented statuses.
  for (const f of ['lib/team/operator_core.js', 'lib/claire/caller_context.js', 'api/homeowner_360.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    check(`${f}: no acc_decisions property_id / invented statuses`, !/from\('acc_decisions'\)[^;]*property_id/.test(src) && !/'in_review', 'submitted'/.test(src));
  }
  const h360 = fs.readFileSync(path.join(ROOT, 'api/homeowner_360.js'), 'utf8');
  check('homeowner_360 never passes property ids into community_applications.property_address_id', !/property_address_id', propIds/.test(h360));
  const caller = fs.readFileSync(path.join(ROOT, 'lib/claire/caller_context.js'), 'utf8');
  check('caller_context as_of comes from most_recent_txn_date (the view has no as_of)', /most_recent_txn_date/.test(caller) && !/balance_cents, as_of/.test(caller));
  const portal = fs.readFileSync(path.join(ROOT, 'api/portal.js'), 'utf8');
  check('portal open-request statuses are valid final_status values', /'incomplete', 'pending_review', 'pending_committee_review', 'pending_send'/.test(portal) && !/\['', 'pending'/.test(portal));

  console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall SSOT reader checks passed\x1b[0m');
  process.exit(failures ? 1 : 0);
})();
