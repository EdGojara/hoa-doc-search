// ============================================================================
// lib/billing/email_intake.js  (Ed 2026-07-13)
// ----------------------------------------------------------------------------
// Staff email a DEDICATED billing intake mailbox (billing@) with ad-hoc billing
// items — reimbursables, community events, one-offs. Tessa (Bedrock's office
// assistant) reads each message, maps it to the community's rate-card
// categories, stages the charge in billing_pending_items, and replies to
// confirm what she staged (or asks which community if it's ambiguous). The
// staged charges then auto-drop onto that community's next activity invoice.
//
// Deliberately a STANDALONE poller (like lib/ea/tessa_inbox.js), NOT wired into
// the Claire/comms-board graph_ingest pipeline: billing items belong in the
// Billing module, and routing billing@ through the persona system would collide
// with Tessa's owner-only filtering on the team board. Idempotent via an
// email_messages row per processed graph_id.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const graphSend = require('../email/graph_send');
const { buildTessaEmail } = require('../email/tessa_signature');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';
const MODEL = 'claude-sonnet-4-5';
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Rate-card categories for a community's active contract (for mapping).
async function communityRateCard(communityId) {
  const { data: contracts } = await supabase.from('contracts').select('id')
    .eq('community_id', communityId).eq('status', 'active')
    .order('version', { ascending: false }).limit(1);
  if (!contracts || !contracts.length) return [];
  const { data } = await supabase.from('v_contract_fee_schedule')
    .select('section, category, description, amount, unit_price')
    .eq('contract_id', contracts[0].id);
  return (data || [])
    .filter((r) => r.category && (r.section === 'reimbursable' || r.section === 'owner_charge'))
    .map((r) => ({
      category: r.category, description: r.description,
      unit_price: r.unit_price != null ? Number(r.unit_price) : (r.amount != null ? Number(r.amount) : 0),
    }));
}

// Resolve the community a billing email is about: an explicit name in the text
// wins; otherwise try the sender's own community links. Returns {id, name} or null.
async function resolveCommunity(nameHint) {
  if (nameHint) {
    const { data } = await supabase.from('communities')
      .select('id, name').eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .ilike('name', `%${nameHint}%`).limit(2);
    if (data && data.length === 1) return data[0];
    if (data && data.length > 1) {
      const exact = data.find((c) => c.name.toLowerCase() === nameHint.toLowerCase());
      if (exact) return exact;
    }
  }
  return null;
}

// Ask the model to pull a community name + a list of billable line items out of
// the free-text request, mapping each to a rate-card category when one fits.
async function extractBillingItems({ subject, body, catalog }) {
  const catalogText = catalog.length
    ? catalog.map((c) => `- ${c.category} | ${c.description} | $${c.unit_price}`).join('\n')
    : '(no rate card available)';
  const prompt = `A Bedrock staff member emailed the billing inbox asking to bill a community for some items (reimbursables, community events, or one-offs). Extract what to bill.

RATE CARD (category | description | unit rate) for mapping — use the exact category key when an item clearly matches one; leave category null for a true one-off:
${catalogText}

EMAIL SUBJECT: ${subject || '(none)'}
EMAIL BODY:
${(body || '').slice(0, 4000)}

Return ONLY JSON:
{
  "community_name": "<the community this should be billed to, as written; null if not stated>",
  "items": [
    { "category": "<rate-card category key or null>", "description": "<short line description>", "qty": <number>, "unit_price": <number or null>, "amount": <number or null> }
  ],
  "needs_clarification": <true if you cannot tell the community or what to bill>,
  "clarification_reason": "<one sentence, only if needs_clarification>"
}
Rules: qty defaults to 1. If the staffer gives a total amount but no unit rate, put it in "amount" and leave unit_price null. If an item matches a rate-card category, prefer that category's unit rate. Do not invent charges not in the email.`;
  const r = await anthropic.messages.create({
    model: MODEL, max_tokens: 900,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = (r.content?.[0]?.text || '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { community_name: null, items: [], needs_clarification: true, clarification_reason: 'Could not parse the request.' };
  try { return JSON.parse(m[0]); }
  catch (_) { return { community_name: null, items: [], needs_clarification: true, clarification_reason: 'Could not parse the request.' }; }
}

// Normalize an extracted item to a stageable charge (qty/unit_price/amount).
function normalizeItem(it, catalog) {
  let qty = Number(it.qty); if (!(qty > 0)) qty = 1;
  let unit = it.unit_price != null ? Number(it.unit_price) : null;
  let amount = it.amount != null ? Number(it.amount) : null;
  // Prefer the rate-card unit price when the item mapped to a category.
  if (it.category) {
    const hit = catalog.find((c) => c.category === it.category);
    if (hit && (unit == null || !(unit > 0))) unit = hit.unit_price;
  }
  if (unit == null) unit = 0;
  if (amount == null) amount = Math.round(qty * unit * 100) / 100;
  else if (!(unit > 0)) unit = qty > 0 ? Math.round((amount / qty) * 10000) / 10000 : amount;
  return {
    category: it.category || null,
    description: String(it.description || 'Billing item').slice(0, 300),
    qty, unit_price: unit, amount,
  };
}

// Ack (or clarification) reply, sent AS Tessa.
async function replyAsTessa({ to, subject, staged, communityName, clarify }) {
  if (!graphSend.isConfigured() || !to || !EMAIL_RE.test(to)) return null;
  let body;
  if (clarify) {
    body = `Hi,\n\n${clarify}\n\nReply with the community name (and the item + amount or quantity) and I'll get it staged for the next invoice.`;
  } else if (staged && staged.length) {
    const lines = staged.map((s) => `  • ${s.description} — ${s.qty} × $${Number(s.unit_price).toFixed(2)} = $${Number(s.amount).toFixed(2)}`).join('\n');
    const total = staged.reduce((t, s) => t + Number(s.amount || 0), 0);
    body = `Hi,\n\nAdded the following to ${communityName}'s next invoice:\n\n${lines}\n\nTotal staged: $${total.toFixed(2)}. It'll appear on the next activity draft for review before anything is sent. Reply if any of it needs adjusting.`;
  } else {
    body = `Hi,\n\nI got your note but couldn't find a billable item to stage. Reply with the item and the amount or quantity and I'll add it.`;
  }
  const { html } = buildTessaEmail(body);
  const replySubject = /^re:/i.test(subject || '') ? subject : `Re: ${subject || 'billing item'}`;
  try { await graphSend.sendAs({ from: graphSend.TESSA_MAILBOX, to, subject: replySubject, html }); return graphSend.TESSA_MAILBOX; }
  catch (e) { console.warn('[billing_intake] ack send failed:', e.message); return null; }
}

// Process ONE inbound billing email. Idempotent via email_messages.graph_id.
async function processBillingMessage({ graphId, from, fromName, subject, body }) {
  if (!graphId) return { status: 'skipped', reason: 'no_graph_id' };
  // Dedup: already handled?
  const { data: seen } = await supabase.from('email_messages').select('id').eq('graph_id', graphId).limit(1);
  if (seen && seen.length) return { status: 'exists', graph_id: graphId };

  const ex = await extractBillingItems({ subject, body, catalog: [] }).catch(() => null);
  const community = ex ? await resolveCommunity(ex.community_name) : null;

  // Log the inbound message (also the idempotency marker).
  const logInbound = async (extra = {}) => {
    try {
      await supabase.from('email_messages').insert({
        mailbox: graphSend.BILLING_MAILBOX, graph_id: graphId, direction: 'inbound',
        sender_email: from || null, sender_name: fromName || null,
        subject: subject || null, body_preview: (body || '').slice(0, 2000),
        classification: 'billing_item', community_id: (community && community.id) || null,
        triage_status: 'handled', record_ownership: 'workpaper', received_at: new Date().toISOString(),
        ...extra,
      });
    } catch (e) { console.warn('[billing_intake] inbound log failed:', e.message); }
  };

  if (!community) {
    await logInbound();
    await replyAsTessa({ to: from, subject, clarify: (ex && ex.clarification_reason) || 'I couldn\'t tell which community to bill.' });
    return { status: 'needs_clarification', reason: 'no_community' };
  }

  // Re-extract WITH the community's rate card so category mapping + rates are right.
  const catalog = await communityRateCard(community.id);
  const ex2 = await extractBillingItems({ subject, body, catalog }).catch(() => ex);
  const rawItems = (ex2 && ex2.items) || [];
  const staged = [];
  for (const it of rawItems) {
    const n = normalizeItem(it, catalog);
    if (!n.description) continue;
    const { data, error } = await supabase.from('billing_pending_items').insert({
      management_company_id: BEDROCK_MGMT_CO_ID, community_id: community.id,
      category: n.category, description: n.description, qty: n.qty, unit_price: n.unit_price, amount: n.amount,
      source: 'email', source_ref: graphId, submitted_by: from || null,
      note: (subject ? subject + ' — ' : '') + (body || '').slice(0, 500),
    }).select('id').single();
    if (error) { console.warn('[billing_intake] stage failed:', error.message); continue; }
    staged.push({ ...n, id: data.id });
  }

  await logInbound();
  const ackFrom = await replyAsTessa({
    to: from, subject, staged, communityName: community.name,
    clarify: staged.length ? null : 'I couldn\'t find a specific item + amount to bill.',
  });
  // Log the outbound ack too.
  if (ackFrom && from) {
    try {
      await supabase.from('email_messages').insert({
        mailbox: graphSend.TESSA_MAILBOX, direction: 'outbound', sender_email: graphSend.TESSA_MAILBOX,
        sender_name: 'Tessa McCall (Bedrock)', recipients: [{ emailAddress: { address: from } }],
        subject: `Re: ${subject || 'billing item'}`, classification: 'outbound_reply',
        community_id: community.id, triage_status: 'handled', record_ownership: 'workpaper',
        received_at: new Date().toISOString(),
      });
    } catch (_) { /* best-effort */ }
  }
  return { status: staged.length ? 'staged' : 'no_items', community: community.name, staged_count: staged.length, items: staged };
}

// Poll the billing inbox and process new messages.
async function pollBillingInbox({ limit = 15 } = {}) {
  if (!graphSend.isConfigured()) return { status: 'not_configured' };
  const mailbox = graphSend.BILLING_MAILBOX;
  const token = await graphSend.getToken();
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages?$top=${limit}&$orderby=receivedDateTime desc&$select=id,subject,bodyPreview,body,from,receivedDateTime`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    // billing@ not yet authorized in the Azure AppOnly access policy (same
    // setup as Annie/Miranda/Tessa) — surface a clean, actionable status.
    if (r.status === 403 || /AccessPolicy|AccessDenied|MailboxNotEnabled|ResourceNotFound|ErrorInvalidUser/i.test(t)) {
      return { status: 'not_authorized', message: `The billing inbox (${mailbox}) isn't connected yet — create the shared mailbox and add it to the Azure Mail access policy (same as Annie/Miranda).` };
    }
    throw new Error(`Graph list failed (${r.status}): ${t.slice(0, 200)}`);
  }
  const j = await r.json();
  const messages = j.value || [];
  const results = [];
  for (const gm of messages) {
    const from = gm.from?.emailAddress?.address || null;
    const fromName = gm.from?.emailAddress?.name || null;
    const body = gm.body?.content ? String(gm.body.content).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : (gm.bodyPreview || '');
    const out = await processBillingMessage({ graphId: gm.id, from, fromName, subject: gm.subject, body }).catch((e) => ({ status: 'error', error: e.message }));
    results.push({ subject: gm.subject, ...out });
  }
  const tally = results.reduce((t, x) => { t[x.status] = (t[x.status] || 0) + 1; return t; }, {});
  return { status: 'ok', processed: results.length, tally, results };
}

module.exports = { pollBillingInbox, processBillingMessage, extractBillingItems, communityRateCard, resolveCommunity };
