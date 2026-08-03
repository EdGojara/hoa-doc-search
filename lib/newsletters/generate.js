// ============================================================================
// lib/newsletters/generate.js  (Ed 2026-08-03)
// ----------------------------------------------------------------------------
// Assemble a newsletter DRAFT from data already in the platform. Two-stage
// discipline (CLAUDE.md): DATA sections (events, contacts, links, cover) are
// built deterministically from the DB — the AI NEVER invents a date, time,
// fee, name, or link. The model writes ONLY editorial prose (a board message
// and an HOA Corner article) grounded in the supplied facts, and flags missing
// info with [STAFF REVIEW REQUIRED]. Everything is a DRAFT a human approves.
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function monthBounds(isoMonth) {
  const start = `${isoMonth}-01`;
  const d = new Date(start + 'T12:00:00');
  const next = new Date(d); next.setMonth(next.getMonth() + 1);
  const nn = new Date(next); nn.setMonth(nn.getMonth() + 1);
  const iso = (x) => x.toISOString().slice(0, 10);
  return { start, nextStart: iso(next), nextEnd: iso(nn) };
}
function monthLabel(isoMonth) {
  try { return new Date(isoMonth + '-01T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); }
  catch (_) { return isoMonth; }
}
function fmtDate(dateStr) {
  try { return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }); }
  catch (_) { return dateStr; }
}
function seasonOf(isoMonth) {
  const m = parseInt(String(isoMonth).slice(5, 7), 10);
  if (m === 12 || m <= 2) return 'winter';
  if (m <= 5) return 'spring';
  if (m <= 8) return 'summer';
  return 'fall';
}

// Pull the month's events from the same canonical sources the Bedrock Calendar
// aggregates: native calendar_events, scheduled meetings, amenity reservations.
async function gatherEvents(supabase, communityId, from, to) {
  const out = [];
  try {
    const { data, error } = await supabase.from('meeting_agendas')
      .select('meeting_date, meeting_type, meeting_time, title, location')
      .eq('community_id', communityId).not('meeting_date', 'is', null)
      .gte('meeting_date', from).lt('meeting_date', to).order('meeting_date');
    if (error) throw error;
    for (const m of data || []) {
      const typ = String(m.meeting_type || 'regular');
      out.push({ date: m.meeting_date, time: m.meeting_time || null, location: m.location || null,
        title: m.title || `${typ.charAt(0).toUpperCase() + typ.slice(1)} Meeting`, kind: 'meeting' });
    }
  } catch (e) { console.warn('[newsletter.gather] meetings:', e.message); }
  try {
    const { data, error } = await supabase.from('amenity_rentals')
      .select('event_date, arrival_time, event_description, renter_name, status, amenities(name)')
      .eq('community_id', communityId).not('event_date', 'is', null)
      .gte('event_date', from).lt('event_date', to)
      .not('status', 'in', '(cancelled,refunded,draft)').order('event_date');
    if (error) throw error;
    for (const r of data || []) {
      out.push({ date: r.event_date, time: r.arrival_time || null,
        location: (r.amenities && r.amenities.name) || null,
        title: r.event_description || `${(r.amenities && r.amenities.name) || 'Amenity'} reservation`, kind: 'reservation' });
    }
  } catch (e) { console.warn('[newsletter.gather] rentals:', e.message); }
  try {
    const { data, error } = await supabase.from('calendar_events')
      .select('start_date, start_time, title, event_type, community_id')
      .eq('community_id', communityId).eq('event_type', 'staff_event')
      .gte('start_date', from).lt('start_date', to).order('start_date');
    if (error) throw error;
    for (const c of data || []) out.push({ date: c.start_date, time: c.start_time || null, location: null, title: c.title, kind: 'event' });
  } catch (e) { console.warn('[newsletter.gather] calendar_events:', e.message); }
  out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return out;
}

// The single most common open-violation topic this quarter — used only to
// SUGGEST an HOA Corner article topic (not a published statistic), so a rough
// per-category count is acceptable here.
async function topViolationTopic(supabase, communityId) {
  try {
    const since = new Date(); since.setMonth(since.getMonth() - 3);
    const { data, error } = await supabase.from('violations')
      .select('primary_category_id, enforcement_categories(label)')
      .eq('community_id', communityId).gte('opened_at', since.toISOString()).limit(2000);
    if (error) throw error;
    const counts = {};
    for (const v of data || []) {
      const label = v.enforcement_categories && v.enforcement_categories.label;
      if (label) counts[label] = (counts[label] || 0) + 1;
    }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return top ? { label: top[0], count: top[1] } : null;
  } catch (e) { console.warn('[newsletter.gather] topics:', e.message); return null; }
}

