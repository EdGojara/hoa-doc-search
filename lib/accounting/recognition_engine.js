// ============================================================================
// lib/accounting/recognition_engine.js
// ----------------------------------------------------------------------------
// The revenue/expense recognition engine. For each active schedule, posts the
// monthly recognition journal entry for every month that is due but not yet
// posted. Idempotent — a month posts once (unique (schedule, month) + re-check).
// The last month stubs to the exact remaining balance so the balance-sheet
// account zeros precisely.
//
// Two mirror-image directions, driven by schedule_type:
//   prepaid_expense   Dr income (expense) / Cr balance (prepaid asset)
//   deferred_revenue  Dr balance (unearned liability) / Cr income (revenue)
//
// This is "trustEd knows the journal entries": a schedule is set up once (from
// an uploaded document or the annual assessment), and this runs monthly (cron)
// or on demand with no human touching a journal.
//
//   postDueRecognition({ supabase, communityId?, throughMonth, actor })
//     throughMonth: 'YYYY-MM-01' — post months up to and including this one.
// ============================================================================

const firstOfMonth = (d) => String(d).slice(0, 8) + '01';
function addMonths(iso, n) {
  const [y, m] = iso.slice(0, 7).split('-').map(Number);
  const total = (y * 12 + (m - 1)) + n;
  const ny = Math.floor(total / 12), nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-01`;
}

// Straight-line DAILY recognition (Ed 2026-06-30). Month k gets its share of the
// days that fall within [period_start, period_end] — so a prorated assessment
// honors a partial first/last month. Computed as the difference of cumulative-
// day roundings, so the running total always lands exactly on
// recognize_amount_cents at the final month (no rounding drift).
function dailyMonthCents(sch, k) {
  const DAY = 86400000;
  const P = Date.parse(sch.period_start);
  const E = Date.parse(sch.period_end);
  if (!Number.isFinite(P) || !Number.isFinite(E) || E < P) return 0;
  const total = Number(sch.recognize_amount_cents);
  const totalDays = Math.round((E - P) / DAY) + 1; // inclusive of both endpoints
  const cum = (m) => {
    if (m < 0) return 0;
    const ms = addMonths(sch.start_month, m);                 // 'YYYY-MM-01'
    const monthEnd = Date.UTC(Number(ms.slice(0, 4)), Number(ms.slice(5, 7)), 0); // last day of that month
    const clamp = Math.min(monthEnd, E);
    if (clamp < P) return 0;
    const days = Math.min(Math.round((clamp - P) / DAY) + 1, totalDays);
    return Math.round((days * total) / totalDays);
  };
  return cum(k) - cum(k - 1);
}

// Posts every due, unposted month through the database function
// post_recognition_period() (migration 466): schedule lock, idempotency, cap,
// open-period check, journal + lines + posting row + audit event in ONE
// transaction. A month that fails is reported, never skipped silently.
async function postDueRecognition({ supabase, communityId = null, throughMonth, actor }) {
  if (!throughMonth) throw new Error('throughMonth required (YYYY-MM-01)');
  if (!actor || !String(actor).trim()) throw new Error('actor required (who is posting recognition)');
  const through = firstOfMonth(throughMonth);

  let q = supabase.from('recognition_schedules').select('id, community_id, description, schedule_type, status').eq('status', 'active').order('id');
  if (communityId) q = q.eq('community_id', communityId);
  const { data: schedules, error } = await q;
  if (error) throw error;

  const results = [];
  for (const sch of schedules || []) {
    const { data: periods, error: pErr } = await supabase.from('recognition_schedule_periods')
      .select('period_month, scheduled_cents').eq('schedule_id', sch.id).order('period_month');
    if (pErr) throw pErr;
    const { data: posted, error: rErr } = await supabase.from('recognition_postings')
      .select('period_month, kind, reversed_by_posting_id').eq('schedule_id', sch.id).order('period_month');
    if (rErr) throw rErr;
    const done = new Set((posted || []).filter((p) => p.kind === 'recognition' && !p.reversed_by_posting_id).map((p) => String(p.period_month).slice(0, 10)));
    for (const p of periods || []) {
      const month = String(p.period_month).slice(0, 10);
      if (month > through) break;
      if (Number(p.scheduled_cents) === 0 || done.has(month)) continue;
      const { data: postingId, error: postErr } = await supabase.rpc('post_recognition_period', {
        p_schedule_id: sch.id, p_period_month: month, p_actor: String(actor).trim(),
      });
      if (postErr) {
        console.warn('[recognition] post failed', JSON.stringify({ schedule: sch.id, month, error: postErr.message }));
        results.push({ schedule: sch.description, month, error: postErr.message });
        break; // later months wait until this one posts (keeps the schedule in order)
      }
      results.push({ schedule: sch.description, type: sch.schedule_type, month, amount_cents: Number(p.scheduled_cents), posting_id: postingId, posted: true });
    }
  }
  return results;
}

module.exports = { postDueRecognition, addMonths, dailyMonthCents };
