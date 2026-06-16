// ============================================================================
// lib/interactions/history.js
// ----------------------------------------------------------------------------
// Shared interaction-history fetcher + AI summarizer. ONE source of truth used
// by:
//   - api/interactions.js — the /summarize HTTP endpoint backing the
//     ✨ Summarize buttons on the property panels and the top-bar shortcut.
//   - lib/askEdTools.js — get_homeowner_contact_history tool so Ask Ed can
//     speak to "what's the story on 5226 Jay Thrush" when staff asks.
//   - lib/voice/tools.js — same tool, voice-mode (caller_facing=true)
//     filters internal notes so Claire never reads staff scratch out loud
//     to the caller on the other end of the phone.
//
// Two filter levels:
//   - internal (default)    — everything; staff-facing.
//   - caller_facing=true    — strips direction='internal' and type='internal_note'
//                             rows; tunes the summary prompt for "what should I
//                             tell the person on the phone right now."
// ============================================================================

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Resolve a property by community + address fragment. Mirrors the
// fuzzy-match approach in get_ar_for_property_handler so a caller saying
// "5226 Jay Thrush" lands the same way for both balance lookups and
// history lookups.
async function resolvePropertyByAddress({ community_name, address }) {
  if (!community_name || !address) {
    return { error: 'missing_input' };
  }
  const { data: communityRow } = await supabase
    .from('communities')
    .select('id, name')
    .ilike('name', `%${community_name.trim()}%`)
    .limit(1)
    .maybeSingle();
  if (!communityRow) return { error: 'community_not_found', community_searched: community_name };

  const cleaned = String(address).trim().replace(/\s+/g, ' ');
  const m = cleaned.match(/^\s*(\d+)\s+(.+?)\s*$/);
  if (!m) return { error: 'address_unparseable', address_given: address };
  const houseNum = m[1];
  const streetFragment = m[2].split(/\s+/).slice(0, 2).join(' ');

  const { data: rows } = await supabase
    .from('properties')
    .select('id, street_address')
    .eq('community_id', communityRow.id)
    .ilike('street_address', `${houseNum}%${streetFragment}%`)
    .limit(2);

  if (!rows || rows.length === 0) {
    return { error: 'property_not_found', community: communityRow.name, address_given: address };
  }
  if (rows.length > 1) {
    return {
      error: 'address_ambiguous',
      community: communityRow.name,
      candidates: rows.map((r) => r.street_address),
    };
  }
  return { property_id: rows[0].id, street_address: rows[0].street_address, community: communityRow.name };
}

