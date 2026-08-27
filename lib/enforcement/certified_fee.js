// ============================================================================
// lib/enforcement/certified_fee.js  (Ed 2026-08-27)
// ----------------------------------------------------------------------------
// When a homeowner gets a CERTIFIED letter, charge their account per the fee
// schedule — a pass-through to Bedrock: Dr 1300 A/R / Cr 2300 Accrued Liability
// (via ar_engine.createCharge + the 'certified_violation' charge type, mig 394).
//
// Idempotent per certified letter (source_reference = the mail-piece id), so a
// re-send or a re-run never double-charges. Gated to communities with
// certified_fee_autopost=true and to letters mailed on/after CERTIFIED_FEE_START.
//
// VIOLATION certifieds only for now — they live in letter_mail_pieces with
// stage_at_send in ('certified_209','fine_assessed'). COLLECTIONS certifieds go
// through a separate channel (not in letter_mail_pieces); once Ed sets
// communities.certified_collection_fee_cents and we wire that send path, add a
// postCertifiedCollectionFee twin here.
// ============================================================================
const { createCharge } = require('../accounting/ar_engine');

const CERTIFIED_FEE_START = '2026-08-01';
const CERTIFIED_STAGES = new Set(['certified_209', 'fine_assessed']);

// Decide-and-optionally-post the violation certified fee for one mail piece.
// piece: { id, community_id, property_id, stage_at_send, mailed_at, created_at }
// Returns { posted|skipped|would_post, reason?, amount_cents?, charge_id?, ... }.
async function postCertifiedViolationFee(supabase, piece, { postedByUserId = null, dryRun = false } = {}) {
  if (!piece || !piece.id) return { skipped: true, reason: 'no_piece' };
  if (!CERTIFIED_STAGES.has(piece.stage_at_send)) return { skipped: true, reason: 'not_certified_stage' };
  if (!piece.property_id) return { skipped: true, reason: 'no_property' };

  const mailed = String(piece.mailed_at || piece.created_at || '').slice(0, 10);
  if (!mailed || mailed < CERTIFIED_FEE_START) return { skipped: true, reason: 'before_start_date', mailed };

  const { data: comm, error: ce } = await supabase
    .from('communities')
    .select('name, certified_fee_autopost, letter_fee_certified_209_cents')
    .eq('id', piece.community_id).maybeSingle();
  if (ce) throw ce;
  if (!comm) return { skipped: true, reason: 'community_not_found' };
  if (!comm.certified_fee_autopost) return { skipped: true, reason: 'autopost_disabled', community: comm.name };
  const amount = comm.letter_fee_certified_209_cents || 0;
  if (amount <= 0) return { skipped: true, reason: 'fee_zero', community: comm.name };

  // Idempotency: one fee per certified letter. Key on the interaction (the
  // letter itself) — stable across a re-batch/re-print of the same letter.
  const sourceRef = 'interaction:' + (piece.interaction_id || piece.id);
  const { data: existing, error: ee } = await supabase
    .from('ar_charges').select('id')
    .eq('community_id', piece.community_id)
    .eq('source_module', 'certified_letter_fee')
    .eq('source_reference', sourceRef).limit(1);
  if (ee) throw ee;
  if (existing && existing.length) return { skipped: true, reason: 'already_charged', charge_id: existing[0].id, amount_cents: amount };

  if (dryRun) return { would_post: true, amount_cents: amount, community: comm.name, property_id: piece.property_id, mailed };

  const res = await createCharge({
    community_id: piece.community_id,
    property_id: piece.property_id,
    charge_type_code: 'certified_violation',
    amount_cents: amount,
    charge_date: mailed,
    due_date: mailed,
    description: `Certified letter (violation) mailed ${mailed}`,
    source_module: 'certified_letter_fee',
    source_reference: sourceRef,
    posted_by_user_id: postedByUserId,
  });
  return { posted: true, amount_cents: amount, community: comm.name, charge_id: res.charge.id, journal_entry_id: res.journal_entry.id };
}

// Sweep every certified violation letter and post the fee for any that lack one.
// Idempotent (per-piece via postCertifiedViolationFee) — safe to run repeatedly.
// This is BOTH the backfill and the ongoing mechanism (call it after a mail
// batch, and/or on a daily cron). dryRun returns the same summary without posting.
async function sweepCertifiedViolationFees(supabase, { communityIds = null, dryRun = false, postedByUserId = null } = {}) {
  const { data: comms, error: ce } = await supabase
    .from('communities').select('id, name').eq('certified_fee_autopost', true);
  if (ce) throw ce;
  let enabled = (comms || []);
  if (communityIds) enabled = enabled.filter((c) => communityIds.includes(c.id));
  const enabledIds = enabled.map((c) => c.id);
  const summary = { dryRun, pieces: 0, posting: 0, already: 0, skipped: 0, total_cents: 0, by_community: {}, samples: [] };
  if (!enabledIds.length) return summary;

  // All certified-stage pieces for the enabled communities (paginated, ordered).
  let pieces = []; let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('letter_mail_pieces')
      .select('id, interaction_id, community_id, property_id, stage_at_send, mailed_at, created_at')
      .in('community_id', enabledIds)
      .in('stage_at_send', ['certified_209', 'fine_assessed'])
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    pieces = pieces.concat(data || []);
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  summary.pieces = pieces.length;

  for (const p of pieces) {
    const r = await postCertifiedViolationFee(supabase, p, { postedByUserId, dryRun });
    if (r.posted || r.would_post) {
      summary.posting += 1;
      summary.total_cents += (r.amount_cents || 0);
      const key = r.community || p.community_id;
      summary.by_community[key] = (summary.by_community[key] || 0) + 1;
      if (summary.samples.length < 15) {
        summary.samples.push({ community: r.community, property_id: p.property_id, mailed: String(p.mailed_at || p.created_at || '').slice(0, 10), amount: (r.amount_cents || 0) / 100 });
      }
    } else if (r.reason === 'already_charged') {
      summary.already += 1;
    } else {
      summary.skipped += 1;
    }
  }
  return summary;
}

module.exports = { postCertifiedViolationFee, sweepCertifiedViolationFees, CERTIFIED_FEE_START, CERTIFIED_STAGES };
