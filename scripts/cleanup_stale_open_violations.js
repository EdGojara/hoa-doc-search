// scripts/cleanup_stale_open_violations.js
// ---------------------------------------------------------------------------
// One-time cleanup of the historical open-violation backlog surfaced by the
// enforcement health page (Ed 2026-09-18). The rule Ed set:
//
//   "remove those if there was no letter sent out and they are old — they are
//    obviously duplicates or errors. The Vantaca ones have no value to us, so
//    remove those. Only certifieds stay (unless cured). We have 2 letters in
//    the queue to mail today, but the rest shouldn't be here."
//
// Encoded as VOID (never hard-delete — reversible, keeps the audit trail; a
// voided row is gone from every open count and the health page just the same):
//   set current_stage='voided', resolved_at=NOW(), resolved_via='voided',
//   resolved_notes=<reason>.
//
// PROTECTED — never touched:
//   * certified_209 / fine_assessed  (Ed: "only certifieds stay unless cured")
//   * any violation that already had a letter SENT/MAILED (a real notice went out)
//   * any violation carrying a LIVE draft letter (draft/awaiting/approved/printed)
//     — this is the mail queue, incl. the 2 to mail today. Ed decides those
//       separately; this script will not silently kill a queued letter.
//   * already-terminal (cured/closed/voided) or resolved_at set
//   * recent native cases (<= STALE_DAYS, source!='vantaca_import') — a genuinely
//     new courtesy_1 with no letter yet may just be awaiting its first notice;
//     reported but NOT auto-voided.
//
// VOIDED — open courtesy_1/courtesy_2, no sent letter, no live draft, AND one of:
//   * source='vantaca_import'                (no value to us — Ed)
//   * originating observation was REJECTED   (should have been voided already)
//   * old native (opened > STALE_DAYS ago)   (stuck/error, never lettered)
//
// DRY-RUN BY DEFAULT. Prints the full plan and changes nothing.
// Pass --commit to actually void. Optional --community <id> to scope.
//   node -r dotenv/config scripts/cleanup_stale_open_violations.js
//   node -r dotenv/config scripts/cleanup_stale_open_violations.js --commit
// ---------------------------------------------------------------------------
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const STALE_DAYS = 30;
const COMMIT = process.argv.includes('--commit');
const ONLY_ID = process.argv.includes('--community') ? process.argv[process.argv.indexOf('--community') + 1] : null;
const TERMINAL = ['cured', 'closed', 'voided'];
const PROTECTED_STAGE = ['certified_209', 'fine_assessed'];
const LIVE_DRAFT = ['draft', 'awaiting_approval', 'approved', 'printed'];

const pageAll = async (t, sel, f, cid) => {
  let out = [], fr = 0;
  for (;;) {
    let q = supabase.from(t).select(sel).eq('community_id', cid).order('id', { ascending: true }).range(fr, fr + 999);
    if (f) q = f(q);
    const { data, error } = await q;
    if (error) throw new Error(t + ': ' + error.message);
    out = out.concat(data);
    if (data.length < 1000) break;
    fr += 1000;
  }
  return out;
};

async function planCommunity(c) {
  const cutoff = Date.now() - STALE_DAYS * 864e5;
  const vios = await pageAll('violations',
    'id, source, current_stage, resolved_at, opened_at, opened_from_observation_id', null, c.id);
  const openV = vios.filter((v) => !TERMINAL.includes(v.current_stage) && !v.resolved_at);

  // which open violations have a SENT letter, and which have a LIVE draft
  const openIds = openV.map((v) => v.id);
  const sent = new Set(), liveDraft = new Set();
  for (let i = 0; i < openIds.length; i += 200) {
    const { data, error } = await supabase.from('interactions')
      .select('violation_id, status, mailed_at').in('violation_id', openIds.slice(i, i + 200)).ilike('type', 'letter%');
    if (error) throw new Error('interactions: ' + error.message);
    (data || []).forEach((l) => {
      if (l.status === 'sent' || l.mailed_at) sent.add(l.violation_id);
      if (LIVE_DRAFT.includes(l.status)) liveDraft.add(l.violation_id);
    });
  }

  // originating observation reviewer_status (for the rejected-obs bucket)
  const obsIds = [...new Set(openV.map((v) => v.opened_from_observation_id).filter(Boolean))];
  const obsStatus = {};
  for (let i = 0; i < obsIds.length; i += 200) {
    const { data, error } = await supabase.from('property_observations')
      .select('id, reviewer_status').in('id', obsIds.slice(i, i + 200));
    if (error) throw new Error('property_observations: ' + error.message);
    (data || []).forEach((o) => { obsStatus[o.id] = o.reviewer_status; });
  }

  const b = {
    protect_certified: [], protect_sent: [], protect_livedraft: [], protect_recent_native: [],
    void_vantaca: [], void_rejected: [], void_old_native: [],
  };
  for (const v of openV) {
    if (PROTECTED_STAGE.includes(v.current_stage)) { b.protect_certified.push(v); continue; }
    if (sent.has(v.id)) { b.protect_sent.push(v); continue; }
    if (liveDraft.has(v.id)) { b.protect_livedraft.push(v); continue; }
    // remaining: courtesy_1/courtesy_2, no sent letter, no live draft
    const rejected = v.opened_from_observation_id && obsStatus[v.opened_from_observation_id] === 'rejected';
    const old = v.opened_at && new Date(v.opened_at).getTime() < cutoff;
    if (v.source === 'vantaca_import') b.void_vantaca.push(v);
    else if (rejected) b.void_rejected.push(v);
    else if (old) b.void_old_native.push(v);
    else b.protect_recent_native.push(v); // recent native, no letter — leave for Ed
  }
  return { name: c.name, id: c.id, open: openV.length, ...b };
}