// Pull raw interactions for a property. Caller-facing mode filters out
// internal-only rows (type='internal_note', direction='internal') so they
// never appear in spoken summaries.
async function fetchInteractionsForProperty(property_id, { caller_facing = false } = {}) {
  let query = supabase
    .from('interactions')
    .select('id, type, direction, subject, content, sent_at, follow_up_due_at, source, notes, attachments')
    .eq('property_id', property_id)
    .order('sent_at', { ascending: false })
    .limit(50);
  if (caller_facing) {
    query = query.neq('type', 'internal_note').neq('direction', 'internal');
  }
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

function buildTimelineText(rows) {
  // Oldest-first so the AI reads the story chronologically.
  return rows.slice().reverse().map((r) => {
    const when = r.sent_at ? new Date(r.sent_at).toLocaleDateString() : '?';
    const kind = (r.type || 'note').replace(/_/g, ' ');
    const dir = r.direction === 'inbound' ? '← homeowner'
              : r.direction === 'outbound' ? '→ homeowner'
              : 'internal';
    const subj = r.subject ? ` "${r.subject}"` : '';
    const body = r.content ? ` — ${String(r.content).slice(0, 500)}` : '';
    const fu = r.follow_up_due_at ? ` [follow up by ${new Date(r.follow_up_due_at).toLocaleDateString()}]` : '';
    return `${when} · ${kind} ${dir}${subj}${body}${fu}`;
  }).join('\n');
}

function emptyResult(propertyContext = {}) {
  return {
    headline: 'No contact on record yet.',
    summary: 'Nothing logged for this property. The first call, note, or dropped email will populate the timeline.',
    followups: [],
    row_count: 0,
    property: propertyContext,
    generated_at: new Date().toISOString(),
  };
}

// Ask Claude to summarize the timeline. Voice mode tunes the prompt so
// the output is short enough to be spoken on a live call and avoids
// referencing files / attachments staff would otherwise see.
async function summarizeInteractions({ propertyContext, rows, caller_facing = false }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('AI not configured');
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  const timeline = buildTimelineText(rows);

  const staffSystem = `You are summarizing a homeowner's contact history at an HOA management firm. Write for a staff member who is about to pick up the phone — they have 10 seconds to read this before they speak.

Voice: clear, factual, short. No "the homeowner appears to" hedging. State what happened. If a promise was made and isn't closed out, name it.

Return ONLY this JSON (no preamble, no fences):
{
  "headline":  "One short line — who they are, what's open. Under 90 chars.",
  "summary":   "2-4 sentences of the story arc, in chronological order. What was the issue, what did Bedrock do, what's the current state. Plain English.",
  "followups": ["Specific open commitments by date if any — empty array if none. Each item under 100 chars."]
}`;

  // Voice-mode prompt: this output will be spoken aloud by Claire to the
  // person who called in. No internal notes, no jargon, no "the operator
  // logged" voice. State what Bedrock did, what's open, what's next.
  const voiceSystem = `You are giving a voice agent context so it can speak to a homeowner who just called. The homeowner is on the line right now. The agent has 10 seconds to read this before speaking.

Voice: short, plain English, no jargon, no internal-process language ("the operator logged", "ticket opened", "queue", "ledger"). Write as if you were briefing a co-worker about what to say next.

Return ONLY this JSON (no preamble, no fences):
{
  "headline":  "One short sentence — what's currently open with this homeowner. Under 90 chars.",
  "summary":   "1-3 short sentences the agent can paraphrase: what happened, what we did, what's next. NO references to internal notes or staff names. Plain English suitable for speaking aloud.",
  "followups": ["Specific commitments made TO the homeowner that haven't closed yet — empty array if none. Each item under 100 chars."]
}`;

  const user = `Property: ${propertyContext.street_address || '(address unknown)'}
Owner: ${propertyContext.owner_name || '(unknown)'}
Total ${caller_facing ? 'caller-relevant ' : ''}interactions: ${rows.length}

Timeline (oldest first):
${timeline}`;

  const resp = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 600,
    system: caller_facing ? voiceSystem : staffSystem,
    messages: [{ role: 'user', content: user }],
  });
  const block = (resp.content || []).find((b) => b.type === 'text');
  const raw = (block && block.text) || '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('AI returned no JSON');
  const parsed = JSON.parse(jsonMatch[0]);
  return {
    headline:  (parsed.headline || '').toString().slice(0, 200),
    summary:   (parsed.summary || '').toString(),
    followups: Array.isArray(parsed.followups) ? parsed.followups.slice(0, 8) : [],
  };
}

// One-shot convenience used by tool handlers: resolve OR accept property_id,
// fetch, summarize, return a Claire/Ask-Ed-ready bundle.
async function getInteractionHistoryBundle({
  property_id,
  community_name,
  address,
  caller_facing = false,
  include_recent = true,
}) {
  let propertyContext = {};
  let resolved_property_id = property_id;

  if (!resolved_property_id) {
    const resolved = await resolvePropertyByAddress({ community_name, address });
    if (resolved.error) return { ok: false, ...resolved };
    resolved_property_id = resolved.property_id;
    propertyContext = {
      property_id: resolved.property_id,
      street_address: resolved.street_address,
      community: resolved.community,
    };
  } else {
    const { data: p } = await supabase
      .from('v_current_property_owners')
      .select('property_id, street_address, owner_name, community_id')
      .eq('property_id', resolved_property_id)
      .maybeSingle();
    if (p) propertyContext = {
      property_id: p.property_id,
      street_address: p.street_address,
      owner_name: p.owner_name,
    };
  }

  const rows = await fetchInteractionsForProperty(resolved_property_id, { caller_facing });

  if (rows.length === 0) {
    return { ok: true, ...emptyResult(propertyContext) };
  }

  const summary = await summarizeInteractions({
    propertyContext,
    rows,
    caller_facing,
  });

  // Recent rows shaped for the model. Internal notes already filtered when
  // caller_facing. Content trimmed so tool_result payload stays small.
  const recent = include_recent
    ? rows.slice(0, 8).map((r) => ({
        when: r.sent_at,
        type: r.type,
        direction: r.direction,
        subject: r.subject,
        snippet: r.content ? String(r.content).slice(0, 240) : null,
        follow_up_due: r.follow_up_due_at,
      }))
    : undefined;

  return {
    ok: true,
    property: propertyContext,
    headline: summary.headline,
    summary: summary.summary,
    open_followups: summary.followups,
    row_count: rows.length,
    recent_interactions: recent,
    caller_facing,
    generated_at: new Date().toISOString(),
  };
}

module.exports = {
  resolvePropertyByAddress,
  fetchInteractionsForProperty,
  summarizeInteractions,
  getInteractionHistoryBundle,
};
