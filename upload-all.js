const { execSync } = require('child_process');

const files = [
  // Lakes of Pine Forest - Core Documents
  { path: 'docs/Master Declaration of Covenants, Conditions and Restrictions.pdf', community: 'Lakes of Pine Forest' },
  { path: 'docs/By-Laws.pdf', community: 'Lakes of Pine Forest' },
  { path: 'docs/Amended Bylaws and Builder Guidelines 2015.pdf', community: 'Lakes of Pine Forest' },
  { path: 'docs/Builder Guidelines.pdf', community: 'Lakes of Pine Forest' },
  { path: 'docs/Fence Update to Builder Guidelines.pdf', community: 'Lakes of Pine Forest' },
  { path: 'docs/Amendment to the Builder Guidelines Fencing.pdf', community: 'Lakes of Pine Forest' },
  { path: 'docs/Assessment Policy.pdf', community: 'Lakes of Pine Forest' },
  { path: 'docs/Parking and Towing Policy.pdf', community: 'Lakes of Pine Forest' },
  { path: 'docs/LOPF Parking Policy notarized.pdf', community: 'Lakes of Pine Forest' },
  { path: 'docs/Books and Records Policy.pdf', community: 'Lakes of Pine Forest' },
  { path: 'docs/Payment Plan Policy.pdf', community: 'Lakes of Pine Forest' },
  { path: 'docs/Articles of Incorporation.pdf', community: 'Lakes of Pine Forest' },
  { path: 'docs/LOPF Resolutions.pdf', community: 'Lakes of Pine Forest' },
  { path: 'docs/LOPF Resolution - Fining Policy.pdf', community: 'Lakes of Pine Forest' },
  { path: 'docs/Quorum Amendment to Bylaws.pdf', community: 'Lakes of Pine Forest' },
  { path: 'docs/LOPF_Fining_Policy_Summary.txt', community: 'Lakes of Pine Forest' },
  { path: 'docs/Solar Panel and Rain Barrel Regulations.pdf', community: 'Lakes of Pine Forest' },
  { path: 'docs/Records Retention Policy.pdf', community: 'Lakes of Pine Forest' },
  { path: 'docs/Supplemental Deed.pdf', community: 'Lakes of Pine Forest' },
  { path: 'docs/FILED BOD Resolution - Rental Leasing Policy.pdf', community: 'Lakes of Pine Forest' },
  { path: 'docs/Board Resolution Regarding Dissolution of Fence Assessment.pdf', community: 'Lakes of Pine Forest' },
  { path: 'docs/Amended Recorded [Lakes of Pine Forest] Notice of Filing of Dedicatory Instruments - Policies and Rules.pdf', community: 'Lakes of Pine Forest' },
  { path: 'docs/Recorded [Lakes of Pine Forest] Amended and Restated Management Certificate RP-2025-30596.pdf', community: 'Lakes of Pine Forest' },
  { path: 'docs/Resolution - Fining Policy.pdf', community: 'Lakes of Pine Forest' },
  // Law - Applies to all communities
  { path: 'docs/Texas_Chapter_209_Summary.txt', community: 'Law' },
  { path: 'docs/texascode209.pdf', community: 'Law' },
];

async function runAll() {
  for (const file of files) {
    console.log(`\n=============================`);
    console.log(`Uploading: ${file.path}`);
    console.log(`Community: ${file.community}`);
    console.log(`=============================\n`);
    try {
      execSync(`node upload.js "${file.path}" "${file.community}"`, { stdio: 'inherit' });
    } catch (err) {
      console.log(`Error uploading ${file.path} — skipping and continuing`);
    }
  }
  console.log('\nAll files uploaded!');
}

runAll().catch(console.error);