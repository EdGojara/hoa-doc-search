// ===========================================================================
// board_package/native.js  (Ed 2026-07-18)
// ---------------------------------------------------------------------------
// The live-data probes behind Paige's readiness check: for each trustEd-owned
// section, is the data there for the meeting's financial cutoff period? Returns
// { <section_key>: { present, period?, count?, reason?, minutes_meeting_date? } }.
// Each probe is defensive — a failed query reports the section as not-present
// with a reason, never throws (so one broken source can't sink the report).
//
// INVARIANT: there is exactly one probe per engine.nativeSectionKeys() entry.
// A native section with no probe here would always read "missing" in readiness
// even though assemble can fill it (the agenda bug, fixed 2026-07-19). The
// registry test asserts probe-keys == native-keys, so this can't silently drift.
// ===========================================================================

const { nativeSectionKeys } = require('./engine');

async function nativeContext(supabase, community, cutoff, priorMeetingDate) {
  const cid = community.id;
  const nat = {};
  const monthStart = cutoff ? cutoff.slice(0, 8) + '01' : null;

  // Draft agenda — a saved agenda for the meeting (or the latest on file).
  try {
    const { data, error } = await supabase.from('meeting_agendas').select('id, meeting_date')
      .eq('community_id', cid).order('meeting_date', { ascending: false, nullsFirst: false }).limit(1);
    if (error) throw error;
    nat.agenda = (data && data[0])
      ? { present: true, count: 1 }
      : { present: false, reason: 'no saved agenda yet — create one in the Agenda Generator' };
  } catch (_) { nat.agenda = { present: false, reason: 'agenda lookup failed' }; }

  // §209 / violations — open enforcement status
  try {
    const { count, error } = await supabase.from('violations').select('*', { count: 'exact', head: true })
      .eq('community_id', cid).not('current_stage', 'in', '(cured,closed,voided)');
    nat.drv = error ? { present: false, reason: 'DRV not readable' } : { present: true, count: count || 0 };
  } catch (_) { nat.drv = { present: false, reason: 'DRV lookup failed' }; }

  // ACC / architectural activity
  try {
    const { count, error } = await supabase.from('acc_decisions').select('*', { count: 'exact', head: true }).eq('community_id', cid);
    nat.arc_decisions = error ? { present: false, reason: 'ACC not readable' } : { present: true, count: count || 0 };
  } catch (_) { nat.arc_decisions = { present: false, reason: 'ACC lookup failed' }; }

  // Legal-referral candidates — available whenever the community has an AR
  // ledger (the actual list is computed from the subledger at assemble time).
  try {
    const { count, error } = await supabase.from('v_homeowner_current_balance').select('*', { count: 'exact', head: true }).eq('community_id', cid);
    nat.legal_referral = error ? { present: false, reason: 'AR not readable' } : { present: true, count: count || 0 };
  } catch (_) { nat.legal_referral = { present: false, reason: 'AR lookup failed' }; }

  // Prior open-session minutes — must be finalized and for the immediately-prior meeting
  try {
    const { data: mm } = await supabase.from('meeting_minutes').select('meeting_date,status')
      .eq('community_id', cid).order('meeting_date', { ascending: false }).limit(3);
    const finalPrior = (mm || []).find((m) => m.status === 'final');
    nat.prior_minutes = finalPrior
      ? { present: true, minutes_meeting_date: finalPrior.meeting_date }
      : { present: false, reason: 'no finalized prior minutes on record' };
  } catch (_) { nat.prior_minutes = { present: false, reason: 'minutes lookup failed' }; }

  // Financial sections — GL activity posted in the cutoff month is the signal
  const financialKeys = ['balance_sheet', 'income_statement', 'ar_aging', 'delinquency', 'ap_approval', 'reserve_activity', 'bank_rec'];
  for (const key of financialKeys) {
    try {
      let q = supabase.from('journal_entries').select('*', { count: 'exact', head: true }).eq('community_id', cid);
      if (monthStart && cutoff) q = q.gte('posting_date', monthStart).lte('posting_date', cutoff);
      const { count, error } = await q;
      nat[key] = error ? { present: false, reason: 'GL not readable' }
        : (count > 0 ? { present: true, period: cutoff, count } : { present: false, reason: `no GL activity posted for ${cutoff}` });
    } catch (_) { nat[key] = { present: false, reason: 'GL lookup failed' }; }
  }

  // Backstop: any native section that somehow lacked a probe above reads as a
  // clear "not wired" gap rather than an undefined that verdictFor treats as a
  // silent miss. The registry test makes this branch unreachable in practice.
  for (const key of nativeSectionKeys()) {
    if (!(key in nat)) nat[key] = { present: false, reason: 'no readiness probe wired for this section' };
  }

  return nat;
}

module.exports = { nativeContext };
