// ============================================================================
// lib/messaging/sla_engine.js
// ----------------------------------------------------------------------------
// SLA enforcement layer for homeowner_threads. Runs as a scheduled job
// (every 2 hours via lib/scheduler.js). Bezos's "mechanisms not good
// intentions" — but Ed 2026-06-04: starting LOOSE on thresholds so the
// team isn't discouraged by metrics they can't reach. Beat baseline
// first, ratchet down later as performance proves it.
//
// Thresholds (configurable; tunable as the team builds the muscle):
//   - Target:    8 business hours to first response (1 full business day)
//   - Yellow:    12 hours past target, no first response
//   - Red:       24 hours past target, no first response
//   - Overdue:   48 hours past target, no first response
//                → escalation hook (Phase 2)
//
// Close-with-agreement auto-close:
//   - When a thread has closure_proposed_at + 24h has elapsed with no
//     homeowner reply → auto-close with reason 'auto_after_silent_24h'
//   (Kept at 24h per Ed's earlier design call.)
//
// First-response-due calculation:
//   - 8 business hours during 9am-5pm Central, Mon-Fri
//   - Off-hours: rolls forward to next business window start
//   - Approximation good enough for v1; refine after real usage data
// ============================================================================

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const BUSINESS_TZ = 'America/Chicago';
const BUSINESS_HOUR_START = 9;   // 9am Central
const BUSINESS_HOUR_END = 17;    // 5pm Central
const FIRST_RESPONSE_BUSINESS_HOURS = 8;   // was 2 — loosened (Ed 2026-06-04)
const YELLOW_OVERDUE_HOURS = 12;            // was 4 — loosened
const RED_OVERDUE_HOURS = 24;               // was 8 — loosened
const SENIOR_ESCALATION_OVERDUE_HOURS = 48; // was 24 — loosened
const CLOSURE_AUTO_CLOSE_HOURS = 24;        // unchanged — per design

// Compute when first-response is due, given the inbound message time. Adds
// 2 business hours, skipping weekends and off-hours.
function computeFirstResponseDueAt(inboundAt) {
  const date = new Date(inboundAt);
  // Convert to Central
  let central = new Date(date.toLocaleString('en-US', { timeZone: BUSINESS_TZ }));
  let dueAt = new Date(central);
  let hoursRemaining = FIRST_RESPONSE_BUSINESS_HOURS;

  // March forward, hour by hour, only counting business hours.
  while (hoursRemaining > 0) {
    const day = dueAt.getDay();         // 0 = Sun, 6 = Sat
    const hour = dueAt.getHours();
    const isWeekend = day === 0 || day === 6;
    const inBusinessWindow = hour >= BUSINESS_HOUR_START && hour < BUSINESS_HOUR_END;
    if (!isWeekend && inBusinessWindow) {
      hoursRemaining -= 1;
      dueAt.setTime(dueAt.getTime() + 60 * 60 * 1000);
    } else {
      // Skip to next 9am Central
      while (true) {
        dueAt.setTime(dueAt.getTime() + 60 * 60 * 1000);
        const d = dueAt.getDay();
        const h = dueAt.getHours();
        if (d !== 0 && d !== 6 && h === BUSINESS_HOUR_START) break;
      }
    }
  }
  // Convert back to UTC
  const utcOffset = dueAt.getTimezoneOffset() * 60 * 1000;
  // dueAt is in local timezone interpretation; we want UTC ISO
  return new Date(dueAt.toISOString());
}

