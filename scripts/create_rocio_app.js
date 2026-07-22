// Create Rocio Munoz's Waterview ACC application from the form she attached
// (Ed 2026-07-22). Her filed email's Graph id is stale so attachments can't be
// re-fetched; build it from the .msg Ed forwarded. Uploads the ARC form + photo,
// lands one pending_review record, and queues a "received, under review"
// acknowledgment (nothing asked — she gave us a complete application).
// Idempotent on intake_source_ref.
require('dotenv').config();
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const MsgReader = require('@kenjiuno/msgreader').default || require('@kenjiuno/msgreader');
const { queueDraft } = require('../lib/email/outbound_drafts');

const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK = '00000000-0000-0000-0000-000000000001';
const WATERVIEW = 'a0000000-0000-4000-8000-000000000001';
const SRC_REF = 'email:patio-approval-rocio-2026-07-09';
const MSG = 'C:/Users/edget/AppData/Local/Temp/Patio Approval.msg';

(async () => {
  // Idempotency.
  const { data: exist } = await s.from('acc_decisions').select('id').eq('intake_source_ref', SRC_REF).limit(1);
  if (exist && exist.length) { console.log('application already exists:', exist[0].id); return; }

  // Pull the form + photo out of the .msg.
  const m = new MsgReader(fs.readFileSync(MSG));
  const d = m.getFileData();
  const files = [];
  for (const a of d.attachments || []) {
    const c = m.getAttachment(a);
    files.push({ name: a.fileName, buf: Buffer.from(c.content), isPdf: /\.pdf$/i.test(a.fileName) });
  }
  console.log('attachments from .msg:', files.map((f) => f.name + (f.isPdf ? ' [pdf]' : '')).join(', '));

  // Reference number.
  let reference = null;
  try { const { nextReferenceNumber } = require('../api/applications'); reference = await nextReferenceNumber(WATERVIEW, 'resident_acc', 'WVE-ARC'); } catch (e) { console.warn('ref gen skipped:', e.message); }

  // One pending_review record.
  const { data: rec, error } = await s.from('acc_decisions').insert({
    management_company_id: BEDROCK, community_id: WATERVIEW, community_name: 'Waterview Estates',
    homeowner_name: 'Rocio Munoz', homeowner_address: '20014 Juniper Berry Dr, Richmond, TX 77407',
    project_summary: 'Backyard patio, approx. 8 ft x 34 ft, concrete pavers, with a painted aluminum patio cover color-matched to the home. Within property boundaries; no encroachment on common areas or easements.',
    reference_number: reference, status: 'pending_review', source: 'email',
    submitter_email: 'juanmedina57@gmail.com', ai_recommendation: null,
    intake_source_ref: SRC_REF, source_email_refs: [SRC_REF],
  }).select('id').single();
  if (error) { console.error('insert ERR:', error.message); return; }
  const id = rec.id;
  console.log('application created:', id, '| ref', reference);

  // Archive the form + photo under the decision.
  const photoPaths = []; let appPath = null;
  for (let i = 0, p = 0; i < files.length; i++) {
    const f = files[i];
    try {
      if (f.isPdf && !appPath) {
        appPath = `acc_decisions/${id}/application.pdf`;
        await s.storage.from('documents').upload(appPath, f.buf, { contentType: 'application/pdf', upsert: true });
      } else if (!f.isPdf) {
        const path = `acc_decisions/${id}/photo_${++p}.jpg`;
        await s.storage.from('documents').upload(path, f.buf, { contentType: 'image/jpeg', upsert: true });
        photoPaths.push(path);
      }
    } catch (e) { console.warn('  upload skipped', f.name, e.message); }
  }
  await s.from('acc_decisions').update({ application_pdf_storage_path: appPath, photo_storage_paths: photoPaths, updated_at: new Date().toISOString() }).eq('id', id);
  console.log('archived: form', !!appPath, '| photos', photoPaths.length);

  // Queue the acknowledgment (received + under review — nothing asked).
  const q = await queueDraft({
    communityId: WATERVIEW, communityName: 'Waterview Estates', persona: 'annie',
    toEmail: 'juanmedina57@gmail.com', toName: 'Rocio Munoz',
    subject: `We received your architectural application${reference ? ' (' + reference + ')' : ''}`,
    bodyText: `Hi Rocio,\n\nWe have received your architectural review application for 20014 Juniper Berry Dr, along with your plans and photo, and it is now under review.${reference ? `\n\nYour reference number is ${reference}. Please keep it for your records.` : ''}\n\nThe committee will review the patio and cover, and we will follow up with the decision. If anything else is needed to complete the review, we will reach out.`,
    relatedType: 'acc_decision', relatedId: id, sourceEmailRef: SRC_REF, draftKind: 'acknowledgment',
    draftReason: 'ACC receipt — complete application, nothing to ask for', createdBy: 'system',
  });
  console.log('acknowledgment draft:', q.status, q.id || '');
})();
