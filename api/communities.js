// ============================================================================
// Community Profile + Facts API
// ----------------------------------------------------------------------------
// Mounted at /api/community-profile (server.js).
//
// Routes:
//   GET   /:communityId/full              — profile + facts + computed in one
//   GET   /:communityId/profile           — structured JSONB profile
//   PATCH /:communityId/profile           — merge-update profile fields
//   GET   /:communityId/facts             — list facts (active + expired)
//   POST  /:communityId/facts             — create a new fact (re-embed)
//   PATCH /facts/:factId                  — update a fact (re-embed if text changed)
//   POST  /facts/:factId/mark-current     — bump last_updated_at + clear needs_review
//   DELETE /facts/:factId                 — soft delete (actually deletes for now)
//   GET   /:communityId/computed          — auto-pulled facts from existing tables
//                                             (current landscape vendor, etc.)
//
// All endpoints scoped to BEDROCK_MGMT_CO_ID for now (single-tenant).
// ============================================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';
const EMBEDDING_MODEL = 'text-embedding-ada-002';

const router = express.Router();

// ----------------------------------------------------------------------------
// POST /extract-contact-from-email
// Body: { email_text }
// Returns: { ok, contact: { vendor_name, vendor_category, contact_name, role,
//                            phone, email, notes } }
// Used by the Profile → Contacts UI to pre-fill the structured contact form
// from a pasted email (or signature block). The model returns ONLY JSON; any
// field can be null if the email doesn't mention it.
// ----------------------------------------------------------------------------
router.post('/extract-contact-from-email', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const { email_text } = req.body || {};
    if (!email_text || email_text.trim().length < 20) {
      return res.status(400).json({ error: 'Provide the email text (at least 20 characters).' });
    }

    const system =
      "You extract a single business contact from an email body or signature block. " +
      "Output ONLY a JSON object — no prose, no markdown fences — with these keys " +
      "(use null when the email does not mention them):\n" +
      "  vendor_name: company name\n" +
      "  vendor_category: one of pool|landscape|security|gate|electrical|plumbing|hvac|pest_control|irrigation|cleaning|attorney|accountant|insurance|banking|board_member|onsite_staff|other\n" +
      "  contact_name: full name of the person\n" +
      "  role: title or role (e.g., 'Account manager')\n" +
      "  phone: formatted as 281-555-0100 (US 10-digit). If multiple, pick the most-likely-primary.\n" +
      "  email: best email address\n" +
      "  notes: anything useful that isn't already captured — license number, after-hours line, backup contact, scope of service, etc.\n" +
      "Never fabricate. If unsure of vendor_category, use 'other'.";

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system,
      messages: [{ role: 'user', content: 'Email:\n\n' + email_text }],
    });

    const raw = (response.content?.[0]?.text || '').trim();
    let contact = {};
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      contact = JSON.parse(m ? m[0] : raw);
    } catch (e) {
      console.warn('[extract-contact] JSON parse failed:', e.message);
    }

    res.json({ ok: true, contact });
  } catch (err) {
    console.error('[extract-contact-from-email] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

async function embed(text) {
  if (!text || !text.trim()) return null;
  const r = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.replace(/\n+/g, ' ').slice(0, 8000)
  });
  return r.data[0].embedding;
}

// Build the "computed facts" — pulls from existing tables to produce
// fact-shaped objects so the UI can show them alongside manual entries.
async function getComputedFacts(communityId) {
  const out = [];

  // 1) Current vendors by service category (active vendor_contracts)
  try {
    const { data: contracts } = await supabase
      .from('vendor_contracts')
      .select(`
        id, service_category, status, contract_start_date, contract_end_date,
        vendor:vendors(id, name, primary_contact_name, primary_contact_email, primary_contact_phone)
      `)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .eq('community_id', communityId)
      .eq('status', 'active');

    for (const c of contracts || []) {
      const v = c.vendor || {};
      out.push({
        kind: 'computed',
        source: 'vendor_contracts',
        source_ref: `vendor_contracts:${c.id}`,
        category: 'vendor',
        key: `current_vendor_${c.service_category}`,
        label: `Current ${c.service_category} vendor`,
        value: v.name || '(no name)',
        details: {
          vendor_name: v.name,
          contact_name: v.primary_contact_name,
          email: v.primary_contact_email,
          phone: v.primary_contact_phone,
          contract_id: c.id,
          contract_start: c.contract_start_date,
          contract_end: c.contract_end_date
        },
        last_updated_at: c.contract_start_date || null,
        expires_at: c.contract_end_date || null
      });
    }
  } catch (err) {
    console.warn('[community-profile] computed vendors failed:', err.message);
  }

  return out;
}

