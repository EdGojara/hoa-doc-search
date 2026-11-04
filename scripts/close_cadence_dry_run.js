#!/usr/bin/env node
// ============================================================================
// scripts/close_cadence_dry_run.js  (Ed 2026-10-15)
// ----------------------------------------------------------------------------
// What Amanda's daily close sweep (lib/close/cadence.js) WOULD do, without
// writing anything: no checklist run recorded, no task created or closed, no
// meeting row, no packet. Reads only.
//
//   node scripts/close_cadence_dry_run.js --community <uuid> [--meeting-date YYYY-MM-DD] [--json]
//
// --meeting-date assumes a board meeting on that date (for a community with none
// on file) so the deadlines and packet timing can be seen before the date is set.
// ============================================================================
'use strict';
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');
const { runCadence } = require('../lib/close/cadence');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const cid = arg('--community');
const md = arg('--meeting-date');
if (!cid || !/^[0-9a-f-]{36}$/i.test(cid)) { console.error('usage: --community <uuid> [--meeting-date YYYY-MM-DD] [--json]'); process.exit(2); }
if (md && !/^\d{4}-\d{2}-\d{2}$/.test(md)) { console.error('--meeting-date must be YYYY-MM-DD'); process.exit(2); }

(async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const r = await runCadence({ supabase, dryRun: true, only: [cid], assumeMeeting: md ? { meeting_date: md } : null,
    deps: { communities: async () => [{ id: cid }] } });
  if (process.argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return; }
  console.log(`Close cadence DRY RUN ${r.today} (nothing written)`);
  if (!r.ok) console.log('ERRORS', JSON.stringify(r.errors));
  for (const p of r.plans) {
    console.log(`\n${p.community.name}`);
    console.log(`  Open months: ${p.open_months.join(', ') || 'none'}`);
    console.log(`  Next meeting: ${p.meeting ? `${p.meeting.meeting_date} (${p.meeting.source}${p.meeting.would_create ? ', would create the meeting record' : ''})` : 'NONE ON FILE'}`);
    if (p.deadlines) console.log(`  Deadlines: inputs ${p.deadlines.collect} · months closed ${p.deadlines.close} · draft reviewed ${p.deadlines.review_draft} · distribution approved ${p.deadlines.approve} · financials through ${p.cutoff}`);
    for (const v of p.reviews) console.log(`  Kat review ${v.month}: ${v.error ? `ERROR ${v.error}` : `${v.changed ? 'books/evidence CHANGED -> would record a new run' : 'unchanged -> no new run'}; ${v.summary ? `${v.summary.block} BLOCK, ${v.summary.warning} WARNING, ${v.summary.pass} PASS` : ''}`}`);
    console.log(`  Packet: ${p.packet_action ? 'would create + assemble as DRAFT' : 'no packet action'}`);
    console.log(`  Tasks (${p.tasks.length}):`);
    for (const t of p.tasks) {
      const tag = p.would.create.includes(t.source_ref) ? 'CREATE' : p.would.update.includes(t.source_ref) ? 'UPDATE' : 'same  ';
      console.log(`    ${tag} [${t.assigned_to}] ${t.title}${t.due_date ? ` (due ${t.due_date}, ${t.urgency})` : ` (${t.urgency})`}\n           ref ${t.source_ref}\n           next: ${t.next_step}`);
    }
    for (const a of p.adopted) console.log(`    ADOPT  ${a.source_ref} -> existing hand-made task ${a.adopted_by} (not created, not edited)`);
    for (const ref of p.would.resolve) console.log(`    RESOLVE ${ref}`);
    for (const n of p.notes) console.log(`  NOTE ${n}`);
  }
})().catch((e) => { console.error('dry run failed:', e.message); process.exit(1); });
