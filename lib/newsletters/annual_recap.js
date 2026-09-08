// ============================================================================
// lib/newsletters/annual_recap.js  (Ed 2026-09-07)
// ----------------------------------------------------------------------------
// The annual YEAR-IN-REVIEW recap for the annual meeting. Reads the SAME ledgers
// the monthly newsletter reads — the key-events timeline (community_key_events),
// the year's proof-of-work numbers, and the projects completed — over a full
// year, and assembles a recap. "Here's everything the community and its board
// got done this year," without anyone reconstructing it from memory.
//
// Output is newsletter SECTIONS (reusing the existing render/section types), so
// a recap looks and prints like a polished issue. (See project_community_key_events.)
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const { listKeyEvents } = require('../events/key_events');

async function countIn(supabase, table, communityId, dateCol, from, to) {
  try {
    const { count, error } = await supabase.from(table).select('id', { count: 'exact', head: true })
      .eq('community_id', communityId).gte(dateCol, from).lt(dateCol, to);
    if (error) return 0;
    return count || 0;
  } catch (_) { return 0; }
}

const CAT_LABEL = { governance: 'Governance', security: 'Security', project: 'Projects', financial: 'Financial', event: 'Community Events', amenity: 'Amenities', maintenance: 'Maintenance', community: 'Community', update: 'Updates' };

async function buildAnnualRecapSections({ supabase, communityId, year, communityName }) {
  const from = `${year}-01-01`, to = `${Number(year) + 1}-01-01`;
  const [acc, requests, messages, keyEvents, projRes] = await Promise.all([
    countIn(supabase, 'acc_decisions', communityId, 'created_at', from, to),
    countIn(supabase, 'work_items', communityId, 'created_at', from, to),
    countIn(supabase, 'email_messages', communityId, 'created_at', from, to),
    listKeyEvents(supabase, communityId, { from, to }),
    supabase.from('vendor_projects').select('title, completed_at').eq('community_id', communityId).gte('completed_at', from).lt('completed_at', to).limit(50),
  ]);
  const projectsDone = (projRes.data || []).map((p) => ({ name: p.title || 'Community project', status: 'Complete', done: true }));

  // AI year-narrative — grounded ONLY in the supplied facts (never invents).
  let narrative = '';
  try {
    const factLine = `ACC decisions: ${acc}; homeowner requests handled: ${requests}; resident messages handled: ${messages}; projects completed: ${projectsDone.length}; key events: ${keyEvents.slice(0, 20).map((e) => e.title).join('; ') || 'none logged'}.`;
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 500,
      system: `You are Phoebe Hart, writing a warm, proud "Year in Review" opening for an HOA community's annual meeting. Use ONLY the supplied facts; never invent a number, name, or event. 2 short paragraphs, ~90-130 words, warm and appreciative of the community and board. Return plain text only.`,
      messages: [{ role: 'user', content: `Community: ${communityName}. Year: ${year}. Facts: ${factLine}\n\nWrite the opening.` }],
    });
    narrative = (resp.content || []).map((c) => c.text || '').join('').trim();
  } catch (e) { console.warn('[annual_recap] narrative:', e.message); }

  const stats = [];
  if (acc) stats.push({ value: acc, label: 'Architectural requests reviewed' });
  if (requests) stats.push({ value: requests, label: 'Homeowner requests handled' });
  if (messages) stats.push({ value: messages, label: 'Resident messages handled' });
  if (projectsDone.length) stats.push({ value: projectsDone.length, label: 'Projects completed' });

  // group key events by category for a scannable "the year in developments"
  const byCat = {};
  for (const e of keyEvents) { const c = e.category || 'update'; (byCat[c] = byCat[c] || []).push(e); }

  const sections = [];
  sections.push({ section_type: 'cover', title: `${communityName}`, subtitle: `${year} Year in Review`, body_json: { tagline: `A look back at everything ${communityName} accomplished together in ${year}.`, month: `${year} Year in Review` }, ai_generated: false, source_metadata: { source: 'annual_recap' } });
  if (narrative) sections.push({ section_type: 'custom_article', title: `${year} in Review`, body_json: { markdown: narrative }, ai_generated: true, needs_review: true, source_metadata: { source: 'annual_recap' } });
  if (stats.length) sections.push({ section_type: 'community_numbers', title: `${communityName} — ${year} By the Numbers`, subtitle: year, body_json: { stats, period: String(year) }, ai_generated: false, source_metadata: { source: 'annual_recap' } });
  if (projectsDone.length) sections.push({ section_type: 'project_watch', title: `Projects Completed in ${year}`, body_json: { projects: projectsDone }, ai_generated: false, source_metadata: { source: 'annual_recap' } });
  if (keyEvents.length) {
    sections.push({ section_type: 'key_events', title: `${year} in the Community`, body_json: { events: keyEvents.map((e) => ({ date: e.event_date, date_label: new Date(e.event_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), title: e.title, summary: e.summary, category: e.category })) }, ai_generated: false, source_metadata: { source: 'annual_recap', categories: Object.keys(byCat) } });
  }
  return { sections, notes: [`${keyEvents.length} key event(s), ${projectsDone.length} project(s) completed in ${year}.`] };
}

module.exports = { buildAnnualRecapSections };
