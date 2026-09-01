// Set each AI teammate's Microsoft 365 / Outlook profile photo from their
// portrait, so recipients see a real face next to their emails (Ed 2026-09-01:
// "give people the feeling that our AI team is real"). Needs Graph app
// permission User.ReadWrite.All (the mail app has Mail.Send only) — a 403 means
// that permission + admin consent must be granted in Azure first.
//   node scripts/set_team_photos.js            (dry run: show the plan)
//   node scripts/set_team_photos.js --only=amanda   (probe one)
//   node scripts/set_team_photos.js --apply         (set all)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const g = require('../lib/email/graph_send');
const DIR = path.join(__dirname, '..', 'public', 'assets', 'presentations', 'team');
const TEAM = [
  ['claire', g.CLAIRE_MAILBOX], ['emma', g.EMMA_MAILBOX], ['amanda', g.AMANDA_MAILBOX],
  ['annie', g.ANNIE_MAILBOX], ['miranda', g.MIRANDA_MAILBOX], ['paige', g.PAIGE_MAILBOX],
  ['reese', g.REESE_MAILBOX], ['kat', g.KAT_MAILBOX], ['darby', g.DARBY_MAILBOX], ['tessa', g.TESSA_MAILBOX],
];
const APPLY = process.argv.includes('--apply');
const only = (process.argv.find(a=>a.startsWith('--only='))||'').split('=')[1];
(async()=>{
  if(!g.isConfigured()){ console.log('Graph not configured'); return; }
  const token = await g.getToken();
  let list = TEAM.filter(([p])=>!only || p===only);
  for(const [persona, mailbox] of list){
    const file = path.join(DIR, persona+'.jpg');
    if(!fs.existsSync(file)){ console.log(`  ${persona}: no photo file, skip`); continue; }
    if(!mailbox){ console.log(`  ${persona}: no mailbox, skip`); continue; }
    if(!APPLY){ console.log(`  would set ${persona} -> ${mailbox} (${(fs.statSync(file).size/1024|0)}KB)`); continue; }
    try {
      const buf = fs.readFileSync(file);
      const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/photo/$value`, {
        method:'PUT', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'image/jpeg' }, body: buf });
      if(r.ok || r.status===200 || r.status===204){ console.log(`  ✓ ${persona} -> ${mailbox}`); }
      else { const t = await r.text(); console.log(`  ✗ ${persona} (${r.status}): ${t.slice(0,160)}`); }
    } catch(e){ console.log(`  ✗ ${persona}: ${e.message}`); }
  }
  if(!APPLY) console.log('\n(dry run — pass --apply to set, or --only=amanda to probe one)');
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
