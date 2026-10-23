// scripts/correct_mislabeled_mail_pieces_20261023.js  (Ed 2026-10-23, steps 3 + 5)
// ----------------------------------------------------------------------------
// Four first-class Courtesy 1 letters were recorded on their mail pieces as
// certified §209 mailings, because the print run took the stage from the letter
// TYPE (letter_209) instead of the letter itself. Each letter, its PDF and its
// seal are correct and stay untouched; only the mailing record's stage is
// corrected, with the prior value and the reason kept in the piece's event
// history and a note on the case timeline. Nothing is deleted, nothing is mailed.
//
//   7919 Caribou Valley Ct   piece 506c2896  letter acf2020e  mailed 8/18
//   5811 Acacia Rose Ct      piece f192bb19  letter 47873300  mailed 8/27
//   5115 Emory Mill Rd       piece 3c0e7c3e  letter 6d93e999  mailed 8/27
//   622 Shady Brook Dr       piece 1b871a17  letter 9bcc5de2  mailed 9/1
//
// Certified-fee charges on these four are NOT touched here: reversing a ledger
// charge is a separate decision.
//
//   node scripts/correct_mislabeled_mail_pieces_20261023.js           (dry run)
//   node scripts/correct_mislabeled_mail_pieces_20261023.js --apply
// ----------------------------------------------------------------------------
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');
const { letterStageOf } = require('../lib/enforcement/letter_stage');

const APPLY = process.argv.includes('--apply');
const PIECES = ['506c2896-3db6-4750-a65a-c03ebce96845', 'f192bb19-21e9-4f60-bbfd-4ebdf144dfc8', '3c0e7c3e-6177-4e56-878d-98f1450ca193', '1b871a17-41dd-4443-b47b-c51094591b69'];
const REASON = 'Mail record corrected (Ed 2026-10-23): this letter is a Courtesy 1 notice sent by first-class mail. The print run had recorded it as a certified §209 mailing because it took the stage from the letter type instead of the letter. The letter, its PDF and its seal are unchanged; no certified notice was sent.';

(async () => {
  const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const { data: all, error } = await s.from('letter_mail_pieces')
    .select('id, interaction_id, violation_id, property_id, community_id, stage_at_send, delivery_method, status, mailed_at, events')
    .in('id', PIECES).eq('delivery_method', 'first_class');
  if (error) throw error;
  const pieces = all || [];
  if (pieces.length !== PIECES.length) throw new Error(`expected ${PIECES.length} pieces, found ${pieces.length}`);

  for (const p of pieces) {
    const { data: ix, error: ie } = await s.from('interactions').select('id, type, subject, delivery_method, mailed_at, postmark_date').eq('id', p.interaction_id).single();
    if (ie) throw ie;
    const actual = letterStageOf(ix);
    if (actual !== 'courtesy_1' || ix.delivery_method !== 'first_class_mail' || !ix.mailed_at) {
      throw new Error(`piece ${p.id}: letter is ${actual}/${ix.delivery_method}/${ix.mailed_at}; refusing`);
    }
    const done = p.stage_at_send === 'courtesy_1' && (p.events || []).some((e) => e && e.type === 'stage_corrected');
    const { data: notes, error: nqe } = await s.from('interactions').select('id').eq('violation_id', p.violation_id).eq('subject', 'Mail record corrected: Courtesy 1, first class (was recorded certified)');
    if (nqe) throw nqe;
    if (done && notes.length) { console.log(`piece ${p.id.slice(0, 8)} already corrected, note present`); continue; }
    if (!done && p.stage_at_send !== 'certified_209') throw new Error(`piece ${p.id}: unexpected state ${p.stage_at_send}`);
    console.log(`${APPLY ? 'CORRECT' : 'would correct'} piece ${p.id.slice(0, 8)}: stage certified_209 -> courtesy_1 (letter ${ix.id.slice(0, 8)} "${ix.subject}", first class, mailed ${ix.postmark_date || String(ix.mailed_at).slice(0, 10)})`);
    if (!APPLY) continue;
    const now = new Date().toISOString();
    if (!done) {
    const { data: upd, error: ue } = await s.from('letter_mail_pieces').update({
      stage_at_send: 'courtesy_1',
      events: [...(Array.isArray(p.events) ? p.events : []), { ts: now, type: 'stage_corrected', by: 'Ed Gojara (approved 2026-10-23)', prior: { stage_at_send: p.stage_at_send }, note: REASON }],
    }).eq('id', p.id).eq('stage_at_send', 'certified_209').select('id');
    if (ue) throw ue;
    if (!upd || !upd.length) throw new Error(`piece ${p.id} changed underneath; stopped`);
    }
    const { error: ne } = await s.from('interactions').insert({
      community_id: p.community_id, property_id: p.property_id, violation_id: p.violation_id,
      type: 'observation_note', direction: 'internal',
      subject: 'Mail record corrected: Courtesy 1, first class (was recorded certified)',
      content: REASON, sent_at: now,
    });
    if (ne) throw ne;
  }
  console.log(APPLY ? 'done' : 'dry run only; pass --apply to write');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
