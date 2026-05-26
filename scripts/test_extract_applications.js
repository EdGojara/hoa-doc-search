// scripts/test_extract_applications.js
// ----------------------------------------------------------------------------
// Brief 01 acceptance harness — runs extractApplication() on the three real
// packets and prints the result. Uses persist=false so the test doesn't write
// to application_extractions (test-only).
//
// Run: node scripts/test_extract_applications.js
//      node scripts/test_extract_applications.js --fixture nguyen
//      node scripts/test_extract_applications.js --persist   (writes to DB)
// ----------------------------------------------------------------------------

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { extractApplication } = require('../lib/applications/extraction');

const PERSIST = process.argv.includes('--persist');
const FIXTURE = (process.argv.find((a) => a.startsWith('--fixture=')) || '').split('=')[1];

// Fixture descriptors. applicationId / communityId are placeholders — for a
// real test against the DB use --persist and pass real community ids.
const FIXTURES = [
  {
    name: 'nguyen-patio',
    applicationId: 'test-nguyen-patio',
    communityId: 'a0000000-0000-4000-8000-000000000001', // Waterview Estates
    formFields: {
      homeowner_name: 'Harriette Nguyen',
      homeowner_email: 'nguyen.harriette@gmail.com',
      homeowner_phone: '832-812-8800',
      property_address: '4910 Beech Fern Dr, Richmond, TX 77407',
      request_summary: 'Extend patio cover to home — 14x12 covered structure',
      project_completion_date: '1 week',
    },
    files: [{
      fileId: 'nguyen-packet-pdf',
      filePath: 'C:/Users/edget/OneDrive - Bedrock Association Management, LLC/BEDROCK/Client - Waterview Estates/ACC/2026/April/4910 Beech Fern Dr..pdf',
      mimeType: 'application/pdf',
      originalName: '4910 Beech Fern Dr..pdf',
    }],
    expected: {
      requestType: 'patio_or_cover',
      hasOrderSummary: false, // it's a contractor estimate
      hasContractorEstimate: true,
      hasSurvey: true,
      hasElevation: true,
    },
  },
  {
    name: 'janabi-tree',
    applicationId: 'test-janabi-tree',
    communityId: 'a0000000-0000-4000-8000-000000000001',
    formFields: {
      homeowner_name: 'Riyadh Janabi',
      homeowner_email: 'riadhkadhim@yahoo.com',
      homeowner_phone: '832-596-2608',
      property_address: '19710 Moss Bark Trail, Richmond, TX 77407',
      request_summary: 'Tree replacement',
      project_completion_date: '3-4 days',
    },
    files: [{
      fileId: 'janabi-packet-pdf',
      filePath: 'C:/Users/edget/OneDrive - Bedrock Association Management, LLC/BEDROCK/Client - Waterview Estates/ACC/2026/April/19710 Moss Bark Trail.pdf',
      mimeType: 'application/pdf',
      originalName: '19710 Moss Bark Trail.pdf',
    }],
    expected: {
      requestType: 'tree_removal_or_replacement',
      specsEmpty: true, // no specs for tree replacement
      hasPropertyPhoto: true,
    },
  },
  {
    name: 'dejesus-windows',
    applicationId: 'test-dejesus-windows',
    communityId: 'a0000000-0000-4000-8000-000000000003', // Canyon Gate
    formFields: {
      homeowner_name: 'DeJesus',
      property_address: '6227 Piedra Negras Ct, Katy, TX 77450', // intentionally uses real address — file name typo says 5227 but content says 6227
      request_summary: 'Window and door replacement — 3 windows + 1 entry door',
      project_start_date: '07/06/2026',
      project_completion_date: '07/06/2026',
    },
    files: [{
      fileId: 'dejesus-packet-pdf',
      filePath: 'C:/Users/edget/AppData/Local/Temp/canyon_gate_dejesus.pdf',
      mimeType: 'application/pdf',
      originalName: 'dejesus-windows.pdf',
    }],
    expected: {
      requestType: 'window_and_door_replacement',
      hasOrderSummary: true,
      hasPropertyPhoto: true,
      hasSurvey: false,
      flagImplausibleDates: true, // start === completion
      unitMatchStatus: 'matched', // 6227 Piedra Negras Ct — not "5227" from filename
    },
  },
];

