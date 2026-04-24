const { execSync } = require('child_process');

const files = [
  { path: 'docs/LOPF Parking Policy notarized.pdf', community: 'Lakes of Pine Forest' },
  { path: 'docs/LOPF Quorum Amendment to Bylaws.pdf', community: 'Lakes of Pine Forest' },
  { path: 'docs/LOPF Resolution - Fining Policy.pdf', community: 'Lakes of Pine Forest' },
  { path: 'docs/LOPF Resolutions.pdf', community: 'Lakes of Pine Forest' },
  { path: 'docs/LOPF_Fining_Policy_Summary.txt', community: 'Lakes of Pine Forest' },
  { path: 'docs/texascode209.pdf', community: 'Law' },
  { path: 'docs/Texas_Chapter_209_Summary.txt', community: 'Law' },
];

async function runAll() {
  for (const file of files) {
    console.log(`\n=============================`);
    console.log(`Uploading: ${file.path}`);
    console.log(`Community: ${file.community}`);
    console.log(`=============================\n`);
    execSync(`node upload.js "${file.path}" "${file.community}"`, { stdio: 'inherit' });
  }
  console.log('\nAll files uploaded!');
}

runAll().catch(console.error);