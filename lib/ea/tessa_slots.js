// ============================================================================
// lib/ea/tessa_slots.js  (Ed 2026-10-07) — WHEN to schedule, from Ed's calendar
// ----------------------------------------------------------------------------
// Tessa never books a time blindly. Before a meeting is staged (and before its
// confirmation email is drafted, so the email names the real time) she reads
// Ed's calendar plus every meeting she has already staged (a HOLD on its slot)
// and decides:
//   exact    Ed named the time. Free -> that time. Busy -> NOT booked: the
//            conflict and the 2-3 nearest open alternatives go back to Ed (his
//            explicit time is his call; Tessa never silently moves it).
//   window   "Friday afternoon", "tomorrow morning", "next week": the earliest
//            open slot of the right length inside the window and Ed's working
//            hours. None -> the best 2-3 alternatives, nothing booked.
//   options  the person (or Ed) offered several times: the earliest one that is
//            free. None free -> alternatives, nothing booked.
// Never overlaps a busy event or a hold, never in the past (30 min lead), wall
// times in Central; a thread that states Eastern / Mountain / Pacific times is
// converted. Pure: no I/O (lib/ea/tessa_availability.js reads the calendar).
// ============================================================================

const WD = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const PARTS = { morning: ['09:00', '12:00'], afternoon: ['13:00', '17:00'], evening: ['17:00', '19:00'] };
const DEFAULT_HOURS = { days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], start: '09:00', end: '17:00' };
const ZONE_SHIFT = { eastern: -60, et: -60, est: -60, edt: -60, mountain: 60, mt: 60, mst: 60, mdt: 60, pacific: 120, pt: 120, pst: 120, pdt: 120 };   // minutes to add to reach Central

// ---- wall-time math (naive 'YYYY-MM-DDTHH:MM:SS', always Central) -----------
const toMs = (w) => { const [d, t] = String(w).split('T'); const [Y, M, D] = d.split('-').map(Number); const [h, m] = (t || '00:00').split(':').map(Number); return Date.UTC(Y, M - 1, D, h, m); };
const fromMs = (ms) => new Date(ms).toISOString().slice(0, 19);
const dateOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const hm = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
const at = (dayIso, minutes) => fromMs(Date.UTC(...dayIso.split('-').map((x, i) => (i === 1 ? +x - 1 : +x)), 0, minutes));
const weekday = (dayIso) => WD[new Date(dayIso + 'T00:00:00Z').getUTCDay()];
const addDays = (dayIso, n) => dateOf(toMs(dayIso + 'T00:00:00') + n * 86400000);
const overlaps = (aS, aE, bS, bE) => toMs(aS) < toMs(bE) && toMs(bS) < toMs(aE);

