// ============================================================================
// Enforcement API
// ----------------------------------------------------------------------------
// Endpoints under /api/enforcement/* — backs the escalation engine
// (lib/enforcement/escalation.js) and the observation → violation promotion
// flow.
//
//   POST /api/enforcement/decide
//     Preview-only. Body { property_id, category_id, community_id?,
//                          is_cure_lapse?, current_stage? }
//     Returns the escalation decision (stage, mail_type, cure_days,
//     requires_hearing, rationale) WITHOUT writing anything.
//     Used by the UI to show "if you opened a violation here, this is what
//     would happen" before staff commits.
//
//   POST /api/enforcement/open-violation
//     Creates an actual violations row + an interaction record. Body:
//       { observation_id }       — required; pulls property + category from it
//       override_stage?          — staff can override the engine's recommendation
//                                   (rare; logged in violation.notes)
//       override_rationale?      — required if override_stage is set
//     Returns { violation_id, decision, observation_updated }
//     Side effects: observation.reviewer_status set to 'confirmed' if pending;
//     interaction row of type 'observation_note' created to record the open.
//     Letter generation happens in Phase 5 (PDF + queue + mail-out).
//
// ============================================================================

const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { decideEscalation, filterRecentSameCategory } = require('../lib/enforcement/escalation');
const { renderViolationLetterPdf } = require('../lib/enforcement/violation_letter');
const { renderPostcardReminderPdf } = require('../lib/enforcement/postcard_reminder');
const { parseVantacaViolations } = require('../lib/enforcement/vantaca_violation_import');
const { sendEmail, isConfigured: isEmailConfigured } = require('../lib/notifications/email');
const { sendSms,   isConfigured: isSmsConfigured }   = require('../lib/notifications/sms');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Bedrock management company id — matches the seed in 001_foundation.sql
// and the constant used elsewhere. Scoped here so violation-letter endpoints
// can stamp library_documents with the right management_company_id without
// trusting client input.
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

// Supabase storage bucket for generated violation letters. Created lazily —
// we attempt creation on first letter generation if missing.
const LETTERS_BUCKET = 'violation-letters';
let _bucketEnsured = false;
async function _ensureLettersBucket() {
  if (_bucketEnsured) return;
  try {
    const { data, error } = await supabase.storage.createBucket(LETTERS_BUCKET, { public: false });
    // If the bucket already exists, error.message contains 'already exists' or 'duplicate' — fine.
    if (error && !/already exists|duplicate/i.test(error.message || '')) {
      console.warn('[enforcement] bucket creation note:', error.message);
    }
  } catch (e) {
    console.warn('[enforcement] bucket creation threw:', e.message);
  }
  _bucketEnsured = true;
}

const router = express.Router();

