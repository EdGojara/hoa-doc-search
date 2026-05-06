// ============================================================================
// Quick test for the playbook retrieval helper.
//
// Tests three queries to verify semantic retrieval is working and matches
// look reasonable. Run after dropping playbook.js into the repo:
//
//   node test_playbook_retrieval.js
//
// Look for: sensible matches, similarity scores, no errors.
// ============================================================================

require('dotenv').config();

const { getRelevantPlaybook } = require('./playbook');

const TEST_QUERIES = [
  {
    label: 'VENDOR — pool insurance question',
    text: `Comparing two pool service vendor proposals. One has $2M umbrella insurance,
the other has only general liability with no umbrella. The community has lifeguards
on staff during pool season. Which vendor should the board pick?`
  },
  {
    label: 'HOMEOWNER — neighbor complaint about violations',
    text: `A homeowner is asking what action we took against their neighbor for parking
violations. They said the neighbor's RV is still parked on the street and they
want to know what enforcement steps we have already taken.`
  },
  {
    label: 'ACC — fence application replacement',
    text: `Homeowner submitted ACC application to replace existing wood fence with same
material and same height. The original fence was approved years ago. They are
not changing the fence line, just replacing it.`
  }
];

async function main() {
  console.log('\n=== Playbook Retrieval Smoke Test ===\n');

  for (const q of TEST_QUERIES) {
    console.log(`\n--- ${q.label} ---`);
    console.log(`Query: ${q.text.slice(0, 100).replace(/\n/g, ' ')}...`);
    console.log();

    const entries = await getRelevantPlaybook(q.text, { matchCount: 5 });

    if (entries.length === 0) {
      console.log('  No matches — investigate.');
      continue;
    }

    console.log(`  Returned ${entries.length} entries (top 5 most relevant):`);
    entries.forEach((e, i) => {
      const preview = (e.situation || '').slice(0, 90).replace(/\n/g, ' ');
      console.log(`    ${i + 1}. sim=${e.similarity.toFixed(3)}  cat=${e.category || '-'}`);
      console.log(`       "${preview}..."`);
    });
  }

  console.log('\n=== Done ===\n');
  console.log('What to look for:');
  console.log('  - Similarity scores generally between 0.7 and 0.9 for top matches');
  console.log('  - Entries that look topically relevant to the query');
  console.log('  - Categories appropriately diverse (not all same category)\n');
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
