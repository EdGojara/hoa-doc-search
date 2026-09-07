// ============================================================================
// lib/events/key_events.js  (Ed 2026-09-07)
// ----------------------------------------------------------------------------
// The community KEY-EVENTS ledger (community_key_events, migration 412). The
// significant things that happened in a community — a security-provider change,
// a completed project, a board decision, a community event, a milestone —
// captured from the community's email and platform data, so the platform
// REMEMBERS the year. Feeds the newsletter's "This Month at <Community>" and the
// annual year-in-review recap. Institutional memory, per community, per month.
//
// Guardrail: community-LEVEL developments only. Never an individual's private
// matter, a complaint, a dispute, an account, or an enforcement action against a
// person. AI-captured rows land 'active' and staff can hide a miss.
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CATEGORIES = ['governance', 'security', 'project', 'financial', 'event', 'amenity', 'maintenance', 'community', 'update'];
function normTitle(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

// List key events for a period (a month for the newsletter, a year for the recap).
async function listKeyEvents(supabase, communityId, { from, to } = {}) {
  let q = supabase.from('community_key_events').select('*')
    .eq('community_id', communityId).eq('status', 'active').order('event_date', { ascending: false });
  if (from) q = q.gte('event_date', from);
  if (to) q = q.lt('event_date', to);
  const { data, error } = await q;
  if (error) { console.warn('[key_events] list:', error.message); return []; }
  return data || [];
}

// One AI pass over recent community email → notable, community-wide developments.
async function extractKeyEvents(candidates, refDate) {
  if (!candidates.length) return [];
  const sys = `You maintain a community's KEY-EVENTS timeline for an HOA. From the community's recent email, extract the SIGNIFICANT, community-WIDE developments a resident would want on a year-in-review: a security or vendor change, a completed or launched project, a board decision, a community event, a policy or fee change, an amenity change, a milestone.
Rules:
- Community-LEVEL only. NEVER an individual's private matter, a single homeowner's complaint/violation/account, or an out-of-office reply.
- Skip routine noise (invoices, auto-replies, one-off questions).
- Give each an absolute date (YYYY-MM-DD) using the reference date for anything relative.
- category is one of: ${CATEGORIES.join(', ')}. impact is minor | normal | major.
- Only include something you're confident is a real, notable development.`;
  const lines = candidates.map((c, i) => `[${i}] (${c.when}) ${c.subject}\n    ${c.summary}`).join('\n');
  const user = `Reference date: ${refDate}.\nRecent community email:\n${lines}\n\nReturn the key events.`;
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 1600, system: sys,
      tools: [{
        name: 'key_events', description: 'Notable community-wide developments.',
        input_schema: { type: 'object', properties: { events: { type: 'array', items: { type: 'object', properties: {
          title: { type: 'string' }, summary: { type: 'string' }, date: { type: 'string' },
          category: { type: 'string' }, impact: { type: 'string' },
        }, required: ['title', 'date', 'category'] } } }, required: ['events'] },
      }],
      tool_choice: { type: 'tool', name: 'key_events' },
      messages: [{ role: 'user', content: user }],
    });
    const tu = (resp.content || []).find((c) => c.type === 'tool_use');
    return ((tu && tu.input && tu.input.events) || []).filter((e) => e && e.title && /^\d{4}-\d{2}-\d{2}$/.test(e.date || ''));
  } catch (e) { console.warn('[key_events] AI:', e.message); return []; }
}

// Scan the community's email and record the new key events. Returns { added, skipped }.
async function captureKeyEvents({ supabase, communityId, sinceDays = 120 }) {
  const since = new Date(Date.now() - sinceDays * 864e5).toISOString();
  let emails = [];
  try {
    const { data, error } = await supabase.from('email_messages')
      .select('subject, ai_summary, received_at, sent_at')
      .eq('community_id', communityId).or(`received_at.gte.${since},sent_at.gte.${since}`)
      .order('received_at', { ascending: false }).limit(300);
    if (error) throw error;
    emails = (data || []).filter((m) => m.subject && !/^(automatic reply|out of office)/i.test(m.subject));
  } catch (e) { console.warn('[key_events] emails:', e.message); return { added: [], skipped: [], error: e.message }; }
  const candidates = emails.map((m) => ({ subject: (m.subject || '').slice(0, 120), summary: (m.ai_summary || '').slice(0, 160), when: (m.received_at || m.sent_at || '').slice(0, 10) }));
  const events = await extractKeyEvents(candidates, new Date().toISOString().slice(0, 10));

  // existing events (dedupe by date + title)
  const { data: existing } = await supabase.from('community_key_events').select('event_date, title').eq('community_id', communityId).limit(1000);
  const seen = new Set((existing || []).map((e) => `${e.event_date}|${normTitle(e.title)}`));
  const added = [], skipped = [];
  for (const e of events) {
    const key = `${e.date}|${normTitle(e.title)}`;
    if (seen.has(key)) { skipped.push({ ...e, reason: 'exists' }); continue; }
    const category = CATEGORIES.includes(e.category) ? e.category : 'update';
    const impact = ['minor', 'normal', 'major'].includes(e.impact) ? e.impact : 'normal';
    const { data, error } = await supabase.from('community_key_events').insert({
      community_id: communityId, event_date: e.date, title: String(e.title).slice(0, 200),
      summary: e.summary || null, category, impact, source: 'ai', created_by: 'Phoebe Hart',
    }).select('id').single();
    if (error) { skipped.push({ ...e, reason: error.message }); continue; }
    seen.add(key);
    added.push({ id: data.id, title: e.title, date: e.date, category, impact });
  }
  return { added, skipped };
}

module.exports = { listKeyEvents, captureKeyEvents, extractKeyEvents, CATEGORIES };
