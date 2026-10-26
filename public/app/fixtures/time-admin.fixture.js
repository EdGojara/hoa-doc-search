// Team Time fixture (synthetic: invented employees and times, demo community names).
(function () {
  var flags = {
    a: [{ code: 'approaching_threshold', date: '2026-10-26', severity: 'warn', message: '37h 10m so far in the week of Oct 25; 2h 50m left before 40h 00m.', week_start: '2026-10-25' }],
    b: [{ code: 'missing_out', date: '2026-10-23', severity: 'bad', message: 'Still clocked in from an earlier day. Request a correction for the missing clock-out; these hours are not counted until it is approved.' },
        { code: 'break_20_29', date: '2026-10-22', severity: 'warn', message: 'A 25-minute meal break is under 30 minutes, so it is paid. Review if this was meant as an unpaid meal period.' }],
    c: [{ code: 'over_threshold_unapproved', date: '2026-10-24', severity: 'bad', message: '42h 15m worked in the week of Oct 18; 2h 15m past 40h 00m without approval. All hours are recorded and paid.', week_start: '2026-10-18' }],
  };
  window.TX_FIXTURE = {
    user: { full_name: 'Preview Owner', role: 'admin' },
    '/api/time/admin/overview': { ok: true, data: {
      from: '2026-10-13', to: '2026-10-26', today: '2026-10-26', week_start: '2026-10-25',
      settings: { workweek_start_dow: 0, weekly_threshold_minutes: 2400, pay_frequency: null, pay_period_anchor: null },
      people: [
        { user_id: 'u-a1', name: 'Alex Rivera', email: 'alex@example.test', flsa_status: 'nonexempt', tracks_time: true, active: true, clocked_in: true, since: '2026-10-26T13:01:00Z', today_minutes: 312, week_minutes: 2230, week_threshold: 2400, flags: flags.a },
        { user_id: 'u-b2', name: 'Blair Chen', email: 'blair@example.test', flsa_status: 'nonexempt', tracks_time: true, active: true, clocked_in: false, since: null, today_minutes: 0, week_minutes: 0, week_threshold: 2400, flags: flags.b },
        { user_id: 'u-c3', name: 'Casey Morgan', email: 'casey@example.test', flsa_status: 'nonexempt', tracks_time: true, active: true, clocked_in: true, since: '2026-10-26T12:30:00Z', today_minutes: 355, week_minutes: 355, week_threshold: 2400, flags: flags.c },
        { user_id: 'u-d4', name: 'Devon Patel', email: 'devon@example.test', flsa_status: 'exempt', tracks_time: false, active: true, clocked_in: false, since: null, today_minutes: 0, week_minutes: 0, week_threshold: 2400, flags: [] },
      ],
      not_enrolled: [{ user_id: 'u-e5', name: 'Emery Brooks', email: 'emery@example.test', role: 'staff' }],
      pending_corrections: [
        { id: 'c1', user_id: 'u-b2', employee: 'Blair Chen', kind: 'add_punch', proposed_direction: 'out', proposed_at: '2026-10-23T22:05:00Z', employee_reason: 'Forgot to clock out Friday; left at 5:05 after the Drama Creek board meeting.', requested_at: '2026-10-26T13:40:00Z' },
        { id: 'c2', user_id: 'u-a1', employee: 'Alex Rivera', kind: 'change_time', original_direction: 'in', original_at: '2026-10-21T13:24:00Z', proposed_at: '2026-10-21T13:00:00Z', employee_reason: 'Started at 8 on the Canyon Gate site walk; punched in when I got to the office.', requested_at: '2026-10-21T19:02:00Z' },
      ],
      pending_overtime: [{ id: 'o1', user_id: 'u-a1', employee: 'Alex Rivera', week_start: '2026-10-25', extra_minutes: 180, employee_reason: 'Month-end close for Still Creek Ranch.', requested_at: '2026-10-26T15:00:00Z' }],
      periods: [], frequencies: ['weekly', 'biweekly', 'semimonthly', 'monthly'], current_period: null,
    } },
    '/api/time/admin/timesheet/u-b2': { ok: true, data: {
      from: '2026-10-13', to: '2026-10-26', settings: { workweek_start_dow: 0 }, employee: { user_id: 'u-b2', name: 'Blair Chen', flsa_status: 'nonexempt' },
      timesheet: { days: [{ date: '2026-10-22', paid_minutes: 505, overtime_minutes: 0 }, { date: '2026-10-21', paid_minutes: 480, overtime_minutes: 0 }], flags: flags.b, weeks: [] },
      punches: [
        { direction: 'in', effective_at: '2026-10-21T13:00:00Z', reason: 'start_shift', is_corrected: false, origin: 'punch' }, { direction: 'out', effective_at: '2026-10-21T21:00:00Z', reason: 'end_of_shift', is_corrected: false, origin: 'punch' },
        { direction: 'in', effective_at: '2026-10-22T13:00:00Z', reason: 'start_shift', is_corrected: true, original_at: '2026-10-22T13:20:00Z', origin: 'punch' }, { direction: 'out', effective_at: '2026-10-22T17:00:00Z', reason: 'meal_break', is_corrected: false, origin: 'punch' },
        { direction: 'in', effective_at: '2026-10-22T17:25:00Z', reason: 'back_from_meal', is_corrected: false, origin: 'punch' }, { direction: 'out', effective_at: '2026-10-22T21:40:00Z', reason: 'end_of_shift', is_corrected: false, origin: 'punch' },
        { direction: 'in', effective_at: '2026-10-23T13:05:00Z', reason: 'start_shift', is_corrected: false, origin: 'punch' },
      ],
      corrections: [{ id: 'c0', kind: 'change_time', original_direction: 'in', original_at: '2026-10-22T13:20:00Z', proposed_at: '2026-10-22T13:00:00Z', status: 'approved', decided_by_name: 'Preview Owner', decided_at: '2026-10-22T20:00:00Z', employee_reason: 'Was on a vendor call from 8.', decision_reason: 'Confirmed with employee' }],
      overtime: [],
      summaries: [{ work_date: '2026-10-22', categories: ['Accounting / AP', 'Board support'], accomplishments: 'Coded 14 bills; prepared the Drama Creek packet draft.', outstanding: 'Two W-9s.' }],
    } },
    '/api/time/admin/activity': { ok: true, data: { from: '2026-10-20', to: '2026-10-26', rows: [
      { employee: 'Alex Rivera', date: '2026-10-23', categories: ['Accounting / AP'], communities: ['Still Creek Ranch'], accomplishments: 'Bank reconciliation for September; 22 bills coded.', outstanding: 'Two vendor statements missing.', notes: null },
      { employee: 'Blair Chen', date: '2026-10-22', categories: ['Accounting / AP', 'Board support'], communities: ['Drama Creek'], accomplishments: 'Coded 14 bills; prepared the Drama Creek packet draft.', outstanding: 'Two W-9s.', notes: null },
      { employee: 'Casey Morgan', date: '2026-10-24', categories: ['Compliance / DRV', 'Homeowner communication'], communities: ['Canyon Gate', 'Waterview Estates'], accomplishments: 'Drove Canyon Gate; 31 observations logged. Returned 9 homeowner calls.', outstanding: 'Waterview photos to upload.', notes: 'Gate 2 arm is sticking.' },
    ] } },
    '/api/time/admin/payroll': { ok: true, data: { from: '2026-10-16', to: '2026-10-31', totals: { regular_hours: 158.5, overtime_hours: 2.25, total_hours: 160.75 }, rows: [
      { employee: 'Alex Rivera', regular_hours: 77.5, overtime_hours: 0, total_hours: 77.5, paid_break_hours: 1.25, unapproved_overtime_hours: 0 },
      { employee: 'Blair Chen', regular_hours: 41, overtime_hours: 0, total_hours: 41, paid_break_hours: 0.42, unapproved_overtime_hours: 0 },
      { employee: 'Casey Morgan', regular_hours: 40, overtime_hours: 2.25, total_hours: 42.25, paid_break_hours: 0.5, unapproved_overtime_hours: 2.25 },
    ], exceptions: [{ employee: 'Blair Chen', date: '2026-10-23', code: 'missing_out', message: 'Still clocked in from an earlier day. Request a correction for the missing clock-out; these hours are not counted until it is approved.' }, { employee: 'Blair Chen', date: '2026-10-23', code: 'pending_correction', message: 'A correction is waiting for approval.' }] } },
  };
})();
