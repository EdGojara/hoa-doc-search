// Cooper thread cleanup (Ed 2026-07-22):
//  1) Queue the correction email to Andrea (Draft Queue — Ed releases it).
//  2) File her 4 emails as ONE Eaglewood community-manager concern (work_item).
//  3) Take the thread off the ACC path: reclassify the misfiled "Fence" email to
//     violation_report and stamp her property/community on all 4.
// Idempotent: guards on a stable source ref for both the draft and the work_item.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { queueDraft } = require('../lib/email/outbound_drafts');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const EAGLEWOOD = 'a0000000-0000-4000-8000-000000000004';
const COOPER_EMAIL = 'cooperandrea1@icloud.com';
const CORRECTION_REF = 'acc_correction:cooper-fence-2026-07';

const CORRECTION_BODY = `Hi Andrea,

I owe you a correction. I first replied as though you were applying to build a fence and asked you for application details. That was my mistake. Reading again what you sent, I understand you are raising a property line concern involving the neighboring property, not requesting architectural approval, and the photos you already shared show the boundary and the spot that was never patched.

I've handed your message and pictures to the community management team for Eaglewood, who handle property line and neighbor matters. They'll follow up with you directly, and you don't need to resend anything.

Thank you for your patience, and I'm sorry for the confusion.

-----Original message-----
On Wed, Jul 22, 2026, Annie Reeves <annie@bedrocktx.com> wrote:

Hi there,

Thank you for your fence request. To process it, could you send me the property address and a brief description of the proposed fence (material, height, and where on the lot it will go), along with any photos or a site sketch? Once I have those, I'll get it into review.`;

(async () => {
  // Property id for 9211 Floral Crest (Cooper's lot).
  const { data: prop, error: pe } = await s.from('properties')
    .select('id, street_address').eq('community_id', EAGLEWOOD).ilike('street_address', '%9211 Floral Crest%').maybeSingle();
  if (pe) return console.error('property lookup ERR:', pe.message);
  const propId = prop ? prop.id : null;
  console.log('Cooper property:', prop ? prop.street_address : '(not found)', propId || '');

  // Her 4 emails.
  const { data: emails, error: ee } = await s.from('email_messages')
    .select('id, subject, classification, conversation_id').ilike('sender_email', COOPER_EMAIL);
  if (ee) return console.error('emails ERR:', ee.message);
  console.log('Cooper emails:', emails.length);
  const convId = (emails.find((e) => e.conversation_id) || {}).conversation_id || null;

  // 1) Queue the correction draft.
  const q = await queueDraft({
    communityId: EAGLEWOOD, communityName: 'Eaglewood', persona: 'annie',
    toEmail: COOPER_EMAIL, toName: 'Andrea Cooper', subject: 'Re: Fence',
    bodyText: CORRECTION_BODY, relatedType: 'email_triage', relatedId: emails[0] ? emails[0].id : null,
    sourceEmailRef: CORRECTION_REF, draftKind: 'reply',
    draftReason: 'Correction — misfiled a neighbor fence complaint as an ACC request', createdBy: 'system',
  });
  console.log('correction draft:', q.status, q.id || '');

  // 2) File the CM concern as ONE work_item (guard on source_ref).
  const wiRef = 'cooper-floral-crest-boundary';
  const { data: existingWi } = await s.from('work_items').select('id').eq('source_ref', wiRef).limit(1);
  if (existingWi && existingWi.length) {
    console.log('work_item exists:', existingWi[0].id);
  } else {
    const { data: wi, error: wErr } = await s.from('work_items').insert({
      community_id: EAGLEWOOD, community_name: 'Eaglewood',
      source_type: 'email', item_type: 'homeowner_concern', urgency: 'normal', status: 'new',
      title: 'Property line / fence dispute — 9211 vs 9215 Floral Crest',
      summary: 'Andrea Cooper (9211 Floral Crest) reports a property-line/fence dispute with the neighbor at 9215 Floral Crest (owner Jose Estrada): a boundary marking, mowing over the line, and an unpatched area where the property was divided. Photos sent across 4 emails (7/8-7/9). Originally misfiled as an ACC request and corrected; homeowner has been told the CM team will follow up. Needs CM review of the boundary concern.',
      source_ref: wiRef, record_ownership: 'association_record', created_by: 'system (reclassified from ACC)',
    }).select('id').single();
    if (wErr) console.error('work_item ERR:', wErr.message);
    else console.log('work_item created:', wi.id);
  }

  // 3) Off the ACC path: reclassify the misfiled "Fence" email + stamp property/community.
  for (const e of emails) {
    const patch = { community_id: EAGLEWOOD };
    if (propId) patch.resolved_property_id = propId;
    if (/^\s*fence\s*$/i.test(e.subject || '') && e.classification === 'acc_request') patch.classification = 'violation_report';
    const { error: uErr } = await s.from('email_messages').update(patch).eq('id', e.id);
    if (uErr) console.warn('  stamp ERR', e.id, uErr.message);
  }
  console.log('emails reclassified/stamped to Eaglewood + Cooper property.');
})();
