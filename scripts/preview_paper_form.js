// Render a sample Paper Nomination Form HTML so Ed can preview it in the
// browser before deploying. Uses Canyon Gate + Waterview samples.

const fs = require('fs');
const path = require('path');
const { renderPaperFormHTML } = require('../lib/nominations/paper_form');

const canyonGate = {
  community_name: 'Canyon Gate at Cinco Ranch',
  association_legal_name: 'Canyon Gate at Cinco Ranch Homeowners Association, Inc.',
  nominations_close_at: '2026-05-04',
  nominations_close_time: '5:00 PM',
  onsite_drop_off: {
    enabled: true,
    location_name: 'Canyon Gate Rec Center',
    address: '20422 Canyon Gate Blvd, Katy, TX 77450',
  },
};
const waterview = {
  community_name: 'Waterview Estates',
  association_legal_name: "Waterview Estates Owners' Association, Inc.",
  nominations_close_at: '2024-05-17',
  nominations_close_time: '12:00 PM',
  onsite_drop_off: {
    enabled: true,
    location_name: 'Waterview Estates On-Site Office',
    address: '5110 Waterview Estates Trail, Richmond, TX 77407',
  },
};

async function main() {
  const downloads = path.join(process.env.USERPROFILE || process.env.HOME || '.', 'Downloads');
  if (!fs.existsSync(downloads)) fs.mkdirSync(downloads, { recursive: true });

  const cg = await renderPaperFormHTML(canyonGate);
  const cgPath = path.join(downloads, 'PREVIEW_Paper_Nomination_Form_Canyon_Gate.html');
  fs.writeFileSync(cgPath, cg, 'utf8');

  const wv = await renderPaperFormHTML(waterview);
  const wvPath = path.join(downloads, 'PREVIEW_Paper_Nomination_Form_Waterview.html');
  fs.writeFileSync(wvPath, wv, 'utf8');

  console.log('Canyon Gate paper form: ' + cgPath);
  console.log('Waterview paper form:   ' + wvPath);
}

main().catch((e) => { console.error(e); process.exit(1); });
