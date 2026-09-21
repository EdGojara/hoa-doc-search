#!/usr/bin/env node
/**
 * seed_demo_dc_operations.js — makes Drama Creek Estates a believable, permanent
 * residential operating environment across all 376 canonical properties, using
 * ONLY the real production write paths (no parallel demo model, no frontend
 * states). Idempotent (deterministic stable ids + skip-existing).
 *
 *   VIOLATIONS   -> violations           (same shape as migration 188)
 *   DELINQUENCY  -> owner_ar_snapshots   (same shape as the Marcus row; the
 *                                          canonical AR source for a no-ledger
 *                                          community per migration 361)
 *   OCCUPANCY    -> property_residencies (same shape as seed_demo_dc_occupancy)
 *
 * Every surface that reads v_property_summary (community map, Owner AR tab,
 * board portal, Miranda/enforcement, contact search) sees the SAME records —
 * click-through on the map agrees with the underlying state by construction.
 *
 * Preserves the signature personas exactly: Greg Yardgone (3 open violations +
 * $4,800 at-legal), Marcus Behindbills ($2,400 payment plan), Tom Investorson
 * (renter). Jennifer Lateleaves' original courtesy was voided by Ed 2026-07-30;
 * this leaves that history intact and gives her a FRESH active landscaping
 * courtesy so she reads as a signature violation scenario again.
 *
 * Scoped to the DEMO tenant + Drama Creek only. Demo isolation holds.
 *
 *   node scripts/seed_demo_dc_operations.js --dry-run
 *   node scripts/seed_demo_dc_operations.js --execute
 */
require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { DEMO_MGMT_CO_ID } = require('../lib/company');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const EXECUTE = process.argv.includes('--execute');
const DC = 'dc100000-0000-4000-a000-000000000000';
const SNAPSHOT_DATE = '2026-09-15';

