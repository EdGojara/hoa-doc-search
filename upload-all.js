const { execSync } = require('child_process');

const files = [
  // Waterview Estates - Core Governing Documents
  { path: 'docs/Waterview-Covenants-Conditions-Restrictions.pdf', community: 'Waterview Estates' },
  { path: 'docs/Declaration 2004051859.pdf', community: 'Waterview Estates' },
  { path: 'docs/Amended Declaration .pdf', community: 'Waterview Estates' },
  { path: 'docs/Second Amendment to Declaration 2007048797.pdf', community: 'Waterview Estates' },
  { path: 'docs/ByLaws .pdf', community: 'Waterview Estates' },
  { path: 'docs/First Amendment to the Bylaws.pdf', community: 'Waterview Estates' },
  { path: 'docs/Articles, ByLaws & Amendement to Bylaws .pdf', community: 'Waterview Estates' },
  // Rules and Regulations
  { path: 'docs/Rules and Regulations 2015-06-22.pdf', community: 'Waterview Estates' },
  { path: 'docs/Rules and Regulations and Policies .pdf', community: 'Waterview Estates' },
  { path: 'docs/20151117 Rules and Regulations.docx', community: 'Waterview Estates' },
  { path: 'docs/Governing Documents.pdf', community: 'Waterview Estates' },
  // Architectural and Design
  { path: 'docs/ARC-Guidelines.pdf', community: 'Waterview Estates' },
  { path: 'docs/Architectural Guidelines - WVE.pdf', community: 'Waterview Estates' },
  { path: 'docs/Approved Plant List.pdf', community: 'Waterview Estates' },
  { path: 'docs/Approved-Tree-List.pdf', community: 'Waterview Estates' },
  { path: 'docs/Master Plant List.pdf', community: 'Waterview Estates' },
  { path: 'docs/STH.pdf', community: 'Waterview Estates' },
  // Pool and Amenity Rules
  { path: 'docs/Final-Pool-Rules.pdf', community: 'Waterview Estates' },
  { path: 'docs/20200623 Amended Pool Rules.pdf', community: 'Waterview Estates' },
  { path: 'docs/20200623 Amended Tennis Rules.pdf', community: 'Waterview Estates' },
  { path: 'docs/Waterview Estates Rules for Tennis Courts.pdf', community: 'Waterview Estates' },
  { path: 'docs/Waterview Estates View Estates Pool Policy.pdf', community: 'Waterview Estates' },
  { path: 'docs/Waterview Estates Waiver and Indemnification for use of POA pool and tennis facilities.pdf', community: 'Waterview Estates' },
  // Basketball
  { path: 'docs/Basketball Hiatus - Filed .pdf', community: 'Waterview Estates' },
  // Policies and Resolutions
  { path: 'docs/DRV Fining Policy .pdf', community: 'Waterview Estates' },
  { path: 'docs/Payment Plan Policy.pdf', community: 'Waterview Estates' },
  { path: 'docs/2013 Collection Policy .pdf', community: 'Waterview Estates' },
  { path: 'docs/Resale Certificate of Compliance Resolution .pdf', community: 'Waterview Estates' },
  { path: 'docs/Garage Sale Guidelines - Filed.pdf', community: 'Waterview Estates' },
  { path: 'docs/Waterview Estates DR Violation Hearing Policy.docx', community: 'Waterview Estates' },
  { path: 'docs/WATERVIEW ESTATES Bid Policy (2).docx', community: 'Waterview Estates' },
  { path: 'docs/WATERVIEW ESTATES Religious Display Policy.docx', community: 'Waterview Estates' },
  { path: 'docs/Waterview Estates Security Measures Policy.docx', community: 'Waterview Estates' },
  { path: 'docs/17200614 Clubhouse Rental Agreement.pdf', community: 'Waterview Estates' },
  // Legislative Policies
  { path: 'docs/2012 Legislative Policies .pdf', community: 'Waterview Estates' },
  { path: 'docs/2012 Legislative Policy - Collection Policy.pdf', community: 'Waterview Estates' },
  { path: 'docs/2012 Legislative Policy - Open Records Policy.pdf', community: 'Waterview Estates' },
  { path: 'docs/2012 Legislative Policy - Payment Plan policy.pdf', community: 'Waterview Estates' },
  { path: 'docs/2012 Legislative Policy - Records Retention Policy.pdf', community: 'Waterview Estates' },
  { path: 'docs/Supplemental Notice of Dedicatory Instruments_2025 Updates.pdf', community: 'Waterview Estates' },
  { path: 'docs/Supplemental Notice of Dedictory for 2012 Legislative Policies.pdf', community: 'Waterview Estates' },
  // MUD Agreements
  { path: 'docs/Third Amendment to Agreement_Waterview Estates MUD 143 2019.pdf', community: 'Waterview Estates' },
  { path: 'docs/Third Amendment to Agreement_Waterview Estates.pdf', community: 'Waterview Estates' },
  // Corporate
  { path: 'docs/032119 Change of Resident Agent.pdf', community: 'Waterview Estates' },
  { path: 'docs/2014 Budget and Assessment Resolution .pdf', community: 'Waterview Estates' },
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