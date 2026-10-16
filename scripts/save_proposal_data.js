#!/usr/bin/env node
// ============================================================================
// scripts/save_proposal_data.js  (Ed 2026-10-16: one-time save, selective confidence, option (a))
// ----------------------------------------------------------------------------
// Creates the RFP / Bid Workflow records for reviewed proposals from a PLAN FILE.
// Dry run by default (read-only client that throws on any write); writes only with --apply.
// Idempotent: a full, consistent prior save is "0 inserts, 0 updates, already saved"; a
// partial or inconsistent state is a CONFLICT with ids and nothing is written.
//
//   node scripts/save_proposal_data.js --plan=<plan.json> --preview-cache=<dir>                     dry run
//   node scripts/save_proposal_data.js --plan=<plan.json> --preview-cache=<dir> --simulate-saved    dry run, then a second
//                                                                                                     dry run over the simulated post-save state
//   node scripts/save_proposal_data.js --plan=<plan.json> --preview-cache=<dir> --apply             write
//
// Writes, in order, stopping at the first failure with what was already written:
//   1 bid_requests row (unless the matching request already exists), then one vendor_proposals
//   row per canonical proposal. Never: vendors, storage uploads, rfp_decision_log, email.
// Before writing it checks, read-only, that every column it writes exists (a select of exactly
// those columns); the base tables predate the migrations folder, so the column sets mirror the
// production insert paths (api/vendors.js POST /rfps, server.js /upload-proposal).
// ============================================================================
require('dotenv').config();
const fs = require('fs');
const S = require('../lib/vendors/proposal_save');
const V = require('../lib/vendors/line_item_versions');

/** Items per document from the preview cache, at the version the plan names. */
function itemsFromCache(plan, cache) {
  const out = {};
  for (const p of plan.proposals) {
    const ed = cache.get(p.document_sha256);
    if (!ed) throw new Error(`document ${p.document_sha256.slice(0, 12)} is not in the preview cache`);
    const vs = V.versionsOf(ed);
    let v;
    if (p.source_version != null) v = vs.find((x) => x.version === Number(p.source_version));
    else if (vs.length === 1) v = vs[0];
    else throw new Error(`document ${p.document_sha256.slice(0, 12)} has ${vs.length} cached versions (${vs.map((x) => `v${x.version} ${x.status}`).join(', ')}); set source_version for ${p.proposal_key}`);
    if (!v) throw new Error(`version ${p.source_version} not found for ${p.document_sha256.slice(0, 12)}`);
    out[p.document_sha256] = v.items;
  }
  return out;
}

/** Read-only snapshot of what already exists for this community and these documents. */
async function readSnapshot(db, plan) {
  const shas = [...new Set(plan.proposals.flatMap((p) => [p.document_sha256, ...(p.duplicates || []).map((d) => d.document_sha256)]))];
  const q = async (label, query) => { const { data, error } = await query; if (error) throw new Error(`${label} read failed: ${error.message}`); return data || []; };
  return {
    bid_requests: await q('bid_requests', db.from('bid_requests').select('id, community_id, service_category, title, status').eq('community_id', plan.community_id).limit(200)),
    vendor_proposals: await q('vendor_proposals', db.from('vendor_proposals').select('id, community_id, bid_request_id, file_hash, vendor_name_raw, extracted_data').eq('community_id', plan.community_id).in('file_hash', shas).limit(200)),
    vendors: await q('vendors', db.from('vendors').select('id, name, dba, is_active').limit(2000)),
    library_documents: await q('library_documents', db.from('library_documents').select('id, title, file_hash').eq('community_id', plan.community_id).in('file_hash', shas).limit(200)),
  };
}

/** Every column the save writes must exist (PostgREST rejects an unknown column in a select). */
async function preflightColumns(db, inserts) {
  for (const table of ['bid_requests', 'vendor_proposals']) {
    const cols = [...new Set(inserts.filter((i) => i.table === table).flatMap((i) => Object.keys(i.row)))];
    if (!cols.length) continue;
    const { error } = await db.from(table).select(cols.join(', ')).limit(1);
    if (error) throw new Error(`preflight: ${table} rejects the columns this save writes (${error.message}); nothing written`);
  }
}

