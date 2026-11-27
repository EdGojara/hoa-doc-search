// lib/enforcement/record_mailing.js  (Ed 2026-10-29)
// ----------------------------------------------------------------------------
// THE one way a print run's mailing outcome is recorded. Both the Mailing
// confirmation screen and the Mail Queue's "Confirm mailed" button call this,
// so every confirmation carries the real mailing date and the employee who made
// it. (On 10/26 the old button stamped 245 Lakes of Pine Forest letters with the
// click time, no employee and no evidence; one path makes that impossible.)
//
// It writes, in order:
//   1. a mailing_batch_confirmations row (who, when, counts)
//   2. letter_mailing_evidence rows (append-only)   <- if this fails, nothing else
//   3. interactions.mailed_at = the date staff entered, ONLY where it is empty
//   4. cure-deadline review holds for open cases mailed after their letter date
//   5. a timeline note on each case
// It never changes a cure deadline, letter date, stage, PDF, mail piece or charge.
// ----------------------------------------------------------------------------
const ME = require('./mailing_evidence');

async function recordRunConfirmation({ db, staff, communityId, method, printedAt, mailedOn, outcomes, batchLetters, notes = {}, note = null }) {
  const who = staff.full_name || staff.email;
  const entries = Object.entries(outcomes || {});
  const count = (o) => entries.filter(([, x]) => x === o).length;
  const anyMailed = count('mailed') > 0;
  const byId = new Map((batchLetters || []).map((l) => [l.id, l]));

  const { data: conf, error: cErr } = await db.from('mailing_batch_confirmations').insert({
    community_id: communityId, delivery_method: method, printed_at: printedAt,
    mailed_on: anyMailed ? mailedOn : null, letter_count: entries.length,
    mailed_count: count('mailed'), not_mailed_count: count('not_mailed'), held_count: count('held'), excluded_count: count('excluded'),
    note: note ? String(note).slice(0, 2000) : null,
    confirmed_by_user_id: staff.user.id, confirmed_by_name: who,
  }).select('id').single();
  if (cErr) throw cErr;

  const evidence = entries.map(([id, o]) => ({
    interaction_id: id, community_id: communityId, violation_id: (byId.get(id) || {}).violation_id || null,
    batch_confirmation_id: conf.id, outcome: o, mailed_on: o === 'mailed' ? mailedOn : null, delivery_method: method,
    note: notes[id] ? String(notes[id]).slice(0, 1000) : (note ? String(note).slice(0, 1000) : null),
    recorded_by_user_id: staff.user.id, recorded_by_name: who,
  }));
  const { error: eErr } = await db.from('letter_mailing_evidence').insert(evidence);
  if (eErr) {
    console.error('[record-mailing] evidence insert failed after batch row', conf.id, eErr.message);
    const e = new Error('The confirmation was not saved. Nothing about the letters changed. Please try again.');
    e.code = 'evidence_not_saved';
    throw e;
  }

  const fillIds = entries.filter(([id, o]) => o === 'mailed' && byId.get(id) && !byId.get(id).mailed_at).map(([id]) => id);
  let filled = 0;
  if (fillIds.length) {
    const { data: up, error: uErr } = await db.from('interactions')
      .update({ mailed_at: `${mailedOn}T12:00:00+00:00` }).in('id', fillIds).is('mailed_at', null).select('id');
    if (uErr) console.error('[record-mailing] mailed_at fill failed (evidence is saved):', uErr.message);
    filled = (up || []).length;
  }

  let flagged = 0;
  if (anyMailed) {
    const mailedLetters = entries.filter(([, o]) => o === 'mailed').map(([id]) => byId.get(id)).filter((l) => l && l.violation_id);
    if (mailedLetters.length) {
      const vids = [...new Set(mailedLetters.map((l) => l.violation_id))];
      let openCases = [];
      for (let i = 0; i < vids.length; i += 200) {
        const { data, error } = await db.from('violations').select('id, cure_period_ends_at').in('id', vids.slice(i, i + 200)).is('resolved_at', null).order('id');
        if (error) throw error;
        openCases = openCases.concat(data || []);
      }
      const cureBy = new Map(openCases.map((v) => [v.id, v.cure_period_ends_at]));
      const flags = ME.cureDeadlineFlags({ letters: mailedLetters, mailedOn, openViolationIds: openCases.map((v) => v.id) });
      if (flags.length) {
        const already = new Set((await ME.loadOpenReviewHolds(db, { violationIds: flags.map((f) => f.violation_id) })).map((h) => h.violation_id));
        const rows = flags.filter((f) => !already.has(f.violation_id)).map((f) => ({
          community_id: communityId, violation_id: f.violation_id, interaction_id: f.interaction_id, kind: 'cure_deadline_review',
          reason: f.reason, basis_date: f.basis_date, confirmed_mailed_on: f.confirmed_mailed_on,
          cure_period_ends_at_flagged: cureBy.get(f.violation_id) || null, flagged_by_user_id: staff.user.id,
        }));
        if (rows.length) {
          const { error: hErr } = await db.from('enforcement_review_holds').insert(rows);
          if (hErr) console.error('[record-mailing] cure-deadline review holds NOT saved (evidence is saved):', hErr.message);
          else flagged = rows.length;
        }
      }
    }
  }

  const LABEL = { mailed: `confirmed mailed on ${mailedOn}`, not_mailed: 'confirmed NOT mailed yet', held: 'held, not mailed', excluded: 'pulled from the mailing' };
  const timeline = entries.filter(([id]) => byId.get(id) && byId.get(id).violation_id).map(([id, o]) => ({
    community_id: communityId, property_id: byId.get(id).property_id, violation_id: byId.get(id).violation_id,
    type: 'observation_note', direction: 'internal', subject: 'Mailing confirmed by staff',
    content: `${who}: letter printed ${ME.centralDate(printedAt)} was ${LABEL[o]}.${notes[id] ? ' Note: ' + String(notes[id]).slice(0, 300) : ''} Letter dates and the cure deadline were not changed.`,
    sent_by_user_id: staff.user.id, sent_at: new Date().toISOString(),
  }));
  if (timeline.length) {
    const { error: tErr } = await db.from('interactions').insert(timeline);
    if (tErr) console.warn('[record-mailing] timeline notes failed (evidence is saved):', tErr.message);
  }

  return { confirmation_id: conf.id, mailed: count('mailed'), not_mailed: count('not_mailed'), held: count('held'), excluded: count('excluded'), mailed_date_filled: filled, cure_deadline_reviews: flagged };
}

module.exports = { recordRunConfirmation };
