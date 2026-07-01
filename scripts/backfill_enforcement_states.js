#!/usr/bin/env node
// ===========================================================================
// backfill_enforcement_states.js  (Ed 2026-07-01)
// ---------------------------------------------------------------------------
// The durable per-property status table property_enforcement_states (migration
// 202) was never populated, so "accounts at legal" was invisible. This backfills
// it from the two places the knowledge is currently trapped:
//   1) DRV violation reclassification notes ("At legal", "with attorney") — the
//      status staff recorded when they voided/superseded a violation.
//   2) owner_ar_snapshots.at_legal / in_collections (latest per property).
// Sets one ACTIVE state per property (at_legal / in_collections). Idempotent:
// skips a property that already has an active state. Attorney/bankruptcy detail
// is left blank (backfill can't know it) — flagged in notes for staff to fill
// via the existing property-enforcement-state UI.
//
//   node -r dotenv/config scripts/backfill_enforcement_states.js [--apply]
// (dry-run by default; --apply writes)
// ===========================================================================

const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const APPLY = process.argv.includes('--apply');

async function pageAll(table, sel, tweak) {
  let out = [], from = 0;
  for (;;) {
    let q = sb.from(table).select(sel).range(from, from + 999);
    if (tweak) q = tweak(q);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || !data.length) break;
    out = out.concat(data); if (data.length < 1000) break; from += 1000;
  }
  return out;
}

(async () => {
  // ---- source 1: DRV reclassification notes ----
  const vs = await pageAll('violations', 'property_id, community_id, review_notes, resolved_notes');
  const legalRe = /at\s*legal|with\s*attorney|in\s*litigation|lien\s*filed/i;
  const fromNotes = new Map(); // property_id -> {community_id, note}
  for (const v of vs) {
    const note = `${v.review_notes || ''} ${v.resolved_notes || ''}`.trim();
    if (legalRe.test(note) && !fromNotes.has(v.property_id)) fromNotes.set(v.property_id, { community_id: v.community_id, note });
  }

  // ---- source 2: latest AR snapshot per property ----
  const ar = await pageAll('owner_ar_snapshots', 'property_id, community_id, at_legal, in_collections, snapshot_date, balance_total', (q) => q.order('snapshot_date', { ascending: false }));
  const seen = new Set(), fromAr = new Map();
  for (const r of ar) {
    if (seen.has(r.property_id)) continue; seen.add(r.property_id);
    if (r.at_legal || r.in_collections) fromAr.set(r.property_id, r);
  }

  // ---- merge into one desired-state map (at_legal wins over in_collections) ----
  const desired = new Map(); // property_id -> {community_id, state, notes}
  for (const [pid, x] of fromNotes) desired.set(pid, { community_id: x.community_id, state: 'at_legal', notes: `Backfilled from DRV note: "${x.note.slice(0, 80)}". Confirm attorney on file.` });
  for (const [pid, r] of fromAr) {
    const state = r.at_legal ? 'at_legal' : 'in_collections';
    if (!desired.has(pid) || (state === 'at_legal' && desired.get(pid).state !== 'at_legal')) {
      desired.set(pid, { community_id: r.community_id, state, notes: `Backfilled from AR aging snapshot ${r.snapshot_date} (balance $${r.balance_total}). Confirm attorney on file.` });
    }
  }

  // ---- skip properties that already have an ACTIVE state ----
  const existing = await pageAll('property_enforcement_states', 'property_id, state', (q) => q.is('ended_at', null));
  const hasActive = new Set(existing.map((e) => e.property_id));

  const toInsert = [];
  for (const [pid, d] of desired) {
    if (hasActive.has(pid)) continue;
    toInsert.push({ property_id: pid, community_id: d.community_id, state: d.state, notes: d.notes, created_by: 'system-backfill-2026-07-01' });
  }

  // label for output
  const pids = toInsert.map((r) => r.property_id);
  const { data: labels } = await sb.from('v_current_property_owners').select('property_id, street_address, owner_name').in('property_id', pids.length ? pids : ['00000000-0000-0000-0000-000000000000']);
  const lab = Object.fromEntries((labels || []).map((l) => [l.property_id, `${l.street_address} — ${l.owner_name}`]));

  console.log(`from DRV notes: ${fromNotes.size} | from AR: ${fromAr.size} | already active: ${hasActive.size}`);
  console.log(`=== ${APPLY ? 'INSERTING' : 'DRY-RUN would insert'} ${toInsert.length} active enforcement states ===`);
  for (const r of toInsert) console.log(`  [${r.state}] ${lab[r.property_id] || r.property_id.slice(0, 8)}`);

  if (APPLY && toInsert.length) {
    const { error } = await sb.from('property_enforcement_states').insert(toInsert);
    if (error) { console.error('INSERT FAILED:', error.message); process.exit(1); }
    console.log('\nInserted', toInsert.length, 'active enforcement states.');
  } else if (!APPLY) {
    console.log('\n(dry-run — re-run with --apply to write)');
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
