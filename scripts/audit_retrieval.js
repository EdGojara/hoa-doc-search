// Retrieval audit: run getRelevantChunks against representative scenarios
// for each community + each question type, and verify the chunks come back
// from the EXPECTED community + the EXPECTED filename pattern. Reports any
// scenario where contamination or starvation occurs.
//
// Run: node scripts/audit_retrieval.js

require('dotenv').config({ override: true });
const { getRelevantChunks } = require('../lib/hybrid_retrieval');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const SCENARIOS = [
  // [label, query, community, expected_community_substring, optional filename hint]
  ['Canyon Gate — ACC rear addition', 'rear room addition with covered patio shed roof', 'Canyon Gate at Cinco Ranch', 'canyon gate'],
  ['Canyon Gate — quorum', 'what is the quorum requirement for annual meetings', 'Canyon Gate at Cinco Ranch', 'canyon gate'],
  ['Canyon Gate — architectural review', 'architectural control committee approval process', 'Canyon Gate at Cinco Ranch', 'canyon gate'],
  ['LPF — ACC fence', 'fence replacement six foot cedar rear yard', 'Lakes of Pine Forest', 'lakes of pine forest'],
  ['LPF — quorum', 'what is the quorum requirement for annual meetings', 'Lakes of Pine Forest', 'lakes of pine forest'],
  ['LPF — assessments', 'annual assessment late fees', 'Lakes of Pine Forest', 'lakes of pine forest'],
  ['Waterview — ACC pool', 'swimming pool deck construction setback', 'Waterview Estates', 'waterview'],
  ['Waterview — bylaws', 'board member election term limits', 'Waterview Estates', 'waterview'],
  ['Cross-community — Texas §209', 'Texas Property Code 209 cure period violation', 'Canyon Gate at Cinco Ranch', null], // Should pull Law or General + Canyon Gate
];

function parseHeaders(context) {
  const headers = [];
  const re = /\[From:\s*([^\]\n]+)\]/g;
  let m;
  while ((m = re.exec(context || '')) !== null) headers.push(m[1].trim());
  return headers;
}

function communityFromHeader(h) {
  // Header format from hybrid_retrieval.js:
  //   [From: <filename> - <community><ocrTag><sourceTag>]
  // ocrTag/sourceTag start with em-dash (" — ..."), so strip those first.
  // Then community is whatever is after the LAST " - " (filenames can
  // contain hyphens like "Canyon Gate at Cinco Ranch - Declaration.pdf").
  const stripped = h.split(/\s+—\s+/)[0].trim();
  const lastDash = stripped.lastIndexOf(' - ');
  if (lastDash < 0) return stripped;
  return stripped.slice(lastDash + 3).trim();
}

async function runScenario(label, query, community, expectedSubstr) {
  const context = await getRelevantChunks(query, community);
  const headers = parseHeaders(context);
  const total = headers.length;
  const expectedHits = expectedSubstr
    ? headers.filter((h) => communityFromHeader(h).toLowerCase().includes(expectedSubstr.toLowerCase())).length
    : null;
  const lawGeneralHits = headers.filter((h) => {
    const c = communityFromHeader(h).toLowerCase();
    return c === 'law' || c === 'general';
  }).length;
  const wrongCommunityHits = expectedSubstr
    ? headers.filter((h) => {
        const c = communityFromHeader(h).toLowerCase();
        if (c === 'law' || c === 'general') return false;
        return !c.includes(expectedSubstr.toLowerCase());
      }).length
    : 0;

  let verdict;
  if (total === 0) verdict = '❌ EMPTY';
  else if (expectedSubstr && expectedHits === 0 && lawGeneralHits === 0) verdict = '❌ STARVED (no community-relevant chunks)';
  else if (expectedSubstr && expectedHits === 0) verdict = '⚠️  ONLY law/general (no community-specific chunks)';
  else if (wrongCommunityHits > total / 3) verdict = '⚠️  CONTAMINATED (>33% from wrong community)';
  else if (expectedSubstr && expectedHits >= total * 0.5) verdict = '✅ OK';
  else if (!expectedSubstr) verdict = '✅ OK';
  else verdict = '⚠️  MIXED';

  console.log(`${verdict}  ${label}`);
  console.log(`        chunks=${total}  expected=${expectedHits ?? '?'}  law/general=${lawGeneralHits}  wrong-community=${wrongCommunityHits}`);
  if (wrongCommunityHits > 0) {
    const wrongs = headers.filter((h) => {
      const c = communityFromHeader(h).toLowerCase();
      if (c === 'law' || c === 'general') return false;
      return !c.includes((expectedSubstr || '').toLowerCase());
    });
    const uniqueWrong = [...new Set(wrongs.map(communityFromHeader))];
    console.log(`        contaminated by: ${uniqueWrong.join(', ')}`);
  }
}

async function checkDocumentInventory() {
  console.log('\n=== DOCUMENT INVENTORY ===');
  const { data: comms } = await supabase
    .from('communities')
    .select('id, name')
    .order('name');
  for (const c of comms || []) {
    const { count: libCount } = await supabase
      .from('library_documents')
      .select('id', { count: 'exact', head: true })
      .eq('community_id', c.id);
    const { count: chunkCount } = await supabase
      .from('documents')
      .select('id', { count: 'exact', head: true })
      .eq('metadata->>community', c.name);
    console.log(`  ${c.name.padEnd(40)} library_docs=${(libCount ?? 0).toString().padStart(4)}  chunks=${(chunkCount ?? 0).toString().padStart(5)}`);
  }
  const { count: lawChunks } = await supabase
    .from('documents')
    .select('id', { count: 'exact', head: true })
    .eq('metadata->>community', 'Law');
  const { count: generalChunks } = await supabase
    .from('documents')
    .select('id', { count: 'exact', head: true })
    .eq('metadata->>community', 'General');
  console.log(`  ${'Law'.padEnd(40)} chunks=${(lawChunks ?? 0).toString().padStart(5)}`);
  console.log(`  ${'General'.padEnd(40)} chunks=${(generalChunks ?? 0).toString().padStart(5)}`);
}

(async () => {
  await checkDocumentInventory();
  console.log('\n=== RETRIEVAL AUDIT ===');
  for (const [label, query, community, expectedSubstr] of SCENARIOS) {
    try {
      await runScenario(label, query, community, expectedSubstr);
    } catch (e) {
      console.log(`❌ ERROR  ${label}: ${e.message}`);
    }
  }
})();