// deterministic v4-shaped uuid from (namespace,key) — stable across re-runs
function duid(ns, key) {
  const h = crypto.createHash('md5').update(ns + ':' + key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
// stable pseudo-random 0..1 from a key (for occupancy ratios)
function h01(key) {
  const h = crypto.createHash('md5').update(key).digest('hex');
  return parseInt(h.slice(0, 8), 16) / 0xffffffff;
}
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const daysAhead = (n) => new Date(Date.now() + n * 86400000).toISOString();

// ---- VIOLATIONS design (one open case per property; Jennifer signature first)
// Distribution: 10 courtesy_1, 6 courtesy_2, 3 certified_209 (legal stage kept
// rare + conforms to workflow). Categories are real enforcement_categories slugs
// and deliberately avoid the human-only 10-day/force categories.
const VIO = [
  ['landscaping_overgrown', 'courtesy_1', 'standard'],   // [0] Jennifer Lateleaves — signature
  ['weeds', 'courtesy_1', 'standard'],
  ['lawn_height', 'courtesy_1', 'standard'],
  ['trash_cans_recycling_containers', 'courtesy_1', 'standard'],
  ['mailbox_damage', 'courtesy_1', 'standard'],
  ['garage_door', 'courtesy_1', 'standard'],
  ['tree_overgrowth', 'courtesy_1', 'standard'],
  ['powerwash_driveway_sidewalk', 'courtesy_1', 'standard'],
  ['gutters_downspout-repair', 'courtesy_1', 'standard'],
  ['mow_and_edge', 'courtesy_1', 'standard'],
  ['fence_staining', 'courtesy_2', 'standard'],
  ['siding_damage', 'courtesy_2', 'standard'],
  ['mildew_mold_visible', 'courtesy_2', 'standard'],
  ['storage_of_unapproved_items', 'courtesy_2', 'standard'],
  ['trash_visible', 'courtesy_2', 'standard'],
  ['parking_violation', 'courtesy_2', 'standard'],
  ['fence_damage', 'certified_209', 'standard'],
  ['vehicle_inoperable', 'certified_209', 'elevated'],
  ['property_maintenance', 'certified_209', 'standard'],
];
function vioTiming(stage) {
  if (stage === 'courtesy_1') return { opened: daysAgo(14), started: daysAgo(14), cure: daysAhead(16), cert: null };
  if (stage === 'courtesy_2') return { opened: daysAgo(38), started: daysAgo(9), cure: daysAhead(6), cert: null };
  return { opened: daysAgo(55), started: daysAgo(19), cure: daysAhead(11), cert: daysAgo(19).slice(0, 10) }; // certified_209
}

// ---- DELINQUENCY design (balance in its worst aging bucket -> clean color)
// 3× 0-30, 3× 31-60, 3× 61-90, 2× 91-120, 1× over-120, 1× at-legal, 1× collections
const AR = [
  [180, 'bucket_0_30', 'reminder', false, false],
  [240, 'bucket_0_30', 'reminder', false, false],
  [315, 'bucket_0_30', 'reminder', false, false],
  [430, 'bucket_31_60', 'courtesy_1', false, false],
  [560, 'bucket_31_60', 'courtesy_1', false, false],
  [720, 'bucket_31_60', 'courtesy_1', false, false],
  [950, 'bucket_61_90', 'courtesy_2', false, false],
  [1240, 'bucket_61_90', 'courtesy_2', false, false],
  [1580, 'bucket_61_90', 'courtesy_2', false, false],
  [2200, 'bucket_91_120', 'certified_209', false, false],
  [2750, 'bucket_91_120', 'certified_209', false, false],
  [3400, 'bucket_over_120', 'certified_209', false, false],
  [5200, 'bucket_over_120', 'with_attorney', true, false],
  [6800, 'bucket_over_120', 'in_collections', false, true],
];

// pick ~n evenly-spaced entries from a sorted candidate array (geographic spread)
function spread(cands, n) {
  if (cands.length <= n) return cands.slice();
  const step = cands.length / n, out = [];
  for (let i = 0; i < n; i++) out.push(cands[Math.floor(i * step + step / 2)]);
  return out;
}

async function main() {
  console.log(`\nDrama Creek operations seed — ${EXECUTE ? 'EXECUTE' : 'DRY RUN'}\n`);

  // canonical DC properties, geographically ordered by address (DC-40..DC-45)
  const { data: props, error: pErr } = await sb.from('properties')
    .select('id, street_address').eq('community_id', DC).limit(2000);
  if (pErr) throw new Error('properties: ' + pErr.message);
  const dc = props.filter((p) => /^DC-\d+-\d+$/.test(p.street_address || ''))
    .sort((a, b) => a.street_address.localeCompare(b.street_address));
  const byAddr = new Map(dc.map((p) => [p.street_address, p.id]));
  console.log(`canonical DC properties: ${dc.length}`);

  // existing state to PRESERVE (fail loudly on query error)
  const { data: openV, error: ovErr } = await sb.from('violations')
    .select('property_id, current_stage').eq('community_id', DC);
  if (ovErr) throw new Error('violations read: ' + ovErr.message);
  const hasOpenVio = new Set(openV.filter((v) => !['cured', 'closed', 'voided'].includes(v.current_stage)).map((v) => v.property_id));
  const { data: exAr, error: arErr } = await sb.from('owner_ar_snapshots').select('property_id').eq('community_id', DC);
  if (arErr) throw new Error('ar read: ' + arErr.message);
  const hasAr = new Set(exAr.map((a) => a.property_id));
  const { data: exRes, error: rErr } = await sb.from('property_residencies').select('property_id, end_date').in('property_id', dc.map((p) => p.id)).is('end_date', null);
  if (rErr) throw new Error('residencies read: ' + rErr.message);
  const hasRes = new Set(exRes.map((r) => r.property_id));
  console.log(`preserve: ${hasOpenVio.size} props w/ open violation, ${hasAr.size} w/ AR snapshot, ${hasRes.size} w/ current residency`);

  // category slug -> id, and current owner contact per property (for occupancy)
  const { data: cats, error: cErr } = await sb.from('enforcement_categories').select('id, slug');
  if (cErr) throw new Error('categories: ' + cErr.message);
  const slugId = new Map(cats.map((c) => [c.slug, c.id]));
  for (const [slug] of VIO) if (!slugId.has(slug)) throw new Error('missing enforcement category slug: ' + slug);
  const { data: owners, error: oErr } = await sb.from('v_current_property_owners').select('property_id, owner_contact_id').in('property_id', dc.map((p) => p.id));
  if (oErr) throw new Error('owners: ' + oErr.message);
  const ownerOf = new Map((owners || []).map((o) => [o.property_id, o.owner_contact_id]));

  // ---- selection --------------------------------------------------------------
  const jennifer = byAddr.get('DC-41-015');
  // violation candidates: canonical props with no open violation, minus Jennifer (added first)
  const vioCands = dc.filter((p) => !hasOpenVio.has(p.id) && p.id !== jennifer);
  const vioPicks = [jennifer, ...spread(vioCands, VIO.length - 1).map((p) => p.id)].slice(0, VIO.length);
  // AR candidates: props with no existing snapshot
  const arCands = dc.filter((p) => !hasAr.has(p.id));
  const arPicks = spread(arCands, AR.length).map((p) => p.id);

  // ---- plan counts ------------------------------------------------------------
  const vioByStage = {}; VIO.forEach(([, s]) => (vioByStage[s] = (vioByStage[s] || 0) + 1));
  const arByBucket = {}; AR.forEach(([, b]) => (arByBucket[b] = (arByBucket[b] || 0) + 1));
  let occOwner = 0, occRenter = 0, occUnknown = 0;
  const occPlan = [];
  for (const p of dc) {
    if (hasRes.has(p.id)) continue; // preserve existing personas
    const r = h01(p.id) * 100;
    if (r < 10) { occRenter++; occPlan.push([p.id, 'renter']); }
    else if (r < 28) { occUnknown++; } // no row -> unknown
    else { occOwner++; occPlan.push([p.id, 'owner_occupied']); }
  }

  console.log(`\nVIOLATIONS: ${vioPicks.length} properties  ${JSON.stringify(vioByStage)}  (+ Greg preserved: 3 open)`);
  console.log(`DELINQUENCY: ${arPicks.length} new accounts  ${JSON.stringify(arByBucket)}  (+ ${hasAr.size} existing incl. Greg/Marcus/Tom)`);
  console.log(`OCCUPANCY: +${occOwner} owner_occupied, +${occRenter} renter, ${occUnknown} left unknown (+ ${hasRes.size} existing personas)`);

  if (!EXECUTE) { console.log('\nDRY RUN — no writes.'); return; }

  // ---- 0) backfill community_enforcement_priorities for used categories -------
  const usedCatIds = [...new Set(VIO.map(([slug]) => slugId.get(slug)))];
  const { data: exPrio, error: epErr } = await sb.from('community_enforcement_priorities')
    .select('category_id').eq('community_id', DC).is('end_date', null).in('category_id', usedCatIds);
  if (epErr) throw new Error('priorities read: ' + epErr.message);
  const havePrio = new Set((exPrio || []).map((r) => r.category_id));
  const prioRows = usedCatIds.filter((id) => !havePrio.has(id)).map((id) => ({ community_id: DC, category_id: id, priority_weight: 'standard', notes: 'Demo seed via seed_demo_dc_operations.js' }));
  if (prioRows.length) {
    const { error } = await sb.from('community_enforcement_priorities').insert(prioRows);
    if (error) throw new Error('priorities backfill: ' + error.message);
    console.log(`priorities backfilled: ${prioRows.length}`);
  }

  // ---- 1) VIOLATIONS ----------------------------------------------------------
  let vCreated = 0;
  for (let i = 0; i < vioPicks.length; i++) {
    const propId = vioPicks[i]; if (!propId) continue;
    const [slug, stage, prio] = VIO[i];
    const t = vioTiming(stage);
    const row = {
      id: duid('vio', propId), property_id: propId, community_id: DC,
      primary_category_id: slugId.get(slug), board_priority_at_open: prio,
      current_stage: stage, current_stage_started_at: t.started,
      cure_period_ends_at: t.cure, opened_at: t.opened,
      certified_notice_date: t.cert, source: 'trustEd_native',
    };
    const { error } = await sb.from('violations').upsert(row, { onConflict: 'id' });
    if (error) throw new Error(`violation ${propId}: ${error.message}`);
    vCreated++;
  }
  console.log(`violations upserted: ${vCreated}`);

  // ---- 2) DELINQUENCY ---------------------------------------------------------
  let aCreated = 0;
  for (let i = 0; i < arPicks.length; i++) {
    const propId = arPicks[i]; if (!propId) continue;
    const [bal, bucket, stage, legal, coll] = AR[i];
    const row = {
      id: duid('ar', propId), management_company_id: DEMO_MGMT_CO_ID, community_id: DC,
      property_id: propId, snapshot_date: SNAPSHOT_DATE, balance_total: bal,
      bucket_0_30: 0, bucket_31_60: 0, bucket_61_90: 0, bucket_91_120: 0, bucket_over_120: 0,
      [bucket]: bal, at_legal: legal, in_collections: coll, payment_plan_active: false,
      enforcement_stage: stage, notes: 'Demo operating distribution (seed_demo_dc_operations.js).',
      approved_at: new Date().toISOString(), ingested_at: new Date().toISOString(),
    };
    const { error } = await sb.from('owner_ar_snapshots').upsert(row, { onConflict: 'id' });
    if (error) throw new Error(`ar ${propId}: ${error.message}`);
    aCreated++;
  }
  console.log(`ar snapshots upserted: ${aCreated}`);

  // ---- 3) OCCUPANCY -----------------------------------------------------------
  let rCreated = 0;
  for (const [propId, type] of occPlan) {
    const row = {
      id: duid('res', propId), property_id: propId, start_date: '2021-06-01',
      residency_type: type, contact_id: type === 'owner_occupied' ? (ownerOf.get(propId) || null) : null,
      lease_end_date: type === 'renter' ? '2026-12-31' : null, source: 'demo_seed',
    };
    const { error } = await sb.from('property_residencies').upsert(row, { onConflict: 'id' });
    if (error) throw new Error(`residency ${propId}: ${error.message}`);
    rCreated++;
  }
  console.log(`residencies upserted: ${rCreated}`);
  console.log('\nEXECUTE complete. All rows via canonical tables; scoped to Drama Creek (DEMO tenant).');
}
main().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