/** "3", "3:30", "3:30 pm", "15:00" -> minutes after midnight (bare 1-6 = afternoon, 7-11 = morning). */
function timeToMin(raw) {
  const m = String(raw || '').trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|noon)?$/);
  if (!m) return null;
  let h = +m[1]; const min = m[2] ? +m[2] : 0; const ap = (m[3] || '').replace(/\./g, '');
  if (ap === 'noon') return 12 * 60;
  if (ap === 'pm' && h < 12) h += 12; else if (ap === 'am' && h === 12) h = 0;
  else if (!ap && h >= 1 && h <= 6) h += 12;   // "at 3" means 3 PM in business scheduling
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Resolve a day word to 'YYYY-MM-DD' (today / tomorrow / weekday = next occurrence / ISO / m/d / month day). */
function dayToIso(word, baseIso) {
  const s = String(word || '').trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1');
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (s === 'today') return baseIso;
  if (s === 'tomorrow') return addDays(baseIso, 1);
  const wd = WD.findIndex((d) => s === d || s === d.slice(0, 3) || (d === 'tuesday' && s === 'tues') || (d === 'thursday' && (s === 'thur' || s === 'thurs')));
  if (wd >= 0) { let delta = (wd - new Date(baseIso + 'T00:00:00Z').getUTCDay() + 7) % 7; if (delta === 0) delta = 7; return addDays(baseIso, delta); }
  const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  let m = s.match(/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})$/);
  let mo = null; let d = null;
  if (m) { mo = MON.indexOf(m[1]); d = +m[2]; } else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})$/))) { mo = +m[1] - 1; d = +m[2]; }
  if (mo === null) return null;
  const y = +baseIso.slice(0, 4); let iso = `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (iso < baseIso) iso = `${y + 1}${iso.slice(4)}`;
  return iso;
}

const DAY_RX = '(?:today|tomorrow|(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|sday|urday|rsday)?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}\\/\\d{1,2})';
const TIME_RX = '(\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)?|noon)';

/** The zone a text states its times in (Central unless it says otherwise): minutes to add to reach Central. */
function zoneShift(text) {
  const m = String(text || '').toLowerCase().match(/\b(eastern|mountain|pacific|central|e[sd]?t|m[sd]?t|p[sd]?t|c[sd]?t)\b/);
  return m ? (ZONE_SHIFT[m[1]] || 0) : 0;
}

/**
 * Times OFFERED in a text ("I can do Tuesday at 10, Wednesday at 2 PM or Thursday at 11:30"):
 * every "<day> [at] <time>" pair, converted to Central, de-duplicated, in order. Pure.
 */
function proposalsIn(text, baseIso) {
  const s = String(text || '');
  const shift = zoneShift(s);
  const rx = new RegExp(`\\b(${DAY_RX})(?:,)?\\s+(?:at\\s+|@\\s*)?${TIME_RX}(?!\\s*(?:minutes|min|hours|hrs)\\b)`, 'gi');
  const out = []; const seen = new Set();
  for (const m of s.matchAll(rx)) {
    const day = dayToIso(m[1].toLowerCase().replace(/\s+/g, ' '), baseIso); const t = timeToMin(m[2]);
    if (!day || t === null) continue;
    const startMs = toMs(at(day, t)) + shift * 60000; const start = fromMs(startMs);
    if (seen.has(start)) continue; seen.add(start);
    out.push({ start, said: m[0].trim().replace(/[.,;]+$/, '') });
  }
  return out;
}

/**
 * What Ed asked for. Pure.
 * @param text     Ed's words
 * @param meeting  the parsed meeting ({ date, start_time }) after the rule layer
 * @param proposalText  text the person sent offering times (their latest email), optional
 * @returns {{ kind: 'exact'|'window'|'options', ... } | null}
 */
function parseSpec(text, meeting = {}, baseIso, proposalText = '') {
  const own = proposalsIn(text, baseIso);
  if (own.length >= 2) return { kind: 'options', options: own, source: 'ed' };
  const t = String(text || '').toLowerCase();
  const part = (t.match(/\b(morning|afternoon|evening)\b/) || [])[1] || null;
  // A time Ed named outright ("at 3:30", "3 PM") makes it exact; a window word without one does not.
  const namedTime = /\b(?:at|@)\s*\d{1,2}(?::\d{2})?\b|\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b|\bnoon\b/i.test(text);
  // A time read from Ed's words ("tomorrow 4") is exact too, unless he used a window word.
  const windowWord = /\b(?:morning|afternoon|evening|sometime|anytime|any\s+time|next\s+week|this\s+week|later\s+this\s+week)\b/i.test(text);
  if (meeting.start_time && meeting.date && (namedTime || !windowWord)) {
    const day = dayToIso(meeting.date, baseIso); const m = timeToMin(meeting.start_time);
    if (day && m !== null) return { kind: 'exact', start: at(day, m) };
  }
  if (own.length === 1 && namedTime) return { kind: 'exact', start: own[0].start };
  const offered = proposalsIn(proposalText, baseIso);
  if (offered.length >= 1 && !namedTime) return { kind: 'options', options: offered, source: 'thread' };
  // Window: a day phrase and/or a part of day.
  let days = null;
  if (/\bnext\s+week\b/.test(t)) { const monday = addDays(baseIso, ((8 - new Date(baseIso + 'T00:00:00Z').getUTCDay()) % 7) || 7); days = [0, 1, 2, 3, 4].map((i) => addDays(monday, i)); }
  else if (/\b(?:this\s+week|sometime\s+this\s+week|later\s+this\s+week)\b/.test(t)) { days = []; for (let d = addDays(baseIso, 1); weekday(d) !== 'saturday' && weekday(d) !== 'sunday' && days.length < 5; d = addDays(d, 1)) days.push(d); if (!days.length) days = null; }
  else {
    const dw = t.match(new RegExp(`\\b(${DAY_RX})\\b`, 'i'));
    const d = dw ? dayToIso(dw[1], baseIso) : (meeting.date ? dayToIso(meeting.date, baseIso) : (part ? baseIso : null));
    if (d) days = [d];
  }
  if (!days) return null;
  const [from, to] = part ? PARTS[part] : ['00:00', '23:59'];
  return { kind: 'window', days, from, to, part };
}

/**
 * Decide the slot. Pure.
 * @param spec      parseSpec()
 * @param busy      [{ start, end, subject, source }] wall times, Central (Ed's events + Tessa's holds)
 * @param durationMinutes
 * @param workingHours { days, start, end } (Ed's, from Graph; DEFAULT_HOURS otherwise)
 * @param nowWall   current wall time, Central
 * @returns {{ status: 'ok'|'conflict'|'none', slot?: {start,end}, alternatives: {start,end}[], conflicts?: object[], reasons: string[] }}
 */
function pickSlot({ spec, busy = [], durationMinutes = 30, workingHours = DEFAULT_HOURS, nowWall, stepMinutes = 30, leadMinutes = 30, maxAlternatives = 3 }) {
  const wh = { ...DEFAULT_HOURS, ...(workingHours || {}) };
  const dur = Math.max(5, Number(durationMinutes) || 30);
  const earliest = toMs(nowWall) + leadMinutes * 60000;
  const endOf = (s) => fromMs(toMs(s) + dur * 60000);
  const clash = (s) => busy.filter((b) => overlaps(s, endOf(s), b.start, b.end));
  const free = (s) => toMs(s) >= earliest && clash(s).length === 0;
  const inHours = (s) => wh.days.includes(weekday(s.slice(0, 10))) && hm(s.slice(11, 16)) >= hm(wh.start) && hm(s.slice(11, 16)) + dur <= hm(wh.end);
  const slotsOn = (day, fromHm = wh.start, toHm = wh.end) => {
    if (!wh.days.includes(weekday(day))) return [];
    const lo = Math.max(hm(fromHm), hm(wh.start)); const hi = Math.min(hm(toHm), hm(wh.end));
    const out = []; for (let m = Math.ceil(lo / stepMinutes) * stepMinutes; m + dur <= hi; m += stepMinutes) out.push(at(day, m)); return out;
  };
  const ok = (s, reasons) => ({ status: 'ok', slot: { start: s, end: endOf(s) }, alternatives: [], reasons });
  // The nearest open slots to an anchor, inside working hours: the anchor's day first (closest in time), then the next business days.
  const alternativesNear = (anchor, { from, to } = {}) => {
    const out = []; const day0 = anchor.slice(0, 10);
    const sameDay = slotsOn(day0, from, to).filter((s) => free(s) && s !== anchor).sort((a, b) => Math.abs(toMs(a) - toMs(anchor)) - Math.abs(toMs(b) - toMs(anchor)));
    out.push(...sameDay.slice(0, maxAlternatives));
    for (let i = 1; out.length < maxAlternatives && i <= 10; i++) {
      const day = addDays(day0, i);
      const next = slotsOn(day, from, to).filter(free);
      if (next.length) out.push(next[0]);
    }
    return out.slice(0, maxAlternatives).sort().map((s) => ({ start: s, end: endOf(s) }));
  };
  if (!spec) return { status: 'none', alternatives: [], reasons: ['no time or window Tessa can read'] };
  if (spec.kind === 'exact') {
    if (toMs(spec.start) < earliest) return { status: 'conflict', alternatives: alternativesNear(spec.start), conflicts: [], reasons: ['the time Ed named has already passed'] };
    const c = clash(spec.start);
    if (!c.length) return ok(spec.start, ['the time Ed named is free' + (inHours(spec.start) ? '' : ' (outside his usual hours; his instruction stands)')]);
    return { status: 'conflict', conflicts: c, alternatives: alternativesNear(spec.start), reasons: [`Ed is busy then: ${c.map((b) => `"${b.subject}" ${b.start.slice(11, 16)}-${b.end.slice(11, 16)}`).join('; ')}`] };
  }
  if (spec.kind === 'options') {
    const sorted = [...spec.options].sort((a, b) => toMs(a.start) - toMs(b.start));
    const rejected = [];
    for (const o of sorted) {
      const c = clash(o.start);
      if (toMs(o.start) < earliest) { rejected.push(`${o.said}: already passed`); continue; }
      if (c.length) { rejected.push(`${o.said}: Ed is busy ("${c[0].subject}")`); continue; }
      return ok(o.start, [`the earliest offered time Ed is free for (${o.said})`, ...rejected]);
    }
    return { status: 'none', alternatives: alternativesNear(sorted[0].start), reasons: ['none of the offered times is open', ...rejected] };
  }
  // window
  for (const day of spec.days) {
    for (const s of slotsOn(day, spec.from, spec.to)) if (free(s)) return ok(s, [`the earliest open ${dur}-minute slot ${spec.part ? 'that ' + spec.part : 'that day'} on Ed's calendar`]);
  }
  const lastDay = spec.days[spec.days.length - 1];
  const alts = alternativesNear(at(addDays(lastDay, 1), hm(spec.from === '00:00' ? wh.start : spec.from)), { from: spec.from === '00:00' ? undefined : spec.from, to: spec.to === '23:59' ? undefined : spec.to });
  const fill = alts.length < maxAlternatives ? alternativesNear(at(addDays(lastDay, 1), hm(wh.start))) : [];
  const merged = [...alts, ...fill.filter((f) => !alts.some((a) => a.start === f.start))].slice(0, maxAlternatives);
  return { status: 'none', alternatives: merged, reasons: [`no open ${dur}-minute slot ${spec.part ? 'in the ' + spec.part : 'in that window'} on ${spec.days.join(', ')}`] };
}

/** "Friday, October 9 at 2:00 PM" for a wall time. Pure. */
function labelOf(wallStart) {
  const ms = toMs(wallStart); const d = new Date(ms);
  const day = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const h = d.getUTCHours(); const m = d.getUTCMinutes();
  return `${day} at ${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

module.exports = { parseSpec, pickSlot, proposalsIn, dayToIso, timeToMin, zoneShift, labelOf, overlaps, DEFAULT_HOURS, PARTS };
