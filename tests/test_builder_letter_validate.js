// ============================================================================
// tests/test_builder_letter_validate.js  (Ed 2026-07-15)
// ----------------------------------------------------------------------------
// A builder ARC approval letter goes to the builder and then to a CITY PERMIT
// OFFICE. 14250 Emily Bend was one click from sending Needville a letter citing
// no approved plan at all, because DRB's document had the plan name garbled
// ("Soufwork" for "Southfork"), extraction wrote plan_number="UNKNOWN", the
// master-plan match correctly found nothing — and NOTHING NOTICED. The renderer
// never throws; give it a null plan and it prints a blank.
//
// Ed: "WTF claude this is important it is going to client builders and the city
// we have to get this right."
//
// He's right, and prose in CLAUDE.md is not a control. This is.
//
// Part 1 — unit: the rules themselves, including the two that matter most (a
//          linked plan that DISAGREES with the application, and no link at all).
// Part 2 — live: no APPROVED application in the database may fail validation.
//          That's the one that fails the build the day someone re-introduces it.
//
// Run:  npm run test:builder-letters   (also wired into `npm test`)
// ============================================================================
require('dotenv').config({ override: true });
const { validateApplicationForLetter, validateApplicationForLetterById } = require('../lib/builder_letter_validate');

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failures++; console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? '\n      ' + detail : ''}`); }
}

const GOOD_APP = {
  street_address: '8118 GRACES GAMBLE WAY', lot_number: '12', block_number: '1', section_number: '1',
  plan_number: '1960', plan_name: 'KIMBELL', elevation: 'O',
  master_plan_id: 'mp-1', community_id: 'c-1',
};
const GOOD_PLAN = { id: 'mp-1', plan_number: '1960', plan_name: 'KIMBELL', elevation: 'O', status: 'approved' };

console.log('\n\x1b[1mPart 1 — the rules\x1b[0m\n');

check('a sound application passes',
  validateApplicationForLetter(GOOD_APP, GOOD_PLAN, true).ok);

// The 14250 Emily Bend shape — the whole reason this file exists.
const r14250 = validateApplicationForLetter(
  { ...GOOD_APP, plan_number: 'UNKNOWN', plan_name: 'Soulfork/2380', master_plan_id: null }, null, null);
check('14250 shape (plan_number "UNKNOWN" + no master-plan link) is BLOCKED', !r14250.ok);
check('  ...and says the plan number is unreadable', r14250.errors.some((e) => /plan number/i.test(e)));
check('  ...and says there is no master-plan link', r14250.errors.some((e) => /master plan/i.test(e)));

// The one that would be worst: a link that points at the WRONG plan. The letter
// renders perfectly and asserts an approval for a house that wasn't approved.
check('a linked plan whose NUMBER disagrees with the application is BLOCKED',
  !validateApplicationForLetter(GOOD_APP, { ...GOOD_PLAN, plan_number: '2380', plan_name: 'Southfork' }, true).ok);
check('a linked plan whose ELEVATION disagrees with the application is BLOCKED',
  !validateApplicationForLetter(GOOD_APP, { ...GOOD_PLAN, elevation: 'A' }, true).ok);
check('a linked plan approved at ANOTHER community is BLOCKED',
  !validateApplicationForLetter(GOOD_APP, GOOD_PLAN, false).ok);
check('a linked plan that is not itself approved is BLOCKED',
  !validateApplicationForLetter(GOOD_APP, { ...GOOD_PLAN, status: 'retired' }, true).ok);

check('lot "UNKNOWN" is BLOCKED (a permit letter must name the lot)',
  !validateApplicationForLetter({ ...GOOD_APP, lot_number: 'UNKNOWN' }, GOOD_PLAN, true).ok);
check('a blank plan name is BLOCKED (the letter would print an empty plan)',
  !validateApplicationForLetter({ ...GOOD_APP, plan_name: null }, GOOD_PLAN, true).ok);
check('a missing elevation is BLOCKED',
  !validateApplicationForLetter({ ...GOOD_APP, elevation: '' }, GOOD_PLAN, true).ok);

// The specs table IS the substance of the approval. application_data is an
// untyped JSONB blob and easy to clobber — I overwrote 8118's with an internal
// note and the Approved Specifications table silently vanished from the letter,
// because the renderer just omits the section rather than complaining. Ed caught
// it by holding two letters side by side. Warn, not block: some legitimate older
// submissions predate the extractor.
const noMaterials = validateApplicationForLetter({ ...GOOD_APP, application_data: { entered_correction_note: 'an internal note' } }, GOOD_PLAN, true);
check('application_data clobbered (no materials) WARNS about an empty specs table',
  noMaterials.warnings.some((w) => /materials/i.test(w)));
check('  ...but does not block — older submissions predate the extractor', noMaterials.ok);
check('flat colors count as materials',
  validateApplicationForLetter({ ...GOOD_APP, application_data: { brick_color: 'Steel Manor' } }, GOOD_PLAN, true).warnings.length === 0);
check('nested materials count as materials',
  validateApplicationForLetter({ ...GOOD_APP, application_data: { materials: { brick: { type: 'Red River', color: 'Steel Manor' } } } }, GOOD_PLAN, true).warnings.length === 0);

// Warnings must NOT block — a control that fires on everything gets ignored.
const warnOnly = validateApplicationForLetter({ ...GOOD_APP, block_number: null, section_number: null, application_data: { brick_color: 'Steel Manor' } }, GOOD_PLAN, true);
check('a missing block/section warns but does NOT block', warnOnly.ok && warnOnly.warnings.length > 0);
check('a name with the number jammed in warns but does NOT block (when the rest is sound)',
  validateApplicationForLetter({ ...GOOD_APP, plan_name: 'Southfork/2380', application_data: { brick_color: 'Steel Manor' } }, GOOD_PLAN, true).ok);

// ---------------------------------------------------------------------------
(async () => {
  console.log('\n\x1b[1mPart 2 — live: no APPROVED application may fail validation\x1b[0m\n');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.log('  (skipped — SUPABASE_URL / SUPABASE_KEY not set)');
  } else {
    const { createClient } = require('@supabase/supabase-js');
    const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    const { data: apps, error } = await s.from('builder_applications')
      .select('id, reference_number, street_address, status')
      .in('status', ['approved', 'approved_with_conditions']);
    if (error) { failures++; console.log('  \x1b[31m✗ could not load applications: ' + error.message + '\x1b[0m'); }
    else {
      const bad = [];
      for (const a of apps) {
        const v = await validateApplicationForLetterById(s, a.id);
        if (!v.ok) bad.push({ a, v });
      }
      check(`all ${apps.length} approved applications can produce a sound letter`, bad.length === 0,
        bad.map(({ a, v }) => `${a.reference_number} (${a.street_address}): ${v.errors.join('; ')}`).join('\n      '));
    }
  }
  console.log('');
  if (failures) { console.log(`\x1b[31m\x1b[1m✗ ${failures} check(s) failed.\x1b[0m\n`); process.exitCode = 1; }
  else { console.log('\x1b[32m\x1b[1m✓ Builder letter validation: all checks passed.\x1b[0m\n'); }
})();
