// ============================================================================
// lib/acc/catch_up.js  (Ed 2026-11-26)
// ----------------------------------------------------------------------------
// RECOVERY, NOT POLLING. Annie now sends her receipt and her request for
// information herself (lib/acc/acknowledge, lib/acc/annie_issue), but those run
// on the intake/review events. A CURRENT application whose event already
// passed before that existed (6331 Clear Canyon, 5322 Millwood Pass) would
// otherwise wait forever. Once per server start (a deploy is the event), this
// walks the current open applications and lets the normal path finish them:
//   1. receipt, if the homeowner never got one;
//   2. Annie's next step (request for information, or her decision within
//      delegated authority) via annie_issue.issueIfReady.
//
// Never the historical backlog (lib/acc/backlog_hold), never a community Bedrock
// no longer manages, never a case past its review period, never twice (receipts
// are stamped; requests are once per review). Kill switch ACC_CATCH_UP=off.
// ============================================================================
const BH = require('./backlog_hold');


function enabled() { return !/^(0|false|off|no|disabled)$/i.test(String(process.env.ACC_CATCH_UP || '').trim()); }

const { receiptRecipients } = require('./acknowledge');

async function catchUpCurrentCases(supabase, { dryRun = false, now = new Date(), log = console } = {}) {
  if (!enabled()) return { skipped: 'ACC_CATCH_UP=off' };
  const { data: rows, error } = await supabase.from('acc_decisions').select('*')
    .in('status', ['pending_review', 'awaiting_info']).gte('created_at', BH.BACKLOG_CUTOFF).order('created_at', { ascending: true }).limit(500);
  if (error) { log.error('[acc-catch-up] open applications not read:', error.message); return { error: error.message }; }
  const ids = [...new Set((rows || []).map((r) => r.community_id).filter(Boolean))];
  const comms = new Map();
  if (ids.length) {
    const { data: cs, error: ce } = await supabase.from('communities').select('id, name, management_status, management_end_date, acc_delegation').in('id', ids);
    if (ce) { log.error('[acc-catch-up] communities not read:', ce.message); return { error: ce.message }; }
    for (const c of cs || []) comms.set(c.id, c);
  }
  const W = require('./work_view');
  const out = [];
  for (const row of rows || []) {
    const comm = comms.get(row.community_id) || null;
    const v = W.workView({ ...row, acc_delegation: comm && comm.acc_delegation }, { community: comm, now });
    const item = { id: row.id, reference: row.reference_number, view: v.view };
    if (BH.isBacklogHeld(row) || v.view === 'historical' || v.overdue) { out.push({ ...item, skipped: 'not current' }); continue; }
    if (dryRun) {
      const next = await require('./annie_issue').issueIfReady(supabase, row.id, { dryRun: true, source: 'catch_up' });
      item.next = next.would_request_info ? 'would request information' : next.would_issue ? 'would issue decision' : next.skipped;
      item.receipt = row.acknowledged_at ? 'already acknowledged' : 'first contact pending';
    } else {
      // The same coordinated first message as intake (lib/acc/first_contact):
      // one email when Annie's outcome is ready, else the receipt by the window's end.
      const r = await require('./first_contact').respondToApplication(supabase, row.id, { source: 'catch_up', now });
      item.receipt = r.outcome; item.next = r.detail;
    }
    out.push(item);
  }
  log.log(`[acc-catch-up] ${dryRun ? 'dry run: ' : ''}${out.length} current application(s) checked: ${out.filter((x) => x.receipt === 'combined').length} combined first message(s), ${out.filter((x) => x.receipt === 'receipt').length} receipt(s), ${out.filter((x) => x.receipt === 'deferred').length} deferred to the window`);
  return { checked: out.length, results: out };
}

module.exports = { catchUpCurrentCases, receiptRecipients };
