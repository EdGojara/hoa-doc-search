#!/usr/bin/env node
// ============================================================================
// scripts/import_email_folder.js  (Ed 2026-07-06)
// ----------------------------------------------------------------------------
// Batch-file a folder of saved emails (.msg/.eml) into trustEd as ASSOCIATION
// HISTORY — each one filed where it belongs: homeowner correspondence onto the
// homeowner (360), vendor/invoice mail onto the vendor. This is a RECORD of
// what happened, NOT payment (invoices here are history only; AP/payment is a
// separate feature). Dry-run by default; --apply writes.
//
//   node -r dotenv/config scripts/import_email_folder.js "<folder>" [--apply]
// ============================================================================
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { classifyAndExtract } = require('../lib/email/triage');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const FOLDER = process.argv[2];
const APPLY = process.argv.includes('--apply');
const VENDOR_CLASSES = new Set(['vendor_financial', 'vendor_general']);

async function parseFile(fp) {
  const buf = fs.readFileSync(fp);
  if (/\.eml$/i.test(fp)) {
    const { simpleParser } = require('mailparser');
    const p = await simpleParser(buf);
    const f = p.from && p.from.value && p.from.value[0];
    return { subject: p.subject || '', body: p.text || '', senderEmail: f ? f.address : null, senderName: f ? f.name : null, dateISO: p.date ? new Date(p.date).toISOString() : null };
  }
  const MsgReader = require('@kenjiuno/msgreader').default || require('@kenjiuno/msgreader');
  const d = new MsgReader(buf).getFileData();
  const dt = d.messageDeliveryTime || d.clientSubmitTime || d.creationTime;
  return { subject: d.subject || '', body: d.body || '', senderName: d.senderName || null, senderEmail: (d.senderEmail && !/^\/o=/i.test(d.senderEmail)) ? d.senderEmail : null, dateISO: dt ? new Date(dt).toISOString() : null };
}

let COMMS = [];
function matchCommunity(hint) {
  if (!hint) return null; const h = String(hint).toLowerCase();
  return COMMS.find((c) => { const n = String(c.name || '').toLowerCase(); return n && (n.includes(h) || h.includes(n.split(' ')[0])); }) || null;
}
async function resolveHomeowner(parsed, ex) {
  let contact_id = null, property_id = null, community_id = null, label = null;
  if (parsed.senderEmail && !/@bedrocktx\.com$/i.test(parsed.senderEmail)) {
    const { data } = await sb.from('contacts').select('id, full_name').or(`primary_email.ilike.${parsed.senderEmail},secondary_email.ilike.${parsed.senderEmail}`).limit(1);
    if (data && data[0]) { contact_id = data[0].id; label = data[0].full_name; const { data: o } = await sb.from('property_ownerships').select('property_id, properties(community_id)').eq('contact_id', contact_id).is('end_date', null).limit(1); if (o && o[0]) { property_id = o[0].property_id; community_id = o[0].properties ? o[0].properties.community_id : null; } }
  }
  if (!property_id) for (const addr of [...(ex.addresses || []), parsed.subject]) {
    const num = (String(addr).match(/(\d{3,6})/) || [])[1]; const street = String(addr).replace(/.*?\d{3,6}\s*/, '').replace(/,.*$/, '').trim().split(/\s+/).slice(0, 2).join(' ');
    if (!num || !street || street.length < 3) continue;
    const { data: props } = await sb.from('properties').select('id, street_address, community_id').ilike('street_address', `${num} ${street}%`).limit(3);
    const p = (props || []).find((x) => x.street_address.trim().startsWith(num)); if (p) { property_id = p.id; community_id = community_id || p.community_id; const { data: o } = await sb.from('property_ownerships').select('contact_id, contacts(full_name)').eq('property_id', p.id).is('end_date', null).limit(1); if (o && o[0]) { contact_id = contact_id || o[0].contact_id; label = label || (o[0].contacts ? o[0].contacts.full_name : null); } label = label || p.street_address; break; }
  }
  const comm = matchCommunity(ex.community_hint); if (comm && !community_id) community_id = comm.id;
  return { contact_id, property_id, community_id, label };
}
async function resolveVendor(parsed, ex) {
  let vendor_id = null, label = ex.vendor_name || null, community_id = null;
  const from = (parsed.senderEmail || '').toLowerCase();
  if (from) { const { data } = await sb.from('vendors').select('id, name').or(`email.ilike.${from},contact_email.ilike.${from}`).limit(1); if (data && data[0]) { vendor_id = data[0].id; label = data[0].name; } }
  if (!vendor_id && ex.vendor_name) { const { data } = await sb.from('vendors').select('id, name').ilike('name', `%${String(ex.vendor_name).split(/\s+/)[0]}%`).limit(1); if (data && data[0]) { vendor_id = data[0].id; label = data[0].name; } }
  const comm = matchCommunity(ex.community_hint); if (comm) community_id = comm.id;
  return { vendor_id, community_id, label };
}

