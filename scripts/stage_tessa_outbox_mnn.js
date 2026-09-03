// Stage the My Neighborhood News demo items in Tessa's outbox.
//   1) uploads the rendered NDA PDF to the documents bucket
//   2) queues the NDA EMAIL (from Tessa, cc Johnny + Ed, NDA attached)
//   3) queues the Sept 9 MEETING (organizer Tessa; Tiffany, Johnny, Ed as attendees)
// Run AFTER migration 405 is applied. Nothing here sends anything — the items
// wait in Tessa's outbox for Ed to release.
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { createClient } = require(path.join(__dirname, '..', 'node_modules', '@supabase', 'supabase-js'));

const TIFFANY = 'tiffany@myneighborhoodnews.com';
const JOHNNY = 'johnny@myneighborhoodnews.com';
const ED = 'egojara@bedrocktx.com';
const TESSA = 'tessa@bedrocktx.com';
const LOCATION = 'Bedrock Association Management, 12808 W Airport Blvd, Ste 253, Sugar Land, TX 77478 — Conference Room';

const EMAIL_BODY = [
  'Hi Tiffany,',
  "I'm Tessa, Ed Gojara's assistant at Bedrock. Ed asked me to send this over ahead of your visit.",
  "We'd love to host you and Johnny at our Sugar Land office on Wednesday, September 9 from 10:00 to 1:00. Ed will walk you both through the trustEd platform, you can show us yours, and we'll get into where the two fit together. Lunch is on us.",
  'Because Ed will be showing you a good deal of how the platform works under the hood, I’ve attached a mutual NDA for signature. It protects both sides equally, so everyone can speak openly about their platform. Please look it over when you have a moment, and we can sign at the meeting or sooner if you prefer. One note: I’ve listed "My Neighborhood News" as your company on the signature page. If your signing entity is different, just let me know and I’ll update it.',
  'A separate calendar invitation for the 9th is on its way. Please let me know if any of the details need adjusting.',
  'Looking forward to it.',
].join('\n\n');

const MEETING_BODY = [
  'Agenda:',
  '• trustEd platform walkthrough (Bedrock)\n• My Neighborhood News platform overview\n• Where the two can work together',
  'Lunch provided. Please come to the Bedrock conference room at 12808 W Airport Blvd, Ste 253, Sugar Land, TX 77478.',
].join('\n\n');

(async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

  // 1) upload the NDA PDF
  const ndaLocal = process.env.NDA_PDF || path.join(__dirname, 'NDA_My_Neighborhood_News.pdf');
  if (!fs.existsSync(ndaLocal)) { console.error('NDA PDF not found at', ndaLocal, '- set NDA_PDF'); process.exit(1); }
  const buf = fs.readFileSync(ndaLocal);
  const storagePath = `tessa-outbox/mutual-nda-my-neighborhood-news-${Date.now()}.pdf`;
  const up = await supabase.storage.from('documents').upload(storagePath, buf, { contentType: 'application/pdf', upsert: true });
  if (up.error) { console.error('UPLOAD FAILED:', up.error.message); process.exit(1); }
  console.log('Uploaded NDA ->', storagePath, '(' + buf.length + ' bytes)');

  // 2) queue the email
  const emailRow = {
    kind: 'email', status: 'queued',
    title: 'Mutual NDA to Tiffany Krenek (My Neighborhood News)',
    note: 'Sends from Tessa, copies Ed. NDA attached. Ahead of the Sept 9 meeting.',
    to_emails: TIFFANY, cc_emails: `${JOHNNY}, ${ED}`,
    subject: 'Mutual NDA and our September 9 meeting',
    body_text: EMAIL_BODY,
    attachment_path: storagePath, attachment_name: 'Mutual NDA - Bedrock & My Neighborhood News.pdf',
    attachment_mime: 'application/pdf', attachment_bucket: 'documents',
    created_by: 'setup',
  };

  // 3) queue the meeting
  const meetingRow = {
    kind: 'meeting', status: 'queued',
    title: 'Sept 9 platform demo + collaboration (My Neighborhood News)',
    note: 'Tessa is the organizer; Ed is an attendee. In person, Bedrock conference room. Hybrid Teams link included.',
    subject: 'Bedrock & My Neighborhood News — platform demo + collaboration',
    body_text: MEETING_BODY,
    organizer: TESSA,
    meeting_start: '2026-09-09T10:00:00', meeting_end: '2026-09-09T13:00:00',
    meeting_time_zone: 'Central Standard Time',
    meeting_location: LOCATION,
    meeting_attendees: `${TIFFANY}, ${JOHNNY}, ${ED}`,
    created_by: 'setup',
  };

  for (const [label, row] of [['email', emailRow], ['meeting', meetingRow]]) {
    const { data, error } = await supabase.from('tessa_outbox').insert(row).select('id').single();
    if (error) {
      if (/could not find|does not exist|42P01|schema cache/i.test(error.message)) {
        console.error('tessa_outbox not found — apply migration 405 first, then re-run.');
        process.exit(2);
      }
      console.error(`INSERT ${label} FAILED:`, error.message); process.exit(1);
    }
    console.log(`Queued ${label}:`, data.id);
  }
  console.log('\nDone. Both items are waiting in Tessa’s outbox for Ed to release.');
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
