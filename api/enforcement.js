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
const { defaultWeightForSource } = require('../lib/enforcement/source_weights');
const { renderViolationLetterPdf } = require('../lib/enforcement/violation_letter');
const { renderForceMowLetterPdf } = require('../lib/lawn_force_mow_renderer');
const { renderPostcardReminderPdf } = require('../lib/enforcement/postcard_reminder');
const { parseVantacaViolations, parseVantacaViolationsPdf } = require('../lib/enforcement/vantaca_violation_import');
const { sendEmail, isConfigured: isEmailConfigured } = require('../lib/notifications/email');
const { sendSms,   isConfigured: isSmsConfigured }   = require('../lib/notifications/sms');
const { safeErrorMessage } = require('./_safe_error');

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
// Fetch ALL properties for a community, paginating past the PostgREST
// 1000-row response cap. Used by every Vantaca import path that builds
// an address/account → property lookup map. Communities like Waterview
// (1,171 properties) would silently miss 171 properties before this.
// See CLAUDE.md "Supabase 1000-row silent truncation" scar.
async function _fetchAllPropertiesForCommunity(communityId, selectCols = 'id, street_address, unit, vantaca_account_id') {
  const out = [];
  let offset = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('properties')
      .select(selectCols)
      .eq('community_id', communityId)
      .range(offset, offset + PAGE - 1);
    if (error) {
      console.warn('[enforcement._fetchAllPropertiesForCommunity] page failed at offset', offset, ':', error.message);
      break;
    }
    const page = data || [];
    out.push(...page);
    if (page.length < PAGE) break;
    offset += PAGE;
    if (out.length > 50000) break; // safety cap — no community has 50k properties
  }
  return out;
}

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

// ---------------------------------------------------------------------------
// POST /api/enforcement/violations/manual
// Multipart form endpoint that creates a manual-entry violation outside the
// normal drive-by inspection capture flow. Used for:
//   - Neighbor-reported issues (photos forwarded via email)
//   - Board-reported issues (board sends "look at 123 Main")
//   - Force-mow walk-up observations that can't wait for a full inspection
//
// Architecture: we don't have a "violation without observation" path; the
// schema requires every property_observation to have an inspection_id +
// inspection_photo_id, and every violation gets its evidence trail from
// observations. So this endpoint constructs a SYNTHETIC spot_check
// inspection that wraps the manual entry:
//   inspections (mode='spot_check', status='closed')
//     └─ inspection_photos (one per uploaded photo)
//         └─ property_observations (one per photo, reviewer_status='confirmed')
//             └─ violations (one, linked via opened_from_observation_id)
//
// Photos are optional — some manual entries are phoned in with description
// only. If zero photos, we still create the inspection + one observation
// (no inspection_photo_id link — handled below) and the violation. Letter
// generation is decoupled (manual approval step, per Ed 2026-05-29).
// ---------------------------------------------------------------------------

