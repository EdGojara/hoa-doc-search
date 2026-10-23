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

const isCertifiedMethod = (m) => m === 'certified_mail' || m === 'certified_return_receipt';

// Escalation rank of the letter's ACTUAL stage (same scale as the case stage).
const STAGE_RANK = { courtesy_1: 1, courtesy_2: 2, certified_209: 3, fine_assessed: 4 };
const letterRankOf = (inter) => STAGE_RANK[letterStageOf(inter)] || 0;

// Where a letter actually is on its way to the homeowner (Ed 2026-10-23). These
// are different facts and must never be shown as one "sent":
//   generated  drafted, not yet in the mail queue
//   queued     approved into the mail queue (status 'sent' / sent_at), not printed
//   printed    printed, mailing not confirmed (lock-and-batch's postmark is a plan)
//   mailed     a person confirmed it went in the mail (interactions.mailed_at)
//   held       pulled from the mail and never sent (status 'rejected' after print)
const DEAD_STATUS = new Set(['rejected', 'failed', 'cancelled', 'error', 'superseded']);
function letterMailState(inter) {
  const i = inter || {};
  const d = (x) => (x ? new Date(x).toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'numeric', day: 'numeric', year: 'numeric' }) : '');
  const how = isCertifiedMethod(i.delivery_method) ? 'certified mail' : (i.delivery_method === 'email' ? 'email' : 'first-class mail');
  if (i.mailed_at && !DEAD_STATUS.has(String(i.status || ''))) {
    const trk = i.certified_tracking_number ? `, tracking ${i.certified_tracking_number}` : (isCertifiedMethod(i.delivery_method) ? ', no tracking number recorded' : '');
    return { state: 'mailed', at: i.mailed_at, label: `Mailed ${d(i.postmark_date || i.mailed_at)} by ${how}${trk}` };
  }
  if (DEAD_STATUS.has(String(i.status || ''))) {
    return { state: 'held', at: i.printed_at || null, label: i.printed_at ? `Printed ${d(i.printed_at)}, held, not mailed` : 'Not sent' };
  }
  if (i.printed_at) return { state: 'printed', at: i.printed_at, label: `Printed ${d(i.printed_at)}, mailing not confirmed` };
  if (i.sent_at || i.status === 'sent') return { state: 'queued', at: i.sent_at || null, label: `In the mail queue${i.sent_at ? ' since ' + d(i.sent_at) : ''}, not printed` };
  return { state: 'generated', at: i.created_at || null, label: 'Generated, not yet in the mail queue' };
}

module.exports = { letterStageOf, deliveryMismatch, mustGoCertified, isCertifiedMethod, letterRankOf, letterMailState, STAGE_RANK };