// ---------------------------------------------------------------------------
// _fireSupplementalNotices — multi-channel evidence trail
// Fires email + SMS supplemental notices alongside the postal mailing of a
// violation letter. The mail is the legal artifact; email + SMS are belt-
// and-suspenders evidence that the homeowner had multiple opportunities to
// learn about the notice. Each send writes a delivery_receipts row.
//
// TCPA: SMS only goes when contacts.sms_opt_in=TRUE and not opted out.
// CAN-SPAM: email is transactional under the existing customer relationship;
// we still respect explicit email_opt_out.
// Safe-fallback throughout — if Resend/Twilio env vars are missing, the
// sends are skipped and the failure (with reason='not_configured') is
// recorded so the evidence trail still shows the attempt.
// ---------------------------------------------------------------------------
async function _fireSupplementalNotices(args) {
  const { interactionId, communityId, community, propertyId, property,
          violationId, violation, categoryLabel, postmarkIso, cureBy,
          pdfBuffer, letterPath } = args;
  const stage = violation && violation.current_stage;
  const isCertified = stage === 'certified_209' || stage === 'fine_assessed';
  const communityName = (community && community.name) || 'your Association';
  const propAddr = property
    ? `${property.street_address || ''}${property.unit ? ' #' + property.unit : ''}`
    : 'your property';
  const cureByLong = cureBy
    ? new Date(cureBy).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    : 'the date specified in the letter';

  // Owner contact — for email + phone + opt-in flags
  let contact = null;
  if (property && property.owner_contact_id) {
    const { data } = await supabase
      .from('contacts')
      .select('id, full_name, email, phone, notification_phone, sms_opt_in, sms_opt_out, email_opt_out')
      .eq('id', property.owner_contact_id)
      .maybeSingle();
    contact = data;
  }

  // Signed URL for the letter PDF — used by both email and SMS. 30-day
  // expiry so the URL stays valid through the cure window.
  let letterUrl = null;
  if (letterPath) {
    try {
      const { data: signed } = await supabase.storage
        .from('violation-letters')
        .createSignedUrl(letterPath, 60 * 60 * 24 * 30);
      if (signed) letterUrl = signed.signedUrl;
    } catch (_) {}
  }

  // ---------- Email ----------
  if (contact && contact.email && !contact.email_opt_out) {
    const subject = isCertified
      ? `Formal notice (certified) regarding ${propAddr} — ${communityName}`
      : `Compliance concern regarding ${propAddr} — ${communityName}`;
    const greeting = contact.full_name ? `Dear ${contact.full_name.split(/\s+/).pop()},` : 'Dear Property Owner,';
    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1a1a1a; line-height: 1.55;">
        <h2 style="color: #1A3050; margin-bottom: 4px;">${communityName}</h2>
        <p style="color: #5a5a5a; margin-top: 0; font-size: 13px;">via Bedrock Association Management</p>
        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 14px 0;" />
        <p>${greeting}</p>
        <p>${isCertified
          ? `This is a courtesy email accompanying a certified §209 notice mailed today regarding a covenant matter at <strong>${propAddr}</strong>. The certified letter is the legal artifact; this email is supplemental so you don't first learn of the matter when the certified envelope arrives.`
          : `We're writing about a compliance concern noted recently at <strong>${propAddr}</strong>. A letter is being mailed to you today — this email is the same notice in advance so you can address it promptly.`}</p>
        <p><strong>Matter:</strong> ${categoryLabel || 'covenant compliance'}<br/>
           <strong>Please cure by:</strong> ${cureByLong}<br/>
           <strong>Postmark date:</strong> ${postmarkIso}</p>
        ${letterUrl ? `<p style="margin: 18px 0;"><a href="${letterUrl}" style="background: #1A3050; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600;">View the full letter (PDF)</a></p>` : ''}
        <p>If you have questions, please reply to this email or call <a href="tel:8325882485" style="color: #1A3050;">(832) 588-2485</a>. We'd rather resolve this with you than continue escalation.</p>
        <p style="font-size: 12px; color: #5a5a5a; margin-top: 24px; border-top: 1px solid #e2e8f0; padding-top: 12px;">
          This is a transactional communication regarding your property. To stop receiving non-essential email from us, reply with "OPT OUT" in the subject line.
        </p>
      </div>
    `;
    const text = `${greeting}\n\n${isCertified
      ? `This is a courtesy email accompanying a certified §209 notice mailed today regarding a covenant matter at ${propAddr}. The certified letter is the legal artifact; this email is supplemental.`
      : `We're writing about a compliance concern noted recently at ${propAddr}. A letter is being mailed to you today — this email is the same notice in advance.`}\n\nMatter: ${categoryLabel || 'covenant compliance'}\nPlease cure by: ${cureByLong}\nPostmark date: ${postmarkIso}\n${letterUrl ? `\nView the full letter: ${letterUrl}\n` : ''}\nQuestions: reply or call (832) 588-2485.\n\n— ${communityName} via Bedrock Association Management`;

    // Attach PDF for courtesy notices (lightweight + frequent). Certified
    // notices link only — the certified mailing IS the legal artifact and
    // an attached PDF dilutes that.
    let attachments;
    if (pdfBuffer && !isCertified) {
      attachments = [{
        filename: `Bedrock-Notice-${(propAddr || 'property').replace(/[^A-Za-z0-9]+/g, '-')}.pdf`,
        content: pdfBuffer.toString('base64'),
      }];
    }

    const result = await sendEmail({ to: contact.email, subject, html, text, attachments, tags: [
      { name: 'stage',     value: stage || 'unknown' },
      { name: 'community', value: communityName.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 30) },
    ] });
    try {
      await supabase.from('delivery_receipts').insert({
        interaction_id: interactionId,
        contact_id:     contact.id,
        community_id:   communityId,
        property_id:    propertyId,
        violation_id:   violationId,
        channel:        'email',
        to_address:     contact.email,
        status:         result.ok ? 'sent' : 'failed',
        vendor:         'resend',
        vendor_message_id: result.vendor_message_id || null,
        sent_at:        new Date().toISOString(),
        failure_reason: result.ok ? null : (result.error || null),
        raw_response:   result.raw || null,
      });
    } catch (recErr) { console.warn('[supplemental] email receipt insert failed:', recErr.message); }
  }

  // ---------- SMS ----------
  const smsPhone = contact && (contact.notification_phone || contact.phone);
  const smsAllowed = contact && contact.sms_opt_in && !contact.sms_opt_out && smsPhone;
  if (smsAllowed) {
    const body = isCertified
      ? `${communityName}: A CERTIFIED §209 notice was mailed to you today regarding ${propAddr}. Please cure by ${new Date(cureBy).toLocaleDateString('en-US')}. View letter: ${letterUrl || '(see your mail)'}\nQuestions: (832) 588-2485`
      : `${communityName}: A compliance notice was mailed to you regarding ${propAddr}. Please cure by ${new Date(cureBy).toLocaleDateString('en-US')}. View letter: ${letterUrl || '(see your mail)'}\nQuestions: (832) 588-2485`;
    const result = await sendSms({ to: smsPhone, body });
    try {
      await supabase.from('delivery_receipts').insert({
        interaction_id: interactionId,
        contact_id:     contact.id,
        community_id:   communityId,
        property_id:    propertyId,
        violation_id:   violationId,
        channel:        'sms',
        to_address:     result.to || smsPhone,
        status:         result.ok ? 'sent' : 'failed',
        vendor:         'twilio',
        vendor_message_id: result.vendor_message_id || null,
        sent_at:        new Date().toISOString(),
        failure_reason: result.ok ? null : (result.error || null),
        raw_response:   result.raw || null,
      });
    } catch (recErr) { console.warn('[supplemental] sms receipt insert failed:', recErr.message); }
  }
}

// ---------------------------------------------------------------------------
// Helper: fetch the active priority weight for (community, category).
// Returns 'standard' if no row exists (sane default).
// ---------------------------------------------------------------------------
async function _getPriorityWeight(communityId, categoryId) {
  if (!communityId || !categoryId) return 'standard';
  const { data } = await supabase
    .from('community_enforcement_priorities')
    .select('priority_weight')
    .eq('community_id', communityId)
    .eq('category_id', categoryId)
    .is('end_date', null)
    .maybeSingle();
  return (data && data.priority_weight) || 'standard';
}

// ---------------------------------------------------------------------------
// Helper: fetch prior violations of a category on a property in the last
// N months. Returns the array shape decideEscalation expects.
// ---------------------------------------------------------------------------
async function _getRecentSameCategory(propertyId, categoryId, months = 12) {
  if (!propertyId || !categoryId) return [];
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const { data } = await supabase
    .from('violations')
    .select('id, opened_at, primary_category_id, current_stage, quality_status, confidence_weight, source')
    .eq('property_id', propertyId)
    .eq('primary_category_id', categoryId)
    .gte('opened_at', cutoff.toISOString())
    .neq('quality_status', 'superseded')   // exclude corrected-out rows
    .order('opened_at', { ascending: false });
  return data || [];
}

// ---------------------------------------------------------------------------
// POST /api/enforcement/decide — preview-only
// ---------------------------------------------------------------------------
router.post('/decide', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const propertyId = body.property_id;
    const categoryId = body.category_id;
    if (!propertyId || !categoryId) {
      return res.status(400).json({ error: 'property_id and category_id required' });
    }

    // Look up community_id from the property if not provided
    let communityId = body.community_id;
    if (!communityId) {
      const { data: prop } = await supabase
        .from('properties')
        .select('community_id')
        .eq('id', propertyId)
        .maybeSingle();
      communityId = prop && prop.community_id;
    }

    const [priorityWeight, priorViolations] = await Promise.all([
      _getPriorityWeight(communityId, categoryId),
      _getRecentSameCategory(propertyId, categoryId, 12),
    ]);

    const decision = decideEscalation({
      prior_violations: priorViolations,
      priority_weight: priorityWeight,
      is_cure_lapse: !!body.is_cure_lapse,
      current_stage: body.current_stage || null,
    });

    res.json({
      decision,
      priority_weight: priorityWeight,
      prior_count_12mo: priorViolations.length,
      prior_violations: priorViolations.map((v) => ({
        id: v.id, opened_at: v.opened_at, current_stage: v.current_stage,
      })),
    });
  } catch (err) {
    console.error('[enforcement.decide]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/enforcement/open-violation
// ---------------------------------------------------------------------------
router.post('/open-violation', express.json(), async (req, res) => {
  try {
    // Capture actor from JWT — do NOT trust body.opened_by_user_id any
    // longer. Pre-team-management code accepted whatever the client sent.
    const { requireActingUser } = require('./_acting_user');
    const actor = await requireActingUser(req, res);
    if (!actor) return;

    const body = req.body || {};
    const observationId = body.observation_id;
    if (!observationId) return res.status(400).json({ error: 'observation_id required' });

    // Pull the observation + its photo + AI metadata + property + category
    const { data: obs, error: obsErr } = await supabase
      .from('property_observations')
      .select('id, property_id, community_id, category_id, inspection_id, inspection_photo_id, severity, ai_description, ai_recommended_action, reviewer_status')
      .eq('id', observationId)
      .maybeSingle();
    if (obsErr || !obs) return res.status(404).json({ error: 'observation not found' });
    if (!obs.property_id) {
      return res.status(400).json({ error: 'observation has no property_id; resolve property linkage before opening violation' });
    }
    if (!obs.category_id) {
      return res.status(400).json({ error: 'observation has no category_id; staff must assign category before opening violation' });
    }

    // Fetch context for the engine
    const [priorityWeight, priorViolations] = await Promise.all([
      _getPriorityWeight(obs.community_id, obs.category_id),
      _getRecentSameCategory(obs.property_id, obs.category_id, 12),
    ]);

    let decision = decideEscalation({
      prior_violations: priorViolations,
      priority_weight: priorityWeight,
      is_cure_lapse: false,
    });

    if (!decision.should_open) {
      return res.status(400).json({
        error: 'engine decided not to open violation',
        decision,
        priority_weight: priorityWeight,
      });
    }

    // Allow staff override (very rare; logged for auditability)
    const overrideStage = body.override_stage;
    const overrideRationale = body.override_rationale;
    if (overrideStage) {
      if (!overrideRationale) {
        return res.status(400).json({ error: 'override_rationale required when override_stage is set' });
      }
      // Update the decision payload to reflect the override (so the persisted
      // violation reflects what was actually done)
      const validStages = ['courtesy_1','courtesy_2','certified_209','fine_assessed'];
      if (!validStages.includes(overrideStage)) {
        return res.status(400).json({ error: 'invalid override_stage' });
      }
      decision = {
        ...decision,
        stage: overrideStage,
        // Override certified-mail flag when stage requires it
        mail_type: overrideStage === 'certified_209' || overrideStage === 'fine_assessed' ? 'certified_mail' : 'first_class_mail',
        rationale: `Engine recommended ${decision.stage} (${decision.rationale}). Staff override → ${overrideStage}. Reason: ${overrideRationale}`,
      };
    }

    const cureEnd = decision.cure_days > 0
      ? new Date(Date.now() + decision.cure_days * 24 * 60 * 60 * 1000).toISOString()
      : null;

    // Insert the violation row
    const { data: violation, error: vErr } = await supabase
      .from('violations')
      .insert({
        property_id: obs.property_id,
        community_id: obs.community_id,
        opened_from_observation_id: obs.id,
        primary_category_id: obs.category_id,
        board_priority_at_open: priorityWeight === 'disabled' ? 'standard' : priorityWeight,
        current_stage: decision.stage,
        current_stage_started_at: new Date().toISOString(),
        cure_period_ends_at: cureEnd,
        opened_at: new Date().toISOString(),
        opened_by_user_id: actor.id,
      })
      .select()
      .single();
    if (vErr) return res.status(500).json({ error: vErr.message });

    // Update observation status to confirmed (if still pending)
    let observationUpdated = false;
    if (obs.reviewer_status === 'pending') {
      const { error: oErr } = await supabase
        .from('property_observations')
        .update({
          reviewer_status: 'confirmed',
          reviewed_at: new Date().toISOString(),
          reviewer_user_id: actor.id,
        })
        .eq('id', obs.id);
      if (!oErr) observationUpdated = true;
    }

    // Drop an interaction record so the property timeline shows the open event.
    // Letter generation (Phase 5) will create a separate letter_* interaction
    // when the actual mail goes out — this one is just the operational record.
    await supabase.from('interactions').insert({
      community_id: obs.community_id,
      property_id: obs.property_id,
      violation_id: violation.id,
      observation_id: obs.id,
      inspection_id: obs.inspection_id,
      type: 'observation_note',
      direction: 'internal',
      subject: `Violation opened: ${decision.stage}`,
      content: decision.rationale,
      sent_at: new Date().toISOString(),
    });

    res.json({
      ok: true,
      violation_id: violation.id,
      decision,
      priority_weight: priorityWeight,
      prior_count_12mo: priorViolations.length,
      observation_updated: observationUpdated,
    });
  } catch (err) {
    console.error('[enforcement.open-violation]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/enforcement/generate-letter
// Body: { violation_id, sender_name?, sender_title?, force_regenerate? }
//
// Generates a Bedrock-branded PDF for an open violation, uploads to Supabase
// storage, creates the corresponding interaction record (letter_courtesy_1 /
// letter_courtesy_2 / letter_209), and returns a signed URL the UI can open
// in a new tab.
//
// Caching: if a letter for THIS violation at THIS stage already exists,
// returns the existing signed URL instead of generating a new one. Pass
// force_regenerate: true to bypass the cache and re-render with current
// code (used by the 'Regenerate' button when the letter template changes).
// On force_regenerate, the prior interaction row is deleted so the audit
// trail reflects only the latest letter.
// ---------------------------------------------------------------------------
router.post('/generate-letter', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const violationId = body.violation_id;
    const forceRegenerate = !!body.force_regenerate;
    if (!violationId) return res.status(400).json({ error: 'violation_id required' });

    // Fetch violation + property + community + category in one round trip
    const { data: violation, error: vErr } = await supabase
      .from('violations')
      .select(`
        id, property_id, community_id, current_stage, cure_period_ends_at,
        opened_at, opened_from_observation_id, primary_category_id, board_priority_at_open,
        enforcement_categories ( label, description ),
        communities ( name )
      `)
      .eq('id', violationId)
      .maybeSingle();
    if (vErr || !violation) return res.status(404).json({ error: 'violation not found' });

    // Map stage to interaction type
    const stageToType = {
      courtesy_1:    'letter_courtesy_1',
      courtesy_2:    'letter_courtesy_2',
      certified_209: 'letter_209',
      fine_assessed: 'letter_209',  // fines piggyback on §209 letter shell
    };
    const letterType = stageToType[violation.current_stage];
    if (!letterType) {
      return res.status(400).json({ error: `violation is in stage '${violation.current_stage}' — no letter applies` });
    }

    // Check for an existing letter interaction at this stage.
    const { data: priorLetter } = await supabase
      .from('interactions')
      .select('id, subject, content, sent_at')
      .eq('violation_id', violationId)
      .eq('type', letterType)
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (priorLetter && priorLetter.content && !forceRegenerate) {
      // Cached path: return the existing signed URL.
      const { data: sd } = await supabase.storage.from(LETTERS_BUCKET).createSignedUrl(priorLetter.content, 60 * 60);
      if (sd && sd.signedUrl) {
        return res.json({ ok: true, regenerated: false, letter_url: sd.signedUrl, interaction_id: priorLetter.id });
      }
    }

    // Force-regenerate path: schedule deletion of prior interaction + PDF,
    // but only EXECUTE the deletion after the new letter has been successfully
    // rendered + uploaded + inserted (see end of handler). Without this
    // atomic guarantee, a render error mid-way leaves the violation with no
    // interaction at all — the letter disappears from BOTH Drafts queue and
    // Mail Queue and the operator can't recover. (Ed hit this on 2026-05-20:
    // regenerated a letter, render threw, letter vanished from both queues.)
    let priorToDelete = null;
    if (forceRegenerate && priorLetter) {
      priorToDelete = priorLetter;
    }

    // Fetch property + owner from the view
    const { data: pRow, error: pErr } = await supabase
      .from('v_current_property_owners')
      .select('property_id, street_address, unit, city, state, zip, lot_number, owner_name, owner_email, owner_phone, owner_mailing_address')
      .eq('property_id', violation.property_id)
      .maybeSingle();
    if (pErr || !pRow) return res.status(404).json({ error: 'property not found' });

    // Latest confirmed observation for evidence photo.
    // Photo download has TWO fallback paths:
    //   1. violation.opened_from_observation_id (the canonical path)
    //   2. Most recent inspection_photo at this property — used when (1)
    //      got nulled by ON DELETE SET NULL (i.e., earlier inspection
    //      was discarded but the violation/letter survived).
    let observation = null;
    let photoBuffer = null;
    let photoStoragePath = null;
    if (violation.opened_from_observation_id) {
      const { data: obs } = await supabase
        .from('property_observations')
        .select('id, ai_description, severity, created_at, inspection_photo_id, inspection_photos(captured_at, storage_path)')
        .eq('id', violation.opened_from_observation_id)
        .maybeSingle();
      if (obs) {
        observation = {
          ai_description: obs.ai_description,
          severity: obs.severity,
          captured_at: (obs.inspection_photos && obs.inspection_photos.captured_at) || obs.created_at,
        };
        if (obs.inspection_photos && obs.inspection_photos.storage_path) {
          photoStoragePath = obs.inspection_photos.storage_path;
        }
      }
    }
    // Fallback: pull the most recent close-up/single inspection_photo
    // confirmed at this property for this category. Saves the letter from
    // going photo-less when the original observation was deleted.
    if (!photoStoragePath) {
      try {
        const { data: latestPhoto } = await supabase
          .from('inspection_photos')
          .select('storage_path, captured_at')
          .eq('reviewer_confirmed_property_id', violation.property_id)
          .in('photo_role', ['close_up', 'single'])
          .order('captured_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (latestPhoto && latestPhoto.storage_path) {
          photoStoragePath = latestPhoto.storage_path;
          if (!observation) {
            observation = { captured_at: latestPhoto.captured_at };
          }
        }
      } catch (_) {}
    }
    if (photoStoragePath) {
      try {
        const { data: dl } = await supabase.storage
          .from('documents')
          .download(photoStoragePath);
        if (dl) {
          const ab = await dl.arrayBuffer();
          photoBuffer = Buffer.from(ab);
        }
      } catch (e) {
        console.warn('[letter] photo download failed:', e.message);
      }
    }

    // Phase 7 — enrich context for the new template
    //   - community.legal_name (HOA primary header)
    //   - community.letter_sender_name / _title (per-community sign-off override)
    //   - governing_doc (community_enforcement_priorities row for this category)
    //   - prior_violations (history list rendered on §209 letters)
    let commLegalName = null;
    let commAuthorityCitation = null;
    const commLetterFees = { c1: null, c2: null, c209: null, fine: null, curec1: null, curec2: null, curec209: null };
    let senderName = body.sender_name || null;
    let senderTitle = body.sender_title || null;
    try {
      const { data: comm } = await supabase
        .from('communities')
        .select('legal_name, letter_sender_name, letter_sender_title, enforcement_authority_citation, letter_fee_courtesy_1_cents, letter_fee_courtesy_2_cents, letter_fee_certified_209_cents, letter_fee_fine_assessed_cents, letter_cure_days_courtesy_1, letter_cure_days_courtesy_2, letter_cure_days_certified_209')
        .eq('id', violation.community_id)
        .maybeSingle();
      if (comm) {
        commLegalName = comm.legal_name || null;
        commAuthorityCitation = comm.enforcement_authority_citation || null;
        commLetterFees.c1       = comm.letter_fee_courtesy_1_cents;
        commLetterFees.c2       = comm.letter_fee_courtesy_2_cents;
        commLetterFees.c209     = comm.letter_fee_certified_209_cents;
        commLetterFees.fine     = comm.letter_fee_fine_assessed_cents;
        commLetterFees.curec1   = comm.letter_cure_days_courtesy_1;
        commLetterFees.curec2   = comm.letter_cure_days_courtesy_2;
        commLetterFees.curec209 = comm.letter_cure_days_certified_209;
        if (!senderName)  senderName  = comm.letter_sender_name || null;
        if (!senderTitle) senderTitle = comm.letter_sender_title || null;
      }
    } catch (_) {}

    let govDoc = null;
    try {
      const { data: prio } = await supabase
        .from('community_enforcement_priorities')
        .select('governing_doc_reference, governing_doc_section_title, governing_doc_quote, governing_doc_page')
        .eq('community_id', violation.community_id)
        .eq('category_id', violation.primary_category_id)
        .is('end_date', null)
        .maybeSingle();
      if (prio && (prio.governing_doc_reference || prio.governing_doc_section_title || prio.governing_doc_quote)) {
        govDoc = {
          reference:     prio.governing_doc_reference,
          section_title: prio.governing_doc_section_title,
          quote:         prio.governing_doc_quote,
          page:          prio.governing_doc_page,
        };
      }
    } catch (_) {}

    // Auto-lookup the governing-doc section from the community's CC&Rs in the
    // knowledge substrate. Only fires when the manual override above didn't
    // produce a citation. Returns null silently if no doc / no key / no match.
    if (!govDoc) {
      try {
        const { lookupGoverningDoc } = require('../lib/enforcement/governing_doc_lookup');
        const auto = await lookupGoverningDoc({
          communityId:         violation.community_id,
          categoryLabel:       violation.enforcement_categories && violation.enforcement_categories.label,
          categoryDescription: violation.enforcement_categories && violation.enforcement_categories.description,
          aiDescription:       observation && observation.ai_description,
        });
        if (auto) {
          govDoc = {
            reference:      auto.reference,
            section_title:  auto.section_title,
            quote:          auto.quote,
            page:           auto.page,
            document_title: auto.document_title,
          };
        }
      } catch (_) {}
    }

    let priorViolations = [];
    try {
      const yearAgo = new Date(); yearAgo.setMonth(yearAgo.getMonth() - 12);
      const { data: pv } = await supabase
        .from('violations')
        .select('opened_at, current_stage')
        .eq('property_id', violation.property_id)
        .eq('primary_category_id', violation.primary_category_id)
        .neq('id', violation.id)
        .gte('opened_at', yearAgo.toISOString())
        .order('opened_at', { ascending: false })
        .limit(10);
      priorViolations = pv || [];
    } catch (_) {}

    // Generate the PDF
    const pdfBuffer = await renderViolationLetterPdf({
      violation: {
        id: violation.id,
        current_stage: violation.current_stage,
        cure_period_ends_at: violation.cure_period_ends_at,
        opened_at: violation.opened_at,
        category_label: violation.enforcement_categories && violation.enforcement_categories.label,
        category_description: violation.enforcement_categories && violation.enforcement_categories.description,
        board_priority_at_open: violation.board_priority_at_open,
      },
      property: {
        street_address: pRow.street_address,
        unit:           pRow.unit,
        city:           pRow.city,
        state:          pRow.state,
        zip:            pRow.zip,
        lot_number:     pRow.lot_number,
      },
      owner: {
        full_name:       pRow.owner_name,
        mailing_address: pRow.owner_mailing_address,
      },
      community: {
        name:       violation.communities && violation.communities.name,
        legal_name: commLegalName,
        enforcement_authority_citation: commAuthorityCitation,
        letter_fee_courtesy_1_cents:    commLetterFees.c1,
        letter_fee_courtesy_2_cents:    commLetterFees.c2,
        letter_fee_certified_209_cents: commLetterFees.c209,
        letter_fee_fine_assessed_cents: commLetterFees.fine,
        letter_cure_days_courtesy_1:    commLetterFees.curec1,
        letter_cure_days_courtesy_2:    commLetterFees.curec2,
        letter_cure_days_certified_209: commLetterFees.curec209,
      },
      observation,
      governing_doc:    govDoc,
      prior_violations: priorViolations,
      photo_buffer:     photoBuffer,
      options: {
        sender_name:  senderName,
        sender_title: senderTitle,
      },
    });

    // Upload to storage bucket. Path: violation_id/stage-yyyymmdd-HHMMSS.pdf
    await _ensureLettersBucket();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const storagePath = `${violation.id}/${violation.current_stage}-${stamp}.pdf`;
    const { error: upErr } = await supabase.storage
      .from(LETTERS_BUCKET)
      .upload(storagePath, pdfBuffer, { contentType: 'application/pdf', upsert: false });
    if (upErr) return res.status(500).json({ error: 'upload failed: ' + upErr.message });

    // Record the interaction. Mail method depends on stage.
    const isCertified = violation.current_stage === 'certified_209' || violation.current_stage === 'fine_assessed';
    const { data: inter, error: iErr } = await supabase
      .from('interactions')
      .insert({
        community_id:    violation.community_id,
        property_id:     violation.property_id,
        violation_id:    violation.id,
        observation_id:  violation.opened_from_observation_id,
        type:            letterType,
        direction:       'outbound',
        subject:         `Violation letter (${violation.current_stage})`,
        content:         storagePath,         // canonical storage location; signed URLs derived on demand
        delivery_method: isCertified ? 'certified_mail' : 'first_class_mail',
        status:          'draft',             // explicit — regenerated letters always go to the Drafts queue
        // sent_at stays NULL — only stamped at lock-and-batch (postmark time)
      })
      .select()
      .single();
    if (iErr) return res.status(500).json({ error: 'interaction insert failed: ' + iErr.message });

    // ATOMIC REGENERATE: only NOW that the new interaction is safely in the
    // database do we delete the prior one (and its storage PDF). If anything
    // above this point threw, the prior letter survives — operator can find
    // it back in Drafts queue or Mail Queue.
    if (priorToDelete) {
      if (priorToDelete.content && /\.pdf$/i.test(String(priorToDelete.content))) {
        try { await supabase.storage.from('violation-letters').remove([priorToDelete.content]); } catch (_) {}
      }
      try {
        await supabase.from('interactions').delete().eq('id', priorToDelete.id);
      } catch (e) {
        console.warn('[enforcement.generate-letter] post-insert delete of prior interaction failed:', e.message);
      }
    }

    // Signed URL for immediate download
    const { data: sd } = await supabase.storage.from(LETTERS_BUCKET).createSignedUrl(storagePath, 60 * 60);

    res.json({
      ok: true,
      regenerated: true,
      violation_id: violation.id,
      interaction_id: inter.id,
      letter_url: sd && sd.signedUrl,
      letter_type: letterType,
      delivery_method: isCertified ? 'certified_mail' : 'first_class_mail',
      mailed_to: pRow.owner_mailing_address || `${pRow.street_address || ''}${pRow.unit ? ' #' + pRow.unit : ''}, ${pRow.city || ''} ${pRow.state || 'TX'} ${pRow.zip || ''}`,
    });
  } catch (err) {
    console.error('[enforcement.generate-letter]', err);
    console.error('[enforcement.generate-letter] stack:', err.stack);
    res.status(500).json({
      error: err.message,
      stage: 'letter_render',
      hint: 'Letter render failed. The prior letter (if any) is preserved in its original queue. Check server logs for the stack trace.',
    });
  }
});

// ---------------------------------------------------------------------------
// GET /api/enforcement/drafts
//   Query params: ?community_id=  ?inspection_id=  ?limit=50
//   Returns DRAFT interactions (subject starts with '[DRAFT]') + joined
//   violation + property + photo data, ready for the review UI.
//
//   Subject prefix '[DRAFT]' is the gate set in Phase 6c. When a letter is
//   approved + sent (POST /approve-draft below), the prefix is removed and
//   sent_at is bumped to the approval time, so the same interactions
//   row represents the actual send event.
// ---------------------------------------------------------------------------
router.get('/drafts', async (req, res) => {
  try {
    const communityId = req.query.community_id;
    const inspectionId = req.query.inspection_id;
    const limit = Math.min(200, Number(req.query.limit) || 50);

    let q = supabase
      .from('interactions')
      .select(`
        id, subject, content, type, delivery_method, sent_at, created_at, status,
        community_id, property_id, violation_id, observation_id, inspection_id,
        bundle_id, letter_fee_cents
      `)
      .eq('status', 'draft')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (communityId) q = q.eq('community_id', communityId);
    if (inspectionId) q = q.eq('inspection_id', inspectionId);
    const { data: drafts, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    if (!drafts || drafts.length === 0) return res.json({ drafts: [] });

    // Bulk-fetch violations, properties, observations, photos so we can join
    // in JS (Supabase's nested-select can't handle this many cross-table joins
    // cleanly).
    const violationIds = [...new Set(drafts.map((d) => d.violation_id).filter(Boolean))];
    const propertyIds  = [...new Set(drafts.map((d) => d.property_id).filter(Boolean))];
    const observationIds = [...new Set(drafts.map((d) => d.observation_id).filter(Boolean))];

    const [vRes, pRes, oRes] = await Promise.all([
      supabase.from('violations')
        .select('id, primary_category_id, current_stage, cure_period_ends_at, board_priority_at_open, enforcement_categories(label)')
        .in('id', violationIds.length ? violationIds : ['00000000-0000-0000-0000-000000000000']),
      supabase.from('v_current_property_owners')
        .select('property_id, street_address, unit, city, owner_name, owner_mailing_address')
        .in('property_id', propertyIds.length ? propertyIds : ['00000000-0000-0000-0000-000000000000']),
      supabase.from('property_observations')
        .select('id, severity, ai_description, ai_confidence, reviewer_notes, inspection_photo_id, inspection_photos(captured_at, storage_path)')
        .in('id', observationIds.length ? observationIds : ['00000000-0000-0000-0000-000000000000']),
    ]);
    const violationById = new Map((vRes.data || []).map((v) => [v.id, v]));
    const propertyById  = new Map((pRes.data || []).map((p) => [p.property_id, p]));
    const observationById = new Map((oRes.data || []).map((o) => [o.id, o]));

    // Generate signed URLs for both letter PDFs and observation photos (in parallel)
    const enrichedAll = await Promise.all(drafts.map(async (d) => {
      const v = violationById.get(d.violation_id);
      const p = propertyById.get(d.property_id);
      const o = observationById.get(d.observation_id);
      const photoPath = o && o.inspection_photos && o.inspection_photos.storage_path;
      let photoUrl = null;
      if (photoPath) {
        try {
          const { data: sd } = await supabase.storage.from('documents').createSignedUrl(photoPath, 60 * 60);
          if (sd) photoUrl = sd.signedUrl;
        } catch (_) {}
      }
      let letterUrl = null;
      if (d.content) {
        try {
          const { data: sd } = await supabase.storage.from('violation-letters').createSignedUrl(d.content, 60 * 60);
          if (sd) letterUrl = sd.signedUrl;
        } catch (_) {}
      }
      return {
        interaction_id: d.id,
        violation_id:   d.violation_id,
        property_id:    d.property_id,
        observation_id: d.observation_id,
        inspection_id:  d.inspection_id,
        drafted_at:     d.created_at,
        letter_type:    d.type,
        delivery_method: d.delivery_method,
        bundle_id:      d.bundle_id,
        letter_fee_cents: d.letter_fee_cents,
        letter_url:     letterUrl,
        violation: v ? {
          current_stage: v.current_stage,
          cure_period_ends_at: v.cure_period_ends_at,
          board_priority_at_open: v.board_priority_at_open,
          category_label: v.enforcement_categories && v.enforcement_categories.label,
        } : null,
        property: p ? {
          street_address: p.street_address,
          unit:           p.unit,
          city:           p.city,
        } : null,
        owner: p ? {
          full_name: p.owner_name,
          mailing_address: p.owner_mailing_address,
        } : null,
        observation: o ? {
          severity: o.severity,
          ai_description: o.ai_description,
          ai_confidence: o.ai_confidence,
          reviewer_notes: o.reviewer_notes,
          captured_at: o.inspection_photos && o.inspection_photos.captured_at,
          photo_url: photoUrl,
        } : null,
      };
    }));

    res.json({ drafts: enrichedAll });
  } catch (err) {
    console.error('[enforcement.drafts]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// POST /api/enforcement/drafts/auto-bundle
// Body: { community_id? }
//
// Group multiple draft letters at the same property + same stage into one
// envelope. Mrs. Henderson's three findings from one inspection walk get
// rendered into a single bundle PDF (one wide shot, three labeled items,
// one admin fee) instead of three separate envelopes hitting the same
// mailbox. Empty-chair lens win.
//
// What it does:
//   1. Find draft letter interactions where bundle_id IS NULL
//   2. Group by (property_id, type) — type encodes the stage
//   3. For groups of size N>1, regenerate one bundle PDF using the
//      bundle-aware letter generator, upload to storage, then update
//      all N interactions with the same bundle_id + same content path.
//      First interaction in the bundle carries letter_fee_cents (single
//      admin fee per envelope); others get fee_cents=0.
//   4. Singletons get a singleton bundle_id assigned for uniformity.
//
// Returns { bundles_created, drafts_bundled, singletons, skipped }.
// Safe to call repeatedly; bundles that already have bundle_id are skipped.
// ---------------------------------------------------------------------------
router.post('/drafts/auto-bundle', express.json(), async (req, res) => {
  try {
    const communityId = req.body && req.body.community_id;
    const letterTypes = ['letter_courtesy_1', 'letter_courtesy_2', 'letter_209'];

    let q = supabase
      .from('interactions')
      .select('id, type, community_id, property_id, violation_id, observation_id, inspection_id, content, bundle_id, letter_fee_cents')
      .eq('status', 'draft')
      .in('type', letterTypes)
      .is('bundle_id', null);
    if (communityId) q = q.eq('community_id', communityId);
    const { data: drafts, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    if (!drafts || drafts.length === 0) {
      return res.json({ bundles_created: 0, drafts_bundled: 0, singletons: 0, skipped: 0 });
    }

    // Group by (property_id, type)
    const groups = new Map();
    for (const d of drafts) {
      if (!d.property_id) continue;
      const key = `${d.property_id}|${d.type}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(d);
    }

    const { renderViolationLetterBundlePdf } = require('../lib/enforcement/violation_letter');
    const cryptoMod = require('crypto');

    let bundlesCreated = 0;
    let draftsBundled = 0;
    let singletons = 0;
    const skipped = [];

    for (const [, group] of groups) {
      try {
        if (group.length === 1) {
          // Singleton — just assign a bundle_id for uniformity
          const bundleId = cryptoMod.randomUUID();
          await supabase.from('interactions')
            .update({ bundle_id: bundleId })
            .eq('id', group[0].id);
          singletons += 1;
          continue;
        }

        // Multi-violation bundle: regenerate one consolidated PDF
        const first = group[0];
        const propertyId = first.property_id;
        const communityIdForGroup = first.community_id;
        const stage = first.type === 'letter_courtesy_1' ? 'courtesy_1'
                    : first.type === 'letter_courtesy_2' ? 'courtesy_2'
                    : 'certified_209'; // letter_209 → could be certified or fine_assessed; treat as certified for bundling

        // Pull violations + observations + photos for each member
        const violationIds = group.map((g) => g.violation_id).filter(Boolean);
        const observationIds = group.map((g) => g.observation_id).filter(Boolean);

        const [vRes, oRes, pRes, cRes] = await Promise.all([
          supabase.from('violations')
            .select('id, primary_category_id, current_stage, cure_period_ends_at, opened_at, board_priority_at_open, opened_from_observation_id, enforcement_categories(label, description)')
            .in('id', violationIds.length ? violationIds : ['00000000-0000-0000-0000-000000000000']),
          supabase.from('property_observations')
            .select('id, ai_description, severity, created_at, inspection_photo_id, inspection_photos(captured_at, storage_path, paired_wide_photo_id)')
            .in('id', observationIds.length ? observationIds : ['00000000-0000-0000-0000-000000000000']),
          supabase.from('v_current_property_owners')
            .select('property_id, street_address, unit, city, state, zip, lot_number, owner_name, owner_mailing_address')
            .eq('property_id', propertyId).maybeSingle(),
          supabase.from('communities')
            .select('id, name, legal_name, letter_sender_name, letter_sender_title, letter_fee_courtesy_1_cents, letter_fee_courtesy_2_cents, letter_fee_certified_209_cents, letter_fee_fine_assessed_cents, letter_cure_days_courtesy_1, letter_cure_days_courtesy_2, letter_cure_days_certified_209, letter_payment_url, letter_pay_to_name, letter_pay_to_address, enforcement_authority_citation')
            .eq('id', communityIdForGroup).maybeSingle(),
        ]);

        const vById = new Map((vRes.data || []).map((v) => [v.id, v]));
        const oById = new Map((oRes.data || []).map((o) => [o.id, o]));
        const pRow = pRes.data;
        const community = cRes.data;
        if (!pRow || !community) {
          skipped.push({ key: group.map((g) => g.id).join(','), reason: 'property or community missing' });
          continue;
        }

        // Build the per-violation array — order by violation.opened_at asc
        const orderedGroup = [...group].sort((a, b) => {
          const va = vById.get(a.violation_id);
          const vb = vById.get(b.violation_id);
          return new Date((va && va.opened_at) || 0) - new Date((vb && vb.opened_at) || 0);
        });

        // Wide photo — take the first paired wide we find across the group
        let widePhotoBuffer = null;
        for (const d of orderedGroup) {
          const obs = oById.get(d.observation_id);
          const photo = obs && obs.inspection_photos;
          if (photo && photo.paired_wide_photo_id) {
            try {
              const { data: wide } = await supabase
                .from('inspection_photos').select('storage_path')
                .eq('id', photo.paired_wide_photo_id).maybeSingle();
              if (wide && wide.storage_path) {
                const { data: blob } = await supabase.storage.from('documents').download(wide.storage_path);
                if (blob) widePhotoBuffer = Buffer.from(await blob.arrayBuffer());
                break; // one wide shot per bundle is enough
              }
            } catch (_) {}
          }
        }

        // Per-violation contexts
        const violationsCtx = [];
        for (const d of orderedGroup) {
          const v = vById.get(d.violation_id);
          const o = oById.get(d.observation_id);
          if (!v) continue;

          // Governing doc + priors
          let govDoc = null;
          try {
            const { data: prioRow } = await supabase
              .from('community_enforcement_priorities')
              .select('governing_doc_reference, governing_doc_section_title, governing_doc_quote, governing_doc_page')
              .eq('community_id', communityIdForGroup)
              .eq('category_id', v.primary_category_id)
              .is('end_date', null).maybeSingle();
            if (prioRow && (prioRow.governing_doc_reference || prioRow.governing_doc_section_title || prioRow.governing_doc_quote)) {
              govDoc = {
                reference: prioRow.governing_doc_reference,
                section_title: prioRow.governing_doc_section_title,
                quote: prioRow.governing_doc_quote,
                page: prioRow.governing_doc_page,
              };
            }
          } catch (_) {}
          // Auto-lookup fallback — substrate semantic search
          if (!govDoc) {
            try {
              const { lookupGoverningDoc } = require('../lib/enforcement/governing_doc_lookup');
              const auto = await lookupGoverningDoc({
                communityId:         communityIdForGroup,
                categoryLabel:       v.enforcement_categories && v.enforcement_categories.label,
                categoryDescription: v.enforcement_categories && v.enforcement_categories.description,
                aiDescription:       o && o.ai_description,
              });
              if (auto) {
                govDoc = {
                  reference:      auto.reference,
                  section_title:  auto.section_title,
                  quote:          auto.quote,
                  page:           auto.page,
                  document_title: auto.document_title,
                };
              }
            } catch (_) {}
          }

          const yearAgo = new Date(); yearAgo.setMonth(yearAgo.getMonth() - 12);
          const { data: priors } = await supabase
            .from('violations')
            .select('opened_at, current_stage')
            .eq('property_id', propertyId)
            .eq('primary_category_id', v.primary_category_id)
            .neq('id', v.id)
            .gte('opened_at', yearAgo.toISOString())
            .neq('quality_status', 'superseded')
            .order('opened_at', { ascending: false })
            .limit(5);

          let closeUpBuf = null;
          const photo = o && o.inspection_photos;
          if (photo && photo.storage_path) {
            try {
              const { data: blob } = await supabase.storage.from('documents').download(photo.storage_path);
              if (blob) closeUpBuf = Buffer.from(await blob.arrayBuffer());
            } catch (_) {}
          }

          violationsCtx.push({
            category_label: v.enforcement_categories && v.enforcement_categories.label,
            ai_description: o && o.ai_description,
            observation_captured_at: (photo && photo.captured_at) || (o && o.created_at),
            governing_doc: govDoc,
            prior_notices: (priors || []).map((pv) => ({ date: pv.opened_at, stage: pv.current_stage })),
            close_up_photo_buffer: closeUpBuf,
          });
        }

        // Generate the bundle PDF
        const pdfBuffer = await renderViolationLetterBundlePdf({
          property: {
            street_address: pRow.street_address, unit: pRow.unit,
            city: pRow.city, state: pRow.state, zip: pRow.zip, lot_number: pRow.lot_number,
          },
          owner: { full_name: pRow.owner_name, mailing_address: pRow.owner_mailing_address },
          community,
          stage,
          letter_date: new Date(), // placeholder — Mail Queue lock-and-batch re-stamps with postmark
          wide_photo_buffer: widePhotoBuffer,
          violations: violationsCtx,
          options: {
            sender_name:  community.letter_sender_name,
            sender_title: community.letter_sender_title,
          },
        });

        // Upload bundle PDF
        const bundleId = cryptoMod.randomUUID();
        const LETTERS_BUCKET = 'violation-letters';
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const letterPath = `${propertyId}/bundle-${stage}-${stamp}.pdf`;
        const { error: upErr } = await supabase.storage
          .from(LETTERS_BUCKET)
          .upload(letterPath, pdfBuffer, { contentType: 'application/pdf', upsert: false });
        if (upErr && !/already exists/i.test(upErr.message)) {
          skipped.push({ key: group.map((g) => g.id).join(','), reason: 'upload failed: ' + upErr.message });
          continue;
        }

        // Per-stage fee (one per bundle, not per violation)
        const feeCents = stage === 'courtesy_1'    ? Number(community.letter_fee_courtesy_1_cents    || 0)
                       : stage === 'courtesy_2'    ? Number(community.letter_fee_courtesy_2_cents    || 2500)
                       : Number(community.letter_fee_certified_209_cents || 3500);

        // Update all interactions in the bundle. First one carries the fee;
        // others = 0 so the audit per-row totals still sum correctly.
        for (let i = 0; i < orderedGroup.length; i++) {
          const d = orderedGroup[i];
          const isFirst = i === 0;
          await supabase.from('interactions')
            .update({
              bundle_id: bundleId,
              content: letterPath,
              letter_fee_cents: isFirst ? feeCents : 0,
            })
            .eq('id', d.id);
        }

        bundlesCreated += 1;
        draftsBundled += orderedGroup.length;
      } catch (e) {
        skipped.push({ reason: e.message });
      }
    }

    res.json({ bundles_created: bundlesCreated, drafts_bundled: draftsBundled, singletons, skipped });
  } catch (err) {
    console.error('[enforcement.drafts.auto-bundle]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/enforcement/drafts/approve
// Body: { interaction_ids: [uuid, ...] }
// Flips status from 'draft' to 'approved'. The letter is now ready for the
// Mail Queue to pick up (filter: status='approved' AND printed_at IS NULL).
// sent_at stays NULL until lock-and-batch actually postmarks the letter —
// before that, "sent" would be a lie in property-timeline queries.
// ---------------------------------------------------------------------------
router.post('/drafts/approve', express.json(), async (req, res) => {
  try {
    const { requireActingUser } = require('./_acting_user');
    const actor = await requireActingUser(req, res);
    if (!actor) return;

    const ids = (req.body && req.body.interaction_ids) || [];
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'interaction_ids (array) required' });
    }
    const { error: upErr, count } = await supabase
      .from('interactions')
      .update({
        status: 'approved',
        approved_by_user_id: actor.id,
      }, { count: 'exact' })
      .in('id', ids)
      .eq('status', 'draft');
    if (upErr) return res.status(500).json({ error: upErr.message });
    res.json({ approved: count || 0, requested: ids.length });
  } catch (err) {
    console.error('[enforcement.drafts.approve]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/enforcement/drafts/reject
// Body: { interaction_id, reason? }
// Soft-discard: deletes the draft interaction + closes the violation as
// 'voided' (no letter sent, observation stays for audit trail).
// ---------------------------------------------------------------------------
router.post('/drafts/reject', express.json(), async (req, res) => {
  try {
    const interactionId = req.body && req.body.interaction_id;
    const reason = (req.body && req.body.reason) || null;
    if (!interactionId) return res.status(400).json({ error: 'interaction_id required' });
    const { data: inter } = await supabase
      .from('interactions')
      .select('id, violation_id, observation_id, content')
      .eq('id', interactionId)
      .maybeSingle();
    if (!inter) return res.status(404).json({ error: 'draft not found' });

    // Best-effort: delete the rendered PDF from storage. Rejected drafts
    // have no audit value (the violation gets voided, the observation
    // marked rejected — nothing points at the PDF anymore). Without this,
    // every rejection during testing leaves a stale PDF behind.
    if (inter.content && /\.pdf$/i.test(String(inter.content))) {
      try { await supabase.storage.from('violation-letters').remove([inter.content]); } catch (_) {}
    }

    // Void the violation
    if (inter.violation_id) {
      await supabase.from('violations')
        .update({
          current_stage: 'voided',
          resolved_via: 'voided',
          resolved_at: new Date().toISOString(),
          resolved_notes: reason || 'Rejected from Drafts review',
        })
        .eq('id', inter.violation_id);
    }
    // Mark the observation rejected
    if (inter.observation_id) {
      await supabase.from('property_observations')
        .update({
          reviewer_status: 'rejected',
          reviewer_notes: reason || 'Rejected from Drafts review',
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', inter.observation_id);
    }
    // Flip the draft to status='rejected' so it disappears from the queue
    // but stays on the property timeline as an audit-trail record.
    await supabase.from('interactions')
      .update({
        status: 'rejected',
        notes: reason || 'Rejected from Drafts review',
      })
      .eq('id', interactionId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[enforcement.drafts.reject]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// MAIL QUEUE
// ---------------------------------------------------------------------------
// GET  /api/enforcement/mail-queue/summary
//   Counts of pending (approved but not yet printed) letters by delivery
//   method + community.
//
// POST /api/enforcement/mail-queue/batch-pdf
//   Body: { delivery_method, community_id?, interaction_ids? }
//   Merges all pending letter PDFs for that delivery_method (optionally
//   filtered to a community OR a specific set of interaction IDs) into a
//   single multi-page PDF, returns it as application/pdf with
//   Content-Disposition: attachment. Sets printed_at = NOW on the included
//   interactions so they don't re-export next time.
// ---------------------------------------------------------------------------
router.get('/mail-queue/summary', async (req, res) => {
  try {
    const communityId = req.query.community_id;
    // Postcards ride the same Mail Queue but are not bundled — one per
    // violation, just a printed reminder.
    const letterTypes = ['letter_courtesy_1', 'letter_courtesy_2', 'letter_209', 'letter_postcard_reminder'];
    let q = supabase
      .from('interactions')
      .select('id, delivery_method, community_id, communities:community_id(name)')
      .in('type', letterTypes)
      .in('status', ['approved', 'sent'])
      .is('printed_at', null);
    if (communityId) q = q.eq('community_id', communityId);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    const summary = { first_class_mail: 0, certified_mail: 0, by_community: {} };
    (data || []).forEach((row) => {
      if (row.delivery_method === 'first_class_mail') summary.first_class_mail += 1;
      if (row.delivery_method === 'certified_mail')   summary.certified_mail   += 1;
      const cName = (row.communities && row.communities.name) || 'Unknown community';
      if (!summary.by_community[cName]) summary.by_community[cName] = { first_class: 0, certified: 0 };
      if (row.delivery_method === 'first_class_mail') summary.by_community[cName].first_class += 1;
      if (row.delivery_method === 'certified_mail')   summary.by_community[cName].certified  += 1;
    });
    res.json({ summary, total_pending: (data || []).length });
  } catch (err) {
    console.error('[mail-queue.summary]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/enforcement/mail-queue/letters
//   Lists each approved-but-not-printed letter individually so staff can see
//   WHICH letters are queued up to mail (rather than just counts) and revert
//   ones that shouldn't be there — e.g., letters approved during testing,
//   letters belonging to inspections that were later discarded.
// ---------------------------------------------------------------------------
router.get('/mail-queue/letters', async (req, res) => {
  try {
    const communityId = req.query.community_id;
    const letterTypes = ['letter_courtesy_1', 'letter_courtesy_2', 'letter_209', 'letter_postcard_reminder'];
    let q = supabase
      .from('interactions')
      .select(`
        id, type, delivery_method, status, sent_at, postmark_date, subject, created_at,
        community_id, property_id, violation_id, inspection_id, bundle_id,
        communities:community_id(name)
      `)
      .in('type', letterTypes)
      .in('status', ['approved', 'sent'])
      .is('printed_at', null)
      .order('created_at', { ascending: false })
      .limit(500);
    if (communityId) q = q.eq('community_id', communityId);
    const { data: letters, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    if (!letters || letters.length === 0) return res.json({ letters: [] });

    const propertyIds = [...new Set(letters.map((l) => l.property_id).filter(Boolean))];
    const { data: props } = propertyIds.length
      ? await supabase.from('v_current_property_owners')
          .select('property_id, street_address, unit, owner_name')
          .in('property_id', propertyIds)
      : { data: [] };
    const propById = new Map((props || []).map((p) => [p.property_id, p]));

    // Sign a 1-hour URL for each letter PDF so the Mail Queue UI can preview
    // before deciding whether to cancel an approval. interactions.content
    // holds the storage path for letter types.
    const enriched = await Promise.all(letters.map(async (l) => {
      const p = propById.get(l.property_id);
      let letter_url = null;
      // For letters, interactions.content stores the PDF storage path.
      // Skip postcard-reminder if content is not a path-like string.
      const candidatePath = l.subject && typeof l === 'object' && l.id ? null : null; // noop placeholder
      const { data: full } = await supabase
        .from('interactions')
        .select('content')
        .eq('id', l.id)
        .maybeSingle();
      const storagePath = full && full.content;
      if (storagePath && /\.pdf$/i.test(String(storagePath))) {
        try {
          const { data: sd } = await supabase.storage
            .from('violation-letters')
            .createSignedUrl(storagePath, 60 * 60);
          letter_url = sd && sd.signedUrl;
        } catch (_) {}
      }
      return {
        id:               l.id,
        type:             l.type,
        delivery_method:  l.delivery_method,
        status:           l.status,
        subject:          l.subject,
        created_at:       l.created_at,
        sent_at:          l.sent_at,
        community_name:   (l.communities && l.communities.name) || null,
        property_address: p ? `${p.street_address}${p.unit ? ' #' + p.unit : ''}` : null,
        owner_name:       p ? p.owner_name : null,
        violation_id:     l.violation_id,
        bundle_id:        l.bundle_id,
        letter_url,
      };
    }));

    res.json({ letters: enriched });
  } catch (err) {
    console.error('[mail-queue.letters]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/enforcement/mail-queue/cancel
//   Body: { interaction_id }
//   Reverts an approved letter back to draft status so it disappears from
//   Mail Queue and reappears in the Drafts queue for further review. Used
//   when a letter was approved by mistake or belongs to a discarded
//   inspection. Refuses if the letter has already been sent (postmark_date
//   set) — those are audit-grade and must be cancelled via a separate
//   void-letter workflow.
// ---------------------------------------------------------------------------
router.post('/mail-queue/cancel', express.json(), async (req, res) => {
  try {
    const interactionId = req.body && req.body.interaction_id;
    if (!interactionId) return res.status(400).json({ error: 'interaction_id required' });

    const { data: inter, error: getErr } = await supabase
      .from('interactions')
      .select('id, status, postmark_date, printed_at')
      .eq('id', interactionId)
      .maybeSingle();
    if (getErr || !inter) return res.status(404).json({ error: 'interaction not found' });
    if (inter.printed_at) return res.status(409).json({ error: 'letter already printed — cannot cancel' });
    if (inter.postmark_date) return res.status(409).json({ error: 'letter already postmarked — cannot cancel' });
    if (!['approved', 'sent'].includes(inter.status)) {
      return res.status(409).json({ error: `letter is ${inter.status}, not approved — nothing to cancel` });
    }

    const { error: updErr } = await supabase
      .from('interactions')
      .update({ status: 'draft', sent_at: null })
      .eq('id', interactionId);
    if (updErr) return res.status(500).json({ error: updErr.message });

    res.json({ ok: true, interaction_id: interactionId, new_status: 'draft' });
  } catch (err) {
    console.error('[mail-queue.cancel]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/mail-queue/batch-pdf', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const deliveryMethod = body.delivery_method;
    const communityId = body.community_id || null;
    const explicitIds = Array.isArray(body.interaction_ids) ? body.interaction_ids : null;
    if (!deliveryMethod || !['first_class_mail', 'certified_mail'].includes(deliveryMethod)) {
      return res.status(400).json({ error: "delivery_method must be 'first_class_mail' or 'certified_mail'" });
    }
    const letterTypes = ['letter_courtesy_1', 'letter_courtesy_2', 'letter_209', 'letter_postcard_reminder'];

    let q = supabase
      .from('interactions')
      .select('id, content, type, subject, sent_at, community_id, property_id')
      .in('type', letterTypes)
      .eq('delivery_method', deliveryMethod)
      .in('status', ['approved', 'sent'])
      .is('printed_at', null)
      .order('sent_at', { ascending: true });
    if (communityId) q = q.eq('community_id', communityId);
    if (explicitIds) q = q.in('id', explicitIds);
    const { data: letters, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    if (!letters || letters.length === 0) {
      return res.status(404).json({ error: 'No pending letters match those filters.' });
    }

    // Download all the PDFs from storage
    const { PDFDocument } = require('pdf-lib');
    const out = await PDFDocument.create();
    let included = [];
    let skipped = [];
    for (const L of letters) {
      if (!L.content) { skipped.push({ id: L.id, reason: 'no storage path' }); continue; }
      try {
        const { data: blob } = await supabase.storage.from('violation-letters').download(L.content);
        if (!blob) { skipped.push({ id: L.id, reason: 'storage missing' }); continue; }
        const ab = await blob.arrayBuffer();
        const src = await PDFDocument.load(ab);
        const copied = await out.copyPages(src, src.getPageIndices());
        copied.forEach((page) => out.addPage(page));
        included.push(L.id);
      } catch (e) {
        skipped.push({ id: L.id, reason: e.message });
      }
    }
    if (included.length === 0) {
      return res.status(500).json({ error: 'Could not load any letter PDFs.', skipped });
    }
    const mergedBytes = await out.save();

    // Mark all included letters as printed
    const stamp = new Date().toISOString();
    await supabase
      .from('interactions')
      .update({ printed_at: stamp })
      .in('id', included);

    // Stream the PDF back to the browser
    const filenameStamp = stamp.replace(/[:.]/g, '-').slice(0, 19);
    const methodLabel = deliveryMethod === 'certified_mail' ? 'CERTIFIED' : 'first-class';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="bedrock-mail-batch-${methodLabel}-${filenameStamp}.pdf"`);
    res.setHeader('X-Bedrock-Included', included.length);
    res.setHeader('X-Bedrock-Skipped', skipped.length);
    res.end(Buffer.from(mergedBytes));
  } catch (err) {
    console.error('[mail-queue.batch-pdf]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/enforcement/mail-queue/lock-and-batch
// Body: { delivery_method, community_id?, interaction_ids?, postmark_date? }
//
// LEGAL-CRITICAL ENDPOINT. This is the version of batch-pdf that should be
// used for certified §209 letters — and arguably for all letters. It:
//   1. Re-generates each letter PDF with letter_date = postmark_date (today
//      by default), so the cure-by + hearing-request dates in the letter
//      MATCH the actual postmark date. § 209.006(b)(2)(B) keys the 30-day
//      clock to mailing date; this endpoint closes the legal-challenge
//      surface that exists when a letter is drafted today but mailed in
//      three days.
//   2. Updates the corresponding violations' cure_period_ends_at to anchor
//      from the postmark date.
//   3. Stamps interaction.postmark_date + sent_at + printed_at = NOW so the
//      audit trail records the actual legal mailing date.
//   4. Merges the regenerated PDFs into one batch PDF and streams it back.
//
// Per-community letter fees + cure days drive the dates + amounts; defaults
// kick in when the community row hasn't been customized.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// GET /api/enforcement/interactions/:id/delivery-receipts
// Returns the full multi-channel delivery trail for one interaction. Powers
// the property-detail Evidence panel: "mail postmarked May 19, email sent
// May 19 (opened May 20), SMS delivered May 19." When a homeowner calls
// claiming they never got the letter, the operator opens this panel and
// shows — not argues — that three channels reached them on three dates.
// ---------------------------------------------------------------------------
router.get('/interactions/:id/delivery-receipts', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('delivery_receipts')
      .select('id, channel, to_address, status, vendor, vendor_message_id, sent_at, delivered_at, opened_at, clicked_at, failed_at, failure_reason, notes')
      .eq('interaction_id', req.params.id)
      .order('sent_at', { ascending: true });
    if (error) throw error;
    res.json({ receipts: data || [] });
  } catch (err) {
    console.error('[enforcement.delivery-receipts]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/enforcement/violations/:id/delivery-receipts
// Same shape but scoped to all interactions tied to one violation.
// Used by the violation-evidence view (every letter ever sent + every
// channel attempt on each of those letters).
// ---------------------------------------------------------------------------
router.get('/violations/:id/delivery-receipts', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('delivery_receipts')
      .select('id, interaction_id, channel, to_address, status, vendor, vendor_message_id, sent_at, delivered_at, opened_at, clicked_at, failed_at, failure_reason, notes')
      .eq('violation_id', req.params.id)
      .order('sent_at', { ascending: true });
    if (error) throw error;
    res.json({ receipts: data || [] });
  } catch (err) {
    console.error('[enforcement.violations.delivery-receipts]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/mail-queue/lock-and-batch', express.json(), async (req, res) => {
  try {
    const { requireActingUser } = require('./_acting_user');
    const actor = await requireActingUser(req, res);
    if (!actor) return;

    const body = req.body || {};
    const deliveryMethod = body.delivery_method;
    const communityId = body.community_id || null;
    const explicitIds = Array.isArray(body.interaction_ids) ? body.interaction_ids : null;
    if (!deliveryMethod || !['first_class_mail', 'certified_mail'].includes(deliveryMethod)) {
      return res.status(400).json({ error: "delivery_method must be 'first_class_mail' or 'certified_mail'" });
    }
    // Postmark date — today by default. Operator can override (e.g. mailing
    // a batch tomorrow morning, lock it tonight with tomorrow's date).
    const postmarkIso = body.postmark_date
      ? new Date(body.postmark_date).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const postmarkDate = new Date(postmarkIso + 'T12:00:00Z'); // noon UTC anchor

    const letterTypes = ['letter_courtesy_1', 'letter_courtesy_2', 'letter_209'];

    let q = supabase
      .from('interactions')
      .select('id, content, type, subject, community_id, property_id, violation_id, observation_id, status, bundle_id')
      .in('type', letterTypes)
      .eq('delivery_method', deliveryMethod)
      .in('status', ['approved', 'sent'])
      .is('printed_at', null)
      .order('sent_at', { ascending: true });
    if (communityId) q = q.eq('community_id', communityId);
    if (explicitIds) q = q.in('id', explicitIds);
    const { data: letters, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    if (!letters || letters.length === 0) {
      return res.status(404).json({ error: 'No pending letters match those filters.' });
    }

    const { renderViolationLetterPdf } = require('../lib/enforcement/violation_letter');
    const { PDFDocument } = require('pdf-lib');
    const out = await PDFDocument.create();

    // Cache joined community config + property data across iterations
    const communityCache = new Map();
    async function getCommunity(id) {
      if (communityCache.has(id)) return communityCache.get(id);
      // Try the full select first; fall back to a column-conservative select
      // when a not-yet-run migration leaves new columns absent (so the Mail
      // Queue keeps working even before migration 066 is applied).
      let data = null;
      try {
        const r = await supabase
          .from('communities')
          .select('id, name, legal_name, letter_sender_name, letter_sender_title, letter_fee_courtesy_1_cents, letter_fee_courtesy_2_cents, letter_fee_certified_209_cents, letter_fee_fine_assessed_cents, letter_payment_url, letter_pay_to_name, letter_pay_to_address, letter_cure_days_courtesy_1, letter_cure_days_courtesy_2, letter_cure_days_certified_209, logo_storage_path, logo_mime_type, enforcement_authority_citation')
          .eq('id', id)
          .maybeSingle();
        if (r.error) throw r.error;
        data = r.data;
      } catch (_) {
        const r2 = await supabase
          .from('communities')
          .select('id, name, legal_name, letter_sender_name, letter_sender_title, letter_fee_courtesy_1_cents, letter_fee_courtesy_2_cents, letter_fee_certified_209_cents, letter_fee_fine_assessed_cents, letter_payment_url, letter_pay_to_name, letter_pay_to_address, letter_cure_days_courtesy_1, letter_cure_days_courtesy_2, letter_cure_days_certified_209')
          .eq('id', id)
          .maybeSingle();
        data = r2.data;
      }
      communityCache.set(id, data);
      return data;
    }

    // Community-logo buffer cache (one fetch per community per batch).
    const logoCache = new Map();
    async function getCommunityLogo(community) {
      if (!community || !community.logo_storage_path) return null;
      if (logoCache.has(community.id)) return logoCache.get(community.id);
      try {
        const { data: blob } = await supabase.storage.from('documents').download(community.logo_storage_path);
        const buf = blob ? Buffer.from(await blob.arrayBuffer()) : null;
        logoCache.set(community.id, buf);
        return buf;
      } catch (_) {
        logoCache.set(community.id, null);
        return null;
      }
    }

    const included = [];
    const skipped = [];

    for (const L of letters) {
      try {
        // Fetch violation + joined data needed for regeneration
        const { data: vio } = await supabase
          .from('violations')
          .select('id, property_id, community_id, current_stage, primary_category_id, opened_at, board_priority_at_open, opened_from_observation_id')
          .eq('id', L.violation_id)
          .maybeSingle();
        if (!vio) { skipped.push({ id: L.id, reason: 'violation not found' }); continue; }

        const community = await getCommunity(vio.community_id);
        if (!community) { skipped.push({ id: L.id, reason: 'community not found' }); continue; }

        // Cure-by date anchored to the postmark date + per-community cure days
        const cureDays = vio.current_stage === 'courtesy_1' ? Number(community.letter_cure_days_courtesy_1 || 20)
                       : vio.current_stage === 'courtesy_2' ? Number(community.letter_cure_days_courtesy_2 || 20)
                       : Number(community.letter_cure_days_certified_209 || 30);
        const cureBy = new Date(postmarkDate.getTime() + cureDays * 24 * 60 * 60 * 1000).toISOString();

        // Property + owner. owner_contact_id is needed for multi-channel
        // supplemental notices (email/SMS lookups go through contacts).
        const { data: pRow } = await supabase
          .from('v_current_property_owners')
          .select('property_id, street_address, unit, city, state, zip, lot_number, owner_name, owner_mailing_address, owner_contact_id')
          .eq('property_id', vio.property_id)
          .maybeSingle();
        if (!pRow) { skipped.push({ id: L.id, reason: 'property not found' }); continue; }

        // Category + governing doc
        const { data: catRow } = await supabase
          .from('enforcement_categories')
          .select('label, description')
          .eq('id', vio.primary_category_id)
          .maybeSingle();
        let govDoc = null;
        try {
          const { data: prioRow } = await supabase
            .from('community_enforcement_priorities')
            .select('governing_doc_reference, governing_doc_section_title, governing_doc_quote, governing_doc_page')
            .eq('community_id', vio.community_id)
            .eq('category_id', vio.primary_category_id)
            .is('end_date', null)
            .maybeSingle();
          if (prioRow && (prioRow.governing_doc_reference || prioRow.governing_doc_section_title || prioRow.governing_doc_quote)) {
            govDoc = {
              reference:     prioRow.governing_doc_reference,
              section_title: prioRow.governing_doc_section_title,
              quote:         prioRow.governing_doc_quote,
              page:          prioRow.governing_doc_page,
            };
          }
        } catch (_) {}

        // Observation + photo
        let observation = null;
        let closeUpBuffer = null;
        let wideBuffer = null;
        if (vio.opened_from_observation_id) {
          const { data: obs } = await supabase
            .from('property_observations')
            .select('ai_description, severity, created_at, inspection_photo_id, inspection_photos(captured_at, storage_path, paired_wide_photo_id)')
            .eq('id', vio.opened_from_observation_id)
            .maybeSingle();
          if (obs) {
            observation = { ai_description: obs.ai_description, severity: obs.severity, captured_at: (obs.inspection_photos && obs.inspection_photos.captured_at) || obs.created_at };
            // Close-up photo
            if (obs.inspection_photos && obs.inspection_photos.storage_path) {
              try {
                const { data: blob } = await supabase.storage.from('documents').download(obs.inspection_photos.storage_path);
                if (blob) closeUpBuffer = Buffer.from(await blob.arrayBuffer());
              } catch (_) {}
            }
            // Paired wide photo
            const widePhotoId = obs.inspection_photos && obs.inspection_photos.paired_wide_photo_id;
            if (widePhotoId) {
              try {
                const { data: wide } = await supabase
                  .from('inspection_photos')
                  .select('storage_path')
                  .eq('id', widePhotoId)
                  .maybeSingle();
                if (wide && wide.storage_path) {
                  const { data: wideBlob } = await supabase.storage.from('documents').download(wide.storage_path);
                  if (wideBlob) wideBuffer = Buffer.from(await wideBlob.arrayBuffer());
                }
              } catch (_) {}
            }
          }
        }

        // Priors for §209 history block
        const yearAgo = new Date(); yearAgo.setMonth(yearAgo.getMonth() - 12);
        const { data: priors } = await supabase
          .from('violations')
          .select('opened_at, current_stage')
          .eq('property_id', vio.property_id)
          .eq('primary_category_id', vio.primary_category_id)
          .neq('id', vio.id)
          .gte('opened_at', yearAgo.toISOString())
          .neq('quality_status', 'superseded')
          .order('opened_at', { ascending: false })
          .limit(5);

        // Fetch the community logo for co-branded letterhead (cached per batch)
        const communityLogoBuffer = await getCommunityLogo(community);

        // Regenerate the letter PDF anchored at the postmark date
        const pdfBuffer = await renderViolationLetterPdf({
          violation: {
            id: vio.id,
            current_stage: vio.current_stage,
            cure_period_ends_at: cureBy,
            opened_at: vio.opened_at,
            category_label: catRow && catRow.label,
            board_priority_at_open: vio.board_priority_at_open,
          },
          property: {
            street_address: pRow.street_address, unit: pRow.unit,
            city: pRow.city, state: pRow.state, zip: pRow.zip, lot_number: pRow.lot_number,
          },
          owner: { full_name: pRow.owner_name, mailing_address: pRow.owner_mailing_address },
          community,
          observation,
          governing_doc: govDoc,
          prior_violations: priors || [],
          wide_photo_buffer: wideBuffer,
          photo_buffer: closeUpBuffer,
          community_logo_buffer: communityLogoBuffer,
          options: {
            letter_date: postmarkDate,
            sender_name:  community.letter_sender_name,
            sender_title: community.letter_sender_title,
          },
        });

        // Upload regenerated PDF — new path with postmark stamp
        const LETTERS_BUCKET = 'violation-letters';
        const stamp = postmarkIso.replace(/-/g, '');
        const letterPath = `${vio.id}/${vio.current_stage}-postmark-${stamp}.pdf`;
        const { error: upErr } = await supabase.storage
          .from(LETTERS_BUCKET)
          .upload(letterPath, pdfBuffer, { contentType: 'application/pdf', upsert: true });
        if (upErr) {
          skipped.push({ id: L.id, reason: 'upload failed: ' + upErr.message });
          continue;
        }

        // Update violation's cure_period_ends_at + the interaction's
        // content path + postmark_date + sent_at
        const nowIso = new Date().toISOString();
        await supabase.from('violations')
          .update({ cure_period_ends_at: cureBy })
          .eq('id', vio.id);
        await supabase.from('interactions')
          .update({
            content: letterPath,
            postmark_date: postmarkIso,
            sent_at: nowIso,
            status: 'sent',
            letter_fee_cents:
              vio.current_stage === 'courtesy_1' ? Number(community.letter_fee_courtesy_1_cents || 0)
              : vio.current_stage === 'courtesy_2' ? Number(community.letter_fee_courtesy_2_cents || 2500)
              : Number(community.letter_fee_certified_209_cents || 3500),
          })
          .eq('id', L.id);

        // Mail channel delivery receipt — records the postmark side of the
        // evidence trail. Every channel send produces a delivery_receipts
        // row so the homeowner-complaint defense ("I never got it") can
        // surface all attempts on the property-detail evidence panel.
        try {
          await supabase.from('delivery_receipts').insert({
            interaction_id: L.id,
            community_id:   vio.community_id,
            property_id:    vio.property_id,
            violation_id:   vio.id,
            channel:        deliveryMethod,
            to_address:     pRow.owner_mailing_address || pRow.street_address || '',
            status:         'sent',
            vendor:         'usps',
            vendor_message_id: null, // certified tracking number is stamped post-mailing via a separate workflow
            sent_at:        nowIso,
            notes:          'Postmarked ' + postmarkIso,
          });
        } catch (recErr) { console.warn('[lock-and-batch] mail receipt insert failed:', recErr.message); }

        // Multi-channel supplemental notices — email + SMS to the homeowner
        // owner contact, where channel preferences allow. These are TRANSACTIONAL
        // (related to an existing customer relationship under the CC&Rs), so
        // email goes by default; SMS requires explicit sms_opt_in. Each send
        // logs a delivery_receipts row regardless of vendor success.
        try {
          await _fireSupplementalNotices({
            interactionId: L.id,
            communityId:   vio.community_id,
            community,
            propertyId:    vio.property_id,
            property:      pRow,
            violationId:   vio.id,
            violation:     vio,
            categoryLabel: catRow && catRow.label,
            postmarkIso,
            cureBy,
            pdfBuffer,
            letterPath,
          });
        } catch (notifErr) {
          console.warn('[lock-and-batch] supplemental notices failed:', notifErr.message);
        }

        // Append to merged batch PDF
        const src = await PDFDocument.load(pdfBuffer);
        const copied = await out.copyPages(src, src.getPageIndices());
        copied.forEach((page) => out.addPage(page));
        included.push(L.id);
      } catch (e) {
        skipped.push({ id: L.id, reason: e.message });
      }
    }

    if (included.length === 0) {
      return res.status(500).json({ error: 'Could not regenerate any letter PDFs.', skipped });
    }

    // Mark all included letters as printed + stamp the locking user
    await supabase
      .from('interactions')
      .update({
        printed_at: new Date().toISOString(),
        locked_by_user_id: actor.id,
      })
      .in('id', included);

    const mergedBytes = await out.save();
    const filenameStamp = postmarkIso.replace(/-/g, '');
    const methodLabel = deliveryMethod === 'certified_mail' ? 'CERTIFIED' : 'first-class';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="bedrock-mail-batch-${methodLabel}-locked-${filenameStamp}.pdf"`);
    res.setHeader('X-Bedrock-Included', included.length);
    res.setHeader('X-Bedrock-Skipped', skipped.length);
    res.setHeader('X-Bedrock-Postmark', postmarkIso);
    res.end(Buffer.from(mergedBytes));
  } catch (err) {
    console.error('[mail-queue.lock-and-batch]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// AI DOC-REFERENCE EXTRACTOR
// ---------------------------------------------------------------------------
// Given a community + an enforcement category, scan the community's loaded
// governing documents (declaration_ccrs / bylaws / rules_and_regulations /
// design_document) and ask the AI to identify the specific section that
// addresses this category. Writes the result back to
// community_enforcement_priorities.governing_doc_* so the next letter for
// that (community, category) cites the actual section + quote.
//
// Two flavors:
//   POST /api/enforcement/extract-doc-references/:community_id/:category_id
//     One-shot for a specific pair (used by a UI "suggest reference" button).
//
//   POST /api/enforcement/extract-doc-references/:community_id
//     Batch — scans every category that has priority_weight != 'disabled' and
//     no governing_doc_reference yet (or force=true to redo all).
//
// Uses the existing knowledge_documents + knowledge_chunks vector-search
// infrastructure (migration 011). If the community's CC&Rs haven't been
// ingested as knowledge_documents (source_type='governing_document'),
// returns a hint to ingest first — no error.
// ---------------------------------------------------------------------------

async function _extractDocRefForCategory(communityId, categoryId, options = {}) {
  const Anthropic = require('@anthropic-ai/sdk');
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, reason: 'ANTHROPIC_API_KEY not set' };

  // 1. Get the category + community context
  const { data: cat } = await supabase
    .from('enforcement_categories')
    .select('id, slug, label, description')
    .eq('id', categoryId)
    .maybeSingle();
  if (!cat) return { ok: false, reason: 'category not found' };

  const { data: comm } = await supabase
    .from('communities')
    .select('id, name, legal_name, management_company_id')
    .eq('id', communityId)
    .maybeSingle();
  if (!comm) return { ok: false, reason: 'community not found' };

  // 2. Find this community's governing-doc knowledge_chunks via vector search.
  //    Build the query embedding from the category label + description so the
  //    semantic search lands on the relevant section.
  const OpenAI = require('openai');
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  if (!process.env.OPENAI_API_KEY) {
    return { ok: false, reason: 'OPENAI_API_KEY not set (needed for embedding query)' };
  }

  const queryText = `${cat.label}. ${cat.description || ''} — covenant or rule for this in an HOA's CC&Rs, bylaws, or rules and regulations.`;
  let queryEmbedding;
  try {
    const embedResp = await openai.embeddings.create({
      model: 'text-embedding-ada-002',
      input: queryText,
    });
    queryEmbedding = embedResp.data[0].embedding;
  } catch (e) {
    return { ok: false, reason: 'embedding failed: ' + e.message };
  }

  // 3. Vector search the knowledge base for the most relevant chunks
  const { data: chunks, error: matchErr } = await supabase.rpc('match_knowledge_chunks', {
    query_embedding: queryEmbedding,
    mgmt_co_id:      comm.management_company_id,
    match_count:     6,
    source_filter:   ['governing_document'],
  });
  if (matchErr) return { ok: false, reason: 'search failed: ' + matchErr.message };
  if (!chunks || chunks.length === 0) {
    return { ok: false, reason: 'no governing docs found in knowledge base — ingest CC&Rs / Bylaws first (source_type=governing_document)' };
  }

  // 4. Ask the AI to identify the best section + extract a clean quote
  const client = new Anthropic({ apiKey });
  const chunkBlocks = chunks.map((c, i) =>
    `--- Chunk ${i + 1}  (${c.document_title}, page ${c.page_number || '?'}${c.section_heading ? ', ' + c.section_heading : ''}) ---\n${c.text}`
  ).join('\n\n');

  const systemPrompt = `You are reviewing excerpts from an HOA's governing documents to identify the most relevant section that addresses a specific enforcement category. Your job is to extract a clean citation + short verbatim quote that a violation letter can reference.

Voice: just return the JSON. No preamble, no commentary.

If no chunk clearly addresses the category, set "found": false and explain briefly in "notes".

Always respond with valid JSON:
{
  "found": true|false,
  "reference":     "DCC&Rs Article IV, Section 4.3",   // canonical citation
  "section_title": "Landscaping Standards",             // human-readable heading
  "quote":         "Each Owner shall maintain the Lot in a neat, clean...",  // 1-2 sentences max, verbatim
  "page":          14,                                  // page number from chunk metadata
  "chunk_index":   2,                                   // which provided chunk was used (1-based)
  "confidence":    "low|medium|high",
  "notes":         "optional"
}`;

  const userText = `Community: ${comm.name}
Enforcement category: ${cat.label}
${cat.description ? 'Description: ' + cat.description : ''}

Below are 6 excerpts from the community's governing documents (CC&Rs, Bylaws, or Rules & Regulations). Identify which excerpt most directly addresses this category and extract the citation + a brief verbatim quote.

${chunkBlocks}`;

  let raw;
  try {
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userText }],
    });
    raw = (resp.content || []).find((b) => b.type === 'text');
    raw = raw && raw.text || '';
  } catch (e) {
    return { ok: false, reason: 'the AI call failed: ' + e.message };
  }

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { ok: false, reason: 'no JSON in the AI response', raw };
  let parsed;
  try { parsed = JSON.parse(jsonMatch[0]); }
  catch (e) { return { ok: false, reason: 'JSON parse failed', raw }; }

  if (!parsed.found) return { ok: true, found: false, notes: parsed.notes, raw };

  // 5. Write back to community_enforcement_priorities (active row)
  const { error: upErr } = await supabase
    .from('community_enforcement_priorities')
    .update({
      governing_doc_reference:     parsed.reference || null,
      governing_doc_section_title: parsed.section_title || null,
      governing_doc_quote:         parsed.quote || null,
      governing_doc_page:          parsed.page || null,
      governing_doc_source:        'ai_extracted',
      governing_doc_extracted_at:  new Date().toISOString(),
    })
    .eq('community_id', communityId)
    .eq('category_id', categoryId)
    .is('end_date', null);
  if (upErr) return { ok: false, reason: 'update failed: ' + upErr.message };

  return {
    ok: true, found: true,
    reference:     parsed.reference,
    section_title: parsed.section_title,
    quote:         parsed.quote,
    page:          parsed.page,
    confidence:    parsed.confidence,
  };
}

// ---------------------------------------------------------------------------
// GET /api/enforcement/categories — list of canonical enforcement categories.
// Used by UI dropdowns (manual prior-violation entry, category override, etc.)
// ---------------------------------------------------------------------------
router.get('/categories', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('enforcement_categories')
      .select('id, slug, label, description, default_priority_weight, display_order')
      .order('display_order', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ categories: data || [] });
  } catch (err) {
    console.error('[enforcement.categories]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// VIOLATION QUALITY ACTIONS
// ---------------------------------------------------------------------------
// PATCH /api/enforcement/violations/:id/quality
//   Body: { quality_status: 'verified' | 'unreviewed' | 'disputed_by_owner' |
//                            'flagged_internal',
//           confidence_weight?: 0-1,
//           review_notes?: string,
//           user_id?: string }
//   Updates the violation's quality fields + records reviewer + timestamp.
//   For 'superseded' (which means "this is being corrected"), use the
//   /violations/:id/correct endpoint instead so an audit row is created.
// ---------------------------------------------------------------------------
router.patch('/violations/:id/quality', express.json(), async (req, res) => {
  try {
    const violationId = req.params.id;
    const body = req.body || {};
    const allowedStatuses = ['verified', 'unreviewed', 'disputed_by_owner', 'flagged_internal'];
    if (body.quality_status && !allowedStatuses.includes(body.quality_status)) {
      return res.status(400).json({ error: 'invalid quality_status (use /correct for superseded)' });
    }
    const patch = { reviewed_at: new Date().toISOString() };
    if (body.quality_status) patch.quality_status = body.quality_status;
    if (typeof body.confidence_weight === 'number') {
      patch.confidence_weight = Math.max(0, Math.min(1, body.confidence_weight));
    } else if (body.quality_status === 'verified') {
      patch.confidence_weight = 1.0;   // verified always promotes to full weight
    }
    if (body.review_notes != null) patch.review_notes = body.review_notes;
    if (body.user_id) patch.reviewed_by_user_id = body.user_id;

    const { data, error } = await supabase
      .from('violations')
      .update(patch)
      .eq('id', violationId)
      .select('id, quality_status, confidence_weight, reviewed_at, reviewed_by_user_id, review_notes')
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, violation: data });
  } catch (err) {
    console.error('[violations.quality]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/enforcement/violations/:id/correct
// Body: { correction_type, reason, replacement: {...} | null, user_id? }
//   Records a correction row + sets the original to status='superseded'
//   (which makes confidence_weight=0 effective for escalation math).
//   If correction_type is 'reclassified' / 'wrong_property' and the body
//   includes a replacement object, creates a new violation with the
//   corrected fields and links it via replacement_violation_id.
// ---------------------------------------------------------------------------
router.post('/violations/:id/correct', express.json(), async (req, res) => {
  try {
    const originalId = req.params.id;
    const body = req.body || {};
    const validTypes = ['voided','reclassified','wrong_property','duplicate',
                        'resolved_at_inspection','reissued','merged_into','split_from'];
    if (!validTypes.includes(body.correction_type)) {
      return res.status(400).json({ error: 'invalid correction_type', allowed: validTypes });
    }
    if (!body.reason) {
      return res.status(400).json({ error: 'reason is required for any correction' });
    }
    // Fetch original for snapshot
    const { data: original, error: oErr } = await supabase
      .from('violations')
      .select('*')
      .eq('id', originalId)
      .maybeSingle();
    if (oErr || !original) return res.status(404).json({ error: 'violation not found' });

    // Optionally create a replacement violation
    let replacementId = null;
    if (body.replacement && (body.correction_type === 'reclassified' ||
                              body.correction_type === 'wrong_property' ||
                              body.correction_type === 'reissued')) {
      const r = body.replacement;
      const { data: created, error: cErr } = await supabase
        .from('violations')
        .insert({
          property_id:         r.property_id || original.property_id,
          community_id:        r.community_id || original.community_id,
          primary_category_id: r.primary_category_id || original.primary_category_id,
          board_priority_at_open: r.board_priority_at_open || original.board_priority_at_open,
          current_stage:       r.current_stage || original.current_stage,
          opened_at:           r.opened_at || original.opened_at,
          opened_from_observation_id: original.opened_from_observation_id,
          source:              'manual_entry',
          confidence_weight:   1.0,
          quality_status:      'verified',
          review_notes:        `Replacement for corrected violation ${originalId}. Reason: ${body.reason}`,
        })
        .select('id')
        .single();
      if (cErr) return res.status(500).json({ error: 'failed to create replacement: ' + cErr.message });
      replacementId = created.id;
    }

    // Mark original superseded
    await supabase.from('violations')
      .update({
        quality_status: 'superseded',
        confidence_weight: 0,
        reviewed_at: new Date().toISOString(),
        reviewed_by_user_id: body.user_id || null,
        review_notes: `Superseded via ${body.correction_type}: ${body.reason}`,
      })
      .eq('id', originalId);

    // Drop a correction row
    const { data: correction, error: corrErr } = await supabase
      .from('violation_corrections')
      .insert({
        original_violation_id: originalId,
        correction_type: body.correction_type,
        replacement_violation_id: replacementId,
        reason: body.reason,
        corrected_by_user_id: body.user_id || null,
        original_state: original,
        notes: body.notes || null,
      })
      .select()
      .single();
    if (corrErr) return res.status(500).json({ error: 'failed to record correction: ' + corrErr.message });

    res.json({
      ok: true,
      correction,
      replacement_violation_id: replacementId,
    });
  } catch (err) {
    console.error('[violations.correct]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/enforcement/violations/manual
// Body: { property_id, category_id, opened_at, current_stage, source?,
//         confidence_weight?, notes?, user_id? }
//   Manually creates a prior violation. Used to backfill known-existing
//   violations that aren't in trustEd (e.g., Vantaca records not yet imported,
//   verbal history from a homeowner). Defaults to source='manual_entry',
//   confidence_weight=0.8, quality_status='verified'.
// ---------------------------------------------------------------------------
router.post('/violations/manual', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.property_id || !body.category_id || !body.opened_at) {
      return res.status(400).json({ error: 'property_id, category_id, opened_at required' });
    }
    const validStages = ['courtesy_1','courtesy_2','certified_209','fine_assessed','cured','closed','voided'];
    const stage = body.current_stage || 'courtesy_1';
    if (!validStages.includes(stage)) {
      return res.status(400).json({ error: 'invalid current_stage' });
    }
    // Look up community_id from property
    const { data: prop } = await supabase
      .from('properties')
      .select('community_id')
      .eq('id', body.property_id)
      .maybeSingle();
    if (!prop) return res.status(404).json({ error: 'property not found' });

    const source = body.source || 'manual_entry';
    const sourceDefaults = {
      manual_entry:        0.8,
      vantaca_import:      0.5,
      predecessor_import:  0.3,
      legacy_unknown:      0.4,
      trustEd_native:      1.0,
    };
    const weight = (typeof body.confidence_weight === 'number')
      ? Math.max(0, Math.min(1, body.confidence_weight))
      : sourceDefaults[source] || 0.8;

    const { data, error } = await supabase
      .from('violations')
      .insert({
        property_id:        body.property_id,
        community_id:       prop.community_id,
        primary_category_id: body.category_id,
        board_priority_at_open: body.board_priority_at_open || 'standard',
        current_stage:      stage,
        cure_period_ends_at: body.cure_period_ends_at || null,
        opened_at:          body.opened_at,
        resolved_at:        body.resolved_at || null,
        resolved_via:       body.resolved_via || null,
        resolved_notes:     body.resolved_notes || null,
        source,
        confidence_weight:  weight,
        quality_status:     body.quality_status || 'verified',
        reviewed_at:        new Date().toISOString(),
        reviewed_by_user_id: body.user_id || null,
        review_notes:       body.notes || 'Manually entered prior violation',
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    res.json({ ok: true, violation: data });
  } catch (err) {
    console.error('[violations.manual]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/extract-doc-references/:community_id/:category_id', async (req, res) => {
  try {
    const result = await _extractDocRefForCategory(req.params.community_id, req.params.category_id);
    return res.json(result);
  } catch (err) {
    console.error('[extract-doc-references.single]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/extract-doc-references/:community_id', express.json(), async (req, res) => {
  try {
    const communityId = req.params.community_id;
    const force = !!(req.body && req.body.force);

    // List active enforcement priorities for this community + their current state
    const { data: prios, error: prioErr } = await supabase
      .from('community_enforcement_priorities')
      .select('category_id, priority_weight, governing_doc_reference, enforcement_categories(label)')
      .eq('community_id', communityId)
      .is('end_date', null);
    if (prioErr) return res.status(500).json({ error: prioErr.message });

    const targets = (prios || []).filter((p) => p.priority_weight !== 'disabled' &&
                                                 (force || !p.governing_doc_reference));
    if (targets.length === 0) {
      return res.json({ processed: 0, skipped: (prios || []).length, message: 'Nothing to extract (all categories have references already, or pass force=true).' });
    }

    const results = [];
    for (const t of targets) {
      const r = await _extractDocRefForCategory(communityId, t.category_id);
      results.push({
        category: t.enforcement_categories && t.enforcement_categories.label,
        category_id: t.category_id,
        ...r,
      });
      // gentle pacing to keep the AI + OpenAI happy
      await new Promise((r) => setTimeout(r, 300));
    }
    const found = results.filter((r) => r.ok && r.found).length;
    const notFound = results.filter((r) => r.ok && !r.found).length;
    const errored = results.filter((r) => !r.ok).length;
    res.json({ processed: results.length, found, not_found: notFound, errored, results });
  } catch (err) {
    console.error('[extract-doc-references.batch]', err);
    res.status(500).json({ error: err.message });
  }
});

// ===========================================================================
// FINE SCHEDULE + FINE ASSESSMENT (Phase 7c)
// ---------------------------------------------------------------------------
// Most TX HOAs have a fine schedule in their CC&Rs but the board has
// historically declined to fine. The schema is built to default-OFF: a
// community must explicitly turn fines_enabled = TRUE (with board minutes
// reference) before auto-fines fire. Per-category overrides let boards
// fine for some things but not others.
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /api/enforcement/fine-schedule/:community_id
//   Returns the resolved per-(category) schedule for the community plus the
//   community-level toggle state. Backs the Fine Schedule UI.
// ---------------------------------------------------------------------------
router.get('/fine-schedule/:community_id', async (req, res) => {
  try {
    const communityId = req.params.community_id;
    const { data: comm } = await supabase
      .from('communities')
      .select('id, name, fines_enabled, fines_enabled_set_by_board_date, fines_enabled_board_minutes_ref, fines_disabled_reason')
      .eq('id', communityId)
      .maybeSingle();
    if (!comm) return res.status(404).json({ error: 'community not found' });

    const { data: resolved, error: rErr } = await supabase
      .from('v_resolved_fine_schedule')
      .select('*')
      .eq('community_id', communityId);
    if (rErr) return res.status(500).json({ error: rErr.message });

    res.json({ community: comm, schedule: resolved || [] });
  } catch (err) {
    console.error('[fine-schedule.get]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/enforcement/fine-schedule/:community_id/community-toggle
//   Body: { fines_enabled, board_minutes_ref?, board_vote_date?, disabled_reason? }
//   Master toggle for the community. Records who/when/why.
// ---------------------------------------------------------------------------
router.patch('/fine-schedule/:community_id/community-toggle', express.json(), async (req, res) => {
  try {
    const communityId = req.params.community_id;
    const body = req.body || {};
    if (typeof body.fines_enabled !== 'boolean') {
      return res.status(400).json({ error: 'fines_enabled (boolean) required' });
    }
    const patch = {
      fines_enabled: body.fines_enabled,
    };
    if (body.fines_enabled) {
      patch.fines_enabled_board_minutes_ref = body.board_minutes_ref || null;
      patch.fines_enabled_set_by_board_date = body.board_vote_date || new Date().toISOString().slice(0, 10);
      patch.fines_disabled_reason = null;
    } else {
      patch.fines_disabled_reason = body.disabled_reason || 'Board has not authorized fine enforcement';
    }
    const { data, error } = await supabase
      .from('communities')
      .update(patch)
      .eq('id', communityId)
      .select('id, fines_enabled, fines_enabled_set_by_board_date, fines_enabled_board_minutes_ref, fines_disabled_reason')
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, community: data });
  } catch (err) {
    console.error('[fine-schedule.community-toggle]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/enforcement/fine-schedule/:community_id/row
//   Body: { category_id?: null|uuid, fines_enabled, first_offense_amount,
//           second_offense_amount, third_offense_amount, recurring_offense_amount,
//           board_minutes_ref?, board_vote_date?, notes? }
//   Upserts a per-(category-or-default) schedule row. Time-bounded: ends the
//   active row (if any) and inserts the new one so history is preserved.
//   category_id = null means this is the COMMUNITY-DEFAULT row.
// ---------------------------------------------------------------------------
router.put('/fine-schedule/:community_id/row', express.json(), async (req, res) => {
  try {
    const communityId = req.params.community_id;
    const body = req.body || {};
    const categoryId = body.category_id || null;
    const today = new Date().toISOString().slice(0, 10);

    // End-date any active row for this (community, category) pair
    let endQ = supabase.from('community_category_fine_schedule')
      .update({ effective_end_date: today, updated_at: new Date().toISOString() })
      .eq('community_id', communityId)
      .is('effective_end_date', null);
    if (categoryId) endQ = endQ.eq('category_id', categoryId);
    else            endQ = endQ.is('category_id', null);
    await endQ;

    // Insert the new active row
    const { data: created, error: cErr } = await supabase
      .from('community_category_fine_schedule')
      .insert({
        community_id: communityId,
        category_id: categoryId,
        fines_enabled: body.fines_enabled !== false,   // default true if the row exists
        first_offense_amount:     body.first_offense_amount   != null ? Number(body.first_offense_amount)   : null,
        second_offense_amount:    body.second_offense_amount  != null ? Number(body.second_offense_amount)  : null,
        third_offense_amount:     body.third_offense_amount   != null ? Number(body.third_offense_amount)   : null,
        recurring_offense_amount: body.recurring_offense_amount != null ? Number(body.recurring_offense_amount) : null,
        set_by_board_vote_date:   body.board_vote_date || null,
        board_meeting_minutes_ref: body.board_minutes_ref || null,
        notes: body.notes || null,
      })
      .select()
      .single();
    if (cErr) return res.status(500).json({ error: cErr.message });
    res.json({ ok: true, schedule_row: created });
  } catch (err) {
    console.error('[fine-schedule.row]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Helper — resolve the fine amount for a (community, category, offense_count)
// triple. Returns { amount, source, community_enabled, category_enabled } so
// the engine and the manual-assess flow can both reason about it.
// ---------------------------------------------------------------------------
async function _resolveFineAmount(communityId, categoryId, offenseCount) {
  const { data: rows } = await supabase
    .from('v_resolved_fine_schedule')
    .select('community_fines_enabled, effective_fines_enabled, first_offense_amount, second_offense_amount, third_offense_amount, recurring_offense_amount, source_row')
    .eq('community_id', communityId)
    .eq('category_id', categoryId);
  if (!rows || rows.length === 0) {
    return { amount: null, source: 'no_schedule', community_enabled: false, category_enabled: false };
  }
  const r = rows[0];
  const amt = (offenseCount <= 1) ? r.first_offense_amount
            : (offenseCount === 2) ? r.second_offense_amount
            : (offenseCount === 3) ? r.third_offense_amount
            : r.recurring_offense_amount;
  return {
    amount: amt,
    source: r.source_row,
    community_enabled: r.community_fines_enabled,
    category_enabled:  r.effective_fines_enabled,
  };
}

// ---------------------------------------------------------------------------
// POST /api/enforcement/violations/:id/assess-fine
//   Body: { amount?, board_resolution_ref?, override_reason?, user_id? }
//   Assesses a fine on a violation. If amount is omitted, looks up the
//   schedule based on the offense count for this (property, category, 12mo).
//   Required if fines are disabled: board_resolution_ref + override_reason
//   (since this is a one-off override of board policy).
//   Side effects:
//     - violation.current_stage = 'fine_assessed'
//     - violation.cure_period_ends_at = NULL (cure window has passed)
//     - fine_posting_queue row created (status='queued')
//     - interactions row created (type='internal_note' for the assessment record)
// ---------------------------------------------------------------------------
router.post('/violations/:id/assess-fine', express.json(), async (req, res) => {
  try {
    const violationId = req.params.id;
    const body = req.body || {};
    const { data: v, error: vErr } = await supabase
      .from('violations')
      .select('id, property_id, community_id, primary_category_id, current_stage, quality_status')
      .eq('id', violationId)
      .maybeSingle();
    if (vErr || !v) return res.status(404).json({ error: 'violation not found' });
    if (v.quality_status === 'superseded') {
      return res.status(400).json({ error: 'violation is superseded; cannot assess fine on corrected record' });
    }
    if (v.current_stage === 'cured' || v.current_stage === 'closed' || v.current_stage === 'voided') {
      return res.status(400).json({ error: `violation is in terminal stage '${v.current_stage}'; cannot fine` });
    }

    // Count prior violations same property + category in last 12mo (this one counts as the current offense)
    const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 12);
    const { data: priors } = await supabase
      .from('violations')
      .select('id, opened_at, current_stage, quality_status, confidence_weight')
      .eq('property_id', v.property_id)
      .eq('primary_category_id', v.primary_category_id)
      .gte('opened_at', cutoff.toISOString())
      .neq('quality_status', 'superseded');
    const offenseCount = (priors || []).filter((p) => p.id !== v.id).length + 1;

    // Resolve amount + permission
    const resolved = await _resolveFineAmount(v.community_id, v.primary_category_id, offenseCount);
    let amount = (typeof body.amount === 'number' && body.amount > 0)
      ? Number(body.amount)
      : resolved.amount;

    const finesAreOff = !resolved.community_enabled || !resolved.category_enabled;
    const overriding = finesAreOff || (typeof body.amount === 'number' && body.amount !== resolved.amount);
    if (overriding) {
      if (!body.board_resolution_ref || !body.override_reason) {
        return res.status(400).json({
          error: 'board_resolution_ref + override_reason required when assessing fine that overrides schedule or with fines disabled',
          schedule_state: resolved,
        });
      }
    }
    if (amount == null || amount <= 0) {
      return res.status(400).json({
        error: 'No fine amount could be resolved (no schedule for this category, and no explicit amount provided).',
        schedule_state: resolved,
        offense_count: offenseCount,
      });
    }

    // Update violation
    await supabase.from('violations').update({
      current_stage: 'fine_assessed',
      current_stage_started_at: new Date().toISOString(),
      cure_period_ends_at: null,
    }).eq('id', violationId);

    // Insert fine queue entry
    const { data: queueEntry, error: qErr } = await supabase
      .from('fine_posting_queue')
      .insert({
        violation_id: violationId,
        property_id: v.property_id,
        community_id: v.community_id,
        amount: amount,
        assessed_by_user_id: body.user_id || null,
        notes: overriding
          ? `Override assessment. Board res: ${body.board_resolution_ref}. Reason: ${body.override_reason}`
          : `Auto-assessed per ${resolved.source} schedule (offense ${offenseCount}).`,
      })
      .select()
      .single();
    if (qErr) return res.status(500).json({ error: 'fine_posting_queue insert failed: ' + qErr.message });

    // Audit interaction (internal note — not customer-facing)
    await supabase.from('interactions').insert({
      community_id: v.community_id,
      property_id: v.property_id,
      violation_id: violationId,
      type: 'internal_note',
      direction: 'internal',
      subject: `Fine assessed: $${amount.toFixed(2)} (offense #${offenseCount})`,
      content: overriding
        ? `Override assessment. Board resolution: ${body.board_resolution_ref}. Reason: ${body.override_reason}. Source: ${resolved.source}.`
        : `Auto-assessed per ${resolved.source} schedule.`,
      sent_at: new Date().toISOString(),
      status: 'sent',
    });

    res.json({
      ok: true,
      violation_id: violationId,
      fine_amount: amount,
      offense_count: offenseCount,
      queue_entry_id: queueEntry.id,
      schedule_state: resolved,
      override: overriding,
    });
  } catch (err) {
    console.error('[violations.assess-fine]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/enforcement/fine-queue?community_id=&status=
//   Lists fines in the posting queue. Default: queued + recently posted.
// ---------------------------------------------------------------------------
router.get('/fine-queue', async (req, res) => {
  try {
    const communityId = req.query.community_id;
    const status = req.query.status || 'queued';
    let q = supabase
      .from('fine_posting_queue')
      .select(`
        id, violation_id, property_id, community_id, amount, status,
        assessed_at, posted_to_vantaca_at, vantaca_charge_ref, notes,
        violations:violation_id ( primary_category_id, current_stage,
          enforcement_categories ( label ) ),
        communities:community_id ( name )
      `)
      .order('assessed_at', { ascending: false })
      .limit(200);
    if (communityId) q = q.eq('community_id', communityId);
    if (status !== 'all') q = q.eq('status', status);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    // Fetch property addresses in one round trip
    const propIds = [...new Set((data || []).map((d) => d.property_id))];
    let propMap = new Map();
    if (propIds.length > 0) {
      const { data: props } = await supabase
        .from('v_current_property_owners')
        .select('property_id, street_address, unit, owner_name, owner_mailing_address')
        .in('property_id', propIds);
      (props || []).forEach((p) => propMap.set(p.property_id, p));
    }
    const enriched = (data || []).map((q) => ({
      ...q,
      property: propMap.get(q.property_id) || null,
      category_label: q.violations && q.violations.enforcement_categories
        && q.violations.enforcement_categories.label,
    }));
    res.json({ queue: enriched });
  } catch (err) {
    console.error('[fine-queue.list]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/enforcement/fine-queue/:id
//   Body: { status, vantaca_charge_ref?, notes? }
//   Mark a queued fine as posted to Vantaca (status='posted') or reversed.
// ---------------------------------------------------------------------------
router.patch('/fine-queue/:id', express.json(), async (req, res) => {
  try {
    const id = req.params.id;
    const body = req.body || {};
    const allowedStatuses = ['queued', 'posted', 'reversed', 'error'];
    if (body.status && !allowedStatuses.includes(body.status)) {
      return res.status(400).json({ error: 'invalid status' });
    }
    const patch = { updated_at: new Date().toISOString() };
    if (body.status) {
      patch.status = body.status;
      if (body.status === 'posted') patch.posted_to_vantaca_at = new Date().toISOString();
    }
    if (body.vantaca_charge_ref !== undefined) patch.vantaca_charge_ref = body.vantaca_charge_ref;
    if (body.notes !== undefined) patch.notes = body.notes;
    if (body.user_id) patch.posted_by_user_id = body.user_id;
    const { data, error } = await supabase
      .from('fine_posting_queue')
      .update(patch)
      .eq('id', id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, queue_entry: data });
  } catch (err) {
    console.error('[fine-queue.patch]', err);
    res.status(500).json({ error: err.message });
  }
});

// ===========================================================================
// BUNDLE 5 — Cure-period expiry processor (closes the lifecycle)
// ---------------------------------------------------------------------------
// When a violation's cure_period_ends_at passes without resolution, this
// processor:
//   - bumps current_stage per the cure-lapse path in decideEscalation()
//     (courtesy_1 → courtesy_2 → certified_209 → fine_assessed or
//      certified_209-with-needs-board-review when fines are paused)
//   - sets new current_stage_started_at + cure_period_ends_at
//   - auto-drafts the new-stage letter (PDF + Drafts queue entry)
//   - for fine_assessed stage, also creates the fine_posting_queue entry
//   - skips disputed / flagged / superseded violations (they need human
//     attention before escalation)
//
// Designed for daily cron execution but also exposed as a manual-trigger
// endpoint with dry_run mode for staff to preview what would happen.
// ===========================================================================

// Helper: returns the list of violations whose cure period has expired
// and which qualify for automatic escalation.
async function _findExpiredViolations(communityId = null, limit = 200) {
  const now = new Date().toISOString();
  let q = supabase
    .from('violations')
    .select('id, property_id, community_id, primary_category_id, current_stage, cure_period_ends_at, opened_at, opened_from_observation_id, board_priority_at_open, quality_status')
    .in('current_stage', ['courtesy_1', 'courtesy_2', 'certified_209'])
    .lt('cure_period_ends_at', now)
    .is('resolved_at', null)
    .in('quality_status', ['verified', 'unreviewed'])  // skip disputed/flagged/superseded
    .order('cure_period_ends_at', { ascending: true })
    .limit(limit);
  if (communityId) q = q.eq('community_id', communityId);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// Helper: compute the new cure date based on stage + decision
function _newCureDate(decision) {
  if (!decision.cure_days || decision.cure_days <= 0) return null;
  return new Date(Date.now() + decision.cure_days * 24 * 60 * 60 * 1000).toISOString();
}

// Helper: regenerate the letter PDF + draft interaction for a violation
// after its stage has been bumped. Reuses the existing generator with the
// updated context. Returns { letter_path, interaction_id } or { error }.
async function _draftLetterForBumpedViolation(violation, decision, communityId) {
  try {
    // Pull the joined data the letter generator needs
    const [pRowRes, catRes, commRes, prioRes, observationRes] = await Promise.all([
      supabase.from('v_current_property_owners')
        .select('street_address, unit, city, state, zip, lot_number, owner_name, owner_mailing_address')
        .eq('property_id', violation.property_id).maybeSingle(),
      supabase.from('enforcement_categories')
        .select('label, description')
        .eq('id', violation.primary_category_id).maybeSingle(),
      supabase.from('communities')
        .select('name, legal_name, letter_sender_name, letter_sender_title, enforcement_authority_citation, letter_fee_courtesy_1_cents, letter_fee_courtesy_2_cents, letter_fee_certified_209_cents, letter_fee_fine_assessed_cents, letter_cure_days_courtesy_1, letter_cure_days_courtesy_2, letter_cure_days_certified_209')
        .eq('id', communityId).maybeSingle(),
      supabase.from('community_enforcement_priorities')
        .select('governing_doc_reference, governing_doc_section_title, governing_doc_quote, governing_doc_page')
        .eq('community_id', communityId)
        .eq('category_id', violation.primary_category_id)
        .is('end_date', null).maybeSingle(),
      violation.opened_from_observation_id
        ? supabase.from('property_observations')
            .select('ai_description, severity, created_at, inspection_photos(captured_at, storage_path)')
            .eq('id', violation.opened_from_observation_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    const pRow = pRowRes.data;
    const catRow = catRes.data;
    const commRow = commRes.data;
    const prioRow = prioRes.data;
    const obsRow = observationRes.data;
    if (!pRow) return { error: 'property not found' };

    // Pull prior violations for the history list on certified
    const yearAgo = new Date(); yearAgo.setMonth(yearAgo.getMonth() - 12);
    const { data: pv } = await supabase
      .from('violations')
      .select('opened_at, current_stage')
      .eq('property_id', violation.property_id)
      .eq('primary_category_id', violation.primary_category_id)
      .neq('id', violation.id)
      .gte('opened_at', yearAgo.toISOString())
      .order('opened_at', { ascending: false })
      .limit(10);

    // Download photo if present
    let photoBuffer = null;
    if (obsRow && obsRow.inspection_photos && obsRow.inspection_photos.storage_path) {
      try {
        const { data: dl } = await supabase.storage.from('documents').download(obsRow.inspection_photos.storage_path);
        if (dl) photoBuffer = Buffer.from(await dl.arrayBuffer());
      } catch (_) {}
    }

    let govDoc = (prioRow && (prioRow.governing_doc_reference || prioRow.governing_doc_section_title || prioRow.governing_doc_quote))
      ? {
          reference:     prioRow.governing_doc_reference,
          section_title: prioRow.governing_doc_section_title,
          quote:         prioRow.governing_doc_quote,
          page:          prioRow.governing_doc_page,
        }
      : null;
    // Auto-lookup the section from the community's CC&Rs when no manual override exists.
    if (!govDoc) {
      try {
        const { lookupGoverningDoc } = require('../lib/enforcement/governing_doc_lookup');
        const auto = await lookupGoverningDoc({
          communityId:         communityId,
          categoryLabel:       catRow && catRow.label,
          categoryDescription: catRow && catRow.description,
          aiDescription:       obsRow && obsRow.ai_description,
        });
        if (auto) {
          govDoc = {
            reference:      auto.reference,
            section_title:  auto.section_title,
            quote:          auto.quote,
            page:           auto.page,
            document_title: auto.document_title,
          };
        }
      } catch (_) {}
    }

    const newCureEnd = _newCureDate(decision);
    const pdfBuffer = await renderViolationLetterPdf({
      violation: {
        id: violation.id,
        current_stage: decision.stage,
        cure_period_ends_at: newCureEnd,
        opened_at: violation.opened_at,
        category_label: catRow && catRow.label,
        category_description: catRow && catRow.description,
        board_priority_at_open: violation.board_priority_at_open,
      },
      property: pRow,
      owner: {
        full_name:       pRow.owner_name,
        mailing_address: pRow.owner_mailing_address,
      },
      community: {
        name:       commRow && commRow.name,
        legal_name: commRow && commRow.legal_name,
        enforcement_authority_citation: commRow && commRow.enforcement_authority_citation,
        letter_fee_courtesy_1_cents:    commRow && commRow.letter_fee_courtesy_1_cents,
        letter_fee_courtesy_2_cents:    commRow && commRow.letter_fee_courtesy_2_cents,
        letter_fee_certified_209_cents: commRow && commRow.letter_fee_certified_209_cents,
        letter_fee_fine_assessed_cents: commRow && commRow.letter_fee_fine_assessed_cents,
        letter_cure_days_courtesy_1:    commRow && commRow.letter_cure_days_courtesy_1,
        letter_cure_days_courtesy_2:    commRow && commRow.letter_cure_days_courtesy_2,
        letter_cure_days_certified_209: commRow && commRow.letter_cure_days_certified_209,
      },
      observation: obsRow ? {
        ai_description: obsRow.ai_description,
        severity: obsRow.severity,
        captured_at: (obsRow.inspection_photos && obsRow.inspection_photos.captured_at) || obsRow.created_at,
      } : null,
      governing_doc: govDoc,
      prior_violations: pv || [],
      photo_buffer: photoBuffer,
      options: {
        sender_name:  (commRow && commRow.letter_sender_name)  || null,
        sender_title: (commRow && commRow.letter_sender_title) || null,
      },
    });

    // Upload PDF
    await _ensureLettersBucket();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const letterPath = `${violation.id}/${decision.stage}-${stamp}.pdf`;
    const { error: upErr } = await supabase.storage.from(LETTERS_BUCKET)
      .upload(letterPath, pdfBuffer, { contentType: 'application/pdf', upsert: false });
    if (upErr && !/already exists|duplicate/i.test(upErr.message)) {
      return { error: 'letter upload failed: ' + upErr.message };
    }

    // Log a DRAFT interaction
    const stageToType = {
      courtesy_1: 'letter_courtesy_1',
      courtesy_2: 'letter_courtesy_2',
      certified_209: 'letter_209',
      fine_assessed: 'letter_209',
    };
    const { data: inter } = await supabase.from('interactions').insert({
      community_id: communityId,
      property_id: violation.property_id,
      violation_id: violation.id,
      observation_id: violation.opened_from_observation_id,
      type: stageToType[decision.stage] || 'ai_draft',
      direction: 'outbound',
      subject: `Violation letter (${decision.stage}) — cure-lapse escalation`,
      content: letterPath,
      delivery_method: (decision.mail_type === 'certified_mail') ? 'certified_mail' : 'first_class_mail',
      status: 'draft',
      ai_drafted: true,
      ai_model: 'cure_lapse_processor',
    }).select('id').single();

    return { letter_path: letterPath, interaction_id: inter && inter.id };
  } catch (e) {
    return { error: e.message };
  }
}

// ---------------------------------------------------------------------------
// GET /api/enforcement/cure-lapse/pending?community_id=&limit=50
// Returns the list of violations eligible for escalation. Used by the UI
// to show "X violations have expired cure periods" indicator.
// ---------------------------------------------------------------------------
router.get('/cure-lapse/pending', async (req, res) => {
  try {
    const communityId = req.query.community_id || null;
    const limit = Math.min(500, Number(req.query.limit) || 100);
    const violations = await _findExpiredViolations(communityId, limit);

    // Enrich with address + days overdue
    const propIds = [...new Set(violations.map((v) => v.property_id))];
    let propMap = new Map();
    if (propIds.length > 0) {
      const { data: props } = await supabase
        .from('v_current_property_owners')
        .select('property_id, street_address, unit, owner_name')
        .in('property_id', propIds);
      (props || []).forEach((p) => propMap.set(p.property_id, p));
    }
    const enriched = violations.map((v) => {
      const days = Math.floor((Date.now() - new Date(v.cure_period_ends_at).getTime()) / (24 * 60 * 60 * 1000));
      return {
        ...v,
        days_overdue: days,
        property: propMap.get(v.property_id) || null,
      };
    });
    res.json({ pending_count: enriched.length, violations: enriched });
  } catch (err) {
    console.error('[cure-lapse.pending]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// processCureLapses — the cure-lapse engine, callable from both the HTTP
// endpoint and the scheduler. Returns a summary object. Throws on hard error.
// ---------------------------------------------------------------------------
async function processCureLapses({ communityId = null, dryRun = false, limit = 100 } = {}) {
  const effLimit = Math.min(200, Number(limit) || 100);
  const violations = await _findExpiredViolations(communityId, effLimit);
  if (violations.length === 0) {
    return { processed: 0, bumped: 0, flagged_board: 0, fines_assessed: 0, errors: [], dry_run: dryRun, message: 'No violations have expired cure periods.' };
  }

  let bumped = 0;
  let flaggedBoard = 0;
  let finesAssessed = 0;
  const results = [];
  const errors = [];

  for (const v of violations) {
    let commFinesEnabled = false;
    let catFinesEnabled = false;
    let fineAmount = null;
    let offenseCount = 1;
    try {
      const { data: comm } = await supabase
        .from('communities').select('fines_enabled').eq('id', v.community_id).maybeSingle();
      commFinesEnabled = comm && comm.fines_enabled;
      const { data: sched } = await supabase
        .from('v_resolved_fine_schedule')
        .select('effective_fines_enabled, first_offense_amount, second_offense_amount, third_offense_amount, recurring_offense_amount')
        .eq('community_id', v.community_id).eq('category_id', v.primary_category_id).maybeSingle();
      if (sched) {
        catFinesEnabled = sched.effective_fines_enabled;
        const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 12);
        const { data: priors } = await supabase
          .from('violations')
          .select('id')
          .eq('property_id', v.property_id)
          .eq('primary_category_id', v.primary_category_id)
          .gte('opened_at', cutoff.toISOString())
          .neq('quality_status', 'superseded')
          .neq('id', v.id);
        offenseCount = (priors || []).length + 1;
        fineAmount = (offenseCount <= 1) ? sched.first_offense_amount
                   : (offenseCount === 2) ? sched.second_offense_amount
                   : (offenseCount === 3) ? sched.third_offense_amount
                   : sched.recurring_offense_amount;
      }
    } catch (_) {}

    const decision = decideEscalation({
      prior_violations: [],
      priority_weight: v.board_priority_at_open || 'standard',
      is_cure_lapse: true,
      current_stage: v.current_stage,
      community_fines_enabled: commFinesEnabled,
      category_fines_enabled: catFinesEnabled,
      fine_amount: typeof fineAmount === 'number' ? fineAmount : null,
    });

    const summary = {
      violation_id: v.id,
      property: v.property_id,
      from_stage: v.current_stage,
      to_stage: decision.stage,
      cure_was_ends_at: v.cure_period_ends_at,
      decision_rationale: decision.rationale,
      needs_board_review: !!decision.needs_board_review,
    };

    if (dryRun) {
      results.push(summary);
      continue;
    }

    if (decision.needs_board_review) {
      await supabase.from('interactions').insert({
        community_id: v.community_id,
        property_id: v.property_id,
        violation_id: v.id,
        type: 'internal_note',
        direction: 'internal',
        subject: `Cure expired — board review needed`,
        content: decision.rationale,
        sent_at: new Date().toISOString(),
        status: 'sent',
      });
      flaggedBoard += 1;
      results.push(summary);
      continue;
    }

    if (!decision.should_open) {
      results.push({ ...summary, skipped: true });
      continue;
    }

    const newCureEnd = _newCureDate(decision);
    const { error: upErr } = await supabase
      .from('violations')
      .update({
        current_stage: decision.stage,
        current_stage_started_at: new Date().toISOString(),
        cure_period_ends_at: newCureEnd,
      })
      .eq('id', v.id);
    if (upErr) {
      errors.push({ violation_id: v.id, error: 'stage bump failed: ' + upErr.message });
      continue;
    }

    if (decision.stage === 'fine_assessed' && fineAmount) {
      await supabase.from('fine_posting_queue').insert({
        violation_id: v.id,
        property_id: v.property_id,
        community_id: v.community_id,
        amount: fineAmount,
        notes: `Auto-assessed via cure-lapse processor (offense ${offenseCount}).`,
      });
      finesAssessed += 1;
    } else {
      bumped += 1;
    }

    const letterResult = await _draftLetterForBumpedViolation(v, decision, v.community_id);
    if (letterResult.error) {
      errors.push({ violation_id: v.id, error: 'letter draft failed: ' + letterResult.error });
    }
    results.push({ ...summary, letter_drafted: !letterResult.error, new_cure_ends_at: newCureEnd });
  }

  return {
    processed: results.length,
    bumped,
    flagged_board: flaggedBoard,
    fines_assessed: finesAssessed,
    errors,
    dry_run: dryRun,
    results: dryRun ? results : results.slice(0, 20),
  };
}

// POST /api/enforcement/cure-lapse/process
// Body: { community_id?, dry_run?, limit? }
router.post('/cure-lapse/process', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const result = await processCureLapses({
      communityId: body.community_id || null,
      dryRun: !!body.dry_run,
      limit: Number(body.limit) || 100,
    });
    res.json(result);
  } catch (err) {
    console.error('[cure-lapse.process]', err);
    res.status(500).json({ error: err.message });
  }
});

// ===========================================================================
// BUNDLE 4 — Vantaca historical violation import
// ---------------------------------------------------------------------------
// POST /api/enforcement/vantaca-violations/preview
//   multipart: file=<csv|xlsx>, community_id=<uuid>
//   Parses + resolves property + category for each row WITHOUT writing.
//   Returns diff: { resolved, unresolved_property, unresolved_category,
//                   category_label_mapping (slug → label), sample_rows }
//
// POST /api/enforcement/vantaca-violations/apply
//   JSON body: { community_id, rows: [...] }
//   Imports the resolved rows as violations with source='vantaca_import',
//   confidence_weight=0.5, quality_status='unreviewed'. Cured rows get
//   resolved_at + resolved_via set. Skips rows already imported (dedup on
//   (property_id, primary_category_id, opened_at)).
// ===========================================================================
router.post('/vantaca-violations/preview', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file required' });
    const communityId = req.body.community_id;
    if (!communityId) return res.status(400).json({ error: 'community_id required' });
    const { rows, mapping, headers, errors } = parseVantacaViolations(req.file.buffer, req.file.originalname);
    if ((!rows || rows.length === 0) && errors && errors.length > 0) {
      return res.status(400).json({ error: errors.join(' '), headers, mapping });
    }

    // Fetch properties + categories for this community to resolve refs
    const { data: props } = await supabase
      .from('properties')
      .select('id, street_address, unit, vantaca_account_id')
      .eq('community_id', communityId);
    const byAcct = new Map();
    const byStreet = new Map();
    (props || []).forEach((p) => {
      if (p.vantaca_account_id) byAcct.set(String(p.vantaca_account_id), p);
      if (p.street_address) byStreet.set(p.street_address.toLowerCase().trim(), p);
    });

    const { data: cats } = await supabase
      .from('enforcement_categories')
      .select('id, slug, label');
    // Build flexible category matcher
    const catBySlug = new Map();
    const catByLabel = new Map();
    (cats || []).forEach((c) => {
      catBySlug.set(c.slug.toLowerCase(), c);
      catByLabel.set(c.label.toLowerCase(), c);
    });
    const resolveCategory = (rawLabel) => {
      if (!rawLabel) return null;
      const s = String(rawLabel).toLowerCase().trim();
      // 1. Exact label
      if (catByLabel.has(s)) return catByLabel.get(s);
      // 2. Substring match (label contains s OR s contains label)
      for (const [label, c] of catByLabel) {
        if (label.includes(s) || s.includes(label)) return c;
      }
      // 3. Slug substring match
      for (const [slug, c] of catBySlug) {
        if (slug.replace(/_/g, ' ').includes(s) || s.includes(slug.replace(/_/g, ' '))) return c;
      }
      return null;
    };

    // Check for existing violations (dedup at apply time)
    const { data: existingV } = await supabase
      .from('violations')
      .select('property_id, primary_category_id, opened_at')
      .eq('community_id', communityId)
      .eq('source', 'vantaca_import');
    const existingKeys = new Set((existingV || []).map((v) =>
      `${v.property_id}::${v.primary_category_id}::${(v.opened_at || '').slice(0, 10)}`
    ));

    const resolved = [];
    const unresolved_property = [];
    const unresolved_category = [];
    const duplicates = [];

    for (const row of rows) {
      let prop = null;
      if (row.vantaca_account_id) prop = byAcct.get(String(row.vantaca_account_id));
      if (!prop && row.street_address) prop = byStreet.get(row.street_address.toLowerCase().trim());
      if (!prop) { unresolved_property.push(row); continue; }
      const cat = resolveCategory(row.category_label);
      if (!cat) { unresolved_category.push({ ...row, property_id: prop.id }); continue; }
      const dedupKey = `${prop.id}::${cat.id}::${row.opened_at}`;
      if (existingKeys.has(dedupKey)) { duplicates.push({ ...row, property_id: prop.id, category_id: cat.id }); continue; }
      resolved.push({
        ...row,
        property_id: prop.id,
        property_street: prop.street_address,
        category_id: cat.id,
        category_resolved_label: cat.label,
      });
    }

    res.json({
      total_rows: rows.length,
      mapping,
      headers,
      sample_rows: rows.slice(0, 5),
      resolved_count: resolved.length,
      unresolved_property_count: unresolved_property.length,
      unresolved_category_count: unresolved_category.length,
      duplicate_count: duplicates.length,
      resolved,
      unresolved_property: unresolved_property.slice(0, 50),  // cap for response size
      unresolved_category: unresolved_category.slice(0, 50),
      duplicates: duplicates.slice(0, 20),
    });
  } catch (err) {
    console.error('[vantaca-violations.preview]', err);
    res.status(500).json({ error: err.message });
  }
});

// ===========================================================================
// POST /api/enforcement/violations/:violationId/letters
// ---------------------------------------------------------------------------
// Attach a letter PDF to a violation. Files the PDF to Supabase storage,
// creates a library_documents row (category='violation_letter') scoped to
// the property, and creates a violation_letters junction row that links
// violation → library_document → stage.
//
// Used by:
//   - The Vantaca historical import workflow (per-row PDF attach during
//     preview, source='vantaca_import')
//   - The trustEd letter pipeline going forward (after a courtesy/§209/fine
//     letter is generated, source='trusted')
//   - Manual entry by staff (typing a record post-hoc, source='manual_entry')
//
// Body (multipart):
//   pdf            — the letter file (PDF, up to 25MB)
//   stage_at_send  — courtesy_1 | courtesy_2 | certified_209 | fine_assessed |
//                    hearing_notice | legal_referral | lien_filed | other
//   sent_at        — YYYY-MM-DD
//   sent_via       — vantaca | trusted | manual | other (default: 'trusted')
//   source         — vantaca_import | trusted | manual_entry (default: 'trusted')
//   delivery_method?       — mail | certified_mail | email | hand_delivery | postcard
//   tracking_number?
//   notes?
// ===========================================================================
router.post('/violations/:violationId/letters', upload.single('pdf'), async (req, res) => {
  try {
    const violationId = req.params.violationId;
    if (!violationId) return res.status(400).json({ error: 'violation_id required' });

    const body = req.body || {};
    if (!body.stage_at_send) return res.status(400).json({ error: 'stage_at_send required' });
    if (!body.sent_at || !/^\d{4}-\d{2}-\d{2}$/.test(body.sent_at)) {
      return res.status(400).json({ error: 'sent_at required (YYYY-MM-DD)' });
    }

    // Pull the violation to get property_id + community_id (don't trust client)
    const { data: violation, error: vErr } = await supabase
      .from('violations')
      .select('id, property_id, community_id, primary_category_id')
      .eq('id', violationId)
      .maybeSingle();
    if (vErr) throw vErr;
    if (!violation) return res.status(404).json({ error: 'violation_not_found' });

    let libraryDocumentId = null;
    let storagePath = null;

    if (req.file) {
      // Lazy bucket creation
      try { await _ensureLettersBucket(); } catch (_) {}
      const crypto = require('crypto');
      const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex').slice(0, 16);
      const safeName = (req.file.originalname || `letter-${body.stage_at_send}.pdf`).replace(/[^a-zA-Z0-9._\-]/g, '_');
      storagePath = `${LETTERS_BUCKET}/${violation.community_id}/${violation.property_id}/${hash}-${safeName}`;

      const { error: upErr } = await supabase.storage
        .from(LETTERS_BUCKET)
        .upload(storagePath, req.file.buffer, { contentType: 'application/pdf', upsert: true });
      if (upErr && upErr.message && !upErr.message.includes('already exists')) {
        console.warn('[violation_letters] storage upload warn:', upErr.message);
      }

      // Create library_documents row (the homeowner-folder canonical record)
      const { data: libDoc, error: ldErr } = await supabase
        .from('library_documents')
        .insert({
          management_company_id: BEDROCK_MGMT_CO_ID,
          community_id: violation.community_id,
          property_id: violation.property_id,
          category: 'violation_letter',
          title: `Violation letter — ${body.stage_at_send} (${body.sent_at})`,
          file_path: storagePath,
          file_size_bytes: req.file.size || null,
          metadata: {
            violation_id: violationId,
            stage_at_send: body.stage_at_send,
            sent_at: body.sent_at,
            sent_via: body.sent_via || 'trusted',
            source: body.source || 'trusted',
          },
        })
        .select('id')
        .single();
      if (ldErr) {
        console.warn('[violation_letters] library_documents insert failed:', ldErr.message);
      } else {
        libraryDocumentId = libDoc.id;
      }
    }

    // Create violation_letters row regardless of whether PDF was supplied —
    // some letters are recorded after the fact without an artifact (e.g.,
    // operator knows Vantaca sent something on a date but the PDF is lost).
    const { data: vlRow, error: vlErr } = await supabase
      .from('violation_letters')
      .insert({
        violation_id: violationId,
        library_document_id: libraryDocumentId,
        stage_at_send: body.stage_at_send,
        sent_at: body.sent_at,
        sent_via: body.sent_via || 'trusted',
        delivery_method: body.delivery_method || null,
        tracking_number: body.tracking_number || null,
        notes: body.notes || null,
        source: body.source || 'trusted',
      })
      .select()
      .single();
    if (vlErr) throw vlErr;

    res.json({
      ok: true,
      violation_letter: vlRow,
      library_document_id: libraryDocumentId,
      storage_path: storagePath,
    });
  } catch (err) {
    console.error('[violations/letters POST] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===========================================================================
// GET /api/enforcement/violations/:violationId/letters
// ---------------------------------------------------------------------------
// Returns the chronological letter history for a violation, with signed
// download URLs for the PDFs (15-minute expiry). Powers the side-panel
// letter timeline + "next stage" continuation logic.
// ===========================================================================
router.get('/violations/:violationId/letters', async (req, res) => {
  try {
    const violationId = req.params.violationId;
    const { data, error } = await supabase
      .from('violation_letters')
      .select('id, library_document_id, stage_at_send, sent_at, sent_via, delivery_method, tracking_number, notes, source, created_at')
      .eq('violation_id', violationId)
      .order('sent_at', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) throw error;

    const rows = data || [];
    // Hydrate signed URLs for the PDFs
    for (const r of rows) {
      if (r.library_document_id) {
        try {
          const { data: doc } = await supabase
            .from('library_documents')
            .select('file_path, title')
            .eq('id', r.library_document_id)
            .maybeSingle();
          if (doc && doc.file_path) {
            // Bucket is encoded in the file_path prefix; strip it for the signed URL call
            const parts = doc.file_path.split('/');
            const bucket = parts[0];
            const pathInBucket = parts.slice(1).join('/');
            const { data: signed } = await supabase.storage
              .from(bucket)
              .createSignedUrl(pathInBucket, 60 * 15);
            r.pdf_url = signed && signed.signedUrl ? signed.signedUrl : null;
            r.pdf_title = doc.title || null;
          }
        } catch (e) {
          console.warn('[violations/letters signed-url]', e.message);
        }
      }
    }

    res.json({ letters: rows });
  } catch (err) {
    console.error('[violations/letters GET] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===========================================================================
// POST /api/enforcement/violations/:violationId/advance-stage
// ---------------------------------------------------------------------------
// One-click stage advance for the continuation workflow. When an operator
// confirms during inspection that a Vantaca-imported (or any) open
// violation is still uncured, this advances current_stage to the next
// conventional stage and (optionally) attaches a follow-up letter PDF.
//
// Body (JSON or multipart):
//   override_stage?   — operator override (default: use the conventional
//                       next stage from v_violation_latest_letter)
//   note?             — context for the advance ("trash bins still out
//                       after inspection 2026-05-28")
//   record_letter?    — if true (multipart only), also creates a
//                       violation_letters row for the new stage with the
//                       attached PDF (uses the /letters endpoint logic)
// ===========================================================================
router.post('/violations/:violationId/advance-stage', upload.single('pdf'), async (req, res) => {
  try {
    const violationId = req.params.violationId;
    if (!violationId) return res.status(400).json({ error: 'violation_id required' });

    const { data: violation, error: vErr } = await supabase
      .from('violations')
      .select('id, property_id, community_id, primary_category_id, current_stage, opened_at')
      .eq('id', violationId)
      .maybeSingle();
    if (vErr) throw vErr;
    if (!violation) return res.status(404).json({ error: 'violation_not_found' });
    if (['cured', 'closed', 'voided'].includes(violation.current_stage)) {
      return res.status(409).json({ error: `violation is already ${violation.current_stage}; cannot advance` });
    }

    // Determine the next stage. Operator override wins; otherwise use the
    // conventional progression based on current_stage (NOT based on the
    // latest letter, because we want to allow advancing even when no letter
    // was previously recorded — common during Vantaca transition).
    const conventionalNext = {
      'courtesy_1':    'courtesy_2',
      'courtesy_2':    'certified_209',
      'certified_209': 'fine_assessed',
      'fine_assessed': 'hearing_notice',
      'hearing_notice': 'legal_referral',
      'legal_referral': 'lien_filed',
    };
    const nextStage = (req.body && req.body.override_stage)
      || conventionalNext[violation.current_stage]
      || 'other';
    const note = (req.body && req.body.note) || null;

    // Update the violation row
    const { error: upErr } = await supabase
      .from('violations')
      .update({
        current_stage: nextStage,
        current_stage_started_at: new Date().toISOString(),
        last_action_at: new Date().toISOString(),
        notes: note ? `${note}\n---\n(previous notes preserved on history table)` : undefined,
      })
      .eq('id', violationId);
    if (upErr) throw upErr;

    // Optionally record the new letter at the same time
    let letterResult = null;
    if (req.file && req.body && (req.body.record_letter === 'true' || req.body.record_letter === true)) {
      try { await _ensureLettersBucket(); } catch (_) {}
      const crypto = require('crypto');
      const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex').slice(0, 16);
      const safeName = (req.file.originalname || `letter-${nextStage}.pdf`).replace(/[^a-zA-Z0-9._\-]/g, '_');
      const storagePath = `${LETTERS_BUCKET}/${violation.community_id}/${violation.property_id}/${hash}-${safeName}`;
      await supabase.storage.from(LETTERS_BUCKET).upload(storagePath, req.file.buffer, { contentType: 'application/pdf', upsert: true });
      const { data: libDoc } = await supabase
        .from('library_documents')
        .insert({
          management_company_id: BEDROCK_MGMT_CO_ID,
          community_id: violation.community_id,
          property_id: violation.property_id,
          category: 'violation_letter',
          title: `Violation letter — ${nextStage} (${new Date().toISOString().slice(0, 10)})`,
          file_path: storagePath,
          metadata: { violation_id: violationId, stage_at_send: nextStage, source: 'trusted' },
        })
        .select('id')
        .single();
      const { data: vl } = await supabase
        .from('violation_letters')
        .insert({
          violation_id: violationId,
          library_document_id: libDoc ? libDoc.id : null,
          stage_at_send: nextStage,
          sent_at: new Date().toISOString().slice(0, 10),
          sent_via: 'trusted',
          source: 'trusted',
          notes: note,
        })
        .select()
        .single();
      letterResult = { library_document_id: libDoc?.id, violation_letter: vl };
    }

    res.json({
      ok: true,
      previous_stage: violation.current_stage,
      new_stage: nextStage,
      letter_recorded: !!letterResult,
      letter: letterResult,
    });
  } catch (err) {
    console.error('[violations/advance-stage] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===========================================================================
// GET /api/enforcement/property/:propertyId/violation-summary
// ---------------------------------------------------------------------------
// Returns all violations + their letter history for a property. Powers the
// Community Map side panel violation section and the inspection continuation
// flow. Includes the suggested-next-stage hint for each open violation.
// ===========================================================================
router.get('/property/:propertyId/violation-summary', async (req, res) => {
  try {
    const propertyId = req.params.propertyId;
    const { data: violations, error } = await supabase
      .from('violations')
      .select(`
        id, property_id, community_id, primary_category_id,
        current_stage, current_stage_started_at,
        opened_at, last_action_at, resolved_at, resolved_via,
        source, confidence_weight, summary
      `)
      .eq('property_id', propertyId)
      .order('opened_at', { ascending: false })
      .limit(100);
    if (error) throw error;

    // Resolve category labels in one round trip
    const catIds = Array.from(new Set((violations || []).map((v) => v.primary_category_id).filter(Boolean)));
    let catLabels = new Map();
    if (catIds.length > 0) {
      const { data: cats } = await supabase
        .from('enforcement_categories')
        .select('id, label')
        .in('id', catIds);
      catLabels = new Map((cats || []).map((c) => [c.id, c.label]));
    }

    // Pull letters for these violations
    const violationIds = (violations || []).map((v) => v.id);
    let lettersByViolation = new Map();
    if (violationIds.length > 0) {
      const { data: letters } = await supabase
        .from('violation_letters')
        .select('id, violation_id, library_document_id, stage_at_send, sent_at, sent_via, source')
        .in('violation_id', violationIds)
        .order('sent_at', { ascending: false });
      for (const l of (letters || [])) {
        if (!lettersByViolation.has(l.violation_id)) lettersByViolation.set(l.violation_id, []);
        lettersByViolation.get(l.violation_id).push(l);
      }
    }

    const conventionalNext = {
      'courtesy_1':    'courtesy_2',
      'courtesy_2':    'certified_209',
      'certified_209': 'fine_assessed',
      'fine_assessed': 'hearing_notice',
      'hearing_notice': 'legal_referral',
      'legal_referral': 'lien_filed',
    };

    const result = (violations || []).map((v) => {
      const letters = lettersByViolation.get(v.id) || [];
      const isOpen = !['cured', 'closed', 'voided'].includes(v.current_stage);
      return {
        ...v,
        category_label: catLabels.get(v.primary_category_id) || null,
        is_open: isOpen,
        letter_count: letters.length,
        letters,
        suggested_next_stage: isOpen ? conventionalNext[v.current_stage] || 'other' : null,
      };
    });

    res.json({
      property_id: propertyId,
      total_violations: result.length,
      open_count: result.filter((v) => v.is_open).length,
      violations: result,
    });
  } catch (err) {
    console.error('[violation-summary] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===========================================================================
// POST /api/enforcement/violations/bulk-attach-letters
// ---------------------------------------------------------------------------
// Multi-file PDF upload for back-filling Vantaca letters at scale. Operator
// picks all PDFs in one OS file-picker selection (multi-select supported in
// every modern browser); the system tries to auto-match each filename to a
// property + violation, files matched PDFs, reports unmatched ones for
// manual cleanup via the per-violation "+ Attach letter" path.
//
// Filename matching heuristics (tried in order):
//   1. Vantaca account ID embedded in filename → properties.vantaca_account_id
//   2. Lot number embedded in filename → properties.lot_number
//   3. Street-number prefix (e.g., "15711_..." or "15711 Crooked Arrow...") →
//      properties.street_address starts with that number
//
// Once matched to a property, pick the most-recent open violation (or the
// most recent regardless if none open). Operator can specify a target stage
// via form field `default_stage` (default: courtesy_1, which is the most
// common back-fill case). sent_at defaults to today unless the filename
// has a YYYY-MM-DD or MM-DD-YYYY date that we can parse.
//
// Body (multipart):
//   pdfs (multiple files, up to 50 per request, 25MB each)
//   community_id (required) — scopes the property lookup
//   default_stage? (default 'courtesy_1')
//   default_sent_via? (default 'vantaca')
//   default_source? (default 'vantaca_import')
//
// Returns:
//   {
//     processed: N,
//     matched: [{filename, property_id, violation_id, library_document_id, stage_at_send, sent_at}],
//     unmatched: [{filename, reason}],
//     errors: [{filename, error}]
//   }
// ===========================================================================
router.post('/violations/bulk-attach-letters', upload.array('pdfs', 50), async (req, res) => {
  try {
    const communityId = req.body && req.body.community_id;
    if (!communityId) return res.status(400).json({ error: 'community_id required' });
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No PDFs uploaded' });

    const defaultStage = (req.body.default_stage || 'courtesy_1');
    const defaultSentVia = (req.body.default_sent_via || 'vantaca');
    const defaultSource = (req.body.default_source || 'vantaca_import');

    // Pull properties + violations for this community in one shot so we can
    // match in JS without N+1 queries.
    const { data: properties, error: pErr } = await supabase
      .from('properties')
      .select('id, street_address, lot_number, vantaca_account_id')
      .eq('community_id', communityId)
      .limit(5000);
    if (pErr) throw pErr;

    const { data: violations, error: vErr } = await supabase
      .from('violations')
      .select('id, property_id, current_stage, opened_at, source')
      .eq('community_id', communityId)
      .order('opened_at', { ascending: false })
      .limit(10000);
    if (vErr) throw vErr;

    // Build lookup tables
    const propByVantacaId = new Map();
    const propByLot = new Map();
    const propByStreetNumStart = new Map(); // first numeric token → array of properties
    for (const p of properties) {
      if (p.vantaca_account_id) propByVantacaId.set(String(p.vantaca_account_id), p);
      if (p.lot_number) propByLot.set(String(p.lot_number).toLowerCase(), p);
      const m = (p.street_address || '').match(/^\s*(\d+)/);
      if (m) {
        if (!propByStreetNumStart.has(m[1])) propByStreetNumStart.set(m[1], []);
        propByStreetNumStart.get(m[1]).push(p);
      }
    }

    // For each property, the most recent violation (preference: most recent
    // OPEN, fallback: most recent regardless). Used as the auto-target for
    // letter attachment.
    const violationsByProperty = new Map();
    for (const v of violations) {
      if (!violationsByProperty.has(v.property_id)) violationsByProperty.set(v.property_id, []);
      violationsByProperty.get(v.property_id).push(v);
    }
    function pickTargetViolation(propertyId) {
      const list = violationsByProperty.get(propertyId) || [];
      if (list.length === 0) return null;
      const open = list.find((v) => !['cured', 'closed', 'voided'].includes(v.current_stage));
      return open || list[0];
    }

    // Date parser — look for YYYY-MM-DD, YYYY_MM_DD, or MM-DD-YYYY in filename
    function parseDateFromFilename(filename) {
      const m1 = filename.match(/(\d{4})[-_](\d{2})[-_](\d{2})/);
      if (m1) return `${m1[1]}-${m1[2]}-${m1[3]}`;
      const m2 = filename.match(/(\d{2})[-_](\d{2})[-_](\d{4})/);
      if (m2) return `${m2[3]}-${m2[1]}-${m2[2]}`;
      return null;
    }

    function matchProperty(filename) {
      const base = filename.replace(/\.[a-z]+$/i, '');
      const lower = base.toLowerCase();

      // 1. Vantaca account ID — look for sequences of digits/letters typical
      //    of Vantaca account formats. We try every plausible token.
      const tokens = base.split(/[\s_\-\.]+/).filter(Boolean);
      for (const t of tokens) {
        if (propByVantacaId.has(t)) {
          return { property: propByVantacaId.get(t), via: 'vantaca_account_id', token: t };
        }
      }
      // 2. Lot number
      for (const t of tokens) {
        const lk = t.toLowerCase();
        if (propByLot.has(lk)) {
          return { property: propByLot.get(lk), via: 'lot_number', token: t };
        }
      }
      // 3. Street-number prefix — first numeric token in the filename
      //    matched against properties whose street_address starts with that
      //    number. Disambiguate by street-name substring if multiple match.
      const numToken = tokens.find((t) => /^\d{3,6}$/.test(t));
      if (numToken && propByStreetNumStart.has(numToken)) {
        const candidates = propByStreetNumStart.get(numToken);
        if (candidates.length === 1) {
          return { property: candidates[0], via: 'street_num', token: numToken };
        }
        // Multiple — try to match by street-name substring in filename
        const lowerRest = lower.replace(numToken, '');
        for (const cand of candidates) {
          const streetWords = (cand.street_address || '').toLowerCase().split(/\s+/).filter((w) => w.length > 3);
          if (streetWords.some((w) => lowerRest.includes(w))) {
            return { property: cand, via: 'street_num+name', token: numToken };
          }
        }
        // Still ambiguous — return null to surface for operator
        return { ambiguous: true, candidates, via: 'street_num_ambiguous', token: numToken };
      }
      return null;
    }

    // Lazy bucket creation
    try { await _ensureLettersBucket(); } catch (_) {}
    const crypto = require('crypto');

    const matched = [];
    const unmatched = [];
    const errors = [];

    for (const file of req.files) {
      try {
        const fname = file.originalname || 'letter.pdf';
        const m = matchProperty(fname);
        if (!m || m.ambiguous) {
          unmatched.push({
            filename: fname,
            reason: m && m.ambiguous
              ? `ambiguous: street# ${m.token} matched ${m.candidates.length} properties`
              : 'no property match in filename',
          });
          continue;
        }
        const targetViolation = pickTargetViolation(m.property.id);
        if (!targetViolation) {
          unmatched.push({
            filename: fname,
            reason: `property matched (${m.property.street_address}) but no violations exist for it yet — import the CSV first`,
          });
          continue;
        }

        const sentAt = parseDateFromFilename(fname) || new Date().toISOString().slice(0, 10);

        // File to storage
        const hash = crypto.createHash('sha256').update(file.buffer).digest('hex').slice(0, 16);
        const safeName = fname.replace(/[^a-zA-Z0-9._\-]/g, '_');
        const storagePath = `${LETTERS_BUCKET}/${communityId}/${m.property.id}/${hash}-${safeName}`;
        const { error: upErr } = await supabase.storage
          .from(LETTERS_BUCKET)
          .upload(storagePath, file.buffer, { contentType: 'application/pdf', upsert: true });
        if (upErr && !String(upErr.message || '').includes('already exists')) {
          console.warn('[bulk-attach] storage warn for', fname, ':', upErr.message);
        }

        // library_documents row
        const { data: libDoc, error: ldErr } = await supabase
          .from('library_documents')
          .insert({
            management_company_id: BEDROCK_MGMT_CO_ID,
            community_id: communityId,
            property_id: m.property.id,
            category: 'violation_letter',
            title: `Violation letter — ${defaultStage} (${sentAt}) — ${fname}`,
            file_path: storagePath,
            file_size_bytes: file.size || null,
            metadata: {
              violation_id: targetViolation.id,
              stage_at_send: defaultStage,
              sent_at: sentAt,
              sent_via: defaultSentVia,
              source: defaultSource,
              matched_via: m.via,
              original_filename: fname,
            },
          })
          .select('id')
          .single();
        if (ldErr) {
          errors.push({ filename: fname, error: `library_documents: ${ldErr.message}` });
          continue;
        }

        // violation_letters row
        const { error: vlErr } = await supabase
          .from('violation_letters')
          .insert({
            violation_id: targetViolation.id,
            library_document_id: libDoc.id,
            stage_at_send: defaultStage,
            sent_at: sentAt,
            sent_via: defaultSentVia,
            source: defaultSource,
            notes: `Bulk-imported from ${fname}; matched_via=${m.via}`,
          });
        if (vlErr) {
          errors.push({ filename: fname, error: `violation_letters: ${vlErr.message}` });
          continue;
        }

        matched.push({
          filename: fname,
          property_id: m.property.id,
          property_address: m.property.street_address,
          violation_id: targetViolation.id,
          violation_current_stage: targetViolation.current_stage,
          library_document_id: libDoc.id,
          stage_at_send: defaultStage,
          sent_at: sentAt,
          matched_via: m.via,
        });
      } catch (e) {
        errors.push({ filename: file.originalname, error: e.message });
      }
    }

    res.json({
      processed: req.files.length,
      matched_count: matched.length,
      unmatched_count: unmatched.length,
      error_count: errors.length,
      matched,
      unmatched,
      errors,
    });
  } catch (err) {
    console.error('[bulk-attach-letters] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===========================================================================
// END violation-letters endpoints
// ===========================================================================

router.post('/vantaca-violations/apply', express.json({ limit: '20mb' }), async (req, res) => {
  try {
    const body = req.body || {};
    const communityId = body.community_id;
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!communityId) return res.status(400).json({ error: 'community_id required' });
    if (rows.length === 0) return res.json({ inserted: 0, skipped: 0 });

    let inserted = 0;
    let skipped = 0;
    const errors = [];

    for (const r of rows) {
      if (!r.property_id || !r.category_id || !r.opened_at) { skipped += 1; continue; }
      const insertRow = {
        property_id: r.property_id,
        community_id: communityId,
        primary_category_id: r.category_id,
        board_priority_at_open: 'standard',
        current_stage: r.stage || 'courtesy_1',
        current_stage_started_at: r.opened_at,
        opened_at: r.opened_at,
        resolved_at: r.resolved_at || null,
        resolved_via: r.resolved_via || (r.resolved_at ? 'cured' : null),
        resolved_notes: r.notes || null,
        source: 'vantaca_import',
        confidence_weight: 0.5,         // half-weight until reviewed
        quality_status: 'unreviewed',
        review_notes: 'Imported from Vantaca violations export. Needs verification.',
      };
      const { error } = await supabase.from('violations').insert(insertRow);
      if (error) {
        errors.push({ row: r._source_row, error: error.message });
      } else {
        inserted += 1;
      }
    }

    res.json({ inserted, skipped, errors });
  } catch (err) {
    console.error('[vantaca-violations.apply]', err);
    res.status(500).json({ error: err.message });
  }
});

// ===========================================================================
// POSTCARD REMINDER PROCESSOR
// ---------------------------------------------------------------------------
// Daily sweep: finds courtesy_1 violations where the mailing happened N days
// ago (default 7, per-community setting on communities.postcard_reminder_days),
// the cure window is still open, and no postcard reminder has been drafted
// for this violation yet. Generates a postcard PDF + drops a draft interaction
// into the Mail Queue. Operator prints the postcard batch on the same Mail
// Queue tab.
// ===========================================================================

async function processPostcardReminders({ communityId = null, dryRun = false, limit = 100 } = {}) {
  const effLimit = Math.min(200, Number(limit) || 100);
  const now = new Date();

  // Pull communities that have postcard reminders enabled + their N-day setting
  let cq = supabase
    .from('communities')
    .select('id, name, legal_name, postcard_reminder_enabled, postcard_reminder_days, logo_storage_path');
  if (communityId) cq = cq.eq('id', communityId);
  const { data: communities, error: cErr } = await cq;
  if (cErr) throw cErr;
  const enabledCommunities = (communities || []).filter((c) => c.postcard_reminder_enabled !== false);
  if (enabledCommunities.length === 0) {
    return { eligible: 0, drafted: 0, skipped: 0, errors: [], dry_run: dryRun };
  }
  const communityById = new Map(enabledCommunities.map((c) => [c.id, c]));

  // Open courtesy_1 violations in those communities with cure still ahead
  const { data: vios, error: vErr } = await supabase
    .from('violations')
    .select('id, community_id, property_id, opened_at, cure_period_ends_at, primary_category_id, quality_status')
    .in('community_id', enabledCommunities.map((c) => c.id))
    .eq('current_stage', 'courtesy_1')
    .gte('cure_period_ends_at', now.toISOString())
    .in('quality_status', ['verified', 'unreviewed'])
    .order('opened_at', { ascending: true })
    .limit(effLimit);
  if (vErr) throw vErr;
  if (!vios || vios.length === 0) {
    return { eligible: 0, drafted: 0, skipped: 0, errors: [], dry_run: dryRun };
  }

  let drafted = 0;
  let skipped = 0;
  const errors = [];

  // Logo buffer cache per community for the batch
  const logoCache = new Map();
  async function getLogo(comm) {
    if (!comm || !comm.logo_storage_path) return null;
    if (logoCache.has(comm.id)) return logoCache.get(comm.id);
    try {
      const { data: blob } = await supabase.storage.from('documents').download(comm.logo_storage_path);
      const buf = blob ? Buffer.from(await blob.arrayBuffer()) : null;
      logoCache.set(comm.id, buf);
      return buf;
    } catch (_) { logoCache.set(comm.id, null); return null; }
  }

  for (const v of vios) {
    const community = communityById.get(v.community_id);
    if (!community) { skipped++; continue; }

    // Eligibility window: original courtesy_1 mailed N days ago
    const daysWindow = Number(community.postcard_reminder_days || 7);

    // Find the Courtesy 1 interaction for this violation (so we know when it
    // was actually mailed — postmark_date is the legal anchor, falling back
    // to sent_at if postmark wasn't stamped).
    const { data: c1Inter } = await supabase
      .from('interactions')
      .select('id, sent_at, postmark_date')
      .eq('violation_id', v.id)
      .eq('type', 'letter_courtesy_1')
      .in('status', ['sent', 'approved'])
      .order('sent_at', { ascending: false })
      .limit(1).maybeSingle();
    if (!c1Inter) { skipped++; continue; }
    const c1MailedAt = c1Inter.postmark_date ? new Date(c1Inter.postmark_date + 'T12:00:00Z') : new Date(c1Inter.sent_at);
    const daysSince = Math.floor((now.getTime() - c1MailedAt.getTime()) / (24 * 60 * 60 * 1000));
    if (daysSince < daysWindow) { skipped++; continue; }

    // Already drafted/sent a postcard for this violation?
    const { data: existingPc } = await supabase
      .from('interactions')
      .select('id')
      .eq('violation_id', v.id)
      .eq('type', 'letter_postcard_reminder')
      .maybeSingle();
    if (existingPc) { skipped++; continue; }

    if (dryRun) { drafted++; continue; }

    try {
      // Resolve property + owner
      const { data: pRow } = await supabase
        .from('v_current_property_owners')
        .select('property_id, street_address, unit, city, state, zip, lot_number, owner_name, owner_mailing_address, owner_contact_id')
        .eq('property_id', v.property_id).maybeSingle();
      if (!pRow) { skipped++; continue; }

      const logoBuffer = await getLogo(community);

      const pdfBuffer = await renderPostcardReminderPdf({
        community: { name: community.name, legal_name: community.legal_name },
        property: {
          street_address: pRow.street_address, unit: pRow.unit,
          city: pRow.city, state: pRow.state, zip: pRow.zip,
        },
        owner: { full_name: pRow.owner_name, mailing_address: pRow.owner_mailing_address },
        original_letter_date: c1MailedAt,
        cure_by_date: v.cure_period_ends_at,
        community_logo_buffer: logoBuffer,
      });

      // Upload + insert interaction row (status='draft' — operator approves
      // in Drafts queue, then mails from Mail Queue like any other letter).
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const storagePath = `${v.id}/postcard-reminder-${stamp}.pdf`;
      const LETTERS_BUCKET = 'violation-letters';
      const { error: upErr } = await supabase.storage
        .from(LETTERS_BUCKET).upload(storagePath, pdfBuffer, { contentType: 'application/pdf', upsert: false });
      if (upErr && !/already exists/i.test(upErr.message)) {
        errors.push({ violation_id: v.id, error: 'upload: ' + upErr.message });
        continue;
      }

      await supabase.from('interactions').insert({
        community_id:    v.community_id,
        property_id:     v.property_id,
        violation_id:    v.id,
        type:            'letter_postcard_reminder',
        direction:       'outbound',
        subject:         'Postcard reminder — pre-courtesy-2',
        content:         storagePath,
        delivery_method: 'first_class_mail',
        status:          'draft',
        ai_drafted:      true,
        ai_model:        'pdfkit_template',
      });
      drafted++;
    } catch (e) {
      errors.push({ violation_id: v.id, error: e.message });
    }
  }

  return { eligible: vios.length, drafted, skipped, errors, dry_run: dryRun };
}

// POST /api/enforcement/postcard-reminders/process
// Body: { community_id?, dry_run?, limit? }
router.post('/postcard-reminders/process', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const result = await processPostcardReminders({
      communityId: body.community_id || null,
      dryRun: !!body.dry_run,
      limit: Number(body.limit) || 100,
    });
    res.json(result);
  } catch (err) {
    console.error('[postcard-reminders.process]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, processCureLapses, processPostcardReminders };