// Apply a manual override on top of a computed fact: if a manual community_facts
// row exists with the same key, hide the computed version and prefer the manual.
function mergeComputedAndManual(computed, manualFacts) {
  const manualKeys = new Set(manualFacts.map((f) => f.key));
  const filteredComputed = computed.filter((c) => !manualKeys.has(c.key));
  return { computed: filteredComputed, manual: manualFacts };
}

// ----------------------------------------------------------------------------
// GET /:communityId/full — everything in one call (for the admin page)
// ----------------------------------------------------------------------------
router.get('/:communityId/full', async (req, res) => {
  try {
    const { communityId } = req.params;

    const [{ data: community, error: cErr }, factsResp, computed] = await Promise.all([
      supabase.from('communities')
        .select('id, name, slug, total_lots, vantaca_code, profile, active')
        .eq('id', communityId)
        .single(),
      supabase.from('v_community_facts')
        .select('*')
        .eq('community_id', communityId)
        .order('category', { ascending: true })
        .order('label', { ascending: true }),
      getComputedFacts(communityId)
    ]);

    if (cErr) throw cErr;
    if (factsResp.error) throw factsResp.error;

    const manualFacts = factsResp.data || [];
    const merged = mergeComputedAndManual(computed, manualFacts);

    res.json({
      community,
      profile: community?.profile || {},
      facts: merged.manual,
      computed_facts: merged.computed
    });
  } catch (err) {
    console.error('[community-profile] /full failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// PATCH /:communityId/profile — merge-update the profile JSONB
// Body: arbitrary fields to set/override (deep merge for objects, replace for scalars)
// ----------------------------------------------------------------------------
router.patch('/:communityId/profile', express.json(), async (req, res) => {
  try {
    const { communityId } = req.params;
    const updates = req.body || {};

    // Fetch existing profile, merge, write back
    const { data: existing, error: getErr } = await supabase
      .from('communities')
      .select('profile')
      .eq('id', communityId)
      .single();
    if (getErr) throw getErr;

    const merged = { ...(existing?.profile || {}), ...updates };

    const { data: updated, error: setErr } = await supabase
      .from('communities')
      .update({ profile: merged, updated_at: new Date().toISOString() })
      .eq('id', communityId)
      .select('id, profile')
      .single();
    if (setErr) throw setErr;

    res.json({ ok: true, profile: updated.profile });
  } catch (err) {
    console.error('[community-profile] PATCH /profile failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /:communityId/facts — create a fact
// Body: { category, key, label, value, details?, expires_at?, review_note? }
// ----------------------------------------------------------------------------
router.post('/:communityId/facts', express.json(), async (req, res) => {
  try {
    const { communityId } = req.params;
    const { category, key, label, value, details, expires_at, review_note } = req.body || {};
    if (!key || !value) return res.status(400).json({ error: 'key and value are required' });

    const embedding = await embed(`${label || key}. ${value}`);

    const { data, error } = await supabase
      .from('community_facts')
      .insert({
        community_id: communityId,
        category: category || null,
        key,
        label: label || null,
        value,
        details: details || null,
        expires_at: expires_at || null,
        review_note: review_note || null,
        source_type: 'manual',
        embedding
      })
      .select()
      .single();
    if (error) throw error;

    res.json({ ok: true, fact: data });
  } catch (err) {
    console.error('[community-profile] POST /facts failed:', err.message);
    // unique violation → fact with this key exists for this community
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A fact with that key already exists for this community. Use PATCH to update it.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// PATCH /facts/:factId — update a fact (re-embeds if text changed)
// Body: any subset of { category, label, value, details, expires_at, review_note }
// ----------------------------------------------------------------------------
router.patch('/facts/:factId', express.json(), async (req, res) => {
  try {
    const { factId } = req.params;
    const updates = req.body || {};

    // If value/label changed, re-embed.
    const patch = {};
    let willReembed = false;
    if ('category' in updates) patch.category = updates.category;
    if ('label' in updates) { patch.label = updates.label; willReembed = true; }
    if ('value' in updates) { patch.value = updates.value; willReembed = true; }
    if ('details' in updates) patch.details = updates.details;
    if ('expires_at' in updates) patch.expires_at = updates.expires_at;
    if ('review_note' in updates) patch.review_note = updates.review_note;

    patch.last_updated_at = new Date().toISOString();
    patch.needs_review = false;            // editing implicitly marks it fresh
    patch.manual_override = updates.manual_override ?? true;

    if (willReembed) {
      const { data: row } = await supabase
        .from('community_facts')
        .select('label, value')
        .eq('id', factId)
        .single();
      const label = patch.label ?? row?.label;
      const value = patch.value ?? row?.value;
      patch.embedding = await embed(`${label || ''}. ${value || ''}`);
    }

    const { data, error } = await supabase
      .from('community_facts')
      .update(patch)
      .eq('id', factId)
      .select()
      .single();
    if (error) throw error;

    res.json({ ok: true, fact: data });
  } catch (err) {
    console.error('[community-profile] PATCH /facts failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /facts/:factId/mark-current — bump freshness without changing value
// ----------------------------------------------------------------------------
router.post('/facts/:factId/mark-current', async (req, res) => {
  try {
    const { factId } = req.params;
    const { data, error } = await supabase
      .from('community_facts')
      .update({
        last_updated_at: new Date().toISOString(),
        needs_review: false
      })
      .eq('id', factId)
      .select()
      .single();
    if (error) throw error;
    res.json({ ok: true, fact: data });
  } catch (err) {
    console.error('[community-profile] mark-current failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// DELETE /facts/:factId
// ----------------------------------------------------------------------------
router.delete('/facts/:factId', async (req, res) => {
  try {
    const { factId } = req.params;
    const { error } = await supabase
      .from('community_facts')
      .delete()
      .eq('id', factId);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[community-profile] DELETE /facts failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /:communityId/computed — just the computed facts (no manual overlay)
// ----------------------------------------------------------------------------
router.get('/:communityId/computed', async (req, res) => {
  try {
    const computed = await getComputedFacts(req.params.communityId);
    res.json({ computed_facts: computed });
  } catch (err) {
    console.error('[community-profile] /computed failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// Helper for server.js: build a prompt-ready context block for a community
// ----------------------------------------------------------------------------
async function buildCommunityContextBlock(communityNameOrId) {
  if (!communityNameOrId) return '';

  // Resolve community
  const q = supabase.from('communities')
    .select('id, name, total_lots, profile')
    .eq('management_company_id', BEDROCK_MGMT_CO_ID)
    .limit(1);
  const isUuid = /^[0-9a-f-]{36}$/i.test(communityNameOrId);
  const { data: comm } = await (isUuid
    ? q.eq('id', communityNameOrId).maybeSingle()
    : q.eq('name', communityNameOrId).maybeSingle());
  if (!comm) return '';

  const profile = comm.profile || {};
  const lines = [];
  lines.push(`COMMUNITY PROFILE — ${comm.name}`);
  if (comm.total_lots) lines.push(`  Total homes/lots: ${comm.total_lots}`);
  for (const [k, v] of Object.entries(profile)) {
    if (v == null || v === '') continue;
    const label = k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    if (typeof v === 'object') {
      lines.push(`  ${label}: ${JSON.stringify(v)}`);
    } else {
      lines.push(`  ${label}: ${v}`);
    }
  }

  // Active manual facts (non-expired or recently-expired with override)
  const { data: facts } = await supabase
    .from('v_community_facts')
    .select('category, label, value, details, is_expired, last_updated_at, expires_at')
    .eq('community_id', comm.id)
    .order('category', { ascending: true });

  if (facts && facts.length > 0) {
    lines.push('');
    lines.push('COMMUNITY FACTS (operational — current as of dates shown)');
    for (const f of facts) {
      const stamp = f.expires_at ? ` [expires ${f.expires_at.slice(0, 10)}]` : '';
      const stale = f.is_expired ? ' [⚠ EXPIRED — verify before quoting]' : '';
      const label = f.label || f.category || 'note';
      lines.push(`  • ${label}: ${f.value}${stamp}${stale}`);
    }
  }

  // Computed facts (current vendors etc.) — only include those NOT shadowed by a manual override
  const computed = await getComputedFacts(comm.id);
  if (computed.length > 0) {
    const manualKeys = new Set((facts || []).map((f) => f.key));
    const visibleComputed = computed.filter((c) => !manualKeys.has(c.key));
    if (visibleComputed.length > 0) {
      lines.push('');
      lines.push('CURRENT VENDORS / SYSTEM-MAINTAINED');
      for (const c of visibleComputed) {
        const d = c.details || {};
        const contact = [d.contact_name, d.phone, d.email].filter(Boolean).join(' / ');
        lines.push(`  • ${c.label}: ${c.value}${contact ? ' — ' + contact : ''}`);
      }
    }
  }

  // Recent decisions (last 90 days) — gives AskEd the institutional-memory layer
  // that today only lives in inboxes.
  try {
    const sinceIso = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { data: decisions } = await supabase
      .from('community_decisions')
      .select('decision_summary, category, decided_at, decided_by')
      .eq('community_id', comm.id)
      .gte('decided_at', sinceIso)
      .order('decided_at', { ascending: false })
      .limit(15);
    if (decisions && decisions.length > 0) {
      lines.push('');
      lines.push('RECENT DECISIONS (last 90 days)');
      for (const d of decisions) {
        const when = d.decided_at ? new Date(d.decided_at).toISOString().slice(0, 10) : 'date unknown';
        const who = d.decided_by ? ` — ${d.decided_by}` : '';
        lines.push(`  • ${d.decision_summary} (${when}${who})`);
      }
    }
  } catch (_) { /* table may not exist yet; silent */ }

  // Upcoming + recently-completed events — so AskEd knows about the pool party
  // when a homeowner asks "is there a community event coming up?"
  try {
    const now = new Date();
    const past30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const future60 = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000).toISOString();
    const { data: events } = await supabase
      .from('events')
      .select('name, event_type, location, scheduled_start_at, status')
      .eq('community_id', comm.id)
      .gte('scheduled_start_at', past30)
      .lte('scheduled_start_at', future60)
      .order('scheduled_start_at', { ascending: true })
      .limit(10);
    if (events && events.length > 0) {
      lines.push('');
      lines.push('EVENTS (recent + upcoming, ±30/60 days)');
      for (const e of events) {
        const when = new Date(e.scheduled_start_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const where = e.location ? ` at ${e.location}` : '';
        lines.push(`  • ${e.name} — ${when}${where} [${e.status}]`);
      }
    }
  } catch (_) { /* silent */ }

  // Historical ACC decisions — INFORMATIONAL CONTEXT ONLY, not precedent.
  // We surface the 10 most recent decisions so AskEd has a sense of what
  // this community has approved/denied in the past. Semantic matching of
  // specific applications happens in the AI assessment engine route.
  try {
    const { data: arcDecisions } = await supabase
      .from('arc_historical_decisions')
      .select('property_address, project_type, decision_type, decided_at, summary, conditions')
      .eq('community_id', comm.id)
      .order('decided_at', { ascending: false, nullsFirst: false })
      .limit(10);
    if (arcDecisions && arcDecisions.length > 0) {
      lines.push('');
      lines.push('HISTORICAL ACC DECISIONS (informational context only — NOT binding precedent. Current governing documents are the authority.)');
      for (const d of arcDecisions) {
        const when = d.decided_at ? new Date(d.decided_at).toISOString().slice(0, 10) : 'date unknown';
        const tag = d.decision_type ? d.decision_type.toUpperCase() : '?';
        const cond = d.conditions ? ` [conditions: ${d.conditions.slice(0, 80)}${d.conditions.length > 80 ? '…' : ''}]` : '';
        lines.push(`  • [${tag}] ${when} — ${d.project_type || 'project'} at ${d.property_address || 'address unknown'}: ${d.summary || ''}${cond}`);
      }
    }
  } catch (_) { /* silent */ }

  return lines.join('\n');
}

module.exports = { router, buildCommunityContextBlock };
