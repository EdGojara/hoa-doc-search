// Enrich each AI teammate's M365 profile (job title, department, company) so
// their Outlook contact card reads like a real person, alongside the photo
// (Ed 2026-09-01). Needs User.ReadWrite.All (same grant as the photos).
//   node scripts/set_team_profiles.js            (dry run)
//   node scripts/set_team_profiles.js --apply
require('dotenv').config();
const g = require('../lib/email/graph_send');
const CO = 'Bedrock Association Management';
const TEAM = [
  ['claire',  g.CLAIRE_MAILBOX,  'Customer Support Specialist',        'Community Management'],
  ['emma',    g.EMMA_MAILBOX,    'Accounts Payable Specialist',        'Accounting'],
  ['kat',     g.KAT_MAILBOX,     'Accounting Manager',                 'Accounting'],
  ['annie',   g.ANNIE_MAILBOX,   'Architectural Review Coordinator',   'Architectural Review'],
  ['miranda', g.MIRANDA_MAILBOX, 'Compliance Coordinator',             'Compliance'],
  ['amanda',  g.AMANDA_MAILBOX,  'Senior Community Manager',           'Community Management'],
  ['reese',   g.REESE_MAILBOX,   'Resale & Estoppel Coordinator',      'Resale & Transfers'],
  ['darby',   g.DARBY_MAILBOX,   'Legal & Collections Coordinator',    'Legal & Collections'],
  ['paige',   g.PAIGE_MAILBOX,   'Board Operations Coordinator',       'Board Operations'],
  ['tessa',   g.TESSA_MAILBOX,   'Executive Assistant',                'Administration'],
];
const APPLY = process.argv.includes('--apply');
(async()=>{
  if(!g.isConfigured()){ console.log('Graph not configured'); return; }
  const token = await g.getToken();
  for(const [persona, mailbox, title, dept] of TEAM){
    if(!mailbox){ console.log(`  ${persona}: no mailbox, skip`); continue; }
    if(!APPLY){ console.log(`  would set ${persona} -> ${title} · ${dept} · ${CO}`); continue; }
    try {
      const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}`, {
        method:'PATCH', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
        body: JSON.stringify({ jobTitle:title, department:dept, companyName:CO }) });
      if(r.ok || r.status===204){ console.log(`  ✓ ${persona}: ${title}`); }
      else { const t=await r.text(); console.log(`  ✗ ${persona} (${r.status}): ${t.slice(0,140)}`); }
    } catch(e){ console.log(`  ✗ ${persona}: ${e.message}`); }
  }
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
