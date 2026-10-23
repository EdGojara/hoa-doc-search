// lib/enforcement/letter_stage.js  (Ed 2026-10-23)
// ----------------------------------------------------------------------------
// The stage a violation letter ACTUALLY is, for the mailing record. The
// interaction type is not reliable for this: every violation letter is typed
// letter_209, so four first-class courtesy_1 letters (Aug-Sep 2026) were
// recorded as certified_209 mailings, and an internal label then read as if a
// certified statutory notice had been sent. The letter's own subject carries its
// stage ("Violation letter (courtesy_1)"); the type is only a fallback for
// letters whose subject has none (10-day certified force-mow, restored records).
// ----------------------------------------------------------------------------
const SUBJECT_STAGE = /\((courtesy_1|courtesy_2|certified_209|fine_assessed)\)/;
const TYPE_STAGE = {
  letter_courtesy_1: 'courtesy_1',
  letter_courtesy_2: 'courtesy_2',
  letter_209: 'certified_209',
  letter_fine: 'fine_assessed',
  letter_hearing: 'hearing_notice',
  letter_force_mow: 'force_mow',
};

function letterStageOf(inter) {
  const m = SUBJECT_STAGE.exec(String((inter && inter.subject) || ''));
  if (m) return m[1];
  return TYPE_STAGE[inter && inter.type] || 'certified_209';
}

// A certified §209 notice must go by certified mail. A certified-stage letter in a
// first-class run is a mismatch and is not printed.
const mustGoCertified = (stage) => stage === 'certified_209' || stage === 'fine_assessed';
function deliveryMismatch(inter, deliveryMethod) {
  return mustGoCertified(letterStageOf(inter)) && deliveryMethod !== 'certified_mail';
}

module.exports = { letterStageOf, deliveryMismatch, mustGoCertified };
