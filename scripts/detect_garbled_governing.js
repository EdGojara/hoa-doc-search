#!/usr/bin/env node
// ===========================================================================
// detect_garbled_governing.js  (Ed 2026-07-02)
// ---------------------------------------------------------------------------
// Cost-aware pre-check before re-OCR: measure how garbled each community's
// governing-doc INDEXED text actually is (what pdf-parse produced), so we only
// spend Claude vision OCR on docs that need it. Scans the `documents` store
// (askEd's read path) per governing library_document and scores the fraction of
// damaged chunks. Waterview should now read CLEAN (already re-OCR'd) — that's
// the control.
//
//   node -r dotenv/config scripts/detect_garbled_governing.js
// ===========================================================================

const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const GOV = ['declaration_ccrs', 'bylaws', 'rules_and_regulations', 'design_document'];

// TRUE OCR-corruption detector. Calibrated 2026-07-02 against real data:
// clean legal front matter is NUMBER-heavy (recording stamps, county file
// numbers, § symbols, underscore notary blanks) and must NOT be flagged; real
// pdf-parse/OCR garble looks like "c::ist one-th!.rd of tho votC!s ~i-.c~nsn
// Mcinbc!l:s" — junk symbols and punctuation wedged INSIDE words. Key on that,
// not on digit/§/underscore density (which false-flagged clean docs).
function damaged(text) {
  if (!text) return false;
  const s = String(text);
  if (s.length < 40) return false;
  // 1) junk symbols that never appear in clean legal prose
  const junk = (s.match(/[~^`|\\{}=<>✓√®©¬¦°]/g) || []).length;
  // 2) mid-word intrusions: a letter, a non-word symbol, a letter (votC!s, c::ist)
  const midWord = (s.match(/[A-Za-z][~^`|\\{}=<>!?*:;#@%+][A-Za-z]/g) || []).length;
  // 3) unambiguous OCR-misread words
  const sigs = /(perfonn|infonn|govemed|govem|maintainence|obhgated|propenY|thereefi|saidLot|Mcinbc|votC|tho votes|c::|~i-)/i.test(s) ? 1 : 0;
  const density = (junk + midWord) / s.length;
  return density > 0.008 || junk >= 4 || midWord >= 3 || sigs === 1;
}

(async () => {
  const { data: comms } = await sb.from('communities').select('id, name');
  const results = [];
  for (const c of comms || []) {
    const { data: docs } = await sb.from('library_documents')
      .select('id, title, category, page_count').eq('community_id', c.id).in('category', GOV);
    for (const d of docs || []) {
      const { data: chunks } = await sb.from('documents')
        .select('content').filter('metadata->>library_document_id', 'eq', d.id).limit(40);
      const n = (chunks || []).length;
      if (!n) { results.push({ comm: c.name, title: d.title, pages: d.page_count, n: 0, bad: 0, pct: null }); continue; }
      const bad = (chunks || []).filter((ch) => damaged(ch.content)).length;
      results.push({ comm: c.name, title: d.title, pages: d.page_count, n, bad, pct: Math.round((bad / n) * 100) });
    }
  }
  // Group by community, show garble %.
  const byComm = {};
  results.forEach((r) => { (byComm[r.comm] = byComm[r.comm] || []).push(r); });
  const needsReocr = {};
  Object.entries(byComm).sort().forEach(([comm, rows]) => {
    const totalPages = rows.reduce((s, r) => s + (r.pages || 0), 0);
    const badDocs = rows.filter((r) => r.pct != null && r.pct >= 25);
    const noIndex = rows.filter((r) => r.n === 0);
    if (badDocs.length) needsReocr[comm] = badDocs;
    console.log(`\n${comm}  (~${totalPages} pages)`);
    rows.forEach((r) => {
      const flag = r.n === 0 ? 'NOT INDEXED' : (r.pct >= 25 ? `⚠ ${r.pct}% garbled` : `ok (${r.pct}%)`);
      console.log(`  [${r.category || ''}] ${(r.title || '').slice(0, 46).padEnd(46)} ${flag}  (${r.n} chunks, ${r.pages || '?'}pg)`);
    });
  });
  console.log('\n=== RE-OCR RECOMMENDED (>=25% garbled chunks) ===');
  const commsNeeding = Object.keys(needsReocr);
  if (!commsNeeding.length) console.log('  none — all governing docs read clean');
  else commsNeeding.forEach((comm) => {
    const pages = needsReocr[comm].reduce((s, r) => s + (r.pages || 0), 0);
    console.log(`  ${comm}: ${needsReocr[comm].length} docs, ~${pages} pages`);
  });
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
