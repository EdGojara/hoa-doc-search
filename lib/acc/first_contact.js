// ============================================================================
// lib/acc/first_contact.js  (Ed 2026-11-26)
// ----------------------------------------------------------------------------
// ONE NATURAL FIRST MESSAGE. Scar: 6331 Clear Canyon got two emails at 1:09 PM:
// "we received it and will review it", then seconds later "we reviewed it and
// need more information". The receipt and the review were separate workflow
// steps that each sent their own email without knowing about the other.
//
// Annie reviews immediately (the review runs during intake). Within the
// communication window (ACC_ACK_WINDOW_MINUTES, 30 from ingestion):
//   * her review outcome is ready to send (a request for information, or a
//     decision within her authority): ONE email that confirms receipt (date,
//     reference) and gives the outcome (lib/email/acc_cover_note firstContact);
//   * the decision belongs to someone else (Ed's exceptions, the Committee or
//     Board, the developer): the receipt goes now, saying the review may take
//     longer, never promising a date;
//   * the outcome needs a person (e.g. a letter that mixes an approval with a
//     request) or the review is not finished: the receipt waits until the window
//     closes, so a person's response inside the window still goes as one email;
//     at the window's end, if the homeowner still has nothing, the receipt goes.
// The window timer is one-shot (not a poll); a restart is covered by the start-
// up catch-up (lib/acc/catch_up), which runs this again. Never the backlog hold.
//
//   respondToApplication(supabase, id, { source, now }) ->
//     { outcome: 'combined'|'receipt'|'deferred'|'already'|'skipped', detail }
// ============================================================================
const DA = require('./decision_authority');
const BH = require('./backlog_hold');
const SC = require('./service_clock');

const timers = new Map();

async function loadCase(supabase, id) {
  const { data: row, error } = await supabase.from('acc_decisions').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`case read failed: ${error.message}`);
  if (!row) return null;
  let delegation = null;
  if (row.community_id) {
    const { data: c, error: ce } = await supabase.from('communities').select('acc_delegation').eq('id', row.community_id).maybeSingle();
    if (ce && !/acc_delegation|does not exist/i.test(ce.message || '')) console.warn('[acc-first-contact] delegation read failed:', ce.message);
    delegation = c && c.acc_delegation && typeof c.acc_delegation === 'object' ? c.acc_delegation : null;
  }
  return { ...row, acc_delegation: delegation };
}

// Plain-language reason a review takes longer, for the homeowner (no names, no dates).
function longerReviewReason(row, a) {
  if (a.route === 'committee_or_board_required') {
    return row.acc_delegation && row.acc_delegation.reserved_to === 'developer' ? "requires the developer's review" : "requires the Architectural Committee's review";
  }
  if (a.route === 'owner_review_required') return 'requires additional review';
  return null;
}

async function sendReceipt(supabase, row, { longerReview = null } = {}) {
  const A = require('./acknowledge');
  const to = A.receiptRecipients(row);
  if (!to.length) return { outcome: 'skipped', detail: 'no external applicant address' };
  const r = await A.acknowledgeApplication(supabase, {
    decisionId: row.id, to: to.join(', '), applicantName: row.homeowner_name, communityName: row.community_name,
    communityId: row.community_id, reference: row.reference_number, address: row.homeowner_address,
    receivedAt: row.received_at || null, longerReview,
  });
  return r.sent ? { outcome: 'receipt', detail: longerReview ? `receipt sent (${longerReview})` : 'receipt sent' } : { outcome: 'skipped', detail: r.skipped || r.error };
}

function scheduleWindowReceipt(supabase, id, dueMs) {
  if (timers.has(id)) return;
  const wait = Math.max(0, dueMs - Date.now());
  const h = setTimeout(async () => {
    timers.delete(id);
    try {
      const row = await loadCase(supabase, id);
      if (!row || row.acknowledged_at || !['pending_review', 'awaiting_info'].includes(row.status)) return;
      const r = await sendReceipt(supabase, row);
      console.log(`[acc-first-contact] window closed for ${row.reference_number || id}: ${r.detail}`);
    } catch (e) { console.error(`[acc-first-contact] window receipt for ${id} failed: ${e.message}`); }
  }, wait);
  if (h.unref) h.unref();
  timers.set(id, h);
}

async function respondToApplication(supabase, id, { source = 'intake', now = new Date() } = {}) {
  let row = await loadCase(supabase, id);
  if (!row) return { outcome: 'skipped', detail: 'case not found' };
  if (BH.isBacklogHeld(row)) return { outcome: 'skipped', detail: 'backlog hold' };
  if (!['pending_review', 'awaiting_info'].includes(row.status)) return { outcome: 'skipped', detail: `case is ${row.status}` };
  const I = require('./annie_issue');

  // 1. Annie's outcome, if it is hers to send now. Her first email doubles as the receipt.
  const next = await I.issueIfReady(supabase, id, { source });
  if (next.requested_info || (next.issued && next.email_sent)) return { outcome: row.acknowledged_at ? 'already' : 'combined', detail: next.requested_info ? 'information requested' : 'decision issued' };
  if (row.acknowledged_at) return { outcome: 'already', detail: next.skipped || 'acknowledged earlier' };

  row = await loadCase(supabase, id);
  if (!row || row.acknowledged_at) return { outcome: 'already', detail: 'acknowledged' };
  const a = DA.authorityFor(row);

  // 2. The decision belongs to someone else: tell the homeowner now that it may take longer.
  const longer = DA.reviewAt(row) ? longerReviewReason(row, a) : null;
  if (longer) return sendReceipt(supabase, row, { longerReview: longer });

  // 3. Needs a person, or the review is not done: hold the receipt to the window's end.
  const dueMs = Date.parse(row.created_at) + SC.ackWindowMinutes() * 60000;
  if (now.getTime() >= dueMs) return sendReceipt(supabase, row);
  scheduleWindowReceipt(supabase, id, dueMs);
  return { outcome: 'deferred', detail: `receipt by ${new Date(dueMs).toISOString()} unless a response goes first (${next.skipped || 'review pending'})`, due_at: new Date(dueMs).toISOString() };
}

module.exports = { respondToApplication, longerReviewReason, _timers: timers };