async function generateNewsletterDraft({ supabase, communityId, issueMonth, formatKey }) {
  const notes = [];
  const { start, nextStart, nextEnd } = monthBounds(issueMonth);

  // --- Gather canonical data --------------------------------------------------
  let community = { name: 'Your Community' };
  try {
    const { data, error } = await supabase.from('communities').select('id, name, slug, profile, logo_storage_path').eq('id', communityId).maybeSingle();
    if (error) throw error;
    if (data) community = data;
  } catch (e) { console.warn('[newsletter.gather] community:', e.message); }

  let logoUrl = null;
  try {
    if (community.logo_storage_path) {
      const { data: signed } = await supabase.storage.from('documents').createSignedUrl(community.logo_storage_path, 60 * 60 * 24 * 365);
      if (signed && signed.signedUrl) logoUrl = signed.signedUrl;
    }
  } catch (e) { console.warn('[newsletter.gather] logo:', e.message); }

  const thisMonthEvents = await gatherEvents(supabase, communityId, start, nextStart);
  const nextMonthEvents = await gatherEvents(supabase, communityId, nextStart, nextEnd);

  let board = [];
  try {
    const { data, error } = await supabase.from('board_members')
      .select('name, position, email').eq('community_name', community.name).neq('is_active', false).limit(50);
    if (error) throw error;
    board = data || [];
  } catch (e) { console.warn('[newsletter.gather] board:', e.message); }

  let contacts = [];
  try {
    const { data, error } = await supabase.from('community_contacts')
      .select('category, name, phone, email, url, display_order').eq('community_id', communityId).eq('is_published', true)
      .order('display_order', { ascending: true }).limit(100);
    if (error) throw error;
    contacts = data || [];
  } catch (e) { console.warn('[newsletter.gather] contacts:', e.message); }

  let coverImageUrl = null;
  try {
    const { data, error } = await supabase.from('community_photos')
      .select('storage_bucket, storage_path, role, sort_order, active').eq('community_id', communityId).neq('active', false)
      .order('sort_order', { ascending: true }).limit(50);
    if (error) throw error;
    const photos = data || [];
    const hero = photos.find((p) => p.role === 'hero') || photos[0];
    if (hero && hero.storage_path) {
      const { data: signed } = await supabase.storage.from(hero.storage_bucket || 'documents').createSignedUrl(hero.storage_path, 60 * 60 * 24 * 7);
      if (signed && signed.signedUrl) coverImageUrl = signed.signedUrl;
    }
  } catch (e) { console.warn('[newsletter.gather] cover:', e.message); }

  const topic = await topViolationTopic(supabase, communityId);

  notes.push(`${thisMonthEvents.length} event(s) in ${monthLabel(issueMonth)}, ${nextMonthEvents.length} upcoming next month.`);
  notes.push(board.length ? `${board.length} board member(s) on file.` : 'No board members on file — add them in Board Members.');
  if (topic) notes.push(`Top resident topic this quarter: ${topic.label} (${topic.count}).`);
  if (!coverImageUrl) notes.push('No community photo found — add a hero photo in Community Photos for the cover.');

  // --- AI editorial prose (board message + HOA Corner only) -------------------
  const label = monthLabel(issueMonth);
  let ai = { intro: '', board_message: '', hoa_title: '', hoa_body: '' };
  try {
    const season = seasonOf(issueMonth);
    const facts = {
      community: community.name, month: label, season,
      board_positions: board.map((b) => ({ name: b.name, position: b.position })),
      event_titles_this_month: thisMonthEvents.map((e) => e.title),
      hoa_corner_topic: topic ? topic.label : null,
      office_hours: (community.profile && community.profile.office_hours) || null,
    };
    const sys = `You are the editorial assistant for Bedrock Association Management writing a friendly community newsletter for homeowners.
Rules:
- For anything COMMUNITY-SPECIFIC (dates, times, fees, names, links, statistics), use ONLY the supplied facts and NEVER invent them; write [STAFF REVIEW REQUIRED] if missing.
- The seasonal article, recipe, this-month-in-history, and lighter-side pieces are GENERAL-INTEREST content — you may use common general knowledge. Keep recipes simple, safe, common, and family-friendly. For history/birthdays use only well-known, widely verifiable facts and if unsure, leave it out. The lighter-side item is a short, wholesome, PG, self-aware bit of HOA humor (a gentle joke or light anecdote) — never mock real people, homeowners, or the association, and never make light of enforcement, safety, or money.
- Warm, welcoming, service-oriented tone. Write for homeowners, not HOA professionals.
- Do NOT describe covenant enforcement in an aggressive tone; HOA Corner is educational and neighborly.
- No legal conclusions or promises.
- Do NOT begin any body with a markdown heading that repeats the section title (each section already has its own title). Start with the message/article text directly.
- Return STRICT JSON only, matching the schema. Board message ~90-140 words; HOA Corner ~150-230 words; seasonal article ~120-180 words; recipe body as markdown with an **Ingredients** bullet list and **Steps** numbered list.`;
    const user = `Facts (JSON):\n${JSON.stringify(facts)}\n\nIt is ${season}. Produce JSON with keys:
{
  "intro": "one warm sentence for the cover/intro (<= 25 words)",
  "board_message": "a short message from the board for ${label} (markdown ok)",
  "hoa_title": "a friendly title for an HOA Corner educational article${topic ? ' about ' + topic.label : ''}",
  "hoa_body": "the HOA Corner article body (markdown ok), educational and neighborly",
  "seasonal_title": "a fun, interesting ${season} community-life title (e.g. ${season} activities, safety, or neighborhood ideas)",
  "seasonal_body": "a warm, interesting ${season} general-interest article for neighbors (markdown ok)",
  "recipe_title": "a simple, crowd-pleasing ${season} recipe name",
  "recipe_body": "the recipe in markdown: a one-line intro, then **Ingredients** as a bullet list, then **Steps** as a numbered list",
  "history_title": "a fun title for a 'This Month in History' item for the month of ${label.split(' ')[0]}",
  "history_body": "3-5 short, well-known notable events and/or famous birthdays that fall in the calendar month of ${label.split(' ')[0]} (markdown bullet list, each 'Month Day — fact'). Only widely verifiable facts.",
  "lighter_title": "a light, friendly title for an 'On the Lighter Side' item",
  "lighter_body": "a short, wholesome, PG bit of gentle HOA humor — a light joke or fictional anecdote (2-5 sentences). Never mock real people or make light of enforcement/safety/money."
}
If hoa_corner_topic is null, choose a generally useful seasonal HOA Corner topic and still follow all rules.`;
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 6000,
      system: sys, messages: [{ role: 'user', content: user }],
    });
    const text = (resp.content || []).map((c) => c.text || '').join('').replace(/```json\s*|```/g, '');
    if (resp.stop_reason === 'max_tokens') console.warn('[newsletter.generate] hit max_tokens — output may be truncated');
    const jsonStart = text.indexOf('{'); const jsonEnd = text.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
      ai = {
        intro: parsed.intro || '', board_message: parsed.board_message || '',
        hoa_title: parsed.hoa_title || 'HOA Corner', hoa_body: parsed.hoa_body || '',
        seasonal_title: parsed.seasonal_title || '', seasonal_body: parsed.seasonal_body || '',
        recipe_title: parsed.recipe_title || '', recipe_body: parsed.recipe_body || '',
        history_title: parsed.history_title || '', history_body: parsed.history_body || '',
        lighter_title: parsed.lighter_title || '', lighter_body: parsed.lighter_body || '',
      };
    }
  } catch (e) {
    console.warn('[newsletter.generate] AI draft failed, using data-only draft:', e.message);
    notes.push('AI editorial draft unavailable — the board message and HOA Corner are placeholders for staff to write.');
  }

  // --- Assemble sections ------------------------------------------------------
  const sections = [];

  sections.push({
    section_type: 'cover', title: `${community.name}`, subtitle: label,
    image_url: coverImageUrl,
    body_json: { tagline: ai.intro || `Your ${label} community update`, month: label, logo_url: logoUrl },
    ai_generated: !!ai.intro, source_metadata: { source: 'community' },
  });

  sections.push({
    section_type: 'board_message', title: 'A Message from the Board',
    body_json: { markdown: ai.board_message || '[STAFF REVIEW REQUIRED] Add a short message from the board.' },
    ai_generated: !!ai.board_message, needs_review: true, source_metadata: { source: 'board_members' },
  });

  if (thisMonthEvents.length) {
    sections.push({
      section_type: 'event_grid', title: `${label} Events`,
      body_json: { events: thisMonthEvents.map((e) => ({
        title: e.title, date: e.date, date_label: fmtDate(e.date), time: e.time || null, location: e.location || null,
      })) },
      ai_generated: false, source_metadata: { source: 'calendar', count: thisMonthEvents.length },
    });
  } else {
    notes.push('No events this month — the events section was left out. Add events to the Calendar and regenerate, or add one manually.');
  }

  sections.push({
    section_type: 'hoa_corner', title: ai.hoa_title || 'HOA Corner',
    body_json: { markdown: ai.hoa_body || '[STAFF REVIEW REQUIRED] Write a short educational article for residents.' },
    ai_generated: !!ai.hoa_body, needs_review: true,
    source_metadata: { source: 'violation_trends', topic: topic ? topic.label : null },
  });

  // Seasonal general-interest article + a seasonal recipe (Ed 2026-08: make the
  // newsletter interesting, not just operational). AI general knowledge — review.
  if (ai.seasonal_body) {
    sections.push({
      section_type: 'custom_article', title: ai.seasonal_title || `${seasonOf(issueMonth).replace(/^./, (c) => c.toUpperCase())} in the Neighborhood`,
      body_json: { markdown: ai.seasonal_body },
      ai_generated: true, needs_review: true, source_metadata: { source: 'seasonal' },
    });
  }
  if (ai.recipe_body) {
    sections.push({
      section_type: 'recipe', title: ai.recipe_title || 'Neighborhood Recipe',
      body_json: { markdown: ai.recipe_body },
      ai_generated: true, needs_review: true, source_metadata: { source: 'seasonal_recipe' },
    });
  }
  if (ai.history_body) {
    sections.push({
      section_type: 'custom_article', title: ai.history_title || `This Month in History`,
      body_json: { markdown: ai.history_body },
      ai_generated: true, needs_review: true, source_metadata: { source: 'this_month_history' },
    });
  }
  if (ai.lighter_body) {
    sections.push({
      section_type: 'custom_article', title: ai.lighter_title || 'On the Lighter Side',
      body_json: { markdown: ai.lighter_body },
      ai_generated: true, needs_review: true, source_metadata: { source: 'lighter_side' },
    });
  }

  if (nextMonthEvents.length) {
    sections.push({
      section_type: 'calendar', title: 'Looking Ahead',
      body_json: { events: nextMonthEvents.map((e) => ({ title: e.title, date: e.date, date_label: fmtDate(e.date), time: e.time || null })) },
      ai_generated: false, source_metadata: { source: 'calendar', count: nextMonthEvents.length },
    });
  }

  if (board.length) {
    sections.push({
      section_type: 'community_contacts', title: 'Your Board',
      // Names + positions only — board emails left off for privacy (Ed 2026-08).
      body_json: { groups: [{ name: 'Board of Directors', items: board.map((b) => ({ label: `${b.name}${b.position ? ' — ' + b.position : ''}` })) }] },
      ai_generated: false, source_metadata: { source: 'board_members' },
    });
  }

  if (contacts.length) {
    const groups = {};
    for (const c of contacts) {
      const cat = c.category || 'General';
      (groups[cat] = groups[cat] || []).push({ label: c.name, phone: c.phone || null, email: c.email || null, url: c.url || null });
    }
    sections.push({
      section_type: 'community_contacts', title: 'Important Contacts',
      body_json: { groups: Object.entries(groups).map(([name, items]) => ({ name, items })) },
      ai_generated: false, source_metadata: { source: 'community_contacts' },
    });
  }

  // Important links — resident portal + management. Always present.
  const links = [
    { label: 'Resident Portal', url: community.slug ? `/portal.html?community=${community.slug}` : '/portal.html' },
    { label: 'Bedrock Association Management', url: 'https://www.bedrocktx.com' },
  ];
  sections.push({
    section_type: 'important_links', title: 'Stay Connected',
    body_json: { links, note: 'Questions? Reach us at info@bedrocktx.com or 832-588-2485.' },
    ai_generated: false, source_metadata: { source: 'portal_config' },
  });

  return {
    title: `${community.name} — ${label}`,
    introduction: ai.intro || null,
    cover_image_url: coverImageUrl,
    sections, notes,
  };
}

module.exports = { generateNewsletterDraft };
