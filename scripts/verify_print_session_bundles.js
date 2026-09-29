#!/usr/bin/env node
// scripts/verify_print_session_bundles.js  (Issue #5, Ed 2026-09-28)
// READ-ONLY post-print check for ONE Mail Queue lock-and-batch session. For every
// multi-violation envelope (members sharing a bundle_id), it proves:
//   * every member sealed the SAME bytes, equal to the combined letter (content);
//   * the combined letter has every member's violation, numbered, with photos.
// Run it right after a print run and BEFORE "Confirm this batch mailed":
//   node scripts/verify_print_session_bundles.js --printed-at 2026-09-29T15:00:00.000Z [--method first_class_mail]
// Exit code 0 = PASS, 1 = at least one envelope failed. Never writes anything.
require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { fetchAllQuery } = require('../lib/db/fetch_all');
const { PDFDocument, PDFName, PDFDict } = require('pdf-lib');
const pdfParse = require('pdf-parse');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const printedAt = arg('--printed-at');
const method = arg('--method', 'first_class_mail');
if (!printedAt) { console.error('usage: --printed-at <ISO timestamp of the print session>'); process.exit(2); }
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { auth: { persistSession: false } });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function download(bucket, path) {
  const { data, error } = await sb.storage.from(bucket).download(path);
  if (error) throw new Error(`${bucket}/${path}: ${error.message}`);
  return Buffer.from(await data.arrayBuffer());
}
async function facts(buf) {
  const doc = await PDFDocument.load(buf);
  const photos = []; const seen = new Set();
  const walk = (res) => {
    if (!res) return; const xo = res.lookup(PDFName.of('XObject')); if (!(xo instanceof PDFDict)) return;
    for (const [, ref] of xo.entries()) {
      if (seen.has(String(ref))) continue; seen.add(String(ref));
      const o = doc.context.lookup(ref); if (!o || !o.dict) continue;
      const st = String(o.dict.get(PDFName.of('Subtype')));
      if (st === '/Image') { const w = +o.dict.get(PDFName.of('Width')), h = +o.dict.get(PDFName.of('Height')); if (w && h && Math.max(w, h) / Math.min(w, h) < 2) photos.push(`${w}x${h}`); }
      else if (st === '/Form') walk(o.dict.lookup(PDFName.of('Resources')));
    }
  };
  for (const p of doc.getPages()) walk(p.node.Resources());
  const text = (await pdfParse(buf)).text;
  const numbered = [1, 2, 3, 4, 5, 6].filter((n) => new RegExp(`(^|\\n)\\s*${n}\\.\\s+[A-Za-z]`).test(text)).length;
  return { photos: photos.length, numbered, text };
}

(async () => {
  const rows = await fetchAllQuery(() => sb.from('interactions')
    .select('id, bundle_id, content, property_id, mailed_at, violations(enforcement_categories(label))')
    .eq('delivery_method', method).eq('printed_at', printedAt));
  if (!rows.length) { console.error('no letters found for that printed_at / method'); process.exit(2); }
  const groups = new Map();
  for (const r of rows) if (r.bundle_id) (groups.get(r.bundle_id) || groups.set(r.bundle_id, []).get(r.bundle_id)).push(r);
  const bundles = [...groups.values()].filter((g) => g.length > 1);
  const ids = bundles.flat().map((r) => r.id);
  const seals = ids.length ? await fetchAllQuery(() => sb.from('sent_letter_archive').select('id, interaction_id, sha256, archive_path, sealed_at').in('interaction_id', ids), { orderBy: 'id' }) : [];
  let failed = 0;
  for (const g of bundles) {
    const problems = [];
    const contents = new Set(g.map((m) => m.content));
    if (contents.size !== 1) problems.push('members point at different content files');
    const content = g[0].content;
    let cBuf = null, cSha = null, f = null;
    try { cBuf = await download('violation-letters', content); cSha = sha(cBuf); f = await facts(cBuf); } catch (e) { problems.push('content unreadable: ' + e.message); }
    if (f) {
      if (f.numbered < g.length) problems.push(`combined letter numbers ${f.numbered} item(s) for ${g.length} violations`);
      if (f.photos < g.length) problems.push(`combined letter has ${f.photos} photo(s) for ${g.length} violations`);
      for (const m of g) { const lbl = m.violations && m.violations.enforcement_categories && m.violations.enforcement_categories.label; if (lbl && !f.text.includes(lbl)) problems.push(`"${lbl}" missing from the combined letter`); }
    }
    for (const m of g) {
      const mine = seals.filter((s) => s.interaction_id === m.id).sort((a, b) => String(b.sealed_at).localeCompare(String(a.sealed_at)))[0];
      if (!mine) { problems.push(`member ${m.id.slice(0, 8)} has no seal`); continue; }
      if (cSha && mine.sha256 !== cSha) problems.push(`member ${m.id.slice(0, 8)} sealed different bytes than the combined letter`);
    }
    if (problems.length) failed += 1;
    console.log(`${problems.length ? 'FAIL' : 'PASS'}  bundle ${g[0].bundle_id.slice(0, 8)} (${g.length} violations)${problems.length ? ': ' + problems.join('; ') : ''}`);
  }
  console.log(`\n${rows.length} letters, ${bundles.length} multi-violation envelope(s), ${failed} failed.${failed ? ' Do NOT confirm mailed.' : ' OK to confirm mailed.'}`);
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error('verify failed:', e.message); process.exit(2); });