(async () => {
  let comms;
  if (ONLY_ID) { const { data, error } = await supabase.from('communities').select('id, name').eq('id', ONLY_ID); if (error) throw error; comms = data; }
  else { const { data, error } = await supabase.from('communities').select('id, name').order('name'); if (error) throw error; comms = data; }

  console.log(`\nSTALE OPEN-VIOLATION CLEANUP  ${COMMIT ? '*** COMMIT (WILL VOID) ***' : '(DRY-RUN — no changes)'}   ${new Date().toISOString().slice(0, 16)}`);
  console.log('void = vantaca-import OR rejected-obs OR old-native, all with NO letter ever sent and NO live draft.');
  console.log('protected = certifieds, anything with a sent letter, anything with a queued draft, recent native.\n');
  const H = 'community                         | open | VOID van | VOID rej | VOID old | KEEP cert | KEEP sent | KEEP draft | KEEP new';
  console.log(H);
  const rows = [];
  const T = { open: 0, van: 0, rej: 0, old: 0, cert: 0, sent: 0, draft: 0, newn: 0 };
  for (const c of comms) {
    const r = await planCommunity(c);
    const voidN = r.void_vantaca.length + r.void_rejected.length + r.void_old_native.length;
    const keepN = r.protect_certified.length + r.protect_sent.length + r.protect_livedraft.length + r.protect_recent_native.length;
    T.open += r.open; T.van += r.void_vantaca.length; T.rej += r.void_rejected.length; T.old += r.void_old_native.length;
    T.cert += r.protect_certified.length; T.sent += r.protect_sent.length; T.draft += r.protect_livedraft.length; T.newn += r.protect_recent_native.length;
    if (voidN || keepN) rows.push(r);
    if (!voidN && !r.open) continue;
    const nm = (r.name || r.id).slice(0, 32).padEnd(32);
    console.log(`  ${nm} | ${String(r.open).padStart(4)} | ${String(r.void_vantaca.length).padStart(8)} | ${String(r.void_rejected.length).padStart(8)} | ${String(r.void_old_native.length).padStart(8)} | ${String(r.protect_certified.length).padStart(9)} | ${String(r.protect_sent.length).padStart(9)} | ${String(r.protect_livedraft.length).padStart(10)} | ${String(r.protect_recent_native.length).padStart(8)}`);
  }
  const totalVoid = T.van + T.rej + T.old;
  console.log('  ' + '-'.repeat(H.length));
  console.log(`  ${'ALL COMMUNITIES'.padEnd(32)} | ${String(T.open).padStart(4)} | ${String(T.van).padStart(8)} | ${String(T.rej).padStart(8)} | ${String(T.old).padStart(8)} | ${String(T.cert).padStart(9)} | ${String(T.sent).padStart(9)} | ${String(T.draft).padStart(10)} | ${String(T.newn).padStart(8)}`);
  console.log(`\n  WOULD VOID: ${totalVoid}   (vantaca ${T.van} + rejected-obs ${T.rej} + old-native ${T.old})`);
  console.log(`  PROTECTED : certifieds ${T.cert}, sent-letter ${T.sent}, queued-draft ${T.draft}, recent-native ${T.newn}`);

  if (!COMMIT) {
    console.log('\n  DRY-RUN. Nothing changed. Re-run with --commit to void the WOULD-VOID set.\n');
    return;
  }

  // COMMIT: void in batches
  const toVoid = [];
  for (const r of rows) {
    r.void_vantaca.forEach((v) => toVoid.push([v.id, 'vantaca_import backlog — no letter ever sent (cleanup 2026-09-18)']));
    r.void_rejected.forEach((v) => toVoid.push([v.id, 'originating observation rejected — case never voided (cleanup 2026-09-18)']));
    r.void_old_native.forEach((v) => toVoid.push([v.id, `stale >${STALE_DAYS}d open, no letter ever sent (cleanup 2026-09-18)`]));
  }
  console.log(`\n  Voiding ${toVoid.length} violations...`);
  let done = 0;
  for (const [id, note] of toVoid) {
    const { error } = await supabase.from('violations').update({
      current_stage: 'voided', resolved_at: new Date().toISOString(), resolved_via: 'voided', resolved_notes: note,
    }).eq('id', id);
    if (error) { console.error('  FAILED', id, error.message); continue; }
    done++;
    if (done % 50 === 0) console.log(`    ...${done}/${toVoid.length}`);
  }
  console.log(`\n  DONE. Voided ${done}/${toVoid.length}. Refresh /admin/enforcement-health to confirm.\n`);
})().catch((e) => { console.error('CLEANUP FAILED:', e.message); process.exit(1); });
