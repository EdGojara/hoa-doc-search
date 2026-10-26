// My Time fixture (synthetic: invented employee, demo community names). ?state=out shows the clocked-out view.
(function () {
  var out = /[?&]state=out\b/.test(location.search);
  var IN = { start_shift: 'Start of day', back_from_break: 'Back from break', back_from_meal: 'Back from lunch', back_from_personal: 'Back from personal time', other: 'Other' };
  var OUT = { rest_break: 'Break', meal_break: 'Lunch', personal: 'Personal', end_of_shift: 'Done for the day', other: 'Other' };
  var cats = [['accounting_ap', 'Accounting / AP'], ['acc_arc', 'ACC / ARC'], ['admin', 'Admin'], ['amenities', 'Amenities'], ['board_support', 'Board support'], ['collections', 'Collections'], ['compliance_drv', 'Compliance / DRV'], ['homeowner_communication', 'Homeowner communication'], ['training', 'Training'], ['vendors_maintenance', 'Vendors / maintenance'], ['other', 'Other']];
  var punches = [
    { punch_id: 'p1', direction: 'in', effective_at: '2026-10-26T13:02:00Z', original_at: '2026-10-26T13:02:00Z', reason: 'start_shift', is_corrected: false, origin: 'punch' },
    { punch_id: 'p2', direction: 'out', effective_at: '2026-10-26T17:01:00Z', original_at: '2026-10-26T17:01:00Z', reason: 'meal_break', is_corrected: false, origin: 'punch' },
    { punch_id: 'p3', direction: 'in', effective_at: '2026-10-26T17:34:00Z', original_at: '2026-10-26T17:34:00Z', reason: 'back_from_meal', is_corrected: false, origin: 'punch' },
  ];
  if (out) punches.push({ punch_id: 'p4', direction: 'out', effective_at: '2026-10-26T19:45:00Z', original_at: '2026-10-26T19:45:00Z', reason: 'rest_break', is_corrected: false, origin: 'punch' });
  var days = [
    { date: '2026-10-19', paid_minutes: 492, live_minutes: 0, overtime_minutes: 0 }, { date: '2026-10-20', paid_minutes: 480, live_minutes: 0, overtime_minutes: 0 },
    { date: '2026-10-21', paid_minutes: 510, live_minutes: 0, overtime_minutes: 0 }, { date: '2026-10-22', paid_minutes: 465, live_minutes: 0, overtime_minutes: 0 },
    { date: '2026-10-23', paid_minutes: 420, live_minutes: 0, overtime_minutes: 0 }, { date: '2026-10-25', paid_minutes: 0, live_minutes: 0, overtime_minutes: 0 },
    { date: '2026-10-26', paid_minutes: out ? 362 : 239, live_minutes: out ? 0 : 131, overtime_minutes: 0 },
  ];
  window.TX_FIXTURE = {
    user: { full_name: 'Preview Staff', role: 'staff' },
    '/api/time/me': { ok: true, data: {
      user: { id: 'u-preview', name: 'Preview Staff' }, enrolled: true, today: '2026-10-26',
      employee: { user_id: 'u-preview', flsa_status: 'nonexempt', tracks_time: true, active: true },
      settings: { workweek_start_dow: 0, weekly_threshold_minutes: 2400 },
      categories: cats.map(function (c) { return { value: c[0], label: c[1] }; }), in_reasons: IN, out_reasons: OUT,
      status: out ? { clocked_in: false, since: null, stale_open: null, last_punch: punches[3], suggested_in_reason: 'back_from_break', last_out_reason: 'rest_break' }
        : { clocked_in: true, since: '2026-10-26T17:34:00Z', stale_open: null, last_punch: punches[2], suggested_in_reason: 'start_shift' },
      today_row: days[6], week: { week_start: '2026-10-25', paid_minutes: out ? 362 : 239, live_minutes: out ? 0 : 131, so_far_minutes: out ? 362 : 370, threshold_minutes: 2400, approved_overtime_minutes: 0 },
      timesheet: { from: '2026-10-13', to: '2026-10-26', days: days, flags: [{ code: 'break_20_29', date: '2026-10-21', severity: 'warn', message: 'A 25-minute meal break is under 30 minutes, so it is paid. Review if this was meant as an unpaid meal period.' }] },
      punches: punches,
      corrections: [{ id: 'c1', kind: 'change_time', original_at: '2026-10-22T13:20:00Z', proposed_at: '2026-10-22T13:00:00Z', status: 'approved', decision_reason: 'Confirmed, you were at the Canyon Gate walk at 8.' }],
      overtime: [], today_summary: null,
      communities: [{ id: 'cm1', name: 'Canyon Gate' }, { id: 'cm2', name: 'Drama Creek' }, { id: 'cm3', name: 'Lakes of Pine Forest' }, { id: 'cm4', name: 'Still Creek Ranch' }, { id: 'cm5', name: 'Waterview Estates' }],
    } },
  };
})();
