#!/usr/bin/env node
// ============================================================================
// Every per-owner balance screen uses the AR aging rule (Ed 2026-10-08):
// ledger balance + native charges on top, or ar_charges alone where the
// community's AR was migrated into it ('vantaca_migration', Quail Ridge).
// Found 2026-10-21: owner search and collections switched a WHOLE community to
// ar_charges once one native certified-letter fee existed, so every other owner
// showed $0 (Waterview, Still Creek, Canyon Gate). Source guard always runs;
// the live check (read-only) runs when SUPABASE_URL is set.
// ============================================================================
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

let pass = 0; let fail = 0;
const check = (name, ok, detail) => { if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); } };

console.log('source guard: no screen replaces the ledger with native charges');
const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'gl.js'), 'utf8');
check('no "if (charges.length)" / "if (!charges.length)" ledger switch remains', !/if \(!?charges\.length\)/.test(src));
check('owner search, collections, account and statement all apply the shared rule (4 call sites)', (src.match(/await _arNativeIsRecord\(cid\)/g) || []).length === 4);

(async () => {
  if (!process.env.SUPABASE_URL) { console.log('live check skipped (no SUPABASE_URL)'); return; }
  console.log('live (read-only): the rule picks the right AR of record');
  const { _test: { _arNativeIsRecord, _openChargesFromTransactions } } = require('../api/gl');
  const { createClient } = require('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const { data: comms } = await sb.from('communities').select('id, name').in('name', ['Waterview Estates', 'Quail Ridge']);
  for (const c of comms || []) {
    const nativeRecord = await _arNativeIsRecord(c.id);
    if (/quail/i.test(c.name)) { check(`${c.name}: native ar_charges are the AR of record`, nativeRecord === true); continue; }
    check(`${c.name}: the migrated ledger is the AR of record`, nativeRecord === false);
    const ledger = await _openChargesFromTransactions(c.id);
    const owners = new Set(ledger.map((x) => x.property_id));
    check(`${c.name}: ledger balances are present for owners beyond the few with native fees`, owners.size > 50, `${owners.size} owners`);
  }
})().catch((e) => { fail++; console.log(`  ✗ live check threw: ${e.message}`); })
  .finally(() => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); });