(async () => {
  if (!FOLDER) { console.error('usage: "<folder>" [--apply]'); process.exit(1); }
  ({ data: COMMS } = await sb.from('communities').select('id, name'));
  const files = fs.readdirSync(FOLDER).filter((f) => /\.(msg|eml)$/i.test(f));
  console.log(`${files.length} email files in ${FOLDER}\n`);
  const rows = [];
  for (const f of files) {
    let parsed, ex;
    try { parsed = await parseFile(path.join(FOLDER, f)); } catch (e) { console.log(`  SKIP ${f}: parse failed (${e.message})`); continue; }
    try { ex = await classifyAndExtract({ subject: parsed.subject, body_full: parsed.body, sender_email: parsed.senderEmail }); } catch (_) { ex = { classification: 'other', addresses: [] }; }
    const isVendor = VENDOR_CLASSES.has(ex.classification) || (!!ex.vendor_name && ex.classification !== 'homeowner_request');
    const r = isVendor ? await resolveVendor(parsed, ex) : await resolveHomeowner(parsed, ex);
    const track = isVendor ? 'VENDOR' : 'HOMEOWNER';
    const target = isVendor ? (r.vendor_id ? `vendor:${r.label}` : (r.label ? `vendor(new):${r.label}` : 'UNRESOLVED')) : (r.contact_id || r.property_id ? `homeowner:${r.label}` : 'UNRESOLVED');
    console.log(`  ${track.padEnd(9)} [${(ex.classification || '').padEnd(16)}] ${f.slice(0, 34).padEnd(34)} -> ${target}`);
    rows.push({ f, parsed, ex, isVendor, r });
  }

  if (!APPLY) { console.log('\nDRY RUN — pass --apply to file these into association history.'); return; }
  let filed = 0, skipped = 0;
  for (const { f, parsed, ex, isVendor, r } of rows) {
    // Skip homeowner-track mail we couldn't place — don't create orphan records.
    // Those get filed manually via the 360 drop-zone (search-to-pick).
    if (!isVendor && !r.contact_id && !r.property_id) { console.log(`  SKIP (needs manual filing): ${f}`); skipped++; continue; }
    const isOut = parsed.senderEmail && /@bedrocktx\.com$/i.test(parsed.senderEmail);
    const row = {
      mailbox: 'imported', direction: isOut ? 'outbound' : 'inbound', sender_email: parsed.senderEmail, sender_name: parsed.senderName, recipients: [],
      subject: parsed.subject || '(no subject)', body_preview: String(parsed.body).replace(/\s+/g, ' ').trim().slice(0, 2000), received_at: parsed.dateISO, has_attachments: false,
      classification: ex.classification || 'imported', classification_confidence: 'medium', ai_summary: ex.summary || parsed.subject,
      extracted: { imported: true, source_file: f, vendor_label: isVendor ? r.label : undefined },
      community_id: r.community_id || null, resolved_contact_id: isVendor ? null : (r.contact_id || null), resolved_property_id: isVendor ? null : (r.property_id || null), resolved_vendor_id: isVendor ? (r.vendor_id || null) : null,
      resolution_confidence: 'medium', triage_status: 'linked', record_ownership: 'association_record',
    };
    const { error } = await sb.from('email_messages').insert(row);
    if (error) { console.log(`  insert failed ${f}: ${error.message}`); continue; }
    filed++;
  }
  console.log(`\nAPPLIED: filed ${filed} of ${rows.length} into association history.`);
})().catch((e) => { console.error('ERR', e.stack || e.message); process.exit(1); });
