#!/usr/bin/env node
// ============================================================================
// scripts/backfill_proposal_line_items.js  (Ed 2026-10-16)
// ----------------------------------------------------------------------------
// Proposals already on file were stored without line items, so every comparison
// re-extracted them and the camera / license counts could move between runs. This
// extracts line items ONCE per stored document (keyed by its SHA-256) and stores them
// on the proposal record, in vendor_proposals.extracted_data:
//   comparison_items[]  (each with line_items, scope_statements, printed_subtotal_cents)
//   line_items_sha256, line_items_extracted_at
// After that, quantities are computed in code (lib/vendors/line_items.js) and are
// byte-identical on every run.
//
//   node scripts/backfill_proposal_line_items.js --community=<uuid>            dry run (default): writes nothing
//   node scripts/backfill_proposal_line_items.js --community=<uuid> --apply    writes (Ed approves first)
//   add --proposal=<id> to limit to one proposal; --limit=N (default 25)
//   --reprocess --requested-by=<name> --reason="..."  extract again as a NEW version (pending review)
//
// Dry run uses a read-only client that throws on any write. Existing line items are
// never overwritten (re-extracting would reintroduce the variance this removes).
// ============================================================================
require('dotenv').config();
const crypto = require('crypto');
const { readOnly } = require('./amanda_rfp_dry_run');
const L = require('../lib/vendors/line_items');
const V = require('../lib/vendors/line_item_versions');

async function plan(db, { community, proposal, limit = 25, extract, reprocess = null }) {
  let q = db.from('vendor_proposals').select('id, community_id, proposer_company_name, vendor_name_raw, file_path, file_hash, extracted_data').order('created_at', { ascending: true }).limit(limit);
  if (community) q = q.eq('community_id', community);
  if (proposal) q = q.eq('id', proposal);
  const { data, error } = await q;
  if (error) throw new Error(`vendor_proposals read failed: ${error.message}`);
  const out = [];
  for (const p of data || []) {
    const ed = p.extracted_data || {};
    // Ordinary reruns reuse the approved stored version; only a changed file or --reprocess extracts again.
    const usable = V.currentUsable(ed);
    if (!reprocess && usable && (!p.file_hash || p.file_hash === (usable.document_sha256 || p.file_hash))) { out.push({ id: p.id, action: 'skip', reason: `line items stored (v${usable.version}, ${usable.status})` }); continue; }
    if (!p.file_path) { out.push({ id: p.id, action: 'skip', reason: 'no stored file' }); continue; }
    const { data: blob, error: de } = await db.storage.from('documents').download(p.file_path);
    if (de || !blob) { out.push({ id: p.id, action: 'error', reason: `download failed: ${de ? de.message : 'empty'}` }); continue; }
    const buf = Buffer.from(await blob.arrayBuffer());
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (p.file_hash && p.file_hash !== sha) { out.push({ id: p.id, action: 'error', reason: `stored file hash ${p.file_hash.slice(0, 12)} != downloaded ${sha.slice(0, 12)}` }); continue; }
    const need = V.needsExtraction(ed, sha, { reprocess });
    if (!need.extract) { out.push({ id: p.id, action: 'skip', reason: 'line items stored for this file hash' }); continue; }
    const r = await extract(buf, { filename: p.file_path.split('/').pop(), source_kind: 'vendor_proposal', ref: p.id });
    const next = V.addVersion(ed, { items: r.items || [], document_sha256: sha, reason: reprocess ? reprocess.reason : need.reason === 'hash_changed' ? 'source file changed' : 'initial extraction', requested_by: reprocess ? reprocess.requested_by : 'backfill' });
    const newV = next.line_item_versions[next.line_item_versions.length - 1];
    const computed = (r.items || []).map((it) => ({ key: it.key, vendor: it.vendor_name, pages: (it.document || {}).pages, ...L.computeQuantities({ ...it, line_items_stored: true }) }));
    out.push({ id: p.id, action: newV.status === 'pending_approval' ? 'store' : 'store_for_review', status: newV.status, why: need.reason, sha256: sha, items: r.items || [], extracted_data: next, version: newV.version, review_flag: newV.review_flag || null, differs: newV.differs_from_approved || [], computed, invalid: (r.diagnostic || {}).invalid || [] });
  }
  return out;
}

async function apply(db, rows) {
  const done = [];
  for (const r of rows.filter((x) => ['store', 'store_for_review'].includes(x.action) && x.items.length)) {
    const { data: cur, error: ce } = await db.from('vendor_proposals').select('extracted_data').eq('id', r.id).maybeSingle();
    if (ce) { done.push({ id: r.id, error: ce.message }); continue; }
    // Appends a version on top of what is there now; earlier versions are never overwritten or deleted.
    const curEd = (cur && cur.extracted_data) || {};
    const nv = r.extracted_data.line_item_versions[r.extracted_data.line_item_versions.length - 1];
    const ed = V.addVersion(curEd, { items: nv.items, document_sha256: nv.document_sha256, reason: nv.reason, requested_by: nv.requested_by, at: nv.extracted_at, model: nv.model });
    const { error } = await db.from('vendor_proposals').update({ extracted_data: ed }).eq('id', r.id);
    done.push({ id: r.id, error: error ? error.message : null });
  }
  return done;
}

if (require.main === module) {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] == null ? true : m[2]] : [a, true]; }));
  (async () => {
    const { createClient } = require('@supabase/supabase-js');
    const raw = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    const db = args.apply ? raw : readOnly(raw);
    const extract = (b, m) => require('../lib/vendors/proposal_extract').extractProposals(b, m);
    if (args.reprocess && (!args['requested-by'] || !args.reason)) throw new Error('--reprocess needs --requested-by=<name> and --reason="..."');
    const reprocess = args.reprocess ? { requested_by: args['requested-by'], reason: args.reason } : null;
    const rows = await plan(db, { community: args.community, proposal: args.proposal, limit: Number(args.limit || 25), extract, reprocess });
    for (const r of rows) {
      console.log(`${r.id}: ${r.action}${r.reason ? ` (${r.reason})` : ''}${r.version ? ` -> version ${r.version}${r.why ? ` (${r.why})` : ''}` : ''}${r.review_flag ? `; REVIEW: ${r.differs.map((d) => `${d.field} ${d.approved} -> ${d.new}`).join(', ')}` : ''}`);
      for (const c of r.computed || []) console.log(`   ${c.vendor} pp.${c.pages || '?'}: cameras ${c.values.cameras_total} (new ${c.values.cameras_new}, reused ${c.values.cameras_reused}), licenses ${c.values.licenses}${c.subtotal ? `, subtotal ${c.subtotal.matches === false ? 'MISMATCH' : 'ok'}` : ''}${c.uncertain.length ? `, UNCERTAIN: ${c.uncertain.map((u) => u.field).join(', ')}` : ''}`);
    }
    if (!args.apply) { console.log('\nDry run: nothing written. Re-run with --apply after review.'); return; }
    console.log(JSON.stringify(await apply(db, rows), null, 2));
  })().catch((e) => { console.error('backfill failed:', e.message); process.exit(1); });
}

module.exports = { plan, apply };
