// ============================================================================
// lib/enforcement/trash_inspection_windows.js
// ----------------------------------------------------------------------------
// Trash-can violations only hold up if the can was at the curb on a day it
// shouldn't be. On a collection day every can is legitimately out, so writing
// a "trash container left out" violation that day is indefensible. This maps a
// community's trash_schedule.collection_days to the days that ARE clear for
// writing those violations (every day that isn't a collection day).
//
// Pure + testable: computeWindows(communities, today) takes the weekday in,
// so the only impurity (today's date) lives in the caller.
// ============================================================================

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// Lowercase weekday name for a Date, resolved in Central time (TX). new Date()
// is server runtime — fine; only the helper below must stay pure.
function centralWeekday(date) {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'long' }).format(date);
  return wd.toLowerCase();
}

// communities: [{ id, name, slug, trash_schedule }]
// today: lowercase weekday string ('thursday')
// returns one row per community with collection days, clear days, and today's
// status: 'clear' | 'collection' | 'unknown' (no schedule on file).
function computeWindows(communities, today) {
  return (communities || []).map((c) => {
    const sched = c.trash_schedule || {};
    const collection = Array.isArray(sched.collection_days)
      ? sched.collection_days.map((d) => String(d).toLowerCase()).filter((d) => DAYS.includes(d))
      : [];
    const recycling = Array.isArray(sched.recycling_days)
      ? sched.recycling_days.map((d) => String(d).toLowerCase()).filter((d) => DAYS.includes(d))
      : [];
    const hasSchedule = collection.length > 0;
    const clearDays = DAYS.filter((d) => !collection.includes(d));
    return {
      id: c.id,
      name: c.name,
      slug: c.slug,
      has_schedule: hasSchedule,
      collection_days: collection,
      recycling_days: recycling,
      clear_days: hasSchedule ? clearDays : [],
      today,
      today_status: !hasSchedule ? 'unknown' : (collection.includes(today) ? 'collection' : 'clear'),
    };
  });
}

module.exports = { DAYS, centralWeekday, computeWindows };