async function apply(db, result) {
  if (result.conflicts.length) throw new Error(`refusing to write: ${result.conflicts.join(' | ')}`);
  const written = [];
  let bidId = null;
  for (const i of result.inserts) {
    const row = i.table === 'vendor_proposals' && i.row.bid_request_id === '<bid_request.id>' ? { ...i.row, bid_request_id: bidId } : i.row;
    const { data, error } = await db.from(i.table).insert(row).select('id').single();
    if (error) throw new Error(`STOPPED at ${i.table} ${i.ref}: ${error.message}. Already written: ${JSON.stringify(written)}`);
    if (i.table === 'bid_requests') bidId = data.id;
    written.push({ table: i.table, ref: i.ref, id: data.id });
  }
  for (const u of result.updates || []) {
    // Only if the row is still exactly what the dry run saw.
    const { data: cur, error: ce } = await db.from('vendor_proposals').select('extracted_data').eq('id', u.id).maybeSingle();
    if (ce || !cur) throw new Error(`STOPPED at update ${u.ref}: read failed (${ce ? ce.message : 'row not found'}). Already written: ${JSON.stringify(written)}`);
    if (JSON.stringify(cur.extracted_data) !== JSON.stringify(u.expect_extracted_data)) throw new Error(`STOPPED at update ${u.ref}: vendor_proposals ${u.id} changed since the dry run. Already written: ${JSON.stringify(written)}`);
    const { error } = await db.from('vendor_proposals').update(u.patch).eq('id', u.id);
    if (error) throw new Error(`STOPPED at update ${u.ref}: ${error.message}. Already written: ${JSON.stringify(written)}`);
    written.push({ table: 'vendor_proposals', ref: u.ref, id: u.id, op: 'update' });
  }
  return written;
}

function describe(result) {
  const L = [`RESULT: ${result.summary}`];
  for (const c of result.conflicts) L.push(`CONFLICT: ${c}`);
  for (const nop of result.noops) L.push(`NO-OP ${nop.table} ${nop.id}${nop.ref ? ` [${nop.ref}]` : ''}: ${nop.note}`);
  for (const i of result.planned_inserts) {
    if (i.table === 'bid_requests') { L.push(`INSERT bid_requests ${JSON.stringify(i.row)}`); continue; }
    const { extracted_data: ed, ...cols } = i.row;
    const v = ed.line_item_versions[0]; const it = v.items[0];
    L.push(`INSERT vendor_proposals [${i.ref}] mode=${ed.save_mode} status=${ed.classification.status}${ed.classification.replaced_by ? ` replaced_by=${ed.classification.replaced_by}` : ''}`);
    L.push(`   columns: ${JSON.stringify(cols)}`);
    L.push(`   extracted_data: proposal_key ${ed.proposal_key}; version ${v.version} ${v.status}; approval ${JSON.stringify(v.approval)}; fields stored: ${Object.keys(it).sort().join(', ')}${Array.isArray(it.line_items) ? `; line_items ${it.line_items.length}` : '; no line items'}`);
    L.push(`   source_documents: ${JSON.stringify(ed.source_documents)}`);
    L.push(`   audit: ${ed.audit.map((a) => a.note).join(' | ')}`);
  }
  for (const u of result.planned_updates || []) {
    const st = u.patch.extracted_data.decision_statements.slice(-1)[0];
    L.push(`UPDATE vendor_proposals ${u.id} [${u.ref}]: append extracted_data.decision_statements ${JSON.stringify(st)}; append audit "${u.patch.extracted_data.audit.slice(-1)[0].note}"; extracted facts unchanged`);
  }
  for (const m of result.vendor_matches) L.push(`VENDOR ${m.ref} "${m.vendor_name}": vendor_id ${m.vendor_id || 'null'}; exact-name candidates (reported, not used): ${m.exact_name_candidates.map((v) => `${v.id} ${v.name}`).join('; ') || 'none'}`);
  return L.join('\n');
}

if (require.main === module) {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] == null ? true : m[2]] : [a, true]; }));
  (async () => {
    if (!args.plan || !args['preview-cache']) throw new Error('--plan=<file> and --preview-cache=<dir> are required');
    if (args.apply && args['simulate-saved']) throw new Error('--simulate-saved is a dry run; do not combine it with --apply');
    const plan = JSON.parse(fs.readFileSync(args.plan, 'utf8'));
    S.validatePlan(plan);
    const { fileCache, readOnly } = require('./amanda_rfp_dry_run');
    const items = itemsFromCache(plan, fileCache(args['preview-cache']));
    const { createClient } = require('@supabase/supabase-js');
    const raw = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    const db = args.apply ? raw : readOnly(raw);
    const { BEDROCK_MGMT_CO_ID } = require('../lib/company');
    const opts = { mgmtId: BEDROCK_MGMT_CO_ID, communityName: plan.community_name || null, today: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }), at: (plan.approval || {}).approved_at };
    const snapshot = await readSnapshot(db, plan);
    const result = S.planSave(plan, items, { ...opts, snapshot });
    await preflightColumns(readOnly(raw), result.planned_inserts);
    console.log(describe(result));
    if (args['simulate-saved']) {
      const second = S.planSave(plan, items, { ...opts, snapshot: S.layerSaved(snapshot, result.inserts, result.updates) });
      console.log(`\nSIMULATED SECOND RUN (planned rows layered over the snapshot): ${second.summary}`);
      if (second.planned_inserts.length || (second.planned_updates || []).length || second.conflicts.length) { console.log(describe(second)); process.exit(1); }
    }
    if (!args.apply) { console.log('\nDry run: nothing written. Re-run with --apply after review.'); return; }
    console.log(JSON.stringify(await apply(db, result), null, 2));
  })().catch((e) => { console.error('save failed:', e.message); process.exit(1); });
}

module.exports = { itemsFromCache, readSnapshot, preflightColumns, apply, describe };