// ===========================================================================
// GET /api/enforcement/violations/duplicate-check
// Returns existing open + recently-closed violations for a (property,
// category) pair. Used by the manual violation modal to warn the operator
// before they file a duplicate when multiple staff are splitting a community.
//
// Query params:
//   property_id  (required)
//   category_id  (required)
//
// Response:
//   {
//     has_open: bool,
//     has_recent_closed: bool,
//     duplicates: [{
//       id, current_stage, opened_at, days_ago,
//       opened_by_email, category_label, source
//     }]
//   }
//
// "Open" = current_stage NOT IN (cured, closed, voided)
// "Recent closed" = cured/closed within the last 30 days
// ===========================================================================
router.get('/violations/duplicate-check', async (req, res) => {
  try {
    const propertyId = req.query.property_id;
    const categoryId = req.query.category_id;
    if (!propertyId || !categoryId) {
      return res.status(400).json({ error: 'property_id and category_id required' });
    }

    // Pull every violation at (property, category) so we can classify in JS.
    // At per-property scale (< 50 violations lifetime even on the worst
    // offenders) this is fine — we're not iterating the whole table.
    const { data: vios, error } = await supabase
      .from('violations')
      .select(`
        id, current_stage, opened_at, resolved_at, source,
        opened_by_user_id, enforcement_categories(label)
      `)
      .eq('property_id', propertyId)
      .eq('primary_category_id', categoryId)
      .order('opened_at', { ascending: false })
      .limit(20);
    if (error) {
      console.error('[duplicate-check] query failed:', error.message);
      return res.status(500).json({ error: safeErrorMessage(error) });
    }

    const now = Date.now();
    const THIRTY_DAYS_MS = 30 * 86400 * 1000;
    const OPEN_STAGES = new Set();
    // Anything not in this set counts as "open"
    const CLOSED_STAGES = new Set(['cured', 'closed', 'voided']);

    // Resolve opened_by user emails in one batch (avoids N+1)
    const userIds = [...new Set((vios || []).map((v) => v.opened_by_user_id).filter(Boolean))];
    let userEmailById = new Map();
    if (userIds.length > 0) {
      try {
        const { data: profiles } = await supabase
          .from('user_profiles')
          .select('id, email, full_name')
          .in('id', userIds);
        userEmailById = new Map(
          (profiles || []).map((p) => [p.id, p.full_name || p.email || null])
        );
      } catch (_) { /* tolerate */ }
    }

    const duplicates = [];
    let has_open = false;
    let has_recent_closed = false;

    for (const v of (vios || [])) {
      const isClosed = CLOSED_STAGES.has(v.current_stage);
      const openedAt = v.opened_at ? new Date(v.opened_at).getTime() : null;
      const daysAgo = openedAt ? Math.floor((now - openedAt) / 86400000) : null;

      if (!isClosed) {
        has_open = true;
        duplicates.push({
          id: v.id,
          status: 'open',
          current_stage: v.current_stage,
          opened_at: v.opened_at,
          days_ago: daysAgo,
          opened_by: userEmailById.get(v.opened_by_user_id) || null,
          category_label: v.enforcement_categories && v.enforcement_categories.label,
          source: v.source,
        });
      } else {
        const resolvedAt = v.resolved_at ? new Date(v.resolved_at).getTime() : openedAt;
        const sinceResolved = resolvedAt ? now - resolvedAt : Infinity;
        if (sinceResolved <= THIRTY_DAYS_MS) {
          has_recent_closed = true;
          duplicates.push({
            id: v.id,
            status: 'recently_closed',
            current_stage: v.current_stage,
            opened_at: v.opened_at,
            resolved_at: v.resolved_at,
            days_ago: daysAgo,
            days_since_resolved: Math.floor(sinceResolved / 86400000),
            opened_by: userEmailById.get(v.opened_by_user_id) || null,
            category_label: v.enforcement_categories && v.enforcement_categories.label,
            source: v.source,
          });
        }
      }
    }

    res.json({ has_open, has_recent_closed, duplicates });
  } catch (err) {
    console.error('[duplicate-check]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/violations/manual', upload.array('photos', 6), async (req, res) => {
  try {
    const { requireActingUser } = require('./_acting_user');
    const actor = await requireActingUser(req, res);
    if (!actor) return;

    // Multipart fields come through as strings on req.body. multer.array()
    // attaches files as req.files.
    const body = req.body || {};
    const communityId = body.community_id;
    const propertyId = body.property_id;
    const categoryId = body.primary_category_id;
    const source = body.source || 'manual_entry'; // subtype label for notes
    const severity = body.severity || 'moderate'; // ['clean','minor','moderate','severe']
    const description = body.description || '';
    const files = req.files || [];

    // ---- Validation ------------------------------------------------------
    if (!communityId) return res.status(400).json({ error: 'community_id required' });
    if (!propertyId)  return res.status(400).json({ error: 'property_id required' });
    if (!categoryId)  return res.status(400).json({ error: 'primary_category_id required' });
    if (!['clean', 'minor', 'moderate', 'severe'].includes(severity)) {
      return res.status(400).json({ error: 'invalid severity (allowed: clean|minor|moderate|severe)' });
    }
    if (files.length > 6) {
      return res.status(400).json({ error: 'max 6 photos per manual violation' });
    }

    // Verify the property actually belongs to the named community — never
    // trust client-provided community_id without cross-check. This stops a
    // staff member from accidentally (or maliciously) filing a violation
    // against the wrong community's property.
    const { data: propRow, error: propErr } = await supabase
      .from('properties')
      .select('id, community_id')
      .eq('id', propertyId)
      .maybeSingle();
    if (propErr) {
      console.error('[enforcement.manual] property lookup failed:', propErr.message);
      return res.status(500).json({ error: safeErrorMessage(propErr) });
    }
    if (!propRow) return res.status(404).json({ error: 'property not found' });
    if (propRow.community_id !== communityId) {
      return res.status(400).json({ error: 'property does not belong to specified community' });
    }

    // ---- Server-side duplicate guard (race-condition backstop) -----------
    // The frontend modal also checks via GET /duplicate-check before submit,
    // but two operators could pass that check simultaneously and both
    // submit. This guard fires at INSERT time. Bypassed when the operator
    // explicitly sends allow_duplicate=true (i.e., they saw the warning and
    // confirmed it's intentional).
    const allowDuplicate = body.allow_duplicate === 'true' || body.allow_duplicate === true;
    if (!allowDuplicate) {
      const { data: existingOpen } = await supabase
        .from('violations')
        .select('id, current_stage, opened_at, opened_by_user_id, source')
        .eq('property_id', propertyId)
        .eq('primary_category_id', categoryId)
        .not('current_stage', 'in', '("cured","closed","voided")')
        .order('opened_at', { ascending: false })
        .limit(1);
      if (existingOpen && existingOpen.length > 0) {
        const e = existingOpen[0];
        const daysAgo = e.opened_at
          ? Math.floor((Date.now() - new Date(e.opened_at).getTime()) / 86400000)
          : null;
        // Cleanup any uploaded files BEFORE returning — multer already
        // wrote them to memory, but we haven't pushed to storage yet here.
        return res.status(409).json({
          error: 'duplicate_open_violation',
          message: 'An open violation already exists for this property in this category. Set allow_duplicate=true to file anyway.',
          existing_violation: {
            id: e.id,
            current_stage: e.current_stage,
            opened_at: e.opened_at,
            days_ago: daysAgo,
            source: e.source,
          },
        });
      }
    }

    // Resolve board priority for the (community, category) — same engine
    // path the inspection-driven flow uses. Falls back to 'standard' when
    // no row is configured.
    const priorityWeight = await _getPriorityWeight(communityId, categoryId);

    // ---- 1) Synthetic inspection wrapper -------------------------------
    // Migration 054 dropped 'spot_check' from the inspections.mode CHECK
    // (production allows 'drive_by','resale','mounted_camera' only). We use
    // 'drive_by' as the closest match and put the actual differentiator on
    // route_label ("Manual entry: <source>") so reports can still filter
    // manual entries from real drive-bys by route_label LIKE 'Manual %'.
    // A follow-up migration could re-add 'manual_entry' as a first-class
    // mode if Ed wants cleaner filtering at scale.
    const inspectionRouteLabel = `Manual entry: ${source.replace(/_/g, ' ')}`
      + (description ? ` — ${description.slice(0, 60)}` : '');
    const { data: inspection, error: insErr } = await supabase
      .from('inspections')
      .insert({
        community_id: communityId,
        operator_id: actor.id || null,
        mode: 'drive_by',
        route_label: inspectionRouteLabel.slice(0, 200),
        status: 'closed',                              // closes immediately
        started_at: new Date().toISOString(),
        ended_at:   new Date().toISOString(),
        notes: description || null,
      })
      .select('id')
      .single();
    if (insErr) {
      console.error('[enforcement.manual] inspection insert failed:', insErr.message);
      return res.status(500).json({ error: safeErrorMessage(insErr) });
    }
    const inspectionId = inspection.id;

    // ---- 2) Upload photos + 3) create photo rows + 4) observations ------
    // We collect observation ids so the violation can be linked to the
    // first one as the "opened_from_observation_id" anchor. Upload errors
    // are non-fatal IF at least one observation lands — manual violations
    // shouldn't be blocked by a single bad-camera-orientation photo.
    let firstObservationId = null;
    const uploadedPhotoCount = { ok: 0, failed: 0 };
    const uploadedPaths = []; // track for rollback on hard failure
    // For each successful upload, capture what we need to run the async AI
    // cross-check after the response is sent. We keep the buffer in scope
    // so the AI doesn't have to re-fetch from storage.
    const photoWork = []; // [{ observation_id, buffer, mime_type }, ...]

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const safeName = String(file.originalname || `photo_${i}.jpg`).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
      const storagePath = `inspections/${inspectionId}/${Date.now()}_${i}_${safeName}`;

      const { error: stErr } = await supabase.storage
        .from('documents')
        .upload(storagePath, file.buffer, {
          contentType: file.mimetype || 'image/jpeg',
          upsert: false,
        });
      if (stErr) {
        console.warn('[enforcement.manual] storage upload failed for photo', i, stErr.message);
        uploadedPhotoCount.failed++;
        continue;
      }
      uploadedPaths.push(storagePath);

      const { data: photoRow, error: phErr } = await supabase
        .from('inspection_photos')
        .insert({
          inspection_id: inspectionId,
          storage_path: storagePath,
          captured_at: new Date().toISOString(),
          // GPS / heading intentionally NULL — manual entries didn't capture
          // them and we don't want to fake values
          reviewer_confirmed_property_id: propertyId,
          reviewer_user_id: actor.id || null,
          reviewed_at: new Date().toISOString(),
          notes: 'Manual entry — staff-confirmed property',
        })
        .select('id')
        .single();
      if (phErr || !photoRow) {
        console.warn('[enforcement.manual] inspection_photo insert failed:', phErr && phErr.message);
        uploadedPhotoCount.failed++;
        continue;
      }

      const { data: obsRow, error: obsErr } = await supabase
        .from('property_observations')
        .insert({
          inspection_id: inspectionId,
          inspection_photo_id: photoRow.id,
          property_id: propertyId,
          community_id: communityId,
          category_id: categoryId,
          severity: severity,
          ai_description: null,
          reviewer_status: 'confirmed',                // staff entered it directly
          reviewer_user_id: actor.id || null,
          reviewer_notes: description || null,
          reviewed_at: new Date().toISOString(),
        })
        .select('id')
        .single();
      if (obsErr || !obsRow) {
        console.warn('[enforcement.manual] property_observation insert failed:', obsErr && obsErr.message);
        uploadedPhotoCount.failed++;
        continue;
      }

      if (!firstObservationId) firstObservationId = obsRow.id;
      uploadedPhotoCount.ok++;
      // Stash for the async AI cross-check below
      photoWork.push({
        observation_id: obsRow.id,
        buffer: file.buffer,
        mime_type: file.mimetype || 'image/jpeg',
      });
    }

    // ---- Fallback observation when no photos uploaded -------------------
    // Manual violations CAN be filed with description only (phone-in case).
    // In that case we create one observation without an inspection_photo_id.
    // Schema requires inspection_photo_id NOT NULL, so we have to create a
    // placeholder photo row with no storage_path... actually
    // inspection_photos.storage_path is NOT NULL too. So if no photos
    // uploaded, we MUST create at least a stub photo. We use a placeholder
    // path that we'll never actually fetch from storage.
    if (!firstObservationId) {
      const placeholderPath = `inspections/${inspectionId}/_no_photo_placeholder.txt`;
      const { data: stubPhoto, error: stubErr } = await supabase
        .from('inspection_photos')
        .insert({
          inspection_id: inspectionId,
          storage_path: placeholderPath,
          captured_at: new Date().toISOString(),
          reviewer_confirmed_property_id: propertyId,
          reviewer_user_id: actor.id || null,
          reviewed_at: new Date().toISOString(),
          notes: 'Manual entry without photo — description only',
        })
        .select('id')
        .single();
      if (stubErr || !stubPhoto) {
        console.error('[enforcement.manual] stub photo insert failed:', stubErr && stubErr.message);
        return res.status(500).json({ error: 'failed to record observation' });
      }
      const { data: stubObs, error: stubObsErr } = await supabase
        .from('property_observations')
        .insert({
          inspection_id: inspectionId,
          inspection_photo_id: stubPhoto.id,
          property_id: propertyId,
          community_id: communityId,
          category_id: categoryId,
          severity: severity,
          ai_description: null,
          reviewer_status: 'confirmed',
          reviewer_user_id: actor.id || null,
          reviewer_notes: description || 'Manual entry, no photo provided',
          reviewed_at: new Date().toISOString(),
        })
        .select('id')
        .single();
      if (stubObsErr || !stubObs) {
        console.error('[enforcement.manual] stub observation insert failed:', stubObsErr && stubObsErr.message);
        return res.status(500).json({ error: 'failed to record observation' });
      }
      firstObservationId = stubObs.id;
    }

    // ---- 5) Insert the violation ----------------------------------------
    // current_stage='courtesy_1' is the default starting point for manual
    // entries unless the staff explicitly overrides via body.override_stage.
    // quality_status='verified' — full weight, staff put eyes on it.
    const overrideStage = body.override_stage;
    const validStages = ['courtesy_1', 'courtesy_2', 'certified_209', 'fine_assessed'];
    const stage = (overrideStage && validStages.includes(overrideStage)) ? overrideStage : 'courtesy_1';

    const { data: violation, error: vErr } = await supabase
      .from('violations')
      .insert({
        property_id: propertyId,
        community_id: communityId,
        opened_from_observation_id: firstObservationId,
        primary_category_id: categoryId,
        board_priority_at_open: (priorityWeight === 'disabled' || !priorityWeight) ? 'standard' : priorityWeight,
        current_stage: stage,
        current_stage_started_at: new Date().toISOString(),
        opened_at: new Date().toISOString(),
        opened_by_user_id: actor.id || null,
        source: 'manual_entry',
        quality_status: 'verified',          // staff entered directly = full weight
        confidence_weight: 1.0,
        reviewed_by_user_id: actor.id || null,
        reviewed_at: new Date().toISOString(),
        review_notes: description || `Manual entry via ${source}`,
      })
      .select('id, current_stage, opened_at')
      .single();
    if (vErr) {
      console.error('[enforcement.manual] violation insert failed:', vErr.message);
      // Roll back uploaded storage so we don't leak orphan files
      if (uploadedPaths.length > 0) {
        try { await supabase.storage.from('documents').remove(uploadedPaths); } catch (_) {}
      }
      return res.status(500).json({ error: safeErrorMessage(vErr) });
    }

    res.json({
      ok: true,
      violation_id: violation.id,
      current_stage: violation.current_stage,
      opened_at: violation.opened_at,
      inspection_id: inspectionId,
      photos_uploaded: uploadedPhotoCount.ok,
      photos_failed: uploadedPhotoCount.failed,
      observation_id: firstObservationId,
      board_priority: priorityWeight,
      ai_review_pending: photoWork.length > 0,
    });

    // ---- 6) Async AI cross-check (fire-and-forget) ----------------------
    // Runs AFTER the response is sent so the operator sees the violation
    // create immediately. For each manual photo: re-run categorizePhoto,
    // record AI's view alongside staff's, flag the violation if AI sees a
    // different category OR no violation at all. Low-confidence AI is
    // logged but doesn't flag (uncertain ≠ wrong).
    //
    // Errors here NEVER throw the response — we already returned. They
    // log + skip and the next photo is processed.
    if (photoWork.length > 0) {
      (async () => {
        try {
          // Load the full category list once so each call shares it
          const { data: catRows } = await supabase
            .from('enforcement_categories')
            .select('slug, label, description');
          const categories = (catRows || []).filter((c) => c.slug);

          // The staff's category in slug form — for the agree/disagree compare
          const staffCatRow = categories.find((c) => {
            // We have categoryId (UUID); look up its slug by re-fetching once
            return false; // placeholder; we'll resolve below
          });
          let staffCategorySlug = null;
          try {
            const { data: cRow } = await supabase
              .from('enforcement_categories')
              .select('slug')
              .eq('id', categoryId)
              .maybeSingle();
            staffCategorySlug = cRow && cRow.slug;
          } catch (_) {}

          // Pull community + property context for richer AI prompting
          let context = {};
          try {
            const [{ data: comm }, { data: prop }] = await Promise.all([
              supabase.from('communities').select('name').eq('id', communityId).maybeSingle(),
              supabase.from('properties').select('street_address').eq('id', propertyId).maybeSingle(),
            ]);
            if (comm) context.community_name = comm.name;
            if (prop) context.property_address = prop.street_address;
          } catch (_) {}

          let disagreementCount = 0;
          const disagreementNotes = [];

          for (const p of photoWork) {
            try {
              const ai = await categorizePhoto({
                image_buffer: p.buffer,
                image_media_type: p.mime_type,
                categories,
                context,
              });
              if (!ai) {
                console.warn('[enforcement.manual] AI returned null for obs', p.observation_id);
                continue;
              }

              // Persist AI's view onto the observation alongside staff's
              await supabase
                .from('property_observations')
                .update({
                  ai_description: ai.description || null,
                  ai_recommended_action: ai.recommended_action || null,
                  ai_confidence: ai.confidence || null,
                })
                .eq('id', p.observation_id);

              // Agree/disagree analysis. Only treat as disagreement when AI
              // confidence is medium or high — low-confidence AI = "I'm not
              // sure" which doesn't override staff judgment.
              if (ai.confidence === 'low') continue;

              if (ai.is_violation === false || ai.severity === 'clean') {
                disagreementCount++;
                disagreementNotes.push(
                  `AI (${ai.confidence}) doesn't see a violation in this photo: "${(ai.description || '').slice(0, 120)}"`
                );
                continue;
              }

              if (staffCategorySlug && ai.category_slug && ai.category_slug !== staffCategorySlug) {
                disagreementCount++;
                disagreementNotes.push(
                  `AI (${ai.confidence}) sees ${ai.category_slug} not ${staffCategorySlug}: "${(ai.description || '').slice(0, 120)}"`
                );
              }
            } catch (perPhotoErr) {
              console.warn('[enforcement.manual] AI cross-check failed for obs', p.observation_id, perPhotoErr.message);
            }
          }

          // If ANY photo had a real disagreement, flag the violation for
          // re-review and append AI's view to review_notes. Staff's
          // assessment is preserved (we never overwrite their category or
          // current_stage) — we just surface the disagreement.
          if (disagreementCount > 0) {
            try {
              const { data: existing } = await supabase
                .from('violations')
                .select('review_notes')
                .eq('id', violation.id)
                .maybeSingle();
              const priorNotes = (existing && existing.review_notes) || '';
              const aiSummary = `[AI cross-check ${new Date().toISOString().slice(0, 10)}] `
                + `${disagreementCount}/${photoWork.length} photo${photoWork.length === 1 ? '' : 's'} `
                + `flagged disagreement. ${disagreementNotes.join(' · ')}`;
              const newNotes = priorNotes ? `${priorNotes}\n\n${aiSummary}` : aiSummary;
              await supabase
                .from('violations')
                .update({
                  quality_status: 'flagged_internal',
                  review_notes: newNotes.slice(0, 3000), // cap to avoid runaway
                })
                .eq('id', violation.id);
              console.log('[enforcement.manual] AI flagged violation', violation.id,
                'with', disagreementCount, 'disagreement(s)');
            } catch (flagErr) {
              console.error('[enforcement.manual] failed to flag violation', violation.id, flagErr.message);
            }
          } else {
            console.log('[enforcement.manual] AI agrees with staff on violation', violation.id);
          }
        } catch (asyncErr) {
          console.error('[enforcement.manual] async AI cross-check failed:', asyncErr.message);
        }
      })();
    }
  } catch (err) {
    console.error('[enforcement.manual] failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/generate-letter', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const violationId = body.violation_id;
    const forceRegenerate = !!body.force_regenerate;
    if (!violationId) return res.status(400).json({ error: 'violation_id required' });

    // Fetch violation + property + community + category in one round trip.
    // slug is needed so we can dispatch force-mow 10-day letters to the
    // dedicated renderer (lib/lawn_force_mow_renderer.js) instead of the
    // standard §209 violation_letter pipeline. Different statutory
    // structure, different community-config requirements.
    const { data: violation, error: vErr } = await supabase
      .from('violations')
      .select(`
        id, property_id, community_id, current_stage, cure_period_ends_at,
        opened_at, opened_from_observation_id, primary_category_id, board_priority_at_open,
        enforcement_categories ( slug, label, description ),
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
        .select('id, ai_description, reviewer_notes, severity, created_at, inspection_photo_id, inspection_photos(captured_at, storage_path)')
        .eq('id', violation.opened_from_observation_id)
        .maybeSingle();
      if (obs) {
        // For manual entries the AI cross-check may not have finished yet
        // (it's async, ~3-6 sec after submit). Fall back to the staff's
        // reviewer_notes (what they typed in the Description field) so the
        // letter renderer's required-min-10-chars validator passes.
        // Final fallback: a generic placeholder so a letter can still be
        // drafted even if neither AI nor staff entered text — better to
        // have a draftable letter than block the workflow entirely.
        const description = obs.ai_description
          || obs.reviewer_notes
          || `Condition observed at the property consistent with ${(violation.enforcement_categories && violation.enforcement_categories.label) || 'the noted category'}.`;
        observation = {
          ai_description: description,
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
    // Force-mow community config (migration 126) — only used when the
    // category is lawn_force_mow_10day. Captured here so we only round-trip
    // the communities table once.
    const commForceMow = {
      declaration_doc_number:  null,
      declaration_county:      null,
      declaration_short_name:  null,
      force_mow_section_full:  null,
      force_mow_admin_fee_cents: null,
    };
    let senderName = body.sender_name || null;
    let senderTitle = body.sender_title || null;
    try {
      const { data: comm } = await supabase
        .from('communities')
        .select('name, legal_name, letter_sender_name, letter_sender_title, enforcement_authority_citation, letter_fee_courtesy_1_cents, letter_fee_courtesy_2_cents, letter_fee_certified_209_cents, letter_fee_fine_assessed_cents, letter_cure_days_courtesy_1, letter_cure_days_courtesy_2, letter_cure_days_certified_209, declaration_doc_number, declaration_county, declaration_short_name, force_mow_section_full, force_mow_admin_fee_cents')
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
        commForceMow.declaration_doc_number   = comm.declaration_doc_number || null;
        commForceMow.declaration_county       = comm.declaration_county || null;
        commForceMow.declaration_short_name   = comm.declaration_short_name || comm.name || null;
        commForceMow.force_mow_section_full   = comm.force_mow_section_full || null;
        commForceMow.force_mow_admin_fee_cents = (comm.force_mow_admin_fee_cents != null) ? comm.force_mow_admin_fee_cents : 2500;
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
          categorySlug:        violation.enforcement_categories && violation.enforcement_categories.slug,
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

    // ----- DISPATCH: force-mow 10-day letter has its own renderer -------
    // The lawn_force_mow_10day track is governed by §202.018 / Declaration
    // self-help, not the standard §209 escalation pipeline. Different
    // statutory wording, different required community-config fields, locked
    // gold-standard template per CLAUDE.md catastrophic-output discipline.
    // We branch here so this category gets the dedicated renderer; all
    // other categories fall through to the standard violation_letter path.
    const categorySlug = violation.enforcement_categories && violation.enforcement_categories.slug;
    let pdfBuffer = null;
    if (categorySlug === 'lawn_force_mow_10day') {
      // Validate community has the force-mow declaration fields populated.
      // Without them we can't cite the right Article or doc number — too
      // risky to draft with placeholders on a certified §202.018 notice.
      const missing = [];
      if (!commForceMow.declaration_doc_number)  missing.push('declaration_doc_number');
      if (!commForceMow.declaration_county)      missing.push('declaration_county');
      if (!commForceMow.force_mow_section_full)  missing.push('force_mow_section_full');
      if (missing.length > 0) {
        return res.status(400).json({
          error: 'force-mow letter requires community config that is not yet set: '
                 + missing.join(', ')
                 + `. Set these columns on the communities row for ${(violation.communities && violation.communities.name) || 'this community'} via migration 126 pattern, then retry.`,
          missing_fields: missing,
        });
      }

      const today = new Date();
      const todayIso = today.toISOString().slice(0, 10);
      // Observation date — fall back to the violation's opened_at when the
      // observation captured_at is missing
      const obsDateRaw = (observation && observation.captured_at) || violation.opened_at;
      const obsIso = obsDateRaw ? new Date(obsDateRaw).toISOString().slice(0, 10) : todayIso;

      // Owner block: name on line 1, mailing address on subsequent lines.
      // Handles owner-occupied (mailing == property) and rentals
      // (separate mailing line via alt_mailing_address_block, set on the
      // optional field — schema allows null).
      const ownerName = pRow.owner_name || 'Property Owner';
      const propAddr = `${pRow.street_address || ''}${pRow.unit ? ' #' + pRow.unit : ''}`;
      const cityStateZip = `${pRow.city || ''}, ${pRow.state || 'TX'} ${pRow.zip || ''}`.replace(/\s+,/g, ',').trim();
      const homeownerBlock = `${ownerName}\n${propAddr}\n${cityStateZip}`;
      const propertyAddressFull = `${propAddr}, ${cityStateZip}`;

      // Hearing-rights gating: §209.006-007 paragraph required when no
      // prior notice for the same violation in the past 6 months. Look at
      // interactions for this property + category to compute it. Defaults
      // to TRUE (safer to include the disclosure than omit it).
      let includeHearingRights = true;
      try {
        const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
        const { data: priorNotices } = await supabase
          .from('interactions')
          .select('id, sent_at')
          .eq('property_id', violation.property_id)
          .gte('sent_at', sixMonthsAgo)
          .in('type', ['letter_courtesy_1', 'letter_courtesy_2', 'letter_209', 'letter_force_mow_10day']);
        // Cross-reference to violations of the same category — only count
        // letters tied to a force-mow violation here
        if (priorNotices && priorNotices.length > 0) {
          const { data: sameCatVios } = await supabase
            .from('violations')
            .select('id')
            .eq('property_id', violation.property_id)
            .eq('primary_category_id', violation.primary_category_id)
            .gte('opened_at', sixMonthsAgo);
          // Conservative: any same-category violation in window OR any
          // recent letter → suppress (already informed)
          if ((sameCatVios && sameCatVios.length > 0) || priorNotices.length > 0) {
            // Strict reading of §209: NO notice for SAME violation in 6mo
            // means we can omit. Easier to be safe and include — attorney
            // can scrub on review if they want it leaner.
            includeHearingRights = true;
          }
        }
      } catch (_) { /* default TRUE */ }

      const feeCents = commForceMow.force_mow_admin_fee_cents != null ? commForceMow.force_mow_admin_fee_cents : 2500;
      const feeFormatted = `$${(feeCents / 100).toFixed(2)}`;

      const forceMowInput = {
        community_legal_name:    commLegalName || (violation.communities && violation.communities.name) || 'the Association',
        community_short_name:    commForceMow.declaration_short_name,
        letter_date:             todayIso,
        homeowner_names_block:   homeownerBlock,
        property_address_full:   propertyAddressFull,
        property_address_short:  propAddr,
        declaration_doc_number:  commForceMow.declaration_doc_number,
        declaration_county:      commForceMow.declaration_county,
        declaration_section_full: commForceMow.force_mow_section_full,
        observation_date:        obsIso,
        observed_condition:      (observation && observation.ai_description) || 'Lawn in need of mowing, edging, and weed control consistent with the standard maintained by the community.',
        admin_fee_amount:        feeFormatted,
        include_hearing_rights:  includeHearingRights,
      };

      try {
        pdfBuffer = renderForceMowLetterPdf(forceMowInput);
      } catch (renderErr) {
        console.error('[enforcement.generate-letter] force-mow render failed:', renderErr.message);
        return res.status(500).json({
          error: 'force-mow letter render failed',
          detail: renderErr.message,
          code: renderErr.code || null,
        });
      }
    } else {
    // Generate the PDF (standard violation letter)
    pdfBuffer = await renderViolationLetterPdf({
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
        full_name: pRow.owner_name,
        // For owner-occupied properties (the common case), mailing_address
        // IS the property address. Fall back to a constructed string from
        // property fields when owner_mailing_address is null so the
        // validator's "required" rule doesn't block letter generation.
        // Same fallback pattern already used at line 1199 (mailed_to).
        mailing_address: pRow.owner_mailing_address
          || `${pRow.street_address || ''}${pRow.unit ? ' #' + pRow.unit : ''}, ${pRow.city || ''} ${pRow.state || 'TX'} ${pRow.zip || ''}`.trim(),
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
    } // end else (standard violation letter path)

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

    // FALLBACK PHOTO LOOKUP — Ed 2026-06-10 bug fix.
    // The single-letter generator (line ~1149) falls back to the most recent
    // confirmed inspection_photo at the property when the violation's
    // opened_from_observation_id chain is empty. The drafts queue was not
    // mirroring that fallback, so letters that visibly contained a photo
    // were rendering "no photo" in the queue. Identical fallback logic here:
    // latest photo at the property with photo_role in ('close_up','single')
    // where reviewer_confirmed_property_id matches. No category filter
    // (matches the letter generator's behavior exactly).
    const latestPhotoByProperty = new Map();
    if (propertyIds.length) {
      const { data: latestPhotos } = await supabase
        .from('inspection_photos')
        .select('storage_path, captured_at, reviewer_confirmed_property_id')
        .in('reviewer_confirmed_property_id', propertyIds)
        .in('photo_role', ['close_up', 'single'])
        .order('captured_at', { ascending: false });
      for (const ph of (latestPhotos || [])) {
        if (!latestPhotoByProperty.has(ph.reviewer_confirmed_property_id)) {
          latestPhotoByProperty.set(ph.reviewer_confirmed_property_id, ph);
        }
      }
    }

    // Generate signed URLs for both letter PDFs and observation photos (in parallel)
    const enrichedAll = await Promise.all(drafts.map(async (d) => {
      const v = violationById.get(d.violation_id);
      const p = propertyById.get(d.property_id);
      const o = observationById.get(d.observation_id);
      let photoPath = o && o.inspection_photos && o.inspection_photos.storage_path;
      // Fallback — observation chain empty, use latest confirmed property photo
      if (!photoPath) {
        const fallbackPhoto = latestPhotoByProperty.get(d.property_id);
        if (fallbackPhoto && fallbackPhoto.storage_path) {
          photoPath = fallbackPhoto.storage_path;
        }
      }
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
        // Ed 2026-06-10 bug #2: previously this was `o ? {...} : null`, which
        // discarded the photo_url whenever the observation chain was empty
        // even when the fallback lookup HAD resolved a photo at the property.
        // Now the observation object is returned whenever there's either a
        // real observation row OR a resolved photo_url, so the UI thumbnail
        // matches what the letter generator's fallback embeds in the PDF.
        observation: (o || photoUrl) ? {
          severity: o ? o.severity : null,
          ai_description: o ? o.ai_description : null,
          ai_confidence: o ? o.ai_confidence : null,
          reviewer_notes: o ? o.reviewer_notes : null,
          captured_at: o && o.inspection_photos && o.inspection_photos.captured_at,
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

    // Pull ALL draft-status letters at the courtesy / §209 levels regardless
    // of current bundle_id. Ed 2026-06-13 caught the bug: the old query
    // filtered to bundle_id IS NULL, which means once a draft got a
    // singleton bundle_id assigned, it never re-bundled with NEW drafts
    // arriving later at the same property. Each new photo at the same
    // address created its own loose envelope. Now we re-evaluate every draft
    // every run and only regenerate when the grouping is actually wrong
    // (idempotency check below skips groups already correctly bundled).
    let q = supabase
      .from('interactions')
      .select('id, type, community_id, property_id, violation_id, observation_id, inspection_id, content, bundle_id, letter_fee_cents')
      .eq('status', 'draft')
      .in('type', letterTypes);
    if (communityId) q = q.eq('community_id', communityId);
    const { data: drafts, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    if (!drafts || drafts.length === 0) {
      return res.json({ bundles_created: 0, drafts_bundled: 0, singletons: 0, skipped: 0 });
    }

    // Per-community §209 bundling-opt-out config (migration 133). When TRUE,
    // letter_209 drafts (covers both certified_209 and fine_assessed) are
    // treated as singletons regardless of how many are at the same property.
    // Other types (courtesy_1, courtesy_2) still combine as before.
    //
    // Why: Texas §209 procedural defensibility — each violation needs its own
    // §209.0064 cure-rights statement and §209.007 hearing-rights paragraph.
    // A bundled letter CAN include all required citations per violation, but
    // a defending attorney can argue the bundle "obscures" per-violation cure
    // rights and create a procedural defense at the §209 hearing. Operators
    // choose per community.
    const communityIdsInScope = [...new Set(drafts.map((d) => d.community_id).filter(Boolean))];
    const separateCertifiedCommunities = new Set();
    if (communityIdsInScope.length > 0) {
      try {
        const { data: commRows } = await supabase
          .from('communities')
          .select('id, bundle_certified_letters_separately')
          .in('id', communityIdsInScope);
        for (const c of (commRows || [])) {
          if (c.bundle_certified_letters_separately) separateCertifiedCommunities.add(c.id);
        }
      } catch (e) {
        // If the column doesn't exist yet (migration 133 not applied), fall
        // back to existing behavior — combine everything. Loud-warn so the
        // operator can spot it in logs.
        console.warn('[drafts/auto-bundle] community config lookup failed (migration 133 not applied?):', e.message);
      }
    }

    // Group by (property_id, type). For letter_209 drafts in opt-out
    // communities, we use a unique-per-draft key so each one ends up in its
    // own group of 1 → falls through the singletons branch below and gets
    // its own bundle_id without merging.
    const groups = new Map();
    for (const d of drafts) {
      if (!d.property_id) continue;
      const isSeparateCertified = d.type === 'letter_209'
        && separateCertifiedCommunities.has(d.community_id);
      const key = isSeparateCertified
        ? `${d.property_id}|${d.type}|${d.id}`  // unique → singleton path
        : `${d.property_id}|${d.type}`;
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
          // Singleton — assign a bundle_id ONLY if missing. Already-bundled
          // singletons are left alone (idempotent re-run).
          if (group[0].bundle_id) continue;
          const bundleId = cryptoMod.randomUUID();
          await supabase.from('interactions')
            .update({ bundle_id: bundleId })
            .eq('id', group[0].id);
          singletons += 1;
          continue;
        }

        // Multi-draft group — check if already correctly bundled. If every
        // member shares the same bundle_id, the auto-bundle already happened
        // and we skip. Otherwise (mixed bundle_ids OR some NULL OR all
        // different singletons), we re-bundle with one shared bundle_id and
        // regenerate the consolidated PDF.
        const distinctBundleIds = new Set(group.map((g) => g.bundle_id).filter(Boolean));
        const allShareOne = distinctBundleIds.size === 1 && group.every((g) => g.bundle_id);
        if (allShareOne) continue;

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
            .select('id, primary_category_id, current_stage, cure_period_ends_at, opened_at, board_priority_at_open, opened_from_observation_id, enforcement_categories(slug, label, description)')
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
                categorySlug:        v.enforcement_categories && v.enforcement_categories.slug,
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
            violation_id: v.id,
            category_label: v.enforcement_categories && v.enforcement_categories.label,
            ai_description: o && o.ai_description,
            observation_captured_at: (photo && photo.captured_at) || (o && o.created_at),
            governing_doc: govDoc,
            prior_notices: (priors || []).map((pv) => ({ date: pv.opened_at, stage: pv.current_stage })),
            close_up_photo_buffer: closeUpBuf,
          });
        }

        // Generate the bundle PDF — pull per-community editable copy
        // overrides (title, opening, closing) so the rendered letter
        // reflects whatever the operator saved for this stage.
        const { loadOverrides: _loadCopyOverrides } = require('../lib/enforcement/letter_copy');
        const _bundleCopyOverrides = await _loadCopyOverrides(supabase, communityIdForGroup, stage);
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
          copy_overrides: _bundleCopyOverrides,
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
    const printedAt = new Date().toISOString();
    await supabase
      .from('interactions')
      .update({
        printed_at: printedAt,
        locked_by_user_id: actor.id,
      })
      .in('id', included);

    // Log a letter_mail_pieces row per letter with provider='manual' so
    // every mailed letter (whether via Lob or printed-and-stuffed manually)
    // has a unified audit trail. Same UI treats both paths identically.
    try {
      const { data: includedInters } = await supabase
        .from('interactions')
        .select('id, community_id, property_id, violation_id, type, bundle_id')
        .in('id', included);
      const stageMap = {
        letter_courtesy_1: 'courtesy_1',
        letter_courtesy_2: 'courtesy_2',
        letter_209:        'certified_209',
        letter_fine:       'fine_assessed',
        letter_hearing:    'hearing_notice',
        letter_force_mow:  'force_mow',
      };
      const pieces = (includedInters || []).map(inter => ({
        interaction_id: inter.id,
        community_id:   inter.community_id,
        property_id:    inter.property_id,
        violation_id:   inter.violation_id,
        bundle_id:      inter.bundle_id,
        stage_at_send:  stageMap[inter.type] || 'certified_209',
        provider:       'manual',
        delivery_method: deliveryMethod === 'certified_mail' ? 'certified_mail' : 'first_class',
        return_receipt_requested: deliveryMethod === 'certified_mail',
        status:         'submitted',
        submitted_at:   printedAt,
        mailed_at:      postmarkDate.toISOString(),
        events: [{
          ts: printedAt,
          type: 'manual_print_batch',
          note: `Locked + printed in batch by user ${actor.id}, postmark ${postmarkIso}`,
        }],
      }));
      if (pieces.length > 0) {
        const { error: mpErr } = await supabase.from('letter_mail_pieces')
          .upsert(pieces, { onConflict: 'interaction_id' });
        if (mpErr) console.warn('[mail-queue.lock-and-batch] letter_mail_pieces upsert failed:', mpErr.message);
      }
    } catch (e) {
      console.warn('[mail-queue.lock-and-batch] mail piece logging failed (non-fatal):', e.message);
    }

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
      .select('id, slug, label, description, observation_template, default_priority_weight, display_order')
      .order('display_order', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ categories: data || [] });
  } catch (err) {
    console.error('[enforcement.categories]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/enforcement/categories/:id
// Body: { description?, label?, default_priority_weight?, display_order? }
// Lets the operator tune what the AI looks for per category. The label
// change ripples to every existing observation (joins by id). Description
// is what the AI prompt cites when classifying — wording it tightly is
// the highest-leverage way to improve detection accuracy.
// ---------------------------------------------------------------------------
router.patch('/categories/:id', express.json(), async (req, res) => {
  try {
    const allowedFields = ['description', 'label', 'observation_template', 'default_priority_weight', 'display_order'];
    const patch = {};
    for (const k of allowedFields) {
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, k)) {
        patch[k] = req.body[k];
      }
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no editable fields supplied' });
    if (patch.default_priority_weight && !['standard','elevated','aggressive','disabled'].includes(patch.default_priority_weight)) {
      return res.status(400).json({ error: 'invalid default_priority_weight' });
    }
    const { data, error } = await supabase
      .from('enforcement_categories')
      .update(patch)
      .eq('id', req.params.id)
      .select('*').single();
    if (error) throw error;
    res.json({ ok: true, category: data });
  } catch (err) {
    console.error('[enforcement.categories.patch]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/enforcement/category-priorities?community_id=X
// Returns the currently-active priority weight for every category at this
// community. Falls back to category.default_priority_weight when no
// community-specific override exists.
// ---------------------------------------------------------------------------
router.get('/category-priorities', async (req, res) => {
  try {
    const communityId = req.query.community_id;
    if (!communityId) return res.status(400).json({ error: 'community_id_required' });
    const [catRes, prioRes] = await Promise.all([
      supabase.from('enforcement_categories')
        .select('id, slug, label, description, observation_template, default_priority_weight, display_order')
        .order('display_order', { ascending: true }),
      supabase.from('community_enforcement_priorities')
        .select('category_id, priority_weight, set_by_board_vote_date, board_meeting_minutes_ref, notes, governing_doc_reference, governing_doc_section_title, governing_doc_quote, governing_doc_page')
        .eq('community_id', communityId)
        .is('end_date', null),
    ]);
    if (catRes.error) throw catRes.error;
    if (prioRes.error) throw prioRes.error;
    const prioMap = new Map((prioRes.data || []).map(p => [p.category_id, p]));
    const rows = (catRes.data || []).map(c => {
      const p = prioMap.get(c.id);
      return {
        ...c,
        effective_priority: (p && p.priority_weight) || c.default_priority_weight,
        is_overridden: !!p,
        board_vote_date: p && p.set_by_board_vote_date,
        board_minutes_ref: p && p.board_meeting_minutes_ref,
        priority_notes: p && p.notes,
        // Per-(community, category) citation override — when populated,
        // the letter renderer uses these EXACT values and never calls
        // the auto-lookup. This is the encode-Ed pattern: lock the
        // correct citation once, system never gets it wrong again.
        governing_doc_reference:     p && p.governing_doc_reference     || null,
        governing_doc_section_title: p && p.governing_doc_section_title || null,
        governing_doc_quote:         p && p.governing_doc_quote         || null,
        governing_doc_page:          p && p.governing_doc_page          || null,
        has_citation_override: !!(p && p.governing_doc_reference),
      };
    });
    res.json({ community_id: communityId, categories: rows });
  } catch (err) {
    console.error('[enforcement.category-priorities.get]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/enforcement/category-priorities
// Body: { community_id, category_id, priority_weight, board_vote_date?,
//         board_minutes_ref?, notes? }
// End-dates any current row + inserts a new active row. Preserves the
// "why was this enforced" answer even after board recalibration.
// ---------------------------------------------------------------------------
router.put('/category-priorities', express.json(), async (req, res) => {
  try {
    const {
      community_id, category_id, priority_weight, board_vote_date,
      board_minutes_ref, notes,
      governing_doc_reference, governing_doc_section_title,
      governing_doc_quote, governing_doc_page,
    } = req.body || {};
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    if (!category_id) return res.status(400).json({ error: 'category_id_required' });
    if (!['standard','elevated','aggressive','disabled'].includes(priority_weight)) {
      return res.status(400).json({ error: 'invalid priority_weight' });
    }
    // End-date the current active row (if any). Preserves audit trail
    // — both priority recalibrations AND citation corrections show up
    // as historical rows with end_date set.
    const today = new Date().toISOString().slice(0, 10);
    await supabase.from('community_enforcement_priorities')
      .update({ end_date: today })
      .eq('community_id', community_id)
      .eq('category_id', category_id)
      .is('end_date', null);
    // Insert the new active row with both priority + citation fields.
    // Citation fields are nullable — operator may set priority alone,
    // citation alone, or both. Empty strings normalized to NULL so the
    // 'has citation' check is unambiguous.
    const _norm = (v) => (typeof v === 'string' && v.trim()) ? v.trim() : null;
    const _normNum = (v) => {
      const n = parseInt(v, 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const { data, error } = await supabase.from('community_enforcement_priorities')
      .insert({
        community_id, category_id, priority_weight,
        set_by_board_vote_date:      board_vote_date || null,
        board_meeting_minutes_ref:   board_minutes_ref || null,
        notes:                       notes || null,
        governing_doc_reference:     _norm(governing_doc_reference),
        governing_doc_section_title: _norm(governing_doc_section_title),
        governing_doc_quote:         _norm(governing_doc_quote),
        governing_doc_page:          _normNum(governing_doc_page),
      })
      .select('*').single();
    if (error) throw error;
    res.json({ ok: true, priority: data });
  } catch (err) {
    console.error('[enforcement.category-priorities.put]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
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

    // Source weight defaults live in lib/enforcement/source_weights.js —
    // single source of truth across every import path. NEVER hardcode a
    // weight here; the helper enforces consistency so the next "Vantaca
    // was actually full-trust" realization only needs ONE file changed.
    const source = body.source || 'manual_entry';
    const weight = (typeof body.confidence_weight === 'number')
      ? Math.max(0, Math.min(1, body.confidence_weight))
      : defaultWeightForSource(source);

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
// POST /api/enforcement/violations/:id/resolve
//   Manually close an open violation. Ed 2026-06-10: needed for the cases
//   where a violation gets cured WITHOUT a fresh inspection finding —
//   homeowner emails/texts a photo saying "we mowed", manager spots the
//   cure during a drive-by without logging a full inspection, or the
//   board says "let's drop this one" for a documented reason.
//
//   The system already auto-closes when a new inspection at the property
//   finds the category clean. This endpoint covers the explicit-manual
//   close path so staff don't have to log a fake inspection to close
//   one violation.
//
//   Body: { resolved_via, resolved_notes }
//     resolved_via: 'manual_cured' (default) | 'manual_board_dismissed' |
//                   'manual_owner_confirmed' | 'manual_other'
//     resolved_notes: free text required for audit trail
//
//   Refuses if violation is already in a terminal stage. Single source of
//   truth: this is the ONLY way to set current_stage='cured' or 'closed'
//   from outside the AI-analyze observation chain.
// ---------------------------------------------------------------------------
const ALLOWED_RESOLVE_VIA = new Set([
  'manual_cured',
  'manual_board_dismissed',
  'manual_owner_confirmed',
  'manual_other',
]);
router.post('/violations/:id/resolve', express.json(), async (req, res) => {
  try {
    const violationId = req.params.id;
    const body = req.body || {};
    const resolvedVia = body.resolved_via || 'manual_cured';
    const resolvedNotes = (body.resolved_notes || '').trim();
    if (!ALLOWED_RESOLVE_VIA.has(resolvedVia)) {
      return res.status(400).json({ error: `resolved_via must be one of: ${[...ALLOWED_RESOLVE_VIA].join(', ')}` });
    }
    if (!resolvedNotes) {
      return res.status(400).json({ error: 'resolved_notes required for audit trail' });
    }

    const { data: v, error: vErr } = await supabase
      .from('violations')
      .select('id, current_stage, property_id, community_id')
      .eq('id', violationId)
      .maybeSingle();
    if (vErr || !v) return res.status(404).json({ error: 'violation not found' });
    if (v.current_stage === 'cured' || v.current_stage === 'closed' || v.current_stage === 'voided') {
      return res.status(400).json({ error: `violation already in terminal stage '${v.current_stage}'` });
    }

    const targetStage = (resolvedVia === 'manual_board_dismissed' || resolvedVia === 'manual_other')
      ? 'closed'
      : 'cured';

    const { error: uErr } = await supabase
      .from('violations')
      .update({
        current_stage: targetStage,
        resolved_via: resolvedVia,
        resolved_at: new Date().toISOString(),
        resolved_notes: resolvedNotes,
      })
      .eq('id', violationId);
    if (uErr) return res.status(500).json({ error: uErr.message });

    res.json({ ok: true, violation_id: violationId, new_stage: targetStage, resolved_via: resolvedVia });
  } catch (err) {
    console.error('[enforcement.resolve]', err);
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
        .select('slug, label, description')
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
          categorySlug:        catRow && catRow.slug,
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
// GET /api/enforcement/cure-pipeline?community_id=&horizon_days=30
// Returns ACTIVE violations grouped by days-remaining bucket so the
// operator can see what's coming due before it lapses. Complements the
// /cure-lapse/pending endpoint (which only shows already-expired).
//
// Buckets:
//   overdue       — cure_period_ends_at < now
//   due_this_week — 0-7 days remaining
//   coming_soon   — 8-14 days remaining
//   on_track      — 15+ days remaining (within horizon)
//
// Response: { counts: {bucket: n}, violations: [{...,days_remaining,bucket}] }
// ---------------------------------------------------------------------------
router.get('/cure-pipeline', async (req, res) => {
  try {
    const communityId = req.query.community_id || null;
    const horizonDays = Math.min(180, Math.max(1, Number(req.query.horizon_days) || 30));
    const limit = Math.min(2000, Number(req.query.limit) || 500);
    const horizonIso = new Date(Date.now() + horizonDays * 24 * 60 * 60 * 1000).toISOString();

    let q = supabase
      .from('violations')
      .select('id, property_id, community_id, primary_category_id, current_stage, cure_period_ends_at, opened_at, board_priority_at_open, enforcement_categories(label)')
      .in('current_stage', ['courtesy_1', 'courtesy_2', 'certified_209'])
      .not('cure_period_ends_at', 'is', null)
      .lte('cure_period_ends_at', horizonIso)
      .is('resolved_at', null)
      .in('quality_status', ['verified', 'unreviewed'])
      .order('cure_period_ends_at', { ascending: true })
      .limit(limit);
    if (communityId) q = q.eq('community_id', communityId);
    const { data: violations, error } = await q;
    if (error) throw error;
    const rows = violations || [];

    // Enrich with property + community
    const propIds = [...new Set(rows.map(v => v.property_id).filter(Boolean))];
    const commIds = [...new Set(rows.map(v => v.community_id).filter(Boolean))];
    const propMap = new Map();
    const commMap = new Map();
    if (propIds.length) {
      const { data: props } = await supabase
        .from('v_current_property_owners')
        .select('property_id, street_address, unit, owner_name')
        .in('property_id', propIds);
      (props || []).forEach(p => propMap.set(p.property_id, p));
    }
    if (commIds.length) {
      const { data: comms } = await supabase
        .from('communities')
        .select('id, name')
        .in('id', commIds);
      (comms || []).forEach(c => commMap.set(c.id, c));
    }

    // Fetch the relevant letter interaction for each violation so we know
    // whether the cure clock is actually RUNNING (letter mailed) or just
    // a placeholder (violation opened, letter still in Drafts/Mail Queue).
    // The cure_period_ends_at field gets populated at violation creation
    // (from opened_at + cure_days) but the legal cure clock only starts at
    // POSTMARK. Surface the distinction in the UI so the operator doesn't
    // think a violation is on track when the letter hasn't even gone out.
    const violationIds = rows.map(v => v.id).filter(Boolean);
    const letterStatusByVio = new Map();
    if (violationIds.length > 0) {
      const { data: inters } = await supabase
        .from('interactions')
        .select('violation_id, type, status, printed_at, sent_at, postmark_date, created_at')
        .in('violation_id', violationIds)
        .in('type', ['letter_courtesy_1', 'letter_courtesy_2', 'letter_209', 'letter_fine'])
        .order('created_at', { ascending: false });
      // Keep the MOST RECENT letter per violation (first in the desc-ordered list)
      for (const i of (inters || [])) {
        if (!letterStatusByVio.has(i.violation_id)) {
          letterStatusByVio.set(i.violation_id, i);
        }
      }
    }

    const _classifyLetterStatus = (inter) => {
      if (!inter) return 'no_letter';            // violation has no letter draft at all yet
      if (inter.status === 'rejected') return 'rejected';
      if (inter.printed_at) return 'mailed';      // batch was locked + printed → mailed (or Lob accepted)
      if (inter.status === 'approved') return 'in_mail_queue';  // approved, waiting for batch
      if (inter.status === 'draft' || inter.status === 'pending') return 'in_drafts';
      return 'unknown';
    };

    const now = Date.now();
    const counts = { overdue: 0, due_this_week: 0, coming_soon: 0, on_track: 0 };
    const mailCounts = { mailed: 0, in_mail_queue: 0, in_drafts: 0, no_letter: 0, other: 0 };
    const enriched = rows.map(v => {
      const ms = new Date(v.cure_period_ends_at).getTime() - now;
      const days_remaining = Math.ceil(ms / (24 * 60 * 60 * 1000));
      let bucket;
      if (days_remaining < 0) bucket = 'overdue';
      else if (days_remaining <= 7) bucket = 'due_this_week';
      else if (days_remaining <= 14) bucket = 'coming_soon';
      else bucket = 'on_track';
      counts[bucket] = (counts[bucket] || 0) + 1;
      const letterInter = letterStatusByVio.get(v.id);
      const letter_status = _classifyLetterStatus(letterInter);
      if (mailCounts[letter_status] != null) mailCounts[letter_status] += 1;
      else mailCounts.other += 1;
      return {
        ...v,
        days_remaining,
        bucket,
        property: propMap.get(v.property_id) || null,
        community: commMap.get(v.community_id) || null,
        category_label: v.enforcement_categories ? v.enforcement_categories.label : null,
        letter_status,
        letter_printed_at: letterInter ? letterInter.printed_at : null,
        letter_postmark_date: letterInter ? letterInter.postmark_date : null,
      };
    });

    res.json({ counts, mail_counts: mailCounts, total: enriched.length, horizon_days: horizonDays, violations: enriched });
  } catch (err) {
    console.error('[cure-pipeline]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

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
//   confidence_weight=1.0, quality_status='unreviewed'. Cured rows get
//   resolved_at + resolved_via set. Skips rows already imported (dedup on
//   (property_id, primary_category_id, opened_at)).
//   (Weight=1.0 since Ed 2026-06-13 — Bedrock did its own Vantaca-era
//   inspections, so the data is full-trust same as trustEd-native.)
// ===========================================================================
// Persisted job store backed by Postgres (table vantaca_preview_jobs,
// migration 125). Previously this was an in-memory Map which got wiped on
// every Render deploy / process restart / OOM, killing in-flight imports
// mid-extraction. With persistence, deploys are no longer destructive —
// the job runner picks up where the request left off (well, the chunk
// processing is already async/awaited so the next poll just sees the
// finished result row).
//
// Note: the actual extraction work happens INSIDE the Node process, so a
// hard restart still kills the model calls in flight. But after restart,
// the polling client sees the persisted job state (most recent progress
// + any partial result) and can decide whether to retry. Most deploys
// finish within seconds, so the window for catastrophic loss is small.
//
// Old jobs (>24h) are pruned at job creation time below.
async function _vvJobCreate(jobId, communityId) {
  await supabase.from('vantaca_preview_jobs').insert({
    id: jobId,
    community_id: communityId,
    status: 'running',
    progress: 'queued',
  });
  // Opportunistic cleanup of stale jobs
  try {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await supabase.from('vantaca_preview_jobs').delete().lt('created_at', dayAgo);
  } catch (_) { /* non-fatal */ }
}

async function _vvJobGet(jobId) {
  const { data } = await supabase
    .from('vantaca_preview_jobs')
    .select('*')
    .eq('id', jobId)
    .maybeSingle();
  return data;
}

async function _vvJobUpdate(jobId, patch) {
  try {
    await supabase
      .from('vantaca_preview_jobs')
      .update(patch)
      .eq('id', jobId);
  } catch (e) {
    console.warn(`[vvJobUpdate ${jobId}]`, e.message);
  }
}

async function _vvJobSetError(jobId, errMsg) {
  await _vvJobUpdate(jobId, { status: 'error', error: errMsg, progress: null });
}

// Heavy processing — runs in the background after /preview returns the job_id.
// Updates the persisted vantaca_preview_jobs row as it progresses so the
// polling endpoint can report status. Catches its own errors → never crashes
// the process if a chunk throws.
async function _runPreviewJob(jobId, fileBuffer, filename, mimetype, communityId) {
  try {
    const isPdf = (mimetype === 'application/pdf') || (filename || '').toLowerCase().endsWith('.pdf');

    let rows, mapping, headers, errors, rawExtracted = null;
    if (isPdf) {
      await _vvJobUpdate(jobId, { progress: 'extracting from PDF — this can take 30-120 seconds depending on size' });
      const result = await parseVantacaViolationsPdf(fileBuffer, filename);
      rows = result.rows; mapping = result.mapping; headers = result.headers;
      errors = result.errors; rawExtracted = result.raw_extracted;
    } else {
      await _vvJobUpdate(jobId, { progress: 'parsing CSV/Excel' });
      const result = parseVantacaViolations(fileBuffer, filename);
      rows = result.rows; mapping = result.mapping; headers = result.headers; errors = result.errors;
    }

    if ((!rows || rows.length === 0) && errors && errors.length > 0) {
      await _vvJobSetError(jobId, errors.join(' '));
      return;
    }

    // Cache the raw extracted rows on the job so the re-resolve endpoint
    // can re-run resolution against updated enforcement_categories without
    // re-extracting the PDF.
    await _vvJobUpdate(jobId, {
      cached_rows: rows,
      progress: `matching ${rows.length} rows to properties + categories`,
    });

    // ---- existing resolution logic (property + category match + dedup) ----
    // Use paginated fetch — PostgREST 1000-row cap would silently drop
    // properties past row 1000 (Waterview = 1171; CLAUDE.md scar).
    const props = await _fetchAllPropertiesForCommunity(communityId);
    const byAcct = new Map();
    const byStreet = new Map();
    props.forEach((p) => {
      if (p.vantaca_account_id) byAcct.set(String(p.vantaca_account_id), p);
      if (p.street_address) byStreet.set(p.street_address.toLowerCase().trim(), p);
    });

    const { data: cats } = await supabase
      .from('enforcement_categories')
      .select('id, slug, label');
    const catBySlug = new Map();
    const catByLabel = new Map();
    (cats || []).forEach((c) => {
      catBySlug.set(c.slug.toLowerCase(), c);
      catByLabel.set(c.label.toLowerCase(), c);
    });
    const resolveCategory = (rawLabel) => {
      if (!rawLabel) return null;
      const s = String(rawLabel).toLowerCase().trim();
      if (catByLabel.has(s)) return catByLabel.get(s);
      for (const [label, c] of catByLabel) {
        if (label.includes(s) || s.includes(label)) return c;
      }
      for (const [slug, c] of catBySlug) {
        if (slug.replace(/_/g, ' ').includes(s) || s.includes(slug.replace(/_/g, ' '))) return c;
      }
      return null;
    };

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
    let unresolved_category = [];
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

    // ---- AI auto-mapping for unmatched categories ----
    // Vantaca's category labels are usually MORE specific than trustEd's
    // canonical enforcement_categories (e.g., 'Mildew - Landscape brick' vs
    // 'landscape_maintenance'). Substring fuzzy-match can't bridge that gap
    // reliably, so we send the unique unmatched labels + the canonical list
    // to Haiku and ask for a best-fit JSON mapping. Cheap (~$0.001) and
    // typically resolves 90%+ of the remaining unmatched rows.
    let aiMappingApplied = null;
    if (unresolved_category.length > 0 && process.env.ANTHROPIC_API_KEY) {
      try {
        await _vvJobUpdate(jobId, { progress: `AI-mapping ${unresolved_category.length} unmatched category labels` });
        const uniqueLabels = [...new Set(unresolved_category.map((r) => r.category_label).filter(Boolean))];
        const canonicalList = (cats || []).map((c) => `${c.slug} — "${c.label}"`).join('\n');

        const Anthropic = require('@anthropic-ai/sdk');
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

        const prompt = `You are mapping Vantaca HOA violation category labels to trustEd's canonical enforcement category slugs.

Canonical trustEd categories (slug — "label"):
${canonicalList}

Unmatched Vantaca labels to map:
${uniqueLabels.map((l, i) => `${i + 1}. "${l}"`).join('\n')}

Return ONLY a JSON object — no preamble, no markdown:
{
  "mapping": {
    "<exact Vantaca label>": "<canonical slug from the list above>",
    ...
  }
}

RULES:
- Use ONLY the slugs from the canonical list above. Never invent a new slug.
- If a Vantaca label truly has no good canonical fit, OMIT it from the mapping (don't force a bad match).
- Be permissive but accurate — 'Mow and Edge' fits 'lawn_maintenance' even though it doesn't say 'lawn'.
- Vantaca labels often have suffixes/prefixes like 'Brick' or 'Landscape' that hint at the broader category.

Return ONLY the JSON object.`;

        const stream = anthropic.messages.stream({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 4000,
          messages: [{ role: 'user', content: prompt }],
        });
        const completion = await stream.finalMessage();
        const text = (completion.content?.[0]?.text || '').trim();
        const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        let aiParsed;
        try {
          const m = cleaned.match(/\{[\s\S]*\}/);
          aiParsed = JSON.parse(m ? m[0] : cleaned);
        } catch (parseErr) {
          console.warn(`[vantaca-violations.preview job ${jobId}] AI category mapping JSON parse failed:`, parseErr.message);
          aiParsed = { mapping: {} };
        }
        const aiMapping = aiParsed.mapping || {};

        // Re-classify unresolved_category using the AI mapping
        const stillUnresolved = [];
        let aiResolvedCount = 0;
        for (const row of unresolved_category) {
          const slug = aiMapping[row.category_label];
          if (!slug) { stillUnresolved.push(row); continue; }
          const cat = catBySlug.get(slug.toLowerCase());
          if (!cat) { stillUnresolved.push(row); continue; }
          const dedupKey = `${row.property_id}::${cat.id}::${row.opened_at}`;
          if (existingKeys.has(dedupKey)) {
            duplicates.push({ ...row, category_id: cat.id, ai_mapped_from: row.category_label });
            continue;
          }
          resolved.push({
            ...row,
            category_id: cat.id,
            category_resolved_label: cat.label,
            category_ai_mapped: true,
            ai_mapped_from: row.category_label,
          });
          aiResolvedCount++;
        }
        unresolved_category = stillUnresolved;
        aiMappingApplied = {
          unique_label_count: uniqueLabels.length,
          mapping: aiMapping,
          resolved_count: aiResolvedCount,
        };
        console.log(`[vantaca-violations.preview job ${jobId}] AI mapped ${aiResolvedCount} rows from ${uniqueLabels.length} unique labels`);
      } catch (aiErr) {
        console.warn(`[vantaca-violations.preview job ${jobId}] AI category mapping failed (non-fatal):`, aiErr.message);
      }
    }

    const finalResult = {
      total_rows: rows.length,
      mapping,
      headers,
      sample_rows: rows.slice(0, 5),
      resolved_count: resolved.length,
      unresolved_property_count: unresolved_property.length,
      unresolved_category_count: unresolved_category.length,
      duplicate_count: duplicates.length,
      resolved,
      unresolved_property: unresolved_property.slice(0, 50),
      unresolved_category: unresolved_category.slice(0, 50),
      duplicates: duplicates.slice(0, 20),
      ai_category_mapping: aiMappingApplied,
      raw_extracted: rawExtracted,
    };
    await _vvJobUpdate(jobId, {
      status: 'complete',
      result: finalResult,
      progress: `done — ${resolved.length} matched${aiMappingApplied ? ` (${aiMappingApplied.resolved_count} via AI mapping)` : ''} · ${unresolved_property.length} unmatched property · ${unresolved_category.length} unmatched category · ${duplicates.length} duplicates`,
    });
  } catch (err) {
    console.error(`[vantaca-violations.preview job ${jobId}]`, err);
    await _vvJobSetError(jobId, err.message || 'unknown error');
  }
}

// ---------------------------------------------------------------------------
// POST /api/enforcement/categories/bulk-add
// ---------------------------------------------------------------------------
// Bulk-create enforcement_categories from a list of free-text labels (the
// typical case: unresolved Vantaca category labels during import). Auto-
// generates a snake_case slug per label, skips inserts where the slug
// already exists.
//
// Body: { labels: [string], default_priority_weight?: 'standard' }
// ---------------------------------------------------------------------------
function _slugifyLabel(label) {
  return String(label).toLowerCase()
    .replace(/[^a-z0-9\s_\-]/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60) || 'unnamed_category';
}

router.post('/categories/bulk-add', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const labels = Array.isArray(req.body && req.body.labels) ? req.body.labels : [];
    if (labels.length === 0) return res.status(400).json({ error: 'labels array required' });
    const defaultPriority = (req.body && req.body.default_priority_weight) || 'standard';

    // Dedup the input labels + their slugs
    const uniqueLabels = [...new Set(labels.map((l) => String(l).trim()).filter(Boolean))];
    const proposed = uniqueLabels.map((label) => ({ slug: _slugifyLabel(label), label }));

    // Check existing slugs to avoid conflicts
    const slugs = proposed.map((p) => p.slug);
    const { data: existing } = await supabase
      .from('enforcement_categories')
      .select('slug')
      .in('slug', slugs);
    const existingSet = new Set((existing || []).map((r) => r.slug));

    // Dedup the proposed list by slug — two different input labels can
    // slugify to the same string after lowercasing/normalizing (e.g.
    // "Mulch Bags" vs "Mulch bags"). Keep first occurrence of each slug.
    const seenSlugs = new Set();
    const toInsert = [];
    for (const p of proposed) {
      if (existingSet.has(p.slug)) continue;
      if (seenSlugs.has(p.slug)) continue;
      seenSlugs.add(p.slug);
      toInsert.push({
        slug: p.slug,
        label: p.label,
        description: `Auto-added from Vantaca violation import on ${new Date().toISOString().slice(0, 10)}`,
        default_priority_weight: defaultPriority,
        display_order: 999,
      });
    }

    let inserted = [];
    if (toInsert.length > 0) {
      // Use upsert with onConflict ignore as belt-and-suspenders in case
      // of any race or edge case the dedup didn't catch. Returns just the
      // newly-inserted rows.
      const { data, error } = await supabase
        .from('enforcement_categories')
        .upsert(toInsert, { onConflict: 'slug', ignoreDuplicates: true })
        .select('id, slug, label');
      if (error) throw error;
      inserted = data || [];
    }

    res.json({
      proposed_count: uniqueLabels.length,
      inserted_count: inserted.length,
      skipped_existing_count: uniqueLabels.length - inserted.length,
      inserted,
      skipped_existing: proposed.filter((p) => existingSet.has(p.slug)),
    });
  } catch (err) {
    console.error('[categories.bulk-add]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/enforcement/vantaca-violations/preview/:jobId/re-resolve
// ---------------------------------------------------------------------------
// Re-runs property + category resolution against the cached rows in an
// existing preview job. Used after bulk-adding categories so we don't have
// to re-upload + re-extract the PDF.
// ---------------------------------------------------------------------------
router.post('/vantaca-violations/preview/:jobId/re-resolve', async (req, res) => {
  try {
    const jobId = req.params.jobId;
    const job = await _vvJobGet(jobId);
    if (!job) return res.status(404).json({ error: 'job_not_found_or_expired' });
    const cachedRows = job.cached_rows;
    if (!cachedRows || !Array.isArray(cachedRows)) {
      return res.status(409).json({ error: 'job has no cached rows; re-upload the PDF instead' });
    }
    const communityId = job.community_id;
    if (!communityId) {
      return res.status(409).json({ error: 'job is missing community_id; re-upload the PDF instead' });
    }

    await _vvJobUpdate(jobId, { status: 'running', progress: 're-resolving against updated categories' });

    // Re-pull properties + categories (categories may have been bulk-added
    // since the original run — that's the whole point of re-resolve).
    // Properties via paginated helper — 1000-row cap would drop 1171-property
    // communities like Waterview.
    const [props, { data: cats }, { data: existingV }] = await Promise.all([
      _fetchAllPropertiesForCommunity(communityId),
      supabase.from('enforcement_categories').select('id, slug, label'),
      supabase.from('violations').select('property_id, primary_category_id, opened_at').eq('community_id', communityId).eq('source', 'vantaca_import'),
    ]);

    const byAcct = new Map();
    const byStreet = new Map();
    props.forEach((p) => {
      if (p.vantaca_account_id) byAcct.set(String(p.vantaca_account_id), p);
      if (p.street_address) byStreet.set(p.street_address.toLowerCase().trim(), p);
    });
    const catBySlug = new Map();
    const catByLabel = new Map();
    (cats || []).forEach((c) => {
      catBySlug.set(c.slug.toLowerCase(), c);
      catByLabel.set(c.label.toLowerCase(), c);
    });
    const resolveCategory = (rawLabel) => {
      if (!rawLabel) return null;
      const s = String(rawLabel).toLowerCase().trim();
      if (catByLabel.has(s)) return catByLabel.get(s);
      for (const [label, c] of catByLabel) {
        if (label.includes(s) || s.includes(label)) return c;
      }
      for (const [slug, c] of catBySlug) {
        if (slug.replace(/_/g, ' ').includes(s) || s.includes(slug.replace(/_/g, ' '))) return c;
      }
      return null;
    };
    const existingKeys = new Set((existingV || []).map((v) =>
      `${v.property_id}::${v.primary_category_id}::${(v.opened_at || '').slice(0, 10)}`));

    const resolved = [];
    const unresolved_property = [];
    const unresolved_category = [];
    const duplicates = [];

    for (const row of cachedRows) {
      let prop = null;
      if (row.vantaca_account_id) prop = byAcct.get(String(row.vantaca_account_id));
      if (!prop && row.street_address) prop = byStreet.get(row.street_address.toLowerCase().trim());
      if (!prop) { unresolved_property.push(row); continue; }
      const cat = resolveCategory(row.category_label);
      if (!cat) { unresolved_category.push({ ...row, property_id: prop.id }); continue; }
      const dedupKey = `${prop.id}::${cat.id}::${row.opened_at}`;
      if (existingKeys.has(dedupKey)) {
        duplicates.push({ ...row, property_id: prop.id, category_id: cat.id });
        continue;
      }
      resolved.push({
        ...row, property_id: prop.id, property_street: prop.street_address,
        category_id: cat.id, category_resolved_label: cat.label,
      });
    }

    const priorResult = job.result || {};
    const finalResult = {
      total_rows: cachedRows.length,
      mapping: priorResult.mapping || null,
      headers: priorResult.headers || [],
      sample_rows: cachedRows.slice(0, 5),
      resolved_count: resolved.length,
      unresolved_property_count: unresolved_property.length,
      unresolved_category_count: unresolved_category.length,
      duplicate_count: duplicates.length,
      resolved,
      unresolved_property: unresolved_property.slice(0, 50),
      unresolved_category: unresolved_category.slice(0, 50),
      duplicates: duplicates.slice(0, 20),
      re_resolved: true,
    };
    await _vvJobUpdate(jobId, {
      status: 'complete',
      result: finalResult,
      progress: `re-resolved — ${resolved.length} matched · ${unresolved_property.length} unmatched property · ${unresolved_category.length} unmatched category · ${duplicates.length} duplicates`,
    });
    res.json(finalResult);
  } catch (err) {
    console.error('[vantaca-violations.re-resolve]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/enforcement/vantaca-violations/preview-status/:jobId
// Polled by the frontend after a PDF upload kicks off async processing.
// ---------------------------------------------------------------------------
router.get('/vantaca-violations/preview-status/:jobId', async (req, res) => {
  try {
    const job = await _vvJobGet(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'job_not_found_or_expired' });
    // Don't return the cached_rows JSONB (can be large; not needed by polling
    // UI). The /re-resolve endpoint reads them directly from DB.
    const { cached_rows, ...safe } = job;
    res.json(safe);
  } catch (err) {
    console.error('[vantaca-violations.preview-status]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/vantaca-violations/preview', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file required' });
    const communityId = req.body.community_id;
    if (!communityId) return res.status(400).json({ error: 'community_id required' });

    const isPdf = (req.file.mimetype === 'application/pdf') ||
                  (req.file.originalname || '').toLowerCase().endsWith('.pdf');

    // PDFs go async — Claude PDF extraction on a multi-page report can exceed
    // Render's 100s HTTP timeout. Return a job_id and process in the
    // background; frontend polls preview-status to get the result. Job state
    // is persisted in vantaca_preview_jobs (migration 125) so it survives
    // deploys + Node process restarts.
    if (isPdf) {
      const jobId = require('crypto').randomBytes(8).toString('hex');
      await _vvJobCreate(jobId, communityId);
      // Fire and forget — _runPreviewJob updates the job row as it goes
      _runPreviewJob(jobId, req.file.buffer, req.file.originalname, req.file.mimetype, communityId)
        .catch(async (err) => {
          await _vvJobSetError(jobId, err.message);
        });
      return res.json({
        job_id: jobId,
        status: 'running',
        message: 'PDF processing started. Poll preview-status for progress + result.',
      });
    }

    // CSV / Excel — fast enough to do synchronously.
    // Optional manual_mapping form field: JSON-encoded { field: column_index }
    // override from the self-diagnose UI when auto-detect failed on the
    // last attempt. Lets staff resolve "couldn't detect columns" without
    // escalation. See memory project_ed_not_in_loop_test.
    let manualMapping = null;
    if (req.body.manual_mapping) {
      try {
        const parsed = JSON.parse(req.body.manual_mapping);
        if (parsed && typeof parsed === 'object') manualMapping = parsed;
      } catch (_) { /* bad JSON — ignore, fall back to auto-detect */ }
    }
    const result = parseVantacaViolations(req.file.buffer, req.file.originalname, { manualMapping });
    const rows = result.rows;
    const mapping = result.mapping;
    const headers = result.headers;
    const errors = result.errors;

    if ((!rows || rows.length === 0) && errors && errors.length > 0) {
      // Ed 2026-06-10: self-diagnosing import.
      // On failure, return rich diagnostic data so the staff member can SEE
      // what the system saw (headers + first few data rows) and tell us
      // which column is which without escalating to Ed. The frontend
      // renders this as an actionable panel, not just an error string.
      // See memory project_ed_not_in_loop_test.
      let sampleRows = [];
      try {
        const xlsx = require('xlsx');
        const wb = xlsx.read(req.file.buffer, { type: 'buffer', cellDates: true });
        if (wb.SheetNames.length) {
          const sheet = wb.Sheets[wb.SheetNames[0]];
          const aoa = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: null, blankrows: false });
          sampleRows = aoa.slice(1, 4).map((r) => r.map((c) => c == null ? '' : String(c)));
        }
      } catch (_) { /* sample rows are a nice-to-have; failure here non-fatal */ }
      return res.status(400).json({
        error: errors.join(' '),
        diagnostic: {
          headers,
          sample_rows: sampleRows,
          auto_detected_mapping: mapping || {},
          required_fields: ['street_address', 'vantaca_account_id', 'category_label', 'opened_at'],
          help: 'Pick which column matches each required field. The system will retry with your overrides.',
        },
      });
    }

    // Fetch properties + categories. Properties via paginated helper to
    // dodge the PostgREST 1000-row silent cap (Waterview = 1171; CLAUDE.md scar).
    const props = await _fetchAllPropertiesForCommunity(communityId);
    const byAcct = new Map();
    const byStreet = new Map();
    props.forEach((p) => {
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
    let catSlugs = new Map();
    if (catIds.length > 0) {
      const { data: cats } = await supabase
        .from('enforcement_categories')
        .select('id, label, slug')
        .in('id', catIds);
      catLabels = new Map((cats || []).map((c) => [c.id, c.label]));
      catSlugs = new Map((cats || []).map((c) => [c.id, c.slug]));
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
        category_slug: catSlugs.get(v.primary_category_id) || null,
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
// POST /api/enforcement/violations/:violationId/draft-force-mow-letter
// ---------------------------------------------------------------------------
// Generates the 10-day certified force-mow notice PDF for a specific
// violation. Pulls property + owner + community config + violation history;
// validates against the schema; renders via lib/lawn_force_mow_renderer.js.
//
// Hearing-rights paragraph is auto-included only when no prior same-category
// notice has been sent in the past 6 months (per TX §209).
//
// Returns the PDF directly (application/pdf). Operator downloads, prints,
// applies certified mail label, sends.
// ===========================================================================
// (renderForceMowLetterPdf is imported at the top of the file alongside the
// other renderers — was duplicated here in an earlier session, dedup'd
// 2026-05-29 to fix a SyntaxError "Identifier already declared" crash.)

router.post('/violations/:violationId/draft-force-mow-letter', async (req, res) => {
  try {
    const violationId = req.params.violationId;
    if (!violationId) return res.status(400).json({ error: 'violation_id_required' });

    // Pull violation + property + community + owner
    const { data: violation, error: vErr } = await supabase
      .from('violations')
      .select(`
        id, property_id, community_id, primary_category_id, opened_at,
        summary, current_stage
      `)
      .eq('id', violationId)
      .maybeSingle();
    if (vErr) throw vErr;
    if (!violation) return res.status(404).json({ error: 'violation_not_found' });

    const [propRes, commRes, ownerRes] = await Promise.all([
      supabase
        .from('properties')
        .select('id, street_address, unit, city, state, zip')
        .eq('id', violation.property_id)
        .maybeSingle(),
      supabase
        .from('communities')
        .select('id, name, legal_name, declaration_doc_number, declaration_county, declaration_short_name, force_mow_section_full, force_mow_admin_fee_cents')
        .eq('id', violation.community_id)
        .maybeSingle(),
      // Current owner via the spine view
      supabase
        .from('v_current_property_owners')
        .select('owner_name, owner_mailing_address')
        .eq('property_id', violation.property_id)
        .maybeSingle(),
    ]);
    const property = propRes.data;
    const community = commRes.data;
    const owner = ownerRes.data;

    if (!property) return res.status(404).json({ error: 'property_not_found' });
    if (!community) return res.status(404).json({ error: 'community_not_found' });

    // Community config — must be set per migration 126
    if (!community.force_mow_section_full || !community.declaration_doc_number || !community.declaration_county) {
      return res.status(409).json({
        error: 'community_force_mow_config_missing',
        message: `Community "${community.name}" needs force-mow config set: declaration_doc_number, declaration_county, force_mow_section_full. Update the communities row via the Community Profile admin or directly via SQL.`,
      });
    }

    // Hearing-rights conditional — include only when no prior notice
    // for the same category in the past 6 months
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const { data: priorNotices } = await supabase
      .from('violation_letters')
      .select('id, sent_at')
      .eq('violation_id', violationId)
      .gte('sent_at', sixMonthsAgo.toISOString().slice(0, 10));
    const includeHearingRights = !priorNotices || priorNotices.length === 0;

    // Build the validated input
    const propertyAddressFull = [
      `${property.street_address}${property.unit ? ' #' + property.unit : ''}`,
      [property.city, property.state, property.zip].filter(Boolean).join(', '),
    ].filter(Boolean).join(', ');
    const propertyAddressShort = `${property.street_address}${property.unit ? ' #' + property.unit : ''}`;

    // Homeowner names block — name + mailing address (mailing OR property)
    const mailingAddress = owner && owner.owner_mailing_address ? owner.owner_mailing_address : propertyAddressFull;
    const homeownerNamesBlock = [
      (owner && owner.owner_name) || '[Owner Name]',
      mailingAddress,
    ].join('\n');

    // Alt mailing only when mailing differs from property
    let altMailingBlock = null;
    if (owner && owner.owner_mailing_address &&
        owner.owner_mailing_address.toLowerCase().replace(/\s+/g, ' ').trim() !==
        propertyAddressFull.toLowerCase().replace(/\s+/g, ' ').trim()) {
      altMailingBlock = owner.owner_mailing_address;
    }

    const adminFeeCents = community.force_mow_admin_fee_cents || 2500;
    const adminFeeAmount = `$${(adminFeeCents / 100).toFixed(2)}`;

    const renderData = {
      community_legal_name: community.legal_name || community.name,
      community_short_name: community.declaration_short_name || community.name,
      letter_date: new Date().toISOString().slice(0, 10),
      certified_mail_number: (req.body && req.body.certified_mail_number) || null,
      homeowner_names_block: homeownerNamesBlock,
      property_address_full: propertyAddressFull,
      property_address_short: propertyAddressShort,
      alt_mailing_address_block: altMailingBlock,
      declaration_doc_number: community.declaration_doc_number,
      declaration_county: community.declaration_county,
      declaration_section_full: community.force_mow_section_full,
      observation_date: (violation.opened_at || '').slice(0, 10),
      observed_condition: (req.body && req.body.observed_condition) || violation.summary || 'Lawn requires mowing, edging, and weed control.',
      admin_fee_amount: adminFeeAmount,
      include_hearing_rights: includeHearingRights,
    };

    // Render
    let pdfBuffer;
    try {
      pdfBuffer = await renderForceMowLetterPdf(renderData);
    } catch (err) {
      if (err.code === 'SCHEMA_VALIDATION_FAILED') {
        return res.status(400).json({
          error: 'schema_validation_failed',
          details: err.details,
          render_data: renderData,
        });
      }
      throw err;
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="force-mow-letter-${propertyAddressShort.replace(/[^a-zA-Z0-9]+/g, '-')}-${renderData.letter_date}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('[draft-force-mow-letter]', err);
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

    // Batch the inserts — one round trip to Supabase per chunk of 100 rows
    // instead of one per row. Drops apply time from ~60s for 92 rows to
    // ~2-3 seconds. Critical when importing communities like Waterview
    // that have hundreds of historical violations.
    let inserted = 0;
    let skipped = 0;
    const errors = [];

    // Track the original source row alongside the insert payload so error
    // messages can surface street_address + category_label, not just the
    // abstract property_id UUID. Ed 2026-06-10: staff sees the human
    // address in error messages, not "Property xyz-abc-123 failed."
    const valid = [];
    const originals = [];
    for (const r of rows) {
      if (!r.property_id || !r.category_id || !r.opened_at) {
        skipped += 1;
        // Capture skipped-row context so the UI can explain WHY each was
        // skipped (no property match, missing category, missing date).
        errors.push({
          source_row: r._source_row,
          street_address: r.street_address || r.address || null,
          category_label: r.category_label || null,
          vantaca_account_id: r.vantaca_account_id || null,
          opened_at: r.opened_at || null,
          error: !r.property_id
            ? 'Property not found in trustEd — address may not be in the roster.'
            : (!r.category_id
              ? 'Category not yet in trustEd — re-resolve to map it first.'
              : 'Missing violation date.'),
          suggested_action: !r.property_id
            ? 'add_property'
            : (!r.category_id ? 'add_category' : 'review_source'),
        });
        continue;
      }
      valid.push({
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
        // Weight comes from lib/enforcement/source_weights.js — single
        // source of truth so this default can never silently drift again.
        // See helper file for the per-source rationale.
        confidence_weight: defaultWeightForSource('vantaca_import'),
        quality_status: 'unreviewed',
        review_notes: 'Imported from Vantaca violations export.',
      });
      originals.push(r);
    }

    const BATCH_SIZE = 100;
    for (let i = 0; i < valid.length; i += BATCH_SIZE) {
      const batch = valid.slice(i, i + BATCH_SIZE);
      const batchOrigs = originals.slice(i, i + BATCH_SIZE);
      const { data, error } = await supabase
        .from('violations')
        .insert(batch)
        .select('id');
      if (error) {
        // On batch failure, fall back to row-by-row to identify which row(s)
        // are bad (constraint violation, etc.) without losing the rest.
        console.warn('[vantaca-violations.apply] batch insert failed, falling back to per-row:', error.message);
        for (let j = 0; j < batch.length; j++) {
          const single = batch[j];
          const origR = batchOrigs[j];
          const { error: singleErr } = await supabase.from('violations').insert(single);
          if (singleErr) {
            errors.push({
              source_row: origR._source_row,
              street_address: origR.street_address || null,
              category_label: origR.category_label || null,
              vantaca_account_id: origR.vantaca_account_id || null,
              opened_at: single.opened_at,
              error: singleErr.message,
              suggested_action: 'review_db_constraint',
            });
          } else {
            inserted += 1;
          }
        }
      } else {
        inserted += (data && data.length) || batch.length;
      }
    }

    res.json({ inserted, skipped: errors.length, errors });
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

// ---------------------------------------------------------------------------
// GET /api/enforcement/letter-copy?community_id=X&stage=Y
// ---------------------------------------------------------------------------
// Returns the editable copy blocks for a (community, stage) pair, plus the
// canonical defaults so the editor can show "you're overriding [default]
// with [your version]" side-by-side. If no community_id supplied, returns
// just the defaults so the UI can render an empty editor.
//
// Response shape:
//   {
//     community_id, stage,
//     defaults: { title, opening_paragraph, closing_paragraph },
//     overrides: { title?, opening_paragraph?, closing_paragraph? }
//   }
// ---------------------------------------------------------------------------
router.get('/letter-copy', async (req, res) => {
  try {
    const stage = String(req.query.stage || '');
    const community_id = req.query.community_id ? String(req.query.community_id) : null;
    const { VALID_STAGES, DEFAULTS, loadOverrides } = require('../lib/enforcement/letter_copy');
    if (!VALID_STAGES.includes(stage)) {
      return res.status(400).json({ error: `invalid stage; must be one of ${VALID_STAGES.join(', ')}` });
    }
    const defaults = { ...DEFAULTS[stage] };
    const overrides = community_id ? await loadOverrides(supabase, community_id, stage) : {};
    res.json({ community_id, stage, defaults, overrides });
  } catch (err) {
    console.error('[enforcement.letter-copy.get] failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/enforcement/letter-copy — upsert a single block override
// Body: { community_id, stage, block_key, body }
// ---------------------------------------------------------------------------
router.put('/letter-copy', express.json(), async (req, res) => {
  try {
    const { community_id, stage, block_key, body, user_name } = req.body || {};
    const { isValidStage, isValidBlock } = require('../lib/enforcement/letter_copy');
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    if (!isValidStage(stage)) return res.status(400).json({ error: 'invalid stage' });
    if (!isValidBlock(block_key)) return res.status(400).json({ error: 'invalid block_key' });
    if (typeof body !== 'string' || !body.trim()) return res.status(400).json({ error: 'body_required' });
    if (body.length > 4000) return res.status(400).json({ error: 'body_too_long (4000 char max)' });

    const { data, error } = await supabase.from('letter_copy_overrides')
      .upsert({
        community_id, stage, block_key, body: body.trim(),
        updated_at: new Date().toISOString(),
        updated_by_name: user_name || null,
      }, { onConflict: 'community_id,stage,block_key' })
      .select('*').single();
    if (error) throw error;
    res.json({ ok: true, override: data });
  } catch (err) {
    console.error('[enforcement.letter-copy.put] failed:', err);
    res.status(500).json({ error: safeErrorMessage(err), detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/enforcement/letter-copy — revert a block to default
// Body: { community_id, stage, block_key }
// ---------------------------------------------------------------------------
router.delete('/letter-copy', express.json(), async (req, res) => {
  try {
    const { community_id, stage, block_key } = req.body || {};
    const { isValidStage, isValidBlock } = require('../lib/enforcement/letter_copy');
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    if (!isValidStage(stage)) return res.status(400).json({ error: 'invalid stage' });
    if (!isValidBlock(block_key)) return res.status(400).json({ error: 'invalid block_key' });

    const { error } = await supabase.from('letter_copy_overrides')
      .delete()
      .eq('community_id', community_id)
      .eq('stage', stage)
      .eq('block_key', block_key);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[enforcement.letter-copy.delete] failed:', err);
    res.status(500).json({ error: safeErrorMessage(err), detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/enforcement/backfill-authority-citations
// One-click exercise: walks every community, semantic-searches its CC&Rs for
// the enforcement-authority article, stamps the result on
// communities.enforcement_authority_citation. Skips communities that already
// have a value unless ?overwrite=1 is passed.
//
// Returns a per-community report so the operator can see what got populated,
// what fell back to generic, and what needs manual entry.
//
// Latency: ~5-15 seconds per community (one embedding + one substrate query +
// one Claude extraction). Serial processing keeps it simple. Express default
// timeout is 2 min — at 7 communities × 15s = ~2 min, we may need to bump.
// ---------------------------------------------------------------------------
router.post('/backfill-authority-citations', express.json(), async (req, res) => {
  // Extend timeout to 10 minutes for batch processing
  if (req.setTimeout) req.setTimeout(600000);
  if (res.setTimeout) res.setTimeout(600000);

  try {
    const overwrite = String(req.query.overwrite || req.body?.overwrite || '') === '1';
    const onlyCommunityId = req.body?.community_id || null;

    let q = supabase.from('communities')
      .select('id, name, enforcement_authority_citation')
      .order('name', { ascending: true });
    if (onlyCommunityId) q = q.eq('id', onlyCommunityId);
    const { data: comms, error } = await q;
    if (error) throw error;

    const { lookupEnforcementAuthority } = require('../lib/enforcement/governing_doc_lookup');
    const results = [];

    for (const c of (comms || [])) {
      // Skip already-set unless explicitly overwriting
      if (c.enforcement_authority_citation && !overwrite) {
        results.push({
          community_id: c.id,
          community_name: c.name,
          status: 'already_set',
          citation: c.enforcement_authority_citation,
        });
        continue;
      }
      try {
        const lookup = await lookupEnforcementAuthority({ communityId: c.id });
        if (lookup && lookup.reference) {
          // Update community with the found citation
          const { error: updErr } = await supabase
            .from('communities')
            .update({ enforcement_authority_citation: lookup.reference })
            .eq('id', c.id);
          if (updErr) throw updErr;
          results.push({
            community_id: c.id,
            community_name: c.name,
            status: 'updated',
            citation: lookup.reference,
            confidence: lookup.confidence,
            document_title: lookup.document_title,
            quote: lookup.quote,
            previous_value: c.enforcement_authority_citation || null,
          });
        } else {
          results.push({
            community_id: c.id,
            community_name: c.name,
            status: 'not_found',
            note: 'No enforcement article found in substrate. Falls back to generic Authority Statement.',
          });
        }
      } catch (e) {
        results.push({
          community_id: c.id,
          community_name: c.name,
          status: 'error',
          error: e.message,
        });
      }
    }

    const counts = results.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    }, {});

    res.json({
      processed: results.length,
      counts,
      results,
    });
  } catch (err) {
    console.error('[enforcement.backfill-authority-citations]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/enforcement/vantaca-history-status
// Returns per-community count of vantaca_import-sourced violations so the
// operator can see at a glance which communities have historical priors
// loaded (needed for accurate Courtesy 2 / certified §209 escalation).
// ---------------------------------------------------------------------------
router.get('/vantaca-history-status', async (req, res) => {
  try {
    const { data: comms, error: cErr } = await supabase
      .from('communities')
      .select('id, name')
      .order('name', { ascending: true });
    if (cErr) throw cErr;
    const ids = (comms || []).map(c => c.id);
    if (ids.length === 0) return res.json({ communities: [] });

    // Count vantaca_import violations per community
    const { data: rows, error: vErr } = await supabase
      .from('violations')
      .select('community_id, opened_at, resolved_at')
      .eq('source', 'vantaca_import')
      .in('community_id', ids);
    if (vErr) throw vErr;

    const stats = new Map();
    for (const v of (rows || [])) {
      if (!stats.has(v.community_id)) {
        stats.set(v.community_id, { total: 0, last_opened_at: null, unresolved: 0 });
      }
      const s = stats.get(v.community_id);
      s.total += 1;
      if (!v.resolved_at) s.unresolved += 1;
      if (v.opened_at && (!s.last_opened_at || v.opened_at > s.last_opened_at)) {
        s.last_opened_at = v.opened_at;
      }
    }

    const out = (comms || []).map(c => {
      const s = stats.get(c.id) || { total: 0, last_opened_at: null, unresolved: 0 };
      return {
        community_id: c.id,
        community_name: c.name,
        imported_count: s.total,
        unresolved_count: s.unresolved,
        last_imported_opened_at: s.last_opened_at,
        has_history: s.total > 0,
      };
    });
    res.json({ communities: out });
  } catch (err) {
    console.error('[enforcement.vantaca-history-status]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/enforcement/sample-letter
// ---------------------------------------------------------------------------
// Renders a SAMPLE violation letter PDF using realistic mock data so an
// operator (Ed) can see what each of the 4 stage variants actually looks like
// without having to dig through real violations. Pulls live community letter
// config (sender name, cure days, fees, pay-to) so changes to the Community
// Profile letter settings show up immediately in the sample.
//
// Query params:
//   stage         — 'courtesy_1' | 'courtesy_2' | 'certified_209' | 'fine_assessed'
//   community_id  — optional; if omitted, uses the first community in the portfolio
//   multi         — '1' to render a bundle with 2 mock violations; default single
//
// Returns: application/pdf streamed inline (so browsers preview, not download)
// ---------------------------------------------------------------------------
router.get('/sample-letter', async (req, res) => {
  try {
    const stage = String(req.query.stage || 'courtesy_1');
    const validStages = ['courtesy_1', 'courtesy_2', 'certified_209', 'fine_assessed'];
    if (!validStages.includes(stage)) {
      return res.status(400).json({ error: `invalid stage; must be one of ${validStages.join(', ')}` });
    }
    const isMulti = String(req.query.multi || '') === '1';

    // Pull community letter config — use requested community_id, else first one
    let community;
    if (req.query.community_id) {
      const { data } = await supabase.from('communities')
        .select('id, name, legal_name, letter_sender_name, letter_sender_title, letter_fee_courtesy_1_cents, letter_fee_courtesy_2_cents, letter_fee_certified_209_cents, letter_fee_fine_assessed_cents, letter_cure_days_courtesy_1, letter_cure_days_courtesy_2, letter_cure_days_certified_209, letter_payment_url, letter_pay_to_name, letter_pay_to_address, enforcement_authority_citation')
        .eq('id', req.query.community_id).maybeSingle();
      community = data;
    }
    if (!community) {
      const { data } = await supabase.from('communities')
        .select('id, name, legal_name, letter_sender_name, letter_sender_title, letter_fee_courtesy_1_cents, letter_fee_courtesy_2_cents, letter_fee_certified_209_cents, letter_fee_fine_assessed_cents, letter_cure_days_courtesy_1, letter_cure_days_courtesy_2, letter_cure_days_certified_209, letter_payment_url, letter_pay_to_name, letter_pay_to_address, enforcement_authority_citation')
        .order('name', { ascending: true }).limit(1).maybeSingle();
      community = data;
    }
    if (!community) {
      return res.status(400).json({ error: 'no communities found — add one first' });
    }

    // Mock property + owner (clearly fake address so this is never confused
    // with a real notice)
    const sampleProperty = {
      street_address: '1234 Sample Lane',
      unit: null,
      city: 'Katy',
      state: 'TX',
      zip: '77450',
      lot_number: 'L-12, B-3',
    };
    const sampleOwner = {
      full_name: 'Sample Homeowner',
      mailing_address: '1234 Sample Lane, Katy, TX 77450',
    };

    // Mock violation(s) — realistic categories from Bedrock's existing taxonomy
    const baseViolation = {
      violation_id: '00000000-0000-0000-0000-a7f400000b20', // mock id → case ref V-A7F4-20
      category_label: 'Lawn / Landscaping Maintenance',
      ai_description: 'Front lawn shows extensive overgrowth with grass exceeding the community standard. Several brown patches indicate irrigation or weed-control gaps.',
      observation_captured_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      governing_doc: {
        reference: 'Article 7, Section 7.3',
        section_title: 'Maintenance of Lots',
        quote: 'Each Owner shall keep the Lot, including all landscaping and improvements thereon, in a clean and well-maintained condition...',
        page: 14,
      },
      prior_notices: stage === 'courtesy_2' || stage === 'certified_209' || stage === 'fine_assessed'
        ? [{ date: new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString(), stage: 'courtesy_1', delivery_method: 'first_class' }]
        : [],
      close_up_photo_buffer: null, // no photo in sample — render proceeds without
      fine_amount: stage === 'fine_assessed' ? 75 : null,
    };

    const secondMock = {
      violation_id: '00000000-0000-0000-0000-3c9000000d10', // mock id → case ref V-3C90-10
      category_label: 'Trash / Bulk Items',
      ai_description: 'Bulk trash items (mattress, broken furniture) staged at curb outside the designated pickup window.',
      observation_captured_at: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
      governing_doc: {
        reference: 'Article 8, Section 8.2',
        section_title: 'Trash and Refuse',
        quote: 'No trash, garbage, or other waste material shall be kept or stored upon any Lot except in sanitary containers...',
        page: 17,
      },
      prior_notices: [],
      close_up_photo_buffer: null,
      fine_amount: null,
    };

    const violationsArr = isMulti ? [baseViolation, secondMock] : [baseViolation];

    const { renderViolationLetterBundlePdf } = require('../lib/enforcement/violation_letter');
    const { loadOverrides } = require('../lib/enforcement/letter_copy');

    // Pull per-community copy overrides so the sample reflects exactly what
    // a real letter would render. Falls back silently to defaults if the
    // table doesn't exist yet (migration 178 not applied).
    const copyOverrides = await loadOverrides(supabase, community.id, stage);

    const pdfBuffer = await renderViolationLetterBundlePdf({
      property: sampleProperty,
      owner: sampleOwner,
      community,
      stage,
      letter_date: new Date(),
      wide_photo_buffer: null,
      violations: violationsArr,
      copy_overrides: copyOverrides,
      options: {
        sender_name:  community.letter_sender_name,
        sender_title: community.letter_sender_title,
        certified_tracking_number: stage === 'certified_209' || stage === 'fine_assessed'
          ? '9405 5118 9956 1234 5678 90'
          : null,
      },
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="sample-${stage}.pdf"`);
    res.setHeader('Cache-Control', 'no-store'); // always show latest config
    res.send(pdfBuffer);
  } catch (err) {
    console.error('[enforcement.sample-letter] failed:', err);
    res.status(500).json({ error: safeErrorMessage(err), detail: err.message });
  }
});

// ===========================================================================
// CERTIFIED MAIL — Lob.com integration
// ---------------------------------------------------------------------------
// Bedrock never touches the physical certified letter. The flow:
//   1. Operator approves a certified letter via Drafts queue (existing)
//   2. Mail Queue surfaces it with a "Send via Lob" button
//   3. POST /mail/send-via-lob takes the interaction id(s) → calls Lob API
//      → Lob prints, mails, generates tracking number
//   4. trustEd stamps tracking_number + provider_letter_id on the
//      letter_mail_pieces row + the parent interaction
//   5. Lob webhooks fire as USPS scans (in_transit → delivered)
//   6. POST /mail/lob-webhook updates status + captures signature image
//
// Fallback path (provider='manual'):
//   POST /mail/log-manual-tracking — operator pastes a tracking number from
//   a Pitney/USPS-direct send. Same downstream UI works.
// ===========================================================================

router.post('/mail/send-via-lob', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const { interaction_ids } = req.body || {};
    if (!Array.isArray(interaction_ids) || interaction_ids.length === 0) {
      return res.status(400).json({ error: 'interaction_ids array required' });
    }
    if (!process.env.LOB_API_KEY) {
      return res.status(400).json({
        error: 'LOB_API_KEY not configured on this environment',
        hint: 'Add LOB_API_KEY to Render env vars. Use a test_xxx key for sandbox or live_xxx for production.',
      });
    }

    const { createCertifiedLetter } = require('../lib/mail/lob_provider');
    const isTestKey = String(process.env.LOB_API_KEY).startsWith('test_');

    // Pull interactions + violation + property + community + letter PDF storage path
    const { data: interactions, error: iErr } = await supabase
      .from('interactions')
      .select('id, violation_id, community_id, property_id, type, attachments, status, bundle_id, delivery_method')
      .in('id', interaction_ids);
    if (iErr) throw iErr;
    if (!interactions || interactions.length === 0) {
      return res.status(404).json({ error: 'no interactions found' });
    }

    const results = [];
    for (const inter of interactions) {
      try {
        // Pull supporting data — property + community + sender
        const [propRes, commRes] = await Promise.all([
          supabase.from('v_current_property_owners')
            .select('property_id, street_address, unit, city, state, zip, owner_name, owner_mailing_address')
            .eq('property_id', inter.property_id).maybeSingle(),
          supabase.from('communities')
            .select('id, name, legal_name')
            .eq('id', inter.community_id).maybeSingle(),
        ]);
        const prop = propRes.data;
        const community = commRes.data;
        if (!prop || !community) {
          results.push({ interaction_id: inter.id, status: 'error', error: 'property or community missing' });
          continue;
        }

        // Resolve PDF path from interaction.attachments (already populated when the letter was drafted)
        const att = Array.isArray(inter.attachments) ? inter.attachments : [];
        const letterAtt = att.find(a => a && (a.kind === 'letter_pdf' || a.kind === 'violation_letter' || a.type === 'application/pdf'));
        const storagePath = letterAtt && (letterAtt.storage_path || letterAtt.path);
        if (!storagePath) {
          results.push({ interaction_id: inter.id, status: 'error', error: 'letter PDF storage path missing from interaction.attachments' });
          continue;
        }
        // Download PDF from Supabase storage
        const { data: pdfBlob, error: dlErr } = await supabase.storage
          .from('violation-letters')
          .download(storagePath);
        if (dlErr || !pdfBlob) {
          results.push({ interaction_id: inter.id, status: 'error', error: `PDF download failed: ${dlErr && dlErr.message}` });
          continue;
        }
        const pdfBuffer = Buffer.from(await pdfBlob.arrayBuffer());

        // Parse recipient mailing address. Owner_mailing_address may be a single
        // string like "123 Main St, Katy, TX 77450" — parse loosely. Fall back
        // to the property address if no mailing address is on file.
        const recipient = _parseMailingAddress(prop.owner_mailing_address) || {
          address_line1: prop.street_address,
          city: prop.city,
          state: prop.state || 'TX',
          zip: prop.zip,
        };
        recipient.name = prop.owner_name || 'Property Owner';

        // Sender = Bedrock as managing agent. This becomes the printed
        // RETURN ADDRESS on the Lob envelope — undeliverable pieces come
        // back here (matches the pre-printed envelopes Bedrock uses for
        // manual mailings today). The letter content already establishes
        // that Bedrock is acting on behalf of [HOA Name] so homeowners
        // know the underlying principal.
        //
        // BRAND.service stores the address pre-split for letter footers:
        //   address              -> "12808 W Airport Blvd, Ste 253"
        //   addressCityStateZip  -> "Sugar Land, TX 77478"
        // We parse the city/state/zip portion for Lob's structured fields.
        const { BRAND } = require('../lib/enforcement/brand_proxy');
        const _csz = String(BRAND.service.addressCityStateZip || '');
        const _cszMatch = _csz.match(/^(.+?),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\s*$/);
        const sender = {
          name: BRAND.service.legal,                              // "Bedrock Association Management, LLC"
          address_line1: BRAND.service.address,                   // "12808 W Airport Blvd, Ste 253"
          city: _cszMatch ? _cszMatch[1].trim() : 'Sugar Land',
          state: _cszMatch ? _cszMatch[2] : 'TX',
          zip: _cszMatch ? _cszMatch[3] : '77478',
        };

        // Derive mail type from the interaction's delivery_method. Certified
        // gets the §209-grade label + return receipt; first-class is the
        // courtesy-letter path (no tracking, faster turnaround).
        const isCertifiedSend = (inter.delivery_method === 'certified_mail');
        const lobMailType = isCertifiedSend ? 'usps_certified' : 'usps_first_class';

        // Submit to Lob
        const lobResult = await createCertifiedLetter({
          pdfBuffer,
          recipient,
          sender,
          options: {
            description: `Bedrock ${inter.type} for ${community.name} · ${prop.street_address}`,
            mail_type: lobMailType,
          },
        });

        // Upsert letter_mail_pieces row
        const { data: piece, error: upErr } = await supabase.from('letter_mail_pieces')
          .upsert({
            interaction_id:     inter.id,
            community_id:       inter.community_id,
            property_id:        inter.property_id,
            violation_id:       inter.violation_id,
            bundle_id:          inter.bundle_id,
            stage_at_send:      _mapInteractionTypeToStage(inter.type),
            letter_pdf_storage_path: storagePath,
            recipient_name:     recipient.name,
            recipient_address_line1: recipient.address_line1,
            recipient_address_line2: recipient.address_line2 || null,
            recipient_city:     recipient.city,
            recipient_state:    recipient.state,
            recipient_zip:      recipient.zip,
            delivery_method:    isCertifiedSend ? 'certified_return_receipt' : 'first_class',
            return_receipt_requested: isCertifiedSend,
            provider:           'lob',
            provider_letter_id: lobResult.id,
            provider_test_mode: lobResult.is_test_mode,
            tracking_number:    lobResult.tracking_number,
            status:             'submitted',
            submitted_at:       new Date().toISOString(),
            total_cost_cents:   lobResult.price_cents,
            provider_response_payload: lobResult.raw,
            events: [{
              ts: new Date().toISOString(),
              type: 'submitted_to_lob',
              note: `Lob letter id ${lobResult.id}, mail_type ${lobMailType}, tracking ${lobResult.tracking_number || '(first-class, no tracking)'}`,
            }],
          }, { onConflict: 'interaction_id' })
          .select('*').single();
        if (upErr) throw upErr;

        // Mirror tracking number onto the interaction for legacy queries
        await supabase.from('interactions')
          .update({
            certified_tracking_number: lobResult.tracking_number,
            status: 'sent',
            sent_at: new Date().toISOString(),
          })
          .eq('id', inter.id);

        results.push({
          interaction_id: inter.id,
          status: 'submitted',
          provider: 'lob',
          provider_letter_id: lobResult.id,
          tracking_number: lobResult.tracking_number,
          expected_delivery_date: lobResult.expected_delivery_date,
          is_test_mode: lobResult.is_test_mode,
          piece_id: piece && piece.id,
        });
      } catch (e) {
        console.error('[mail.send-via-lob] interaction', inter.id, 'failed:', e.message);
        results.push({ interaction_id: inter.id, status: 'error', error: e.message });
      }
    }

    const counts = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
    res.json({
      submitted_count: counts.submitted || 0,
      error_count: counts.error || 0,
      is_test_mode: isTestKey,
      results,
    });
  } catch (err) {
    console.error('[mail.send-via-lob]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/enforcement/mail/lob-webhook
// Lob fires this on every status change. We verify signature, look up the
// mail piece by provider_letter_id, append to events log, update status.
// ---------------------------------------------------------------------------
router.post('/mail/lob-webhook', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
  try {
    const rawBody = req.body && req.body.toString ? req.body.toString('utf8') : '';
    const signature = req.headers['lob-signature'] || req.headers['Lob-Signature'];
    const timestamp = req.headers['lob-signature-timestamp'] || req.headers['Lob-Signature-Timestamp'];

    const { verifyWebhookSignature, mapLobEventToStatus } = require('../lib/mail/lob_provider');
    if (!verifyWebhookSignature(rawBody, signature, timestamp)) {
      return res.status(401).json({ error: 'invalid_signature' });
    }

    let evt;
    try { evt = JSON.parse(rawBody); } catch (_) { return res.status(400).json({ error: 'invalid_json' }); }

    const eventType = evt.event_type && (evt.event_type.id || evt.event_type);
    const lobLetterId = evt.body && evt.body.id;
    if (!lobLetterId) return res.status(200).json({ ok: true, note: 'no letter id, ignored' });

    // Find the piece
    const { data: piece, error } = await supabase.from('letter_mail_pieces')
      .select('*').eq('provider', 'lob').eq('provider_letter_id', lobLetterId).maybeSingle();
    if (error) throw error;
    if (!piece) {
      console.warn(`[mail.lob-webhook] no piece found for Lob letter ${lobLetterId} — ignored`);
      return res.status(200).json({ ok: true, note: 'no matching piece' });
    }

    // Compute new status
    const newStatus = mapLobEventToStatus(eventType);
    const now = new Date().toISOString();
    const timestamps = {};
    if (newStatus === 'submitted')        timestamps.submitted_at        = piece.submitted_at || now;
    if (newStatus === 'in_transit')       timestamps.in_transit_at       = piece.in_transit_at || now;
    if (newStatus === 'out_for_delivery') timestamps.out_for_delivery_at = piece.out_for_delivery_at || now;
    if (newStatus === 'delivered')        timestamps.delivered_at        = piece.delivered_at || now;
    if (newStatus === 'returned_to_sender') timestamps.returned_at = piece.returned_at || now;
    if (newStatus === 'failed_to_send')   timestamps.refused_at = piece.refused_at || now;

    // Signature capture — Lob passes signature_image_url on delivery events
    const sigUrl = evt.body && (evt.body.signature_image_url || (evt.body.return_receipt_data && evt.body.return_receipt_data.signature_image_url));
    const sigName = evt.body && (evt.body.signed_by || (evt.body.return_receipt_data && evt.body.return_receipt_data.signed_by));

    // Append to events log
    const newEvent = {
      ts: now,
      type: eventType,
      lob_event_id: evt.id || null,
      summary: (evt.body && evt.body.tracking_events && evt.body.tracking_events[0]) || null,
    };
    const existingEvents = Array.isArray(piece.events) ? piece.events : [];
    const events = [...existingEvents, newEvent].slice(-50);  // cap at 50 events to bound JSONB growth

    const patch = {
      ...timestamps,
      events,
      provider_response_payload: evt.body || null,
    };
    if (newStatus) patch.status = newStatus;
    if (sigUrl)    patch.signature_image_url = sigUrl;
    if (sigName)   patch.signed_by_name = sigName;

    const { error: upErr } = await supabase.from('letter_mail_pieces')
      .update(patch).eq('id', piece.id);
    if (upErr) throw upErr;

    res.status(200).json({ ok: true, status: newStatus, piece_id: piece.id });
  } catch (err) {
    console.error('[mail.lob-webhook]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/enforcement/mail/log-manual-tracking
// Fallback for non-Lob sends (Pitney, USPS direct, hand-stamped). Operator
// pastes tracking number — same downstream UI works.
// ---------------------------------------------------------------------------
router.post('/mail/log-manual-tracking', express.json(), async (req, res) => {
  try {
    const { interaction_id, tracking_number, provider, delivery_method, mailed_at, postage_cents } = req.body || {};
    if (!interaction_id) return res.status(400).json({ error: 'interaction_id_required' });
    if (!tracking_number) return res.status(400).json({ error: 'tracking_number_required' });

    const { data: inter } = await supabase.from('interactions')
      .select('id, community_id, property_id, violation_id, type, bundle_id')
      .eq('id', interaction_id).maybeSingle();
    if (!inter) return res.status(404).json({ error: 'interaction_not_found' });

    const { data: piece, error } = await supabase.from('letter_mail_pieces')
      .upsert({
        interaction_id:     inter.id,
        community_id:       inter.community_id,
        property_id:        inter.property_id,
        violation_id:       inter.violation_id,
        bundle_id:          inter.bundle_id,
        stage_at_send:      _mapInteractionTypeToStage(inter.type),
        provider:           provider || 'manual',
        tracking_number,
        delivery_method:    delivery_method || 'certified_mail',
        return_receipt_requested: (delivery_method || 'certified_mail').includes('certified'),
        status:             'submitted',
        submitted_at:       mailed_at || new Date().toISOString(),
        mailed_at:          mailed_at || new Date().toISOString(),
        postage_cents:      postage_cents || null,
        events: [{ ts: new Date().toISOString(), type: 'manual_tracking_logged', tracking_number }],
      }, { onConflict: 'interaction_id' })
      .select('*').single();
    if (error) throw error;

    await supabase.from('interactions')
      .update({ certified_tracking_number: tracking_number, sent_at: mailed_at || new Date().toISOString() })
      .eq('id', inter.id);

    res.json({ ok: true, piece });
  } catch (err) {
    console.error('[mail.log-manual-tracking]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/enforcement/mail/pieces?community_id=&status=&limit=
// List mail pieces with status filter — drives the Mail Queue UI.
// ---------------------------------------------------------------------------
router.get('/mail/pieces', async (req, res) => {
  try {
    const limit = Math.min(500, Number(req.query.limit) || 100);
    let q = supabase.from('letter_mail_pieces')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);
    if (req.query.status) q = q.eq('status', req.query.status);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ pieces: data || [] });
  } catch (err) {
    console.error('[mail.pieces]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /api/enforcement/drafts/:interactionId/trace
// ----------------------------------------------------------------------------
// Ed 2026-06-13: in-app version of scripts/trace_re_evaluate_decisions.js.
// Per-draft "why is this draft at this stage?" trace. Returns everything
// the operator + engineer need to diagnose:
//   - This draft's violation, property, category
//   - All priors at same property + same category in last 365 days
//     (with weight, stage, source — the exact data feed for the engine)
//   - Cross-check: certified+ priors at SAME property but DIFFERENT
//     category (catches Vantaca-vs-trustEd category_id mismatches)
//   - Engine decision + rationale
//   - What re-evaluate would do (KEEP / UPGRADE / BOARD_REVIEW)
// ----------------------------------------------------------------------------
router.get('/drafts/:interactionId/trace', async (req, res) => {
  try {
    const { interactionId } = req.params;
    const { data: draft } = await supabase
      .from('interactions')
      .select('id, violation_id, observation_id, type, status, community_id')
      .eq('id', interactionId)
      .maybeSingle();
    if (!draft) return res.status(404).json({ error: 'draft not found' });
    if (!draft.violation_id) {
      return res.json({
        draft_id: draft.id,
        error: 'draft has no linked violation — cannot trace',
      });
    }

    const { data: violation } = await supabase
      .from('violations')
      .select('id, property_id, community_id, primary_category_id, current_stage, opened_at, board_priority_at_open, enforcement_categories(slug, label)')
      .eq('id', draft.violation_id)
      .maybeSingle();
    if (!violation) return res.status(404).json({ error: 'linked violation not found' });

    const { data: property } = await supabase
      .from('v_current_property_owners')
      .select('property_id, street_address, owner_name')
      .eq('property_id', violation.property_id)
      .maybeSingle();

    const yearAgoIso = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();

    // Same-category priors (the exact input the engine sees)
    const { data: priorsSame } = await supabase
      .from('violations')
      .select('id, primary_category_id, opened_at, current_stage, quality_status, confidence_weight, source, resolved_at, enforcement_categories(slug, label)')
      .eq('property_id', violation.property_id)
      .eq('primary_category_id', violation.primary_category_id)
      .gte('opened_at', yearAgoIso)
      .neq('id', violation.id);

    // Cross-check — other-category priors at same property at certified+
    const { data: priorsCross } = await supabase
      .from('violations')
      .select('id, primary_category_id, current_stage, opened_at, source, resolved_at, enforcement_categories(slug, label)')
      .eq('property_id', violation.property_id)
      .neq('primary_category_id', violation.primary_category_id)
      .gte('opened_at', yearAgoIso)
      .neq('id', violation.id)
      .in('current_stage', ['certified_209', 'fine_assessed']);

    // Duplicate-property detection — same community, similar street_address,
    // different property_id. Vantaca import historically created its own
    // property rows when the address normalization differed from trustEd's,
    // so the same physical house has two property_ids and violations get
    // split across them. This is the scar that explains why side-panel
    // priors exist but the trace can't find them.
    let duplicatePropertyRows = [];
    if (property && property.street_address) {
      const sa = String(property.street_address).trim();
      // Strip the directional + suffix so "6234 Clear Canyon Dr" matches
      // "6234 Clear Canyon Drive" — use the first ~16 chars as a fuzzy
      // prefix match.
      const prefix = sa.slice(0, Math.min(18, sa.length)).replace(/[%_]/g, '');
      const { data: dupProps } = await supabase
        .from('properties')
        .select('id, street_address, unit')
        .eq('community_id', violation.community_id)
        .ilike('street_address', `${prefix}%`)
        .neq('id', violation.property_id);
      if (dupProps && dupProps.length > 0) {
        for (const dp of dupProps) {
          const { data: dpVios } = await supabase
            .from('violations')
            .select('id, current_stage, opened_at, source, enforcement_categories(slug, label)')
            .eq('property_id', dp.id)
            .not('current_stage', 'in', '(cured,closed,voided)')
            .order('opened_at', { ascending: false })
            .limit(10);
          duplicatePropertyRows.push({
            property_id: dp.id,
            street_address: dp.street_address,
            unit: dp.unit,
            open_violations: (dpVios || []).map((v) => ({
              id: v.id,
              stage: v.current_stage,
              opened_at: v.opened_at,
              source: v.source,
              category_label: v.enforcement_categories?.label,
              category_slug: v.enforcement_categories?.slug,
            })),
          });
        }
      }
    }

    // Run the engine + replicate the re-evaluate decision
    const stageRank = { courtesy_1: 0, courtesy_2: 1, certified_209: 2, fine_assessed: 3 };
    const weightFor = (v) => {
      if (v.quality_status === 'superseded') return 0;
      if (typeof v.confidence_weight === 'number') return Math.max(0, Math.min(1, v.confidence_weight));
      return 1.0;
    };
    const certifiedPriors = (priorsSame || []).filter((p) =>
      ['certified_209', 'fine_assessed'].includes(p.current_stage) && weightFor(p) > 0
    );
    const decision = decideEscalation({
      prior_violations: priorsSame || [],
      priority_weight: violation.board_priority_at_open || 'standard',
    });

    let reEvalAction, reEvalNewStage = null;
    if (certifiedPriors.length > 0) {
      reEvalAction = 'BOARD_REVIEW';
    } else if ((stageRank[decision.stage] || 0) > (stageRank[violation.current_stage] || 0)) {
      reEvalAction = 'UPGRADE';
      reEvalNewStage = decision.stage;
    } else {
      reEvalAction = 'KEEP';
    }

    res.json({
      draft: {
        id: draft.id,
        type: draft.type,
        status: draft.status,
      },
      violation: {
        id: violation.id,
        category_slug: violation.enforcement_categories?.slug,
        category_label: violation.enforcement_categories?.label,
        current_stage: violation.current_stage,
        opened_at: violation.opened_at,
        primary_category_id: violation.primary_category_id,
      },
      property: {
        id: violation.property_id,
        address: property?.street_address,
        owner: property?.owner_name,
      },
      priors_same_category: (priorsSame || []).map((p) => ({
        id: p.id,
        stage: p.current_stage,
        opened_at: p.opened_at,
        resolved_at: p.resolved_at,
        source: p.source,
        weight: weightFor(p),
        quality_status: p.quality_status,
        category_label: p.enforcement_categories?.label,
      })),
      priors_cross_category_certified: (priorsCross || []).map((p) => ({
        id: p.id,
        stage: p.current_stage,
        opened_at: p.opened_at,
        resolved_at: p.resolved_at,
        source: p.source,
        category_slug: p.enforcement_categories?.slug,
        category_label: p.enforcement_categories?.label,
      })),
      duplicate_property_rows: duplicatePropertyRows,
      engine_decision: {
        stage: decision.stage,
        cure_days: decision.cure_days,
        rationale: decision.rationale,
      },
      re_evaluate: {
        action: reEvalAction,
        new_stage: reEvalNewStage,
        certified_priors_triggering_board_review: certifiedPriors.map((cp) => ({
          id: cp.id,
          stage: cp.current_stage,
          opened_at: cp.opened_at,
        })),
      },
    });
  } catch (err) {
    console.error('[drafts.trace]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// POST /api/enforcement/drafts/re-evaluate
// ----------------------------------------------------------------------------
// Ed 2026-06-13: after the Vantaca weight fix (0.5 → 1.0), drafts already
// in the queue may be at the wrong stage. This endpoint re-runs the
// escalation engine against EVERY current draft using the post-migration
// weights and applies the right action per draft.
//
// Decisions:
//   KEEP            — current stage matches engine recommendation. No-op.
//   UPGRADE         — engine recommends higher stage. Reject the draft +
//                     void its violation + reset the observation to
//                     'unreviewed'. When operator re-confirms, the engine
//                     creates a new violation at the correct stage.
//   BOARD_REVIEW    — at least one prior at certified_209+ exists. The
//                     June draft is functionally a continuation of the
//                     Vantaca-imported certified case. We log a
//                     continuation row pointing the observation at the
//                     prior, bump the prior's continuation_count, void
//                     the June violation, and reject the draft. The
//                     prior surfaces in v_continued_non_compliance for
//                     board review at the next meeting.
//
// Body: { community_id (optional), apply (default false) }
// apply=false returns dry-run analysis. apply=true applies all changes.
// ----------------------------------------------------------------------------
router.post('/drafts/re-evaluate', express.json(), async (req, res) => {
  try {
    const communityId = req.body && req.body.community_id;
    const apply = req.body && req.body.apply === true;

    const letterTypes = ['letter_courtesy_1', 'letter_courtesy_2', 'letter_209'];
    const stageRank = { courtesy_1: 0, courtesy_2: 1, certified_209: 2, fine_assessed: 3 };

    let q = supabase
      .from('interactions')
      .select('id, violation_id, observation_id, type, community_id, content')
      .eq('status', 'draft')
      .in('type', letterTypes);
    if (communityId) q = q.eq('community_id', communityId);
    const { data: drafts, error: dErr } = await q;
    if (dErr) return res.status(500).json({ error: dErr.message });
    if (!drafts || drafts.length === 0) {
      return res.json({ summary: { evaluated: 0, keep: 0, upgrade: 0, board_review: 0 }, details: [] });
    }

    const violationIds = drafts.map((d) => d.violation_id).filter(Boolean);
    const { data: violations } = await supabase
      .from('violations')
      .select('id, property_id, community_id, primary_category_id, current_stage, opened_at, board_priority_at_open, enforcement_categories(label)')
      .in('id', violationIds);
    const vioById = new Map((violations || []).map((v) => [v.id, v]));

    const yearAgoIso = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const details = [];
    let keep = 0, upgrade = 0, board = 0;

    for (const draft of drafts) {
      const violation = vioById.get(draft.violation_id);
      if (!violation) continue;

      // Priors at same property + same category, excluding this violation itself.
      const { data: priors } = await supabase
        .from('violations')
        .select('id, primary_category_id, opened_at, current_stage, quality_status, confidence_weight, source, resolved_at')
        .eq('property_id', violation.property_id)
        .eq('primary_category_id', violation.primary_category_id)
        .gte('opened_at', yearAgoIso)
        .neq('id', violation.id);

      // Did ANY prior reach certified_209 / fine_assessed (with non-zero weight)?
      const certifiedPriors = (priors || []).filter((p) => {
        if (!['certified_209', 'fine_assessed'].includes(p.current_stage)) return false;
        const w = p.quality_status === 'superseded' ? 0
                : typeof p.confidence_weight === 'number' ? p.confidence_weight
                : 1.0;
        return w > 0;
      });
      const certifiedPrior = certifiedPriors.sort((a, b) => new Date(b.opened_at) - new Date(a.opened_at))[0] || null;

      let action;
      let newStage = null;
      if (certifiedPrior) {
        action = 'board_review';
        board++;
      } else {
        const decision = decideEscalation({
          prior_violations: priors || [],
          priority_weight: violation.board_priority_at_open || 'standard',
        });
        if ((stageRank[decision.stage] || 0) > (stageRank[violation.current_stage] || 0)) {
          action = 'upgrade';
          newStage = decision.stage;
          upgrade++;
        } else {
          action = 'keep';
          keep++;
        }
      }

      const detail = {
        interaction_id: draft.id,
        violation_id: violation.id,
        observation_id: draft.observation_id,
        property_id: violation.property_id,
        category_label: violation.enforcement_categories && violation.enforcement_categories.label,
        current_stage: violation.current_stage,
        action,
        new_stage: newStage,
        prior_count: (priors || []).length,
        certified_prior_id: certifiedPrior && certifiedPrior.id,
        certified_prior_opened_at: certifiedPrior && certifiedPrior.opened_at,
      };
      details.push(detail);

      if (!apply) continue;

      // Apply path
      try {
        // Best-effort: remove the PDF for any rejected draft.
        if ((action === 'upgrade' || action === 'board_review')
            && draft.content && /\.pdf$/i.test(String(draft.content))) {
          try { await supabase.storage.from('violation-letters').remove([draft.content]); } catch (_) {}
        }

        if (action === 'upgrade') {
          // Void the violation so re-confirm creates fresh at correct stage.
          await supabase.from('violations').update({
            current_stage: 'voided',
            resolved_via: 'voided',
            resolved_at: new Date().toISOString(),
            resolved_notes: `Re-evaluation 2026-06-13: stage was ${violation.current_stage}, engine now recommends ${newStage} post-Vantaca-weight-fix. Voiding so re-confirm creates fresh.`,
          }).eq('id', violation.id);
          // Reset the observation so operator can re-confirm at the right stage.
          if (draft.observation_id) {
            await supabase.from('property_observations').update({
              reviewer_status: 'unreviewed',
              reviewer_notes: `[Re-evaluated 2026-06-13: stage upgrade pending — re-confirm to create at ${newStage}]`,
              reviewed_at: null,
            }).eq('id', draft.observation_id);
          }
          // Reject the draft.
          await supabase.from('interactions').update({
            status: 'rejected',
            notes: `[Auto-rejected 2026-06-13: stage ${violation.current_stage} outdated post-Vantaca-weight-fix; re-confirm observation to redraft at ${newStage}]`,
          }).eq('id', draft.id);

        } else if (action === 'board_review') {
          // Log this observation as a continuation of the existing
          // certified_209 prior so the prior accumulates evidence.
          if (draft.observation_id && certifiedPrior) {
            try {
              await supabase.from('violation_continuations').insert({
                violation_id:     certifiedPrior.id,
                observation_id:   draft.observation_id,
                source:           'inspection',
                notes:            `Auto-logged 2026-06-13 by drafts/re-evaluate. June trustEd draft superseded by prior certified §209 from ${(certifiedPrior.opened_at || '').slice(0,10)}.`,
              });
              // Bump the prior's counters (best-effort; not fatal if it fails).
              const { data: priorFresh } = await supabase.from('violations')
                .select('continuation_count').eq('id', certifiedPrior.id).maybeSingle();
              const newCount = ((priorFresh && priorFresh.continuation_count) || 0) + 1;
              await supabase.from('violations').update({
                continuation_count: newCount,
                last_continued_at:  new Date().toISOString(),
              }).eq('id', certifiedPrior.id);
            } catch (e) {
              // Unique-index conflict on observation_id is fine — already logged.
              if (!(e.code === '23505')) console.warn('[re-evaluate] continuation insert failed:', e.message);
            }
          }
          // Void the June violation (it was a duplicate of the open §209 case).
          await supabase.from('violations').update({
            current_stage: 'voided',
            resolved_via: 'voided',
            resolved_at: new Date().toISOString(),
            resolved_notes: `Re-evaluation 2026-06-13: prior certified §209 exists at this property+category (violation ${certifiedPrior && certifiedPrior.id}). This June violation logged as continuation evidence on the prior; voiding to avoid duplicate enforcement. Board to review at next meeting.`,
          }).eq('id', violation.id);
          // Reject the draft.
          await supabase.from('interactions').update({
            status: 'rejected',
            notes: `[Auto-rejected 2026-06-13: prior certified §209 exists at this property+category. Do not auto-mail. Continuation logged on the prior violation. Board review required at next meeting.]`,
          }).eq('id', draft.id);
        }
        // KEEP: no change
      } catch (e) {
        console.error('[drafts.re-evaluate] apply failed for draft', draft.id, e);
        detail.apply_error = e.message;
      }
    }

    res.json({
      summary: {
        evaluated: drafts.length,
        keep, upgrade, board_review: board,
        apply,
      },
      details,
    });
  } catch (err) {
    console.error('[drafts.re-evaluate]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// POST /api/enforcement/drafts/:interactionId/reclassify
// ----------------------------------------------------------------------------
// Ed 2026-06-13: "AI assessment is incorrect — I saw trash can, AI said
// damaged car. Need to fix, must be easy for the person doing it."
//
// Operator clicks ✏️ Fix on a draft row, picks the correct category, edits
// the description to match the actual photo, clicks Save. Single endpoint
// rewrites the observation + violation + (downstream caller regenerates
// the letter PDF). Audit trail preserved in property_observations.reviewer_notes.
//
// Body: { category_id (required), description (required) }
// Returns: { ok, violation_id, observation_id, prior_category_label }
//
// The client's next step is POST /generate-letter with force_regenerate=true
// to rebuild the PDF with the corrected category + description.
// ----------------------------------------------------------------------------
router.post('/drafts/:interactionId/reclassify', express.json(), async (req, res) => {
  try {
    const { interactionId } = req.params;
    const newCategoryId = req.body && req.body.category_id;
    const newDescription = req.body && req.body.description;
    if (!newCategoryId || !newDescription) {
      return res.status(400).json({ error: 'category_id and description required' });
    }

    // 1. Get the interaction → violation_id
    const { data: interaction, error: iErr } = await supabase
      .from('interactions')
      .select('id, violation_id, observation_id, status')
      .eq('id', interactionId)
      .maybeSingle();
    if (iErr || !interaction) return res.status(404).json({ error: 'interaction not found' });
    if (!interaction.violation_id) return res.status(400).json({ error: 'interaction has no linked violation — cannot reclassify' });
    if (interaction.status === 'sent') return res.status(409).json({ error: 'cannot reclassify — letter already mailed' });

    // 2. Get the violation → primary_category_id, observation_id
    const { data: violation, error: vErr } = await supabase
      .from('violations')
      .select('id, primary_category_id, opened_from_observation_id, enforcement_categories(label)')
      .eq('id', interaction.violation_id)
      .maybeSingle();
    if (vErr || !violation) return res.status(404).json({ error: 'violation not found' });

    const obsId = violation.opened_from_observation_id || interaction.observation_id;
    if (!obsId) return res.status(400).json({ error: 'no observation linked to this draft — cannot reclassify' });

    // 3. Validate the new category exists and capture its label for audit trail
    const { data: newCategory, error: ncErr } = await supabase
      .from('enforcement_categories')
      .select('id, slug, label')
      .eq('id', newCategoryId)
      .maybeSingle();
    if (ncErr || !newCategory) return res.status(400).json({ error: 'invalid category_id' });

    const priorCategoryLabel = (violation.enforcement_categories && violation.enforcement_categories.label) || '(unknown)';

    // 4. Update the observation — category, description, audit-trail note
    const auditNote = `[Reclassified ${new Date().toISOString().slice(0, 10)}: ${priorCategoryLabel} → ${newCategory.label} by operator]`;
    const { data: existingObs } = await supabase
      .from('property_observations')
      .select('reviewer_notes')
      .eq('id', obsId)
      .maybeSingle();
    const newReviewerNotes = existingObs && existingObs.reviewer_notes
      ? `${auditNote}\n${existingObs.reviewer_notes}`
      : auditNote;

    const { error: oUpErr } = await supabase
      .from('property_observations')
      .update({
        category_id:    newCategory.id,
        ai_description: newDescription,
        reviewer_notes: newReviewerNotes,
      })
      .eq('id', obsId);
    if (oUpErr) return res.status(500).json({ error: 'observation update failed: ' + oUpErr.message });

    // 5. Update the violation's primary category
    const { error: vUpErr } = await supabase
      .from('violations')
      .update({ primary_category_id: newCategory.id })
      .eq('id', violation.id);
    if (vUpErr) return res.status(500).json({ error: 'violation update failed: ' + vUpErr.message });

    res.json({
      ok: true,
      violation_id: violation.id,
      observation_id: obsId,
      prior_category_label: priorCategoryLabel,
      new_category_label: newCategory.label,
    });
  } catch (err) {
    console.error('[drafts.reclassify]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /api/enforcement/continued-non-compliance
// ----------------------------------------------------------------------------
// Board-packet surface. Returns every OPEN violation that has been
// re-observed at least once (continuation_count > 0). Each row carries:
//   - property address + owner
//   - category label + current stage
//   - days since opened + days since §209 mailed + cure period info
//   - continuation_count (proof-of-continuity evidence count)
//   - recommended_action (advance to §209 / await cure / authorize escalation)
//
// Query params:
//   community_id      — required (community-scope per CLAUDE.md)
//   stage             — optional filter ('certified_209' to focus on
//                       post-cure cases, the highest-attention bucket)
//   min_days_since_209 — optional, integer, default 0
// Sort: continuation_count DESC, last_continued_at DESC.
//
// Added 2026-06-13 — pairs with migration 219 + violation_continuations
// linker. See lib/enforcement/find_or_continue_violation.js.
// ----------------------------------------------------------------------------
router.get('/continued-non-compliance', async (req, res) => {
  try {
    const communityId = req.query.community_id;
    if (!communityId) return res.status(400).json({ error: 'community_id required' });

    const stageFilter = req.query.stage || null;
    const minDaysSince209 = Number.isFinite(parseInt(req.query.min_days_since_209, 10))
      ? parseInt(req.query.min_days_since_209, 10)
      : 0;

    let q = supabase
      .from('v_continued_non_compliance')
      .select('*')
      .eq('community_id', communityId)
      .order('continuation_count', { ascending: false })
      .order('last_continued_at',  { ascending: false })
      .limit(500);

    if (stageFilter) q = q.eq('current_stage', stageFilter);

    const { data, error } = await q;
    if (error) {
      console.error('[continued-non-compliance] query failed:', error.message);
      return res.status(500).json({ error: safeErrorMessage(error) });
    }

    // In-JS post-filter for min_days_since_209 (NULLs excluded when filter > 0).
    const rows = minDaysSince209 > 0
      ? (data || []).filter((r) => Number.isFinite(r.days_since_209) && r.days_since_209 >= minDaysSince209)
      : (data || []);

    const summary = {
      total_continued:                rows.length,
      at_certified_209:               rows.filter((r) => r.current_stage === 'certified_209').length,
      post_cure_period:               rows.filter((r) => r.cure_period_ends_at && new Date(r.cure_period_ends_at) < new Date()).length,
      ready_for_attorney_escalation:  rows.filter((r) => r.recommended_action === 'authorize_fine_or_attorney').length,
    };

    res.json({ summary, rows });
  } catch (err) {
    console.error('[continued-non-compliance]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Helpers ---------------------------------------------------------------------
function _mapInteractionTypeToStage(t) {
  return ({
    letter_courtesy_1: 'courtesy_1',
    letter_courtesy_2: 'courtesy_2',
    letter_209:        'certified_209',
    letter_fine:       'fine_assessed',
    letter_hearing:    'hearing_notice',
    letter_force_mow:  'force_mow',
  })[t] || 'certified_209';
}

function _parseMailingAddress(addressString) {
  if (!addressString || typeof addressString !== 'string') return null;
  // Try "line1, city, state zip"
  const m = addressString.match(/^(.+?),\s*(.+?),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/);
  if (m) {
    return {
      address_line1: m[1].trim(),
      city: m[2].trim(),
      state: m[3],
      zip: m[4],
    };
  }
  return null;
}

module.exports = { router, processCureLapses, processPostcardReminders };
