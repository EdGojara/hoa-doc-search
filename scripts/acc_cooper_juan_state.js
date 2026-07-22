// One-off: what do we ALREADY have for Cooper + Medina across both ACC stores
// and the email inbox, so we merge into one record instead of duplicating.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const EMAILS = ['cooperandrea1@icloud.com', 'juanmedina57@gmail.com'];
const ADDR = '9211 Floral Crest';

(async () => {
  for (const em of EMAILS) {
    console.log('\n================= ' + em + ' =================');

    // 1) acc_decisions (email-intake store)
    const { data: ad, error: adErr } = await s.from('acc_decisions')
      .select('id, status, community_name, homeowner_name, homeowner_address, project_summary, decision_type, source, submitter_email, intake_source_ref, created_at')
      .ilike('submitter_email', em).order('created_at', { ascending: true });
    if (adErr) console.log('acc_decisions ERR:', adErr.message);
    else {
      console.log(`acc_decisions by submitter_email: ${ad.length}`);
      ad.forEach(r => console.log(`   [${r.status}] ${r.id.slice(0,8)} ${r.community_name} | ${r.homeowner_address || '(no addr)'} | ${(r.project_summary||'').slice(0,50)} | ${String(r.created_at).slice(0,10)}`));
    }

    // 2) community_applications (portal/staff store) — find its email/address cols
    const { data: ca, error: caErr } = await s.from('community_applications')
      .select('*').or(`applicant_email.ilike.${em},submitter_email.ilike.${em}`).limit(10);
    if (caErr) console.log('community_applications ERR (col guess):', caErr.message);
    else {
      console.log(`community_applications by email: ${ca.length}`);
      ca.forEach(r => console.log(`   [${r.status}] ${String(r.id).slice(0,8)} | ${r.property_address || r.address || ''} | ${(r.project_description||r.project_summary||'').slice(0,50)}`));
    }

    // 3) email inbox rows
    const { data: em2, error: emErr } = await s.from('email_messages')
      .select('id, subject, received_at, has_attachments, resolved_property_id, resolved_contact_id, classification, triage_status')
      .ilike('sender_email', em).order('received_at', { ascending: true });
    if (emErr) console.log('email_messages ERR:', emErr.message);
    else {
      console.log(`email_messages from sender: ${em2.length}`);
      em2.forEach(r => console.log(`   ${String(r.received_at).slice(0,10)} "${(r.subject||'').slice(0,40)}" att=${r.has_attachments} prop=${r.resolved_property_id?'Y':'-'} contact=${r.resolved_contact_id?'Y':'-'} class=${r.classification} triage=${r.triage_status}`));
    }
  }

  // Also: address-based search in both stores for Floral Crest (a submission may
  // have landed WITHOUT the email attached).
  console.log('\n================= ADDRESS: ' + ADDR + ' =================');
  const { data: ad2, error: ad2Err } = await s.from('acc_decisions')
    .select('id, status, community_name, homeowner_name, homeowner_address, submitter_email, created_at')
    .ilike('homeowner_address', `%${ADDR}%`);
  if (ad2Err) console.log('acc_decisions addr ERR:', ad2Err.message);
  else { console.log(`acc_decisions by address: ${ad2.length}`); ad2.forEach(r => console.log(`   [${r.status}] ${r.id.slice(0,8)} ${r.homeowner_address} | ${r.submitter_email||''}`)); }
})();
