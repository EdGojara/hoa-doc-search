// ============================================================================
// tests/test_match_violation_from_text.js
// Run: node tests/test_match_violation_from_text.js
//
// Proves Claire's call-to-case auto-tagging: a call concern is matched to the
// right OPEN violation, and — critically — ambiguous or no-match cases return
// null rather than guessing a case onto the note.
// ============================================================================

const assert = require('assert');
const { matchViolationFromText } = require('../lib/enforcement/match_violation_from_text');

let passed = 0;
function check(name, cond) { assert.ok(cond, `FAIL: ${name}`); passed += 1; console.log(`  ✓ ${name}`); }

// Real Waterview category labels from the 5/31 report.
const OPEN = [
  { id: 'v-fence', category_label: 'Fences', category_slug: 'fences' },
  { id: 'v-trash', category_label: 'Trash Cans/Recycling Containers', category_slug: 'trash_cans' },
  { id: 'v-sod',   category_label: 'Sod Yard', category_slug: 'sod_yard' },
  { id: 'v-mildew', category_label: 'Mildew', category_slug: 'mildew' },
  { id: 'v-bball', category_label: 'Portable Basketball Goal', category_slug: 'portable_basketball_goal' },
];

// Direct mention
check('"calling about my fence" → fence case',
  matchViolationFromText('Homeowner calling about the fence, says contractor is scheduled', OPEN).violation_id === 'v-fence');

// Synonym: "grass / mowed" → Sod Yard (lawn group)
check('"grass / mow" → sod yard case',
  matchViolationFromText('She said the grass will be mowed this weekend', OPEN).violation_id === 'v-sod');

// Synonym: "garbage bins" → Trash Cans
check('"garbage bins out" → trash case',
  matchViolationFromText('Caller upset about the garbage bins notice', OPEN).violation_id === 'v-trash');

// Synonym: "mold on the siding" → Mildew
check('"mold" → mildew case',
  matchViolationFromText('Asked about the mold on the north wall', OPEN).violation_id === 'v-mildew');

// Basketball goal
check('"basketball hoop" → basketball case',
  matchViolationFromText('Wants to know why the basketball hoop is a problem', OPEN).violation_id === 'v-bball');

// No match → null (account question, nothing enforcement-related)
check('account question → no tag (null)',
  matchViolationFromText('Calling about my account balance and a missing payment', OPEN) === null);

// Ambiguous → null (mentions fence AND trash equally; can\'t tell which)
{
  const r = matchViolationFromText('Calling about the fence and the trash cans', OPEN);
  check('fence+trash mentioned equally → ambiguous, no guess', r !== null && r.ambiguous === true && r.violation_id === null);
}

// Empty inputs
check('no open violations → null', matchViolationFromText('about the fence', []) === null);
check('empty text → null', matchViolationFromText('', OPEN) === null);

// Generic chatter that happens to contain a stopword-y category term doesn\'t
// false-match: "items" alone (from "Storage Of Unapproved Items") is a stopword.
{
  const open2 = [{ id: 'v-stor', category_label: 'Storage Of Unapproved Items', category_slug: 'storage_unapproved_items' }];
  check('"a few items to discuss" does NOT match Storage',
    matchViolationFromText('I have a few items to discuss about the board meeting', open2) === null);
  check('"storage container in the yard" DOES match Storage',
    (matchViolationFromText('There is a storage container left in the side yard', open2) || {}).violation_id === 'v-stor');
}

console.log(`\n${passed} assertions passed.`);
