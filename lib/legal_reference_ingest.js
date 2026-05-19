// ============================================================================
// legal_reference_ingest.js
// ----------------------------------------------------------------------------
// Statute-aware PDF ingest for legal-reference books (RMWBH Texas Property
// Code guides, etc.). Splits by Sec. X.YYY boundaries so each chunk maps to
// a single statute section — citations resolve cleanly and the compliance
// engine can later flag actions against specific sections.
//
// Differs from the generic help.js ingest path (which uses AI-based page
// extraction + 500-token sliding windows). Statute books have explicit
// structural anchors; we use them instead of guessing.
// ============================================================================

const pdfParse = require('pdf-parse');

// ----------------------------------------------------------------------------
// SECTION_REGEX — anchors a statute section heading.
//   "Sec. 209.006 Notice Required Before Enforcement Action"
//   "Sec. 209.0091 Prerequisites To Foreclosure..."
//   "Sec.209.001. Short Title"
// ----------------------------------------------------------------------------
const SECTION_REGEX = /^\s*Sec\.\s*(\d+\.\d+[A-Za-z]*)\.?\s+(.+?)\s*$/gm;

// Chapter number is derivable from the section number itself — Texas codes
// use chapter.section notation universally (209.006 → chapter 209). This
// is more reliable than parsing chapter-header text because TOC markers
// would otherwise leak into body-section chapter assignment.
function chapterFromSection(sectionNumber) {
  if (!sectionNumber) return null;
  const dot = sectionNumber.indexOf('.');
  return dot > 0 ? sectionNumber.slice(0, dot) : sectionNumber;
}

// Sort a section_number like '209.0091' into a comparable numeric tuple
// so 209.006 sorts BEFORE 209.0061 and AFTER 209.005.
function sortKeyForSection(sectionNumber) {
  const m = /^(\d+)\.(\d+)([A-Za-z]*)$/.exec(sectionNumber || '');
  if (!m) return [9999, 9999, ''];
  return [parseInt(m[1], 10), parseInt(m[2], 10), m[3] || ''];
}

// ----------------------------------------------------------------------------
// parseStatuteSections — takes raw PDF text and returns an array of
// { chapter_number, section_number, section_title, body } records, sorted
// numerically by section number.
// ----------------------------------------------------------------------------
function parseStatuteSections(rawText) {
  const sectionStarts = [];
  let secMatch;
  const secRe = new RegExp(SECTION_REGEX.source, 'gm');
  while ((secMatch = secRe.exec(rawText)) !== null) {
    sectionStarts.push({
      offset: secMatch.index,
      header_end: secMatch.index + secMatch[0].length,
      section_number: secMatch[1],
      section_title: secMatch[2].trim(),
    });
  }

  // Drop TOC-line matches — identifiable by a body containing only
  // page-number dots or being very short.
  const sections = [];
  for (let i = 0; i < sectionStarts.length; i++) {
    const s = sectionStarts[i];
    const nextOffset = i + 1 < sectionStarts.length ? sectionStarts[i + 1].offset : rawText.length;
    const body = rawText.slice(s.header_end, nextOffset).trim();
    const looksLikeToc = body.length < 200 && /\.{3,}\s*\d+/.test(body);
    if (looksLikeToc) continue;
    if (body.length < 60) continue;
    sections.push({
      chapter_number: chapterFromSection(s.section_number),
      section_number: s.section_number,
      section_title:  s.section_title,
      body,
    });
  }

  // Dedup — sometimes a section number appears in both TOC and body. Keep
  // the longer-body version (the real statute text).
  const dedup = new Map();
  for (const s of sections) {
    const existing = dedup.get(s.section_number);
    if (!existing || s.body.length > existing.body.length) {
      dedup.set(s.section_number, s);
    }
  }

  return [...dedup.values()].sort((a, b) => {
    const ka = sortKeyForSection(a.section_number);
    const kb = sortKeyForSection(b.section_number);
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    if (ka[1] !== kb[1]) return ka[1] - kb[1];
    return ka[2].localeCompare(kb[2]);
  });
}

// ----------------------------------------------------------------------------
// chunkSection — split a single section's body into ~700-token pieces if it
// runs long, preserving the section header on each chunk. Most sections fit
// in one chunk; §209.005 (records access) is the giveaway candidate to split.
// ----------------------------------------------------------------------------
function chunkSection(section, { jurisdiction = 'TX' } = {}) {
  const TARGET_WORDS = 540; // ~700 tokens at ~1.3 tokens/word
  const OVERLAP_WORDS = 60;
  const words = section.body.split(/\s+/).filter(Boolean);
  const citation = `Tex. Prop. Code § ${section.section_number}`;
  const heading = `§ ${section.section_number} — ${section.section_title}`;

  if (words.length <= TARGET_WORDS) {
    return [{
      text: section.body,
      section_heading: heading,
      chapter_number: section.chapter_number,
      section_number: section.section_number,
      statute_citation: citation,
    }];
  }

  const stride = TARGET_WORDS - OVERLAP_WORDS;
  const chunks = [];
  for (let i = 0; i < words.length; i += stride) {
    const slice = words.slice(i, i + TARGET_WORDS);
    if (slice.length === 0) break;
    const partIndex = Math.floor(i / stride) + 1;
    chunks.push({
      text: slice.join(' '),
      section_heading: `${heading} (part ${partIndex})`,
      chapter_number: section.chapter_number,
      section_number: section.section_number,
      statute_citation: citation,
    });
    if (i + TARGET_WORDS >= words.length) break;
  }
  return chunks;
}

// ----------------------------------------------------------------------------
// extractLegalReferenceChunks — top-level entrypoint. Given a PDF buffer,
// returns the section-aware chunks ready for embedding + insert.
// ----------------------------------------------------------------------------
async function extractLegalReferenceChunks(pdfBuffer, opts = {}) {
  const parsed = await pdfParse(pdfBuffer);
  const sections = parseStatuteSections(parsed.text || '');
  const chunks = [];
  for (const s of sections) {
    for (const c of chunkSection(s, opts)) chunks.push(c);
  }
  return {
    page_count: parsed.numpages || null,
    section_count: sections.length,
    chunks,
  };
}

module.exports = {
  parseStatuteSections,
  chunkSection,
  extractLegalReferenceChunks,
};
