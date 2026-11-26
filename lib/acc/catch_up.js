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

const isInternal = (e) => /@(?:bedrocktx\.com|bedrocktxai\.com)$/i.test(String(e || '')) || /no-?reply|donotreply/i.test(String(e || ''));
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function enabled() { return !/^(0|false|off|no|disabled)$/i.test(String(process.env.ACC_CATCH_UP || '').trim()); }

// The receipt goes to the applicant and the external correspondents on the case
// (a forwarding property manager), never to our own staff.
function receiptRecipients(row) {
  return [...new Set([row.submitter_email, ...(row.correspondent_emails || [])]
    .filter((e) => e && EMAIL_RE.test(String(e).trim()) && !isInternal(e)).map((e) => String(e).trim().toLowerCase()))];
}

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
    if (!row.acknowledged_at) {
      const to = receiptRecipients(row);
      if (!to.length) item.receipt = 'no external applicant address';
      else if (dryRun) item.receipt = `would send to ${to.length} recipient(s)`;
      else {
        const r = await require('./acknowledge').acknowledgeApplication(supabase, {
          decisionId: row.id, to: to.join(', '), applicantName: row.homeowner_name, communityName: row.community_name,
          communityId: row.community_id, reference: row.reference_number, address: row.homeowner_address, receivedAt: row.received_at || null,
        });
        item.receipt = r.sent ? 'sent' : (r.skipped || r.error);
      }
    }
    const next = await require('./annie_issue').issueIfReady(supabase, row.id, { dryRun, source: 'catch_up' });
    item.next = next.requested_info ? 'information requested' : next.issued ? 'decision issued' : next.would_request_info ? 'would request information' : next.would_issue ? 'would issue decision' : next.skipped;
    out.push(item);
  }
  log.log(`[acc-catch-up] ${dryRun ? 'dry run: ' : ''}${out.length} current application(s) checked: ${out.filter((x) => x.receipt === 'sent').length} receipt(s) sent, ${out.filter((x) => x.next === 'information requested').length} information request(s) sent`);
  return { checked: out.length, results: out };
}

module.exports = { catchUpCurrentCases, receiptRecipients };
