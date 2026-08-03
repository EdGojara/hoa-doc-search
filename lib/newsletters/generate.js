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
const crypto = require('crypto');
let OpenAI = null; try { OpenAI = require('openai'); } catch (_) {}

// Generate one image with OpenAI and host it; returns a long-lived URL or null.
// Best-effort — a failure never blocks the draft. Brand-safe prompt wrapper.
async function genImageUrl(supabase, prompt, style) {
  if (!process.env.OPENAI_API_KEY || !OpenAI) return null;
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const safe = style === 'photo'
      ? `A realistic, high-quality photograph for a community newsletter: ${prompt}. Natural lighting, warm, welcoming, family-friendly. Do NOT include real brand names, logos, trademarks, or readable text.`
      : `A warm, friendly flat modern illustration for a community newsletter: ${prompt}. Bright, welcoming, inclusive, family-friendly. Do NOT include real brand names, logos, trademarks, mascots, or readable text.`;
    const res = await openai.images.generate({ model: 'gpt-image-1', prompt: safe, size: '1536x1024', n: 1 });
    const b64 = res && res.data && res.data[0] && res.data[0].b64_json;
    if (!b64) return null;
    const path = `newsletters/images/gen-${crypto.randomUUID()}.png`;
    const { error } = await supabase.storage.from('documents').upload(path, Buffer.from(b64, 'base64'), { contentType: 'image/png', upsert: false });
    if (error) { console.warn('[newsletter.genImage] upload:', error.message); return null; }
    const { data: signed } = await supabase.storage.from('documents').createSignedUrl(path, 60 * 60 * 24 * 365);
    return (signed && signed.signedUrl) || null;
  } catch (e) { console.warn('[newsletter.genImage] failed:', e.message); return null; }
}

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

  // --- AI editorial prose. TWO smaller parallel calls (core + fun) so a
  // truncation/parse failure in the long "fun content" JSON can't wipe out the
  // whole draft (Ed 2026-08-03: intermittent data-only fallbacks). Each call is
  // small enough to rarely hit the token ceiling; they run concurrently so
  // there's no added latency, and a failure in one leaves the other intact.
  const label = monthLabel(issueMonth);
  const season = seasonOf(issueMonth);
  const monthName = label.split(' ')[0];
  let ai = {
    intro: '', board_message: '', hoa_title: 'HOA Corner', hoa_body: '',
    seasonal_title: '', seasonal_body: '', recipe_title: '', recipe_body: '',
    history_title: '', history_body: '', lighter_title: '', lighter_body: '',
  };
  const baseRules = `You are the editorial assistant for Bedrock Association Management writing a friendly community newsletter for homeowners.
Rules: warm, welcoming, service-oriented; write for homeowners, not HOA professionals; no legal conclusions; do not describe covenant enforcement aggressively. Do NOT begin any body with a markdown heading that repeats the section title. Return STRICT JSON only (no code fences).`;
  // Use tool-use / structured output: the model returns the fields as a proper
  // JSON object (arguments), so markdown bodies with newlines, quotes, and lists
  // are correctly escaped by the SDK — no fragile text JSON.parse.
  async function callJSON(sys, user, max, propKeys) {
    try {
      const properties = {}; propKeys.forEach((k) => { properties[k] = { type: 'string' }; });
      const resp = await anthropic.messages.create({
        model: 'claude-sonnet-4-5', max_tokens: max, system: sys,
        tools: [{ name: 'newsletter_draft', description: 'Return the newsletter draft fields.', input_schema: { type: 'object', properties, required: propKeys } }],
        tool_choice: { type: 'tool', name: 'newsletter_draft' },
        messages: [{ role: 'user', content: user }],
      });
      if (resp.stop_reason === 'max_tokens') console.warn('[newsletter.generate] a call hit max_tokens');
      const tu = (resp.content || []).find((c) => c.type === 'tool_use');
      return (tu && tu.input) || null;
    } catch (e) { console.warn('[newsletter.generate] AI call failed:', e.message); return null; }
  }
  const coreSys = `${baseRules}
For COMMUNITY-SPECIFIC facts (dates, names, links, statistics) use ONLY the supplied facts and never invent them; write [STAFF REVIEW REQUIRED] if missing. Board message ~90-140 words; HOA Corner ~150-230 words.`;
  const coreUser = `Community: ${community.name}. Month: ${label}. Board: ${JSON.stringify(board.map((b) => ({ name: b.name, position: b.position })))}. HOA Corner topic: ${topic ? topic.label : '(choose a useful seasonal one)'}.
Return JSON: { "intro": "one warm cover sentence (<=25 words)", "board_message": "a short board message for ${label} (markdown)", "hoa_title": "friendly HOA Corner title${topic ? ' about ' + topic.label : ''}", "hoa_body": "the HOA Corner article (markdown), educational and neighborly" }`;
  const funSys = `${baseRules}
These are GENERAL-INTEREST pieces using common general knowledge. Recipes: simple, safe, common, family-friendly. History: only well-known, widely verifiable facts; if unsure, leave out. Lighter side: short, wholesome, PG, self-aware HOA humor — never mock real people or make light of enforcement, safety, or money.`;
  const funUser = `It is ${season}; the month is ${monthName}.
Return JSON: {
  "seasonal_title": "a fun ${season} community-life title", "seasonal_body": "a warm ${season} general-interest article for neighbors (~120-160 words, markdown)",
  "recipe_title": "a simple crowd-pleasing ${season} recipe name", "recipe_body": "recipe in markdown: one-line intro, then **Ingredients** bullet list, then **Steps** numbered list",
  "history_title": "a title for 'This Month in History' for ${monthName}", "history_body": "3-5 well-known events/famous birthdays in the calendar month of ${monthName} (markdown bullets, 'Month Day — fact')",
  "lighter_title": "an 'On the Lighter Side' title", "lighter_body": "a short wholesome PG bit of gentle HOA humor (2-5 sentences)"
}`;
  const [core, fun] = await Promise.all([
    callJSON(coreSys, coreUser, 2000, ['intro', 'board_message', 'hoa_title', 'hoa_body']),
    callJSON(funSys, funUser, 3500, ['seasonal_title', 'seasonal_body', 'recipe_title', 'recipe_body', 'history_title', 'history_body', 'lighter_title', 'lighter_body']),
  ]);
  if (core) {
    ai.intro = core.intro || ''; ai.board_message = core.board_message || '';
    ai.hoa_title = core.hoa_title || 'HOA Corner'; ai.hoa_body = core.hoa_body || '';
  } else { notes.push('AI could not draft the board message / HOA Corner this time — placeholders left for staff (regenerate to retry).'); }
  if (fun) {
    ai.seasonal_title = fun.seasonal_title || ''; ai.seasonal_body = fun.seasonal_body || '';
    ai.recipe_title = fun.recipe_title || ''; ai.recipe_body = fun.recipe_body || '';
    ai.history_title = fun.history_title || ''; ai.history_body = fun.history_body || '';
    ai.lighter_title = fun.lighter_title || ''; ai.lighter_body = fun.lighter_body || '';
  } else { notes.push('AI could not draft the seasonal / recipe / history / lighter items this time — regenerate to retry.'); }

  // --- Generate a couple of images to break up the text (best-effort, parallel).
  // Cover banner (only if no community hero photo) + a recipe photo. ~2 images
  // per draft via OpenAI; staff can replace/regenerate any of them.
  const season2 = seasonOf(issueMonth);
  let genCover = null, genRecipe = null;
  if (process.env.OPENAI_API_KEY && OpenAI) {
    try {
      [genCover, genRecipe] = await Promise.all([
        coverImageUrl ? Promise.resolve(null) : genImageUrl(supabase, `a cheerful ${season2} day in a friendly suburban neighborhood community — nice homes, trees, families enjoying the outdoors`, 'illustration'),
        ai.recipe_body ? genImageUrl(supabase, `${ai.recipe_title || 'a fresh seasonal dish'}, beautifully plated on a table, appetizing and colorful`, 'photo') : Promise.resolve(null),
      ]);
    } catch (_) {}
    if (genCover || genRecipe) notes.push('Added AI-generated images (cover / recipe). Replace or regenerate any image in the editor.');
  }

  // --- Assemble sections ------------------------------------------------------
  const sections = [];

  sections.push({
    section_type: 'cover', title: `${community.name}`, subtitle: label,
    image_url: coverImageUrl || genCover,
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
      image_url: genRecipe || null,
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