// ----------------------------------------------------------------------------
// runSlaTick — called by scheduler every 15 minutes.
// Returns { yellow_flipped, red_flipped, overdue_flipped, auto_closed }
// ----------------------------------------------------------------------------
async function runSlaTick() {
  const now = new Date();
  const nowIso = now.toISOString();
  const stats = { yellow_flipped: 0, red_flipped: 0, overdue_flipped: 0, auto_closed: 0 };

  // 1. YELLOW: first_response_due_at passed + 4h, no first response yet, not already yellow.
  const yellowCutoff = new Date(now.getTime() - YELLOW_OVERDUE_HOURS * 60 * 60 * 1000).toISOString();
  const { data: yellowRows, error: yellowErr } = await supabase
    .from('homeowner_threads')
    .update({ breached_yellow_at: nowIso })
    .is('first_responded_at', null)
    .is('breached_yellow_at', null)
    .neq('next_action_status', 'closed')
    .lt('first_response_due_at', yellowCutoff)
    .select('id');
  if (yellowErr) console.warn('[sla-engine] yellow update failed:', yellowErr.message);
  else stats.yellow_flipped = (yellowRows || []).length;

  // 2. RED: same condition + 8h.
  const redCutoff = new Date(now.getTime() - RED_OVERDUE_HOURS * 60 * 60 * 1000).toISOString();
  const { data: redRows, error: redErr } = await supabase
    .from('homeowner_threads')
    .update({ breached_red_at: nowIso })
    .is('first_responded_at', null)
    .is('breached_red_at', null)
    .neq('next_action_status', 'closed')
    .lt('first_response_due_at', redCutoff)
    .select('id');
  if (redErr) console.warn('[sla-engine] red update failed:', redErr.message);
  else stats.red_flipped = (redRows || []).length;

  // 3. OVERDUE: 24h past due → escalate to senior staff (mechanism, not nag).
  const overdueCutoff = new Date(now.getTime() - SENIOR_ESCALATION_OVERDUE_HOURS * 60 * 60 * 1000).toISOString();
  const { data: overdueRows, error: overdueErr } = await supabase
    .from('homeowner_threads')
    .update({ breached_overdue_at: nowIso })
    .is('first_responded_at', null)
    .is('breached_overdue_at', null)
    .neq('next_action_status', 'closed')
    .lt('first_response_due_at', overdueCutoff)
    .select('id, assigned_staff_id, subject');
  if (overdueErr) console.warn('[sla-engine] overdue update failed:', overdueErr.message);
  else stats.overdue_flipped = (overdueRows || []).length;
  // TODO: when a thread flips overdue, queue an email to a senior staff
  // distribution list. Implement in Phase 2 after we have staff_users wired.

  // 4. CLOSURE AUTO-CLOSE: threads in closure_pending with closure_proposed_at
  //    older than 24h AND no homeowner message since the proposal → auto-close.
  const autoCloseCutoff = new Date(now.getTime() - CLOSURE_AUTO_CLOSE_HOURS * 60 * 60 * 1000).toISOString();
  const { data: stale, error: staleErr } = await supabase
    .from('homeowner_threads')
    .select('id, closure_proposed_at, last_homeowner_message_at')
    .eq('next_action_status', 'closure_pending')
    .lt('closure_proposed_at', autoCloseCutoff);
  if (staleErr) {
    console.warn('[sla-engine] closure scan failed:', staleErr.message);
  } else {
    for (const row of (stale || [])) {
      // Don't auto-close if homeowner messaged after the proposal — that
      // already should have flipped status, but defensive check.
      if (row.last_homeowner_message_at && row.last_homeowner_message_at > row.closure_proposed_at) continue;
      const { error: closeErr } = await supabase
        .from('homeowner_threads')
        .update({
          next_action_status: 'closed',
          closed_at: nowIso,
          closed_reason: 'auto_after_silent_24h',
        })
        .eq('id', row.id);
      if (closeErr) console.warn(`[sla-engine] auto-close failed for ${row.id}:`, closeErr.message);
      else stats.auto_closed += 1;
    }
  }

  console.log(`[sla-engine] tick complete: yellow=${stats.yellow_flipped} red=${stats.red_flipped} overdue=${stats.overdue_flipped} auto_closed=${stats.auto_closed}`);
  return stats;
}

module.exports = {
  runSlaTick,
  computeFirstResponseDueAt,
};
