// ============================================================================
// lib/events/detect_events.js  (Ed 2026-09-07)
// ----------------------------------------------------------------------------
// Phoebe's job: read the community's email and turn COMMUNITY-WIDE events into
// calendar entries automatically, so nothing announced to residents falls
// through the cracks and the newsletter always knows what's coming up.
//
// Manual today: a garage-sale "Save the Date" email goes out, and someone has
// to read it and type the event onto the calendar by hand. This does that step
// for them — extract the event, put it on the calendar as Phoebe, and it flows
// into the newsletter's Looking Ahead automatically.
//
// Two-stage discipline (CLAUDE.md): EXTRACT structured events from messy email
// text, VALIDATE (community-wide only, real date, not a duplicate), then write.
// Guardrails: private amenity reservations and individual matters are NEVER
// events; everything is Phoebe-authored and visible so staff can remove a miss.
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Cheap pre-filter so we only spend an AI call on emails that plausibly carry an
// event. Broad on purpose; the model makes the real call.
const EVENT_HINT = /\b(save the date|garage sale|yard sale|community (event|garage)|food truck|movie night|pool party|festival|fun run|5k|clean[\s-]?up|blood drive|drive\b|meeting|celebration|gathering|rsvp|holiday|parade|egg hunt|trunk or treat|block party|social\b|mixer|open house|ceremony|picnic|bbq|potluck|market|concert|fireworks|santa|tree lighting)\b/i;

const PHOEBE = 'Phoebe Hart';

function normTitle(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

// Pull recent community emails that might announce an event.
async function fetchCandidates(supabase, communityId, sinceDays) {
  const since = new Date(Date.now() - sinceDays * 864e5).toISOString();
  const { data, error } = await supabase.from('email_messages')
    .select('id, subject, body_preview, ai_summary, received_at, sent_at')
    .eq('community_id', communityId)
    .or(`received_at.gte.${since},sent_at.gte.${since}`)
    .order('received_at', { ascending: false })
    .limit(300);
  if (error) throw error;
  // De-dup by subject (auto-replies repeat the same announcement subject) and
  // keep only event-hinting ones.
  const seen = new Set();
  const out = [];
  for (const m of data || []) {
    const key = normTitle(m.subject).replace(/^(automatic reply|re|fw|fwd)\s*/i, '');
    const text = `${m.subject || ''} ${m.ai_summary || ''} ${m.body_preview || ''}`;
    if (!EVENT_HINT.test(text)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: m.id, subject: m.subject || '', summary: m.ai_summary || '', preview: (m.body_preview || '').slice(0, 400), when: m.received_at || m.sent_at });
  }
  return out;
}

// One AI call over all candidates → structured events. The model decides what
// is a real, community-WIDE, dated event and returns absolute dates.
async function extractEvents(candidates, refDateISO) {
  if (!candidates.length) return [];
  const sys = `You extract COMMUNITY-WIDE events from HOA community emails for a neighborhood calendar.
Rules:
- Only events open to the whole community (garage sale, meeting, festival, movie night, cleanup, holiday event, food truck, etc.).
- NEVER include a private amenity/clubhouse/pool RESERVATION by one resident, an individual complaint, a violation, an account matter, or an out-of-office reply.
- Only include an event if you can determine a specific calendar DATE. Convert relative wording to an absolute date using the reference date. Return dates as YYYY-MM-DD.
- Times as 24h HH:MM if given, else null. Location as text if given, else null.
- If nothing qualifies, return an empty events array.`;
  const lines = candidates.map((c, i) => `[${i}] subject: ${c.subject}\n    summary: ${c.summary}\n    preview: ${c.preview}\n    email_date: ${c.when}`).join('\n');
  const user = `Reference date (today): ${refDateISO}.\nEmails:\n${lines}\n\nReturn the community events found across these emails.`;
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 1500, system: sys,
      tools: [{
        name: 'community_events',
        description: 'Community-wide events extracted from the emails.',
        input_schema: {
          type: 'object',
          properties: {
            events: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  source_index: { type: 'integer' },
                  title: { type: 'string' },
                  date: { type: 'string', description: 'YYYY-MM-DD' },
                  end_date: { type: 'string', description: 'YYYY-MM-DD or empty' },
                  start_time: { type: 'string', description: 'HH:MM 24h or empty' },
                  end_time: { type: 'string', description: 'HH:MM 24h or empty' },
                  location: { type: 'string' },
                  community_wide: { type: 'boolean' },
                  confidence: { type: 'string', description: 'high|medium|low' },
                },
                required: ['title', 'date', 'community_wide'],
              },
            },
          },
          required: ['events'],
        },
      }],
      tool_choice: { type: 'tool', name: 'community_events' },
      messages: [{ role: 'user', content: user }],
    });
    const tu = (resp.content || []).find((c) => c.type === 'tool_use');
    const evs = (tu && tu.input && tu.input.events) || [];
    return evs.filter((e) => e && e.community_wide && e.title && /^\d{4}-\d{2}-\d{2}$/.test(e.date || ''));
  } catch (e) {
    console.warn('[detect_events] AI extract failed:', e.message);
    return [];
  }
}

// Is this event already on the calendar? Same community + date + close title.
async function existsOnCalendar(supabase, communityId, ev) {
  const { data } = await supabase.from('calendar_events')
    .select('id, title').eq('community_id', communityId).eq('start_date', ev.date).limit(20);
  const n = normTitle(ev.title);
  return (data || []).some((r) => { const rn = normTitle(r.title); return rn === n || rn.includes(n) || n.includes(rn); });
}

/**
 * Scan a community's email for community-wide events and add the new ones to the
 * calendar as Phoebe. Returns { added, skipped, candidates_scanned }.
 */
async function scanCommunityEvents({ supabase, communityId, sinceDays = 150, dryRun = false }) {
  const candidates = await fetchCandidates(supabase, communityId, sinceDays);
  const refDate = new Date().toISOString().slice(0, 10);
  const events = await extractEvents(candidates, refDate);
  const added = [];
  const skipped = [];
  for (const ev of events) {
    // Only future-ish events matter for a calendar/newsletter (allow a small past window).
    if (ev.date < new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10)) { skipped.push({ ...ev, reason: 'past' }); continue; }
    if (await existsOnCalendar(supabase, communityId, ev)) { skipped.push({ ...ev, reason: 'already on calendar' }); continue; }
    if (dryRun) { added.push({ ...ev, dryRun: true }); continue; }
    const row = {
      community_id: communityId, event_type: 'staff_event', title: ev.title.slice(0, 200),
      start_date: ev.date, end_date: ev.end_date && /^\d{4}-\d{2}-\d{2}$/.test(ev.end_date) ? ev.end_date : ev.date,
      all_day: !ev.start_time,
      start_time: ev.start_time && /^\d{2}:\d{2}/.test(ev.start_time) ? ev.start_time : null,
      end_time: ev.end_time && /^\d{2}:\d{2}/.test(ev.end_time) ? ev.end_time : null,
      staff_name: PHOEBE, created_by_name: PHOEBE,
      notes: `Added by Phoebe from a community email${ev.location ? ' · ' + ev.location : ''}. Review before it goes out.`,
    };
    const { data, error } = await supabase.from('calendar_events').insert(row).select('id').single();
    if (error) { skipped.push({ ...ev, reason: 'insert failed: ' + error.message }); continue; }
    added.push({ id: data.id, title: ev.title, date: ev.date, start_time: row.start_time, location: ev.location || null, confidence: ev.confidence || null });
  }
  return { added, skipped, candidates_scanned: candidates.length };
}

module.exports = { scanCommunityEvents, extractEvents, fetchCandidates };
