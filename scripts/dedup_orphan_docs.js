#!/usr/bin/env node
// ===========================================================================
// dedup_orphan_docs.js  (Ed 2026-07-01)
// ---------------------------------------------------------------------------
// Retire LEGACY-ORPHAN duplicate governing-doc copies from the retrieval store
// (the `documents` table), keeping the curated library_documents copy. These
// legacy re-ingestions (messy filenames, no library_document_id link) dilute
// askEd retrieval — the Waterview Declaration §3.12 miss was worsened by 5+
// copies of the Declaration competing.
//
// SAFETY (this feeds §209 citations — do not lose content):
//   - Only ORPHAN docs (chunk has no valid, active library_document_id) are
//     candidates. Curated docs are never touched.
//   - An orphan is retired ONLY if its content is DUPLICATED elsewhere: >= 90%
//     of its sampled distinctive text is found in the community's CURATED
//     content. Unique orphans (no curated equivalent) are KEPT.
//   - AMENDMENTS / supplements are NEVER retired (filename match) — they carry
//     current superseding language even when they restate most of the original.
//   - Full snapshot (incl. embeddings) written before any delete — reversible.
//
//   node -r dotenv/config scripts/dedup_orphan_docs.js            # dry-run
//   node -r dotenv/config scripts/dedup_orphan_docs.js --apply    # execute
// ===========================================================================

const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const APPLY = process.argv.includes('--apply');
const OVERLAP_MIN = 0.90;
const AMEND_RE = /amend|supplement|amendment/i;   // never retire these

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

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
  const { data: comms } = await sb.from('communities').select('name').order('name');
  const retireIds = [];         // documents.id to delete
  const report = [];            // {community, file, chunks, overlap, action}

  for (const { name: comm } of comms || []) {
    const dc = await pageAll('documents', 'id, content, metadata', (q) => q.eq('metadata->>community', comm));
    if (!dc.length) continue;
    const libIds = [...new Set(dc.map((c) => c.metadata && c.metadata.library_document_id).filter(Boolean))];
    let validLib = new Set();
    if (libIds.length) {
      const { data: libs } = await sb.from('library_documents').select('id').in('id', libIds);
      validLib = new Set((libs || []).map((l) => l.id));
    }
    const curated = [], orphanByFile = new Map();
    for (const c of dc) {
      const lid = c.metadata && c.metadata.library_document_id;
      if (lid && validLib.has(lid)) curated.push(c);
      else { const fn = (c.metadata && c.metadata.filename) || '?'; if (!orphanByFile.has(fn)) orphanByFile.set(fn, []); orphanByFile.get(fn).push(c); }
    }
    if (!orphanByFile.size) continue;
    const curatedBlob = curated.map((c) => norm(c.content)).join('  ');

    for (const [fn, chunks] of orphanByFile) {
      if (AMEND_RE.test(fn)) { report.push({ comm, fn, n: chunks.length, ov: '-', action: 'KEEP (amendment)' }); continue; }
      const sample = chunks.slice().sort((a, b) => (b.content || '').length - (a.content || '').length).slice(0, 25);
      let hit = 0, tested = 0;
      for (const c of sample) {
        const n = norm(c.content); if (n.length < 80) continue;
        const mid = n.slice(Math.floor(n.length / 2) - 25, Math.floor(n.length / 2) + 25);
        if (mid.length < 30) continue; tested++;
        if (curatedBlob.includes(mid)) hit++;
      }
      const frac = tested ? hit / tested : 0;
      if (curated.length > 0 && frac >= OVERLAP_MIN) {
        report.push({ comm, fn, n: chunks.length, ov: (frac * 100).toFixed(0) + '%', action: 'RETIRE' });
        for (const c of chunks) retireIds.push(c.id);
      } else {
        report.push({ comm, fn, n: chunks.length, ov: (frac * 100).toFixed(0) + '%', action: 'KEEP (unique)' });
      }
    }
  }

  const retired = report.filter((r) => r.action === 'RETIRE');
  console.log(`\n=== ${APPLY ? 'RETIRING' : 'DRY-RUN — would retire'} ${retireIds.length} orphan chunks across ${retired.length} duplicate docs ===`);
  retired.sort((a, b) => b.n - a.n).forEach((r) => console.log(`  RETIRE  ${String(r.n).padStart(4)}  ov ${r.ov}  ${r.comm} · ${r.fn.slice(0, 48)}`));
  const kept = report.filter((r) => r.action !== 'RETIRE');
  console.log(`\nKEPT (untouched): ${kept.length} orphan docs — ${kept.filter((k) => k.action.includes('amendment')).length} amendments, ${kept.filter((k) => k.action.includes('unique')).length} unique`);

  if (!APPLY) { console.log('\n(dry-run — re-run with --apply to snapshot + delete)'); return; }
  if (!retireIds.length) { console.log('nothing to retire.'); return; }

  // snapshot FULL rows (incl embedding) before delete — reversible
  const snap = [];
  for (let i = 0; i < retireIds.length; i += 200) {
    const { data } = await sb.from('documents').select('*').in('id', retireIds.slice(i, i + 200));
    snap.push(...(data || []));
  }
  const path = `backups/dedup-orphan-docs-2026-07-01.json`;
  fs.writeFileSync(path, JSON.stringify(snap));
  console.log(`snapshot: ${snap.length} rows -> ${path}`);

  let deleted = 0;
  for (let i = 0; i < retireIds.length; i += 200) {
    const batch = retireIds.slice(i, i + 200);
    const { error } = await sb.from('documents').delete().in('id', batch);
    if (error) { console.error('delete batch failed:', error.message); process.exit(1); }
    deleted += batch.length;
  }
  console.log(`deleted ${deleted} orphan chunks. Snapshot at ${path} (reversible).`);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
