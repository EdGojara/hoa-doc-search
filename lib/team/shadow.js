// ============================================================================
// lib/team/shadow.js  (Ed 2026-08-29)
// ----------------------------------------------------------------------------
// Shadow mode: run a trained persona against REAL inbound mail, send nothing,
// and record exactly what it would have done. This is the measurement layer that
// earns a go-live — the exception-rate scoreboard per lane. A persona stays dark
// while it accrues a track record here; the flip from propose to execute is then
// a data-backed decision, not a gut call. (See CLAUDE.md: earn autonomy.)
//
// It replays messages already in email_messages, so it adds no cost to the live
// ingest path and can run on demand. Each shadow draft is one grounded model
// call (plus the persona's usual grounding reads), so callers cap the batch.
// ============================================================================

const { CONFIGS } = require('./persona_configs');
const { draftOperatorReply } = require('./operator_reply');
const { routeSpecialist } = require('../email/route_specialist');

// Which lane a real message would land in. routeSpecialist covers the
// specialists; everything else is the front office (Claire). Amanda is the
// escalation tier, reached from her own live path, so we shadow her via the
// operator engine here only when a message is explicitly routed to her.
function routePersonaForEmail(row) {
  const r = routeSpecialist({
    classification: row.classification, subject: row.subject,
    bodyText: row.body_full || row.body_preview || '',
  });
  if (r && CONFIGS[r.persona]) return { persona: r.persona, reason: r.reason };
  return { persona: 'claire', reason: 'general front-office question' };
}

// Draft with the persona's real engine. amanda has her own module; every other
// persona runs through the shared operator engine via its config.
async function draftForPersona(persona, args) {
  if (persona === 'amanda') {
    const { draftAmandaReply } = require('../community/amanda_reply');
    return draftAmandaReply(args);
  }
  const cfg = CONFIGS[persona];
  if (!cfg) throw new Error(`no config for persona "${persona}"`);
  return draftOperatorReply(cfg, args);
}

// Run one real message through its persona in shadow and record the result.
// Idempotent on (source_email_id, persona): a re-run skips already-shadowed
// messages, so replays are cheap. Best-effort — never throws into the caller.
async function runShadowForEmail(supabase, row, { persona, reason, communityName, draftFn } = {}) {
  try {
    const drafter = draftFn || draftForPersona; // injectable for tests
    const route = persona ? { persona, reason } : routePersonaForEmail(row);
    // skip if already shadowed for this persona
    const existing = await supabase.from('shadow_drafts')
      .select('id').eq('source_email_id', row.id).eq('persona', route.persona).limit(1);
    if (existing.error) throw existing.error;
    if (existing.data && existing.data.length) return { status: 'skipped', persona: route.persona, id: existing.data[0].id };

    const email = {
      subject: row.subject, body: row.body_full || row.body_preview || '',
      sender_name: row.sender_name, sender_email: row.sender_email,
    };
    const args = {
      email, supabase,
      propertyId: row.resolved_property_id || null,
      communityId: row.community_id || null,
      contactName: row.sender_name || null,
      communityName: communityName || null,
    };

    const t0 = Date.now();
    const d = await drafter(route.persona, args);
    const latency = Date.now() - t0;

    const rowIns = {
      management_company_id: '00000000-0000-0000-0000-000000000001',
      community_id: row.community_id || null,
      source_email_id: row.id, source_email_ref: row.internet_message_id || null,
      subject: row.subject || null, sender_email: row.sender_email || null,
      persona: route.persona, routed_reason: route.reason || null,
      audience: d.audience || null,
      disposition: d.disposition || null, confidence: d.confidence || null, disposition_reason: d.disposition_reason || null,
      grounded: d.grounded === true, reserved_gate: d.reserved === true, reserved_reason: d.reserved_reason || null,
      escalation_reasons: Array.isArray(d.escalation_reasons) ? d.escalation_reasons : [],
      body_text: d.body || null, model: 'claude-sonnet-4-5', latency_ms: latency,
    };
    const ins = await supabase.from('shadow_drafts').insert(rowIns).select('id').single();
    if (ins.error) {
      if (String(ins.error.code) === '23505') return { status: 'exists', persona: route.persona };
      throw ins.error;
    }
    return { status: 'recorded', persona: route.persona, id: ins.data.id, disposition: d.disposition, confidence: d.confidence };
  } catch (e) {
    console.warn('[shadow] runShadowForEmail failed:', e.message);
    return { status: 'error', error: e.message };
  }
}

module.exports = { runShadowForEmail, routePersonaForEmail, draftForPersona };
