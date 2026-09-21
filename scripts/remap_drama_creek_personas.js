#!/usr/bin/env node
/**
 * remap_drama_creek_personas.js — Phase 2a persona/history remap (REPOINT ONLY).
 *
 * Moves the 13 fictional Drama Creek personas and their preserved history from
 * the legacy Sample properties onto canonical DC-<sec>-<seq> geographic
 * properties, spread across Sections 40-45. REPOINT ONLY — it never deletes a
 * Sample property. Built against the CURRENT schema (does NOT use migration
 * 085's stale dedup function). Idempotent: a row already on its target is left
 * alone. Per persona: snapshot -> repoint by row id -> verify target -> verify
 * source -> rollback on any error.
 *
 * Excluded from modification: appraisal_records (FBCAD provenance on the 376),
 * assets, amenities, boundary, and the 67 bare Sample properties.
 *
 * Usage:
 *   node scripts/remap_drama_creek_personas.js --dry-run
 *   node scripts/remap_drama_creek_personas.js --execute
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const DC = 'dc100000-0000-4000-a000-000000000000';
const EXECUTE = process.argv.includes('--execute');

// Deterministic mapping: persona -> [old sample street, new DC identity, scenario].
// Spread ~2-3 per section; the three role-anchors (violation/ACC/AR) sit in
// Section 40 (showcase assets); the five board members are distributed 41-45.
const MAP = [
  ['Greg Yardgone',           '301 Calm Waters Way',     'DC-40-007', 'active landscaping violation'],
  ['Patricia Newpaint',       '210 Peaceful Pond Drive', 'DC-40-024', 'ACC paint approval'],
  ['Marcus Behindbills',      '201 Harmony Lane',        'DC-40-041', 'delinquency $4,800 at-legal'],
  ['Jennifer Lateleaves',     '102 Serenity Court',      'DC-41-015', 'repeat violation'],
  ['Sunny Meadows',           '109 Tranquility Trail',   'DC-41-058', 'board President'],
  ['Sarah Welcome',           '331 Calm Waters Way',     'DC-42-011', 'new-owner onboarding'],
  ['Byron T. Bylaw',          '202 Peaceful Pond Drive', 'DC-42-038', 'board VP / ACC Chair'],
  ['Tom Investorson',         '231 Harmony Lane',        'DC-43-020', 'rental / investor'],
  ['Cassandra Complaine',     '205 Harmony Lane',        'DC-43-052', 'board Secretary'],
  ['Margaret Foundingmember', '131 Tranquility Trail',   'DC-44-014', 'institutional history'],
  ['Tally Hawthorne',         '110 Serenity Court',      'DC-44-047', 'board Treasurer'],
  ['Robert "Bob" Steady',     '101 Tranquility Trail',   'DC-45-009', 'compliant baseline'],
  ['Felix Goodneighbor',      '305 Calm Waters Way',     'DC-45-050', 'board Member-at-Large'],
];

// property_id-style columns that hold sample rows (the only non-zero ones,
// confirmed by a full-schema probe). appraisal_records is deliberately absent.
const PID_TABLES = [
  ['property_ownerships', 'property_id'],
  ['property_residencies', 'property_id'],
  ['owner_ar_snapshots', 'property_id'],
  ['violations', 'property_id'],
  ['property_enforcement_states', 'property_id'],
  ['homeowner_threads', 'property_id'],
  ['arc_historical_decisions', 'property_id'],
  ['vendor_experiences', 'property_id'],
  ['portal_manager_view_log', 'viewed_property_id'],
];

async function rowsFor(table, col, id) {
  const { data, error } = await sb.from(table).select('id').eq(col, id);
  if (error) throw new Error(`snapshot ${table}.${col}: ${error.message}`);
  return data || [];
}
async function countFor(table, col, id) {
  const { count, error } = await sb.from(table).select('id', { count: 'exact', head: true }).eq(col, id);
  if (error) throw new Error(`count ${table}.${col}: ${error.message}`);
  return count || 0;
}

async function main() {
  const { data: props, error } = await sb.from('properties').select('id, street_address').eq('community_id', DC).limit(2000);
  if (error) throw new Error('load properties: ' + error.message);
  const byAddr = new Map(props.map((p) => [p.street_address, p.id]));

  console.log(`\nDrama Creek persona remap  ·  ${EXECUTE ? 'EXECUTE' : 'DRY RUN'}  ·  ${MAP.length} personas\n`);
  let totalPlanned = 0;

  for (const [persona, oldAddr, newAddr, scenario] of MAP) {
    const sid = byAddr.get(oldAddr), tid = byAddr.get(newAddr);
    if (!sid) throw new Error(`source property not found: ${oldAddr}`);
    if (!tid) throw new Error(`target property not found: ${newAddr}`);

    // snapshot: exact row ids per table on the SOURCE + arc-by-address rows
    const snap = {}; let n = 0;
    for (const [t, c] of PID_TABLES) { const rows = await rowsFor(t, c, sid); if (rows.length) { snap[`${t}.${c}`] = rows; n += rows.length; } }
    const arcAddr = (await sb.from('arc_historical_decisions').select('id').eq('property_address', oldAddr)).data || [];

    console.log(`${persona}  [${oldAddr} -> ${newAddr}]  (${scenario})`);
    console.log(`   snapshot: ${Object.entries(snap).map(([k, v]) => k.replace('.property_id', '').replace('.viewed_property_id', '') + '=' + v.length).join(', ') || '(none)'}${arcAddr.length ? `, arc_address=${arcAddr.length}` : ''}`);
    totalPlanned += n;

    if (!EXECUTE) continue;

    // ---- REPOINT (by primary-key id; idempotent; rollback on error) ----
    const done = [];  // {table, col, ids, from} for rollback
    try {
      for (const [key, rows] of Object.entries(snap)) {
        const [t, c] = key.split('.');
        const ids = rows.map((r) => r.id);
        const { error: uErr } = await sb.from(t).update({ [c]: tid }).in('id', ids);
        if (uErr) throw new Error(`repoint ${key}: ${uErr.message}`);
        done.push({ t, c, ids });
      }
      // arc property_address -> new DC identity string (no stale fabricated address)
      if (arcAddr.length) {
        const ids = arcAddr.map((r) => r.id);
        const { error: aErr } = await sb.from('arc_historical_decisions').update({ property_address: newAddr }).in('id', ids);
        if (aErr) throw new Error(`repoint arc_address: ${aErr.message}`);
        done.push({ t: 'arc_historical_decisions', c: 'property_address', ids, addr: oldAddr });
      }

      // ---- VERIFY target got them, source is empty ----
      for (const [key, rows] of Object.entries(snap)) {
        const [t, c] = key.split('.');
        const got = await countFor(t, c, tid);
        if (got < rows.length) throw new Error(`target verify ${key}: expected >=${rows.length}, got ${got}`);
      }
      for (const [t, c] of PID_TABLES) { const left = await countFor(t, c, sid); if (left > 0) throw new Error(`source not empty ${t}.${c}: ${left} left`); }
      console.log(`   ✓ repointed ${n} rows; source clear; target verified`);
    } catch (e) {
      console.error(`   ✗ ${e.message} — rolling back this persona`);
      for (const d of done.reverse()) {
        if (d.c === 'property_address') await sb.from(d.t).update({ property_address: d.addr }).in('id', d.ids);
        else await sb.from(d.t).update({ [d.c]: sid }).in('id', d.ids);
      }
      throw new Error(`ABORTED at ${persona}; rolled back. No further personas processed.`);
    }
  }

  console.log(`\n${EXECUTE ? 'EXECUTE complete' : 'DRY RUN'} — ${totalPlanned} rows ${EXECUTE ? 'repointed' : 'would repoint'} across ${MAP.length} personas.`);
  console.log('No Sample properties deleted. appraisal_records / assets / amenities / boundary untouched.');
}
main().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
