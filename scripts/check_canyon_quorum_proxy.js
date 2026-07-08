// One-off: pull Canyon Gate bylaws + CC&R chunks for quorum + proxy +
// reconvened-meeting language. Time-sensitive — Ed's annual meeting is
// tonight at 6:30 PM.

require('dotenv').config({ override: true });
const { getRelevantChunks } = require('../lib/hybrid_retrieval');

const COMMUNITY = 'Canyon Gate at Cinco Ranch';

const QUERIES = [
  'quorum requirement annual meeting members',
  'reduced quorum adjourned reconvened meeting second call',
  'proxy delivery deadline submission rules',
  'proxy holder voting on behalf of member',
  'meeting adjournment lack of quorum',
];

async function runOne(query) {
  console.log('\n========================================================================');
  console.log('QUERY:', query);
  console.log('========================================================================');
  const ctx = await getRelevantChunks(query, COMMUNITY);
  if (!ctx || !ctx.trim()) {
    console.log('(no chunks)');
    return;
  }
  // Split into the [From: ...] blocks and show each with snippet
  const blocks = ctx.split('\n\n---\n\n');
  blocks.slice(0, 6).forEach((b, i) => {
    const headerMatch = b.match(/^\[From:\s*([^\]]+)\]/);
    const header = headerMatch ? headerMatch[1] : '(no header)';
    const body = b.replace(/^\[From:[^\]]+\]\s*/, '').trim();
    console.log(`\n--- Chunk ${i + 1}: ${header} ---`);
    // Print up to ~600 chars so we can see the surrounding context
    console.log(body.slice(0, 600).replace(/\s+/g, ' '));
  });
}

(async () => {
  for (const q of QUERIES) {
    try { await runOne(q); } catch (e) { console.error('Failed:', q, e.message); }
  }
})().then(() => process.exit(0));