function loadBufferFromFile(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`fixture file not found: ${filePath}`);
  return fs.readFileSync(filePath);
}

function printSummary(name, result) {
  const { application, validation } = result;
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`Fixture: ${name}`);
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`Application ID:        ${application.applicationId}`);
  console.log(`Request type:          ${application.request.requestType.value}  (conf ${application.request.requestType.provenance.confidence.toFixed(2)})`);
  console.log(`Unit match status:     ${application.unitMatchStatus}`);
  console.log(`Extraction confidence: ${application.extractionConfidence}`);
  console.log(`Ready for evaluation:  ${application.readyForEvaluation}`);
  console.log(`Schema valid:          ${validation.ok} ${validation.ok ? '' : ' (' + validation.errors.length + ' errors)'}`);

  console.log('\nAttachments present:');
  for (const [k, v] of Object.entries(application.attachmentsPresent)) {
    if (v) console.log(`  ✓ ${k}`);
  }

  console.log(`\nDocuments classified (${application.documents.length}):`);
  application.documents.forEach((d, i) => {
    console.log(`  [${i + 1}] ${d.documentType} (conf ${d.confidence.toFixed(2)}, ${d.pages} pages)`);
  });

  console.log(`\nValidation flags (${application.validationFlags.length}):`);
  application.validationFlags.forEach((f) => {
    const sevColor = f.severity === 'block' ? '🛑' : (f.severity === 'warn' ? '⚠' : 'ℹ');
    console.log(`  ${sevColor} [${f.severity}] ${f.code}: ${f.message}${f.field ? ` (field: ${f.field})` : ''}`);
  });

  if (application.request.specs.length > 0) {
    console.log(`\nSpecs extracted (${application.request.specs.length}):`);
    application.request.specs.forEach((s, i) => {
      console.log(`  [${i + 1}] ${s.itemType}`);
      console.log(`        location:        ${s.location.value || '(null)'}`);
      console.log(`        dimensions:      ${s.dimensions.value || '(null)'}`);
      console.log(`        exteriorColor:   ${s.exteriorColor.value || '(null)'}`);
      console.log(`        material:        ${s.material.value || '(null)'}`);
      console.log(`        finishOrStyle:   ${s.finishOrStyle.value || '(null)'}`);
    });
  } else {
    console.log('\nSpecs extracted: 0');
  }

  if (!validation.ok) {
    console.log('\nSchema errors:');
    validation.errors.forEach((e) => console.log(`  - ${e}`));
  }
}

(async () => {
  const fixtures = FIXTURE ? FIXTURES.filter((f) => f.name === FIXTURE || f.name.startsWith(FIXTURE)) : FIXTURES;
  if (fixtures.length === 0) {
    console.error(`No fixture matched "${FIXTURE}". Available: ${FIXTURES.map((f) => f.name).join(', ')}`);
    process.exit(1);
  }

  console.log(`Running ${fixtures.length} fixture(s)${PERSIST ? ' [PERSIST=true → writes to DB]' : ' [PERSIST=false, ephemeral]'}\n`);

  for (const fx of fixtures) {
    let buffer;
    try {
      buffer = loadBufferFromFile(fx.files[0].filePath);
    } catch (e) {
      console.log(`\n══════════════════════════════════════════════════════════════`);
      console.log(`Fixture: ${fx.name} — SKIPPED`);
      console.log(`══════════════════════════════════════════════════════════════`);
      console.log(`  ${e.message}`);
      continue;
    }
    const fileWithBuffer = { ...fx.files[0], buffer };
    try {
      const result = await extractApplication({
        applicationId: fx.applicationId,
        communityId: fx.communityId,
        formFields: fx.formFields,
        files: [fileWithBuffer],
      }, { persist: PERSIST });
      printSummary(fx.name, result);
    } catch (err) {
      console.log(`\n══════════════════════════════════════════════════════════════`);
      console.log(`Fixture: ${fx.name} — FAILED`);
      console.log(`══════════════════════════════════════════════════════════════`);
      console.error(err);
    }
  }
})();
