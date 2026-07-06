#!/usr/bin/env node
// ============================================================================
// scripts/seed_email_triage.js  (Ed 2026-07-05)
// ----------------------------------------------------------------------------
// Run a batch of raw emails through the triage pipeline (classify + resolve)
// and either PRINT the result (demo/dry-run, default) or INSERT into
// email_messages (--apply, requires migration 261 applied).
//
//   node -r dotenv/config scripts/seed_email_triage.js <emails.json> [--apply]
//
// <emails.json> is an array of raw messages (mailbox, graph_id,
// internet_message_id, sender_email, subject, body_preview/body_full,
// received_at, recipients, has_attachments) — as pulled from the M365 mailbox.
// ============================================================================
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { classifyAndExtract, resolveEntities } = require('../lib/email/triage');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const FILE = process.argv[2];
const APPLY = process.argv.includes('--apply');

const pad = (s, n) => String(s == null ? '' : s).slice(0, n).padEnd(n);

(async () => {
  if (!FILE) { console.error('usage: <emails.json> [--apply]'); process.exit(1); }
  const emails = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  console.log(`Loaded ${emails.length} emails from ${FILE}\n`);

  let linked = 0, review = 0, spam = 0, inserted = 0;
  const rows = [];
  for (const em of emails) {
    const ex = await classifyAndExtract(em);
    const res = ex.is_spam
      ? { community_id: null, contact_id: null, property_id: null, vendor_id: null, confidence: 'none', candidates: [] }
      : await resolveEntities(ex, em, sb);

    const status = ex.is_spam ? 'spam'
      : (res.confidence === 'high' ? 'linked' : (res.candidates.length ? 'needs_review' : 'new'));
    if (status === 'spam') spam++; else if (status === 'linked') linked++; else review++;

    const linkLabel = res.contact_id ? 'contact✓' : res.vendor_id ? 'vendor✓' : res.property_id ? 'property✓' : (res.candidates[0] ? `? ${res.candidates[0].label}` : '—');
    console.log(`${pad(ex.classification, 17)} ${pad(ex.classification_confidence, 4)} ${pad(status, 12)} ${pad((em.sender_email || ''), 26)} | ${pad(ex.summary, 62)} | resolve:${pad(res.confidence, 6)} ${linkLabel}`);

    rows.push({
      mailbox: em.mailbox, graph_id: em.graph_id || null, internet_message_id: em.internet_message_id || null,
      conversation_id: em.conversation_id || null, direction: 'inbound',
      sender_email: em.sender_email || null, sender_name: em.sender_name || null,
      recipients: em.recipients || [], subject: em.subject || null,
      body_preview: (em.body_preview || '').slice(0, 2000), body_full: em.body_full || null,
      received_at: em.received_at || null, sent_at: em.sent_at || null, has_attachments: !!em.has_attachments,
      classification: ex.classification, classification_confidence: ex.classification_confidence || 'low',
      ai_summary: ex.summary || null,
      extracted: { requested_action: ex.requested_action, community_hint: ex.community_hint, person_names: ex.person_names, addresses: ex.addresses, amounts: ex.amounts, ticket_ref: ex.ticket_ref, vendor_name: ex.vendor_name },
      community_id: res.community_id, resolved_contact_id: res.contact_id, resolved_property_id: res.property_id, resolved_vendor_id: res.vendor_id,
      resolution_confidence: res.confidence, resolution_candidates: res.candidates,
      triage_status: status, priority: ex.priority || 'normal',
    });
  }

  console.log(`\nSummary: ${linked} auto-linked (high) | ${review} need review | ${spam} spam/noise`);

  if (!APPLY) { console.log('\nDRY RUN — pass --apply to write into email_messages (needs migration 261).'); return; }
  for (const r of rows) {
    // Idempotent without relying on ON CONFLICT (261's graph_id index is partial,
    // which PostgREST upsert can't target): clear any prior row for this message,
    // then insert.
    if (r.graph_id) await sb.from('email_messages').delete().eq('graph_id', r.graph_id);
    const { error } = await sb.from('email_messages').insert(r);
    if (error) { console.error('insert failed:', error.message, '(migration 261 applied?)'); process.exit(1); }
    inserted++;
  }
  console.log(`\nAPPLIED: ${inserted} email_messages rows written.`);
})().catch((e) => { console.error('ERR', e.stack || e.message); process.exit(1); });
