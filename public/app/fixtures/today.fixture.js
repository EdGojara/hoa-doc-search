// Fixture for /app/today in ?fixture=1 / file:// mode (visual snapshot harness).
// SAMPLE DATA ONLY — the demo community, no real owners, vendors or balances.
// Keyed by endpoint path; each value is what TX.get() would return.
window.TX_FIXTURE = {
  user: { full_name: 'Ed Gojara', role: 'admin' },
  '/api/community-profile/': { ok: true, data: { communities: [
    { id: '00000000-0000-4000-8000-000000000001', name: 'Drama Creek (sample)', active: true, hero: '../photos/communities/LPF_hero.jpg' },
  ] } },
  '/api/enforcement/mail-queue/summary': { ok: true, data: {
    total_pending: 0,
    summary: { first_class_mail: 0, certified_mail: 0, locked_first_class: 9, locked_certified: 0,
      locked_batches: [{ printed_at: '2026-09-28T18:05:00Z', delivery_method: 'first_class_mail', count: 9 }] },
  } },
  '/api/ap/ed-queue': { ok: true, data: { count: 1, total_cents: 3572, invoices: [
    { id: 'i1', community_id: '00000000-0000-4000-8000-000000000001', vendor: 'Sample board member reimbursement', total_cents: 3572 },
  ], cash: [{ community_id: '00000000-0000-4000-8000-000000000001', count: 1, pending_cents: 3572, operating_cash_cents: 1250000, covered: true }] } },
  '/api/today': { ok: true, data: {
    inbox: { count: 2, capped: false, items: [{ sla: 'red' }, { sla: 'green' }] },
    calls: { items: [{ started_at: new Date(Date.now() - 3600e3).toISOString(), brief_concern: 'Homeowner asked when the pool reopens for the season.' }] },
    uploads: { items: [{ imported_at: new Date(Date.now() - 7200e3).toISOString(), report_type: 'ar_aging', status: 'committed' }] },
    section_errors: {},
  } },
  '/api/manager/shadow': { ok: true, data: {
    phase: 1, available: true, model_calls: 0, actions_executed: 0, section_errors: {},
    schedule: { hours: [8, 15], business_days_only: true, scheduled: true },
    last_sweep: { started_at: new Date(Date.now() - 2 * 3600e3).toISOString(), ok: true },
    needs_people: [
      { title: 'Possible duplicate: bill 7316 ($1,470.00)', community: 'Drama Creek (sample)', next_action: 'A person confirms whether this bill is a duplicate before it can move.', autonomy_class: 'REVIEW', priority: 'high' },
      { title: 'Board packet October 2026 still draft (meeting in 2 days)', community: 'Drama Creek (sample)', next_action: 'Finish and finalize the board packet before the meeting.', autonomy_class: 'REVIEW', priority: 'high' },
    ],
    blocked: [
      { title: 'Bill waiting on the community this bill belongs to: Sample Landscaping #262093 ($1,185.22)', community: null, blocked_reason: 'Payables needs to supply the community this bill belongs to before this bill can load.', autonomy_class: 'BLOCK' },
    ],
    last_24h: { routine_would_continue: 6, resolved: 2, wakes_processed: 9 },
    pending_wakes: 1,
  } },
  '/api/ar/control': { ok: true, data: {
    subledger_cents: 5870704, accounts: 109, owners_owing: 83, owners_in_credit: 26,
    gl_1300_2400_net_cents: 5870704, gl_accounts_found: 2, diff_cents: 0,
    conversion: { ready: true, batch_code: 'SAMPLE', as_of_date: '2026-07-31' }, ties: true,
  } },
};
