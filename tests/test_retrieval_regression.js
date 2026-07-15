// ============================================================================
// tests/test_retrieval_regression.js
// ----------------------------------------------------------------------------
// Guards the retrieval scars. Prose in CLAUDE.md did not stop these from
// recurring; this test does. Runs live against the real corpus (no fixtures —
// the whole point is that the REAL documents stay findable).
//
// THE SCAR (Ed 2026-07-14): a homeowner asked "how many people can the
// Waterview Estates clubhouse accommodate?". askEd answered correctly (50, per
// the Clubhouse Agreement §6(a)); Claire told her the form "doesn't list a
// maximum capacity" and punted. Same corpus, same retrieval engine — the ONLY
// difference was that Claire's query contained the community name (homeowners
// write it; askEd takes it from a dropdown). Three compounding faults:
//
//   1. "Waterview" contains "water" -> fired the leak/flood/drain concept
//      expansion on EVERY Waterview question, appending "...condition nuisance
//      drainage sanitary" to a clubhouse question.
//   2. That injected "condition", which SUBSTRING-matched "Declaration of
//      Covenants, CONDITIONS and Restrictions" -> the Declaration title-matched
//      every expanded query in every community.
//   3. Title-match fanned out to every scored doc with no discriminating-keyword
//      filter and no cap -> 502 Declaration chunks at 3x weight buried the one
//      doc that answered.
//
// If any assertion here fails, a homeowner is about to get a wrong answer from
// their own governing documents. Fix retrieval — do not weaken the test.
// ============================================================================
require('dotenv').config({ override: true });
const { getRelevantChunks } = require('../lib/hybrid_retrieval');

const norm = (s) => String(s || '').replace(/\s+/g, ' ');

const CASES = [
  {
    name: 'clubhouse capacity WITH community name in the query (the Claire path)',
    q: 'Hi, Can you please tell me how many people the Waterview Estates clubhouse can accommodate? Thank you!',
    community: 'Waterview Estates',
    expect: /limit the size of any gathering|not more than 50 people/i,
    why: 'The community name must not hijack retrieval — this is the exact question Claire got wrong.',
  },
  {
    name: 'clubhouse capacity WITHOUT community name (the askEd path)',
    q: 'how many people can the clubhouse accommodate? maximum capacity',
    community: 'Waterview Estates',
    expect: /limit the size of any gathering|not more than 50 people/i,
    why: 'Both surfaces must agree. If these two ever diverge, we are back to parallel silos.',
  },
  {
    name: 'quorum (the original 2026-05-22 scar)',
    q: "what is Canyon Gate's quorum?",
    community: 'Canyon Gate at Cinco Ranch',
    expect: /quorum/i,
    why: 'Title-match must still surface the doc literally titled about the topic.',
  },
  {
    name: 'symptom-worded leak still expands to provision vocabulary',
    q: 'there is a water leak and standing water causing algae on the sidewalk',
    community: 'Waterview Estates',
    expect: /maintenance|good repair|nuisance|condition/i,
    why: 'Stripping the community name must NOT disable the legitimate concept expansion.',
  },
  {
    name: 'symptom-worded weeds/trash still expands',
    q: 'my neighbor has tall weeds and trash piling up in their yard',
    community: 'Waterview Estates',
    expect: /maintain|nuisance|weed|unsightly|condition/i,
    why: 'Same — expansion is load-bearing for symptom questions.',
  },
  {
    name: 'trailer in driveway finds the vehicle covenant',
    q: 'can I keep a trailer in my driveway?',
    community: 'Lakes of Pine Forest',
    expect: /vehicle|trailer|park/i,
    why: 'Enforcement letters cite this provision — it must be retrievable.',
  },
];

(async () => {
  let failed = 0;
  for (const c of CASES) {
    let text = '';
    try { text = norm((await getRelevantChunks(c.q, c.community)) || ''); }
    catch (e) { console.error(`  ERROR ${c.name}: ${e.message}`); failed++; continue; }
    const ok = c.expect.test(text);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
    if (!ok) {
      failed++;
      console.error(`      expected ${c.expect} in retrieved chunks`);
      console.error(`      why this matters: ${c.why}`);
      console.error(`      retrieved ${text.length} chars for community="${c.community}"`);
    }
  }
  if (failed) {
    console.error(`\n${failed}/${CASES.length} retrieval regressions FAILED — a homeowner would get a wrong answer from their own governing docs.`);
    process.exit(1);
  }
  console.log(`\nAll ${CASES.length} retrieval regressions passed.`);
})();
