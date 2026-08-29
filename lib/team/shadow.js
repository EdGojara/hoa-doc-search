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

// ---------------------------------------------------------------------------
// THE ENCODE-ED LOOP
// ---------------------------------------------------------------------------

const { sigNamesFor } = require('./persona_configs');
const core = require('./operator_core');

function _anthropic() {
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// Regenerate a shadow draft applying Ed's correction, so grading is "type the
// principle, get it rewritten your way" instead of "rewrite from scratch." Uses
// the original (already grounded) draft as the base and Ed's note as the change
// order — cheap, focused, one model call. Returns the revised body.
async function redraftWithFeedback(supabase, shadowRow, note) {
  const em = await supabase.from('email_messages')
    .select('subject, body_full, body_preview, sender_name').eq('id', shadowRow.source_email_id).limit(1);
  const inbound = (!em.error && em.data && em.data[0]) || {};
  const persona = shadowRow.persona;
  const name = (sigNamesFor(persona)[0]) || 'the teammate';
  const learned = (await loadApprovedGuidanceSafe(supabase, persona));

  const system = `You are ${name}, a Bedrock community-management teammate. You are REVISING a draft reply based on a required correction from Ed, the owner, whose judgment is the standard. Apply the correction fully. Keep everything the correction did not object to. Keep the warm, plain, specific voice. No em-dashes, use commas. Write ONLY the full message body, greeting through sign-off. No signature block, title, or contact details. Plain text.${learned ? `\n\nStanding guidance Ed has already set for this lane:\n${learned}` : ''}`;

  const user = `THE INCOMING MESSAGE:\nFrom: ${inbound.sender_name || 'a sender'}\nSubject: ${inbound.subject || '(none)'}\n\n${inbound.body_full || inbound.body_preview || ''}\n\n`
    + `THE CURRENT DRAFT:\n${shadowRow.body_text || ''}\n\n`
    + `ED'S REQUIRED CORRECTION (apply this exactly):\n${note}\n\n`
    + `Rewrite the draft to fully apply Ed's correction.`;

  const resp = await _anthropic().messages.create({
    model: 'claude-sonnet-4-5', max_tokens: 1200, system,
    messages: [{ role: 'user', content: user }],
  });
  const out = core.cleanModelBody((resp.content || []).map((b) => b.text || '').join(''), sigNamesFor(persona));
  return out;
}

async function loadApprovedGuidanceSafe(supabase, persona) {
  try { const { loadApprovedGuidance } = require('./learned_guidance'); return await loadApprovedGuidance(supabase, persona); }
  catch (_) { return ''; }
}

// Distill Ed's graded corrections for a lane into a concise set of durable
// principles in his voice — the encode-Ed step. Merges with the current approved
// guidance so nothing already taught is lost. Returns { proposed, sourceCount }.
// Ed reviews/edits/approves the result; it is never auto-applied.
async function distillGuidance(supabase, persona) {
  const corr = await supabase.from('shadow_drafts')
    .select('subject, body_text, ed_note, ed_rewrite, ed_rated_at')
    .eq('persona', persona).eq('ed_rating', 'needs_work')
    .order('ed_rated_at', { ascending: false }).limit(60);
  if (corr.error) throw corr.error;
  const rows = corr.data || [];
  if (!rows.length) return { proposed: '', sourceCount: 0, note: 'No "needs work" corrections graded for this lane yet.' };

  const current = await loadApprovedGuidanceSafe(supabase, persona);
  const cases = rows.map((r, i) => `--- Correction ${i + 1} (subject: ${r.subject || 'n/a'}) ---\n`
    + `Draft Ed rejected:\n${(r.body_text || '').slice(0, 700)}\n`
    + (r.ed_note ? `What Ed said was wrong / how he'd handle it:\n${r.ed_note}\n` : '')
    + (r.ed_rewrite ? `Ed's rewrite:\n${(r.ed_rewrite || '').slice(0, 900)}\n` : '')).join('\n');

  const system = `You are encoding Ed's judgment into durable rules for how the "${persona}" lane should write. Ed owns the company; his corrections are the standard. From his corrections, extract a CONCISE list of general, reusable PRINCIPLES in Ed's imperative voice (e.g., "Never name or forward to a specific staffer; route to the function."). Rules must generalize beyond the specific email. Merge with the existing principles below, deduplicate, drop nothing still valid, and keep the list tight (aim for 5-12 bullets). Output ONLY the bullet list, each line starting with "- ". No preamble.`;
  const user = `EXISTING APPROVED PRINCIPLES for this lane:\n${current || '(none yet)'}\n\nED'S CORRECTIONS TO LEARN FROM:\n${cases}`;

  const resp = await _anthropic().messages.create({
    model: 'claude-sonnet-4-5', max_tokens: 900, system,
    messages: [{ role: 'user', content: user }],
  });
  const proposed = (resp.content || []).map((b) => b.text || '').join('').trim();
  return { proposed, sourceCount: rows.length };
}

module.exports = { runShadowForEmail, routePersonaForEmail, draftForPersona, redraftWithFeedback, distillGuidance };
