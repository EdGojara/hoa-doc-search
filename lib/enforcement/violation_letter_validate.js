// ============================================================================
// violation_letter_validate.js — Input validator for the violation letter
// renderer. Run BEFORE renderViolationLetterBundlePdf() to fail loud + early
// on bad data instead of letting the renderer produce a bad letter.
//
// IMPORTANT: This validates against the renderer's ACTUAL ctx shape, not a
// hypothetical schema. Field names match what violation_letter.js consumes
// at runtime (verified by grepping the renderer 2026-05-21):
//
//   ctx.property: { street_address, unit, city, state, zip, lot_number }
//   ctx.owner: { full_name, mailing_address }
//   ctx.community: { name, legal_name, letter_*  fields }
//   ctx.stage: enum
//   ctx.letter_date: ISO date (optional, defaults to now)
//   ctx.violations: [{
//     category_label, ai_description, observation_captured_at,
//     governing_doc: { reference, section_title, quote, page },
//     prior_notices: [{ date, stage, delivery_method }],
//     close_up_photo_buffer: Buffer,
//     fine_amount,      // DOLLARS not cents per renderer line 569
//   }]
//   ctx.options: { sender_name, sender_title, certified_tracking_number }
//
// Returns { ok: true } or { ok: false, errors: [...] } — never throws so
// callers can decide whether to bail or warn. The render functions in
// violation_letter.js now call this at entry and throw on !ok so all
// caller code paths get coverage without manual wiring.
// ============================================================================

'use strict';

const ALLOWED_STAGES = ['courtesy_1', 'courtesy_2', 'certified_209', 'fine_assessed'];

function validateViolationLetterInput(ctx) {
  const errors = [];

  if (!ctx || typeof ctx !== 'object') {
    return { ok: false, errors: ['ctx must be an object'] };
  }

  // ---- stage ----
  if (!ctx.stage) {
    errors.push('stage is required');
  } else if (!ALLOWED_STAGES.includes(ctx.stage)) {
    errors.push(`stage must be one of ${ALLOWED_STAGES.join(', ')} — got '${ctx.stage}'`);
  }

  // ---- property ----
  const p = ctx.property;
  if (!p || typeof p !== 'object') {
    errors.push('property is required');
  } else {
    if (!p.street_address || typeof p.street_address !== 'string' || p.street_address.trim().length < 5) {
      errors.push('property.street_address required (PHYSICAL LOT — never mailing). See CLAUDE.md SSOT table.');
    }
  }

  // ---- owner ----
  const o = ctx.owner;
  if (!o || typeof o !== 'object') {
    errors.push('owner is required');
  } else {
    if (!o.full_name || typeof o.full_name !== 'string' || o.full_name.trim().length < 2) {
      errors.push('owner.full_name required (legal name of record — renderer reads this for salutation + envelope)');
    }
    // mailing_address can be string or object — renderer is flexible
    const m = o.mailing_address;
    if (m == null) {
      errors.push('owner.mailing_address required (where the letter is mailed — for rentals this is off-site)');
    } else if (typeof m === 'string') {
      if (m.trim().length < 5) errors.push('owner.mailing_address (string) is too short to be a real address');
    } else if (typeof m === 'object') {
      // Object form accepted; renderer expects line1+city+state+zip but is lenient
      if (!m.line1 && !m.street && !m.address) errors.push('owner.mailing_address object needs line1/street/address field');
      if (m.state && m.state.length !== 2) errors.push('owner.mailing_address.state must be 2-letter code if set');
      if (m.zip && !/^[0-9]{5}(-[0-9]{4})?$/.test(m.zip)) errors.push('owner.mailing_address.zip must be 5-digit (or ZIP+4) if set');
    } else {
      errors.push('owner.mailing_address must be a string or object');
    }
  }

  // ---- community ----
  const c = ctx.community;
  if (!c || typeof c !== 'object') {
    errors.push('community is required');
  } else {
    if (!c.name || typeof c.name !== 'string' || c.name.trim().length < 2) {
      errors.push('community.name required');
    }
    // Per-community override sanity: cure days
    ['letter_cure_days_courtesy_1', 'letter_cure_days_courtesy_2', 'letter_cure_days_certified_209'].forEach((k) => {
      if (c[k] != null) {
        const n = Number(c[k]);
        if (!Number.isFinite(n) || n < 1 || n > 90 || !Number.isInteger(n)) {
          errors.push(`community.${k} must be integer 1-90 if set (got ${c[k]})`);
        }
        if (k === 'letter_cure_days_certified_209' && n < 30) {
          // Texas §209.006(d) floor
          errors.push(`community.${k} cannot be below 30 — Texas Property Code §209.006(d) floor`);
        }
      }
    });
    // Per-community fee sanity (cents, non-negative)
    ['letter_fee_courtesy_1_cents', 'letter_fee_courtesy_2_cents', 'letter_fee_certified_209_cents'].forEach((k) => {
      if (c[k] != null) {
        const n = Number(c[k]);
        if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
          errors.push(`community.${k} must be non-negative integer cents (got ${c[k]})`);
        }
      }
    });
  }

  // ---- violations ----
  const v = ctx.violations;
  if (!Array.isArray(v)) {
    errors.push('violations must be an array');
  } else if (v.length === 0) {
    errors.push('violations must contain at least 1 item — no such thing as a violation letter without a violation');
  } else {
    v.forEach((vio, idx) => {
      const prefix = `violations[${idx}]`;
      if (!vio || typeof vio !== 'object') {
        errors.push(`${prefix} must be an object`);
        return;
      }
      if (!vio.category_label || typeof vio.category_label !== 'string' || vio.category_label.trim().length < 2) {
        errors.push(`${prefix}.category_label required (short category — e.g., 'Lawn maintenance', 'Trash bins visible')`);
      }
      if (!vio.ai_description || typeof vio.ai_description !== 'string' || vio.ai_description.trim().length < 10) {
        errors.push(`${prefix}.ai_description required (specific finding — what was observed, where; minimum 10 chars)`);
      }
      if (vio.observation_captured_at == null) {
        errors.push(`${prefix}.observation_captured_at required (anchors the regulatory timeline)`);
      }
      // governing_doc is optional — but if present should be an object with reference
      if (vio.governing_doc != null) {
        if (typeof vio.governing_doc !== 'object') {
          errors.push(`${prefix}.governing_doc must be object { reference, section_title, quote, page } if set`);
        } else if (!vio.governing_doc.reference) {
          errors.push(`${prefix}.governing_doc.reference required when governing_doc is set`);
        }
      }
      // prior_notices is array of { date, stage, delivery_method } objects
      if (vio.prior_notices != null) {
        if (!Array.isArray(vio.prior_notices)) {
          errors.push(`${prefix}.prior_notices must be array if set`);
        } else {
          vio.prior_notices.forEach((pn, pi) => {
            if (!pn || typeof pn !== 'object') {
              errors.push(`${prefix}.prior_notices[${pi}] must be object { date, stage, delivery_method }`);
            } else if (!pn.date) {
              errors.push(`${prefix}.prior_notices[${pi}].date required`);
            }
          });
        }
      }
      // fine_amount is in DOLLARS (renderer line 569: $${Number(v.fine_amount).toFixed(2)})
      if (vio.fine_amount != null) {
        const fn = Number(vio.fine_amount);
        if (!Number.isFinite(fn) || fn < 0) {
          errors.push(`${prefix}.fine_amount must be non-negative number (dollars, e.g., 75.00 for $75)`);
        }
      }
      // Buffers (close_up_photo_buffer, wide_photo_buffer) are pass-through —
      // we don't validate Buffer contents, just that they're Buffers if set.
      if (vio.close_up_photo_buffer != null && !Buffer.isBuffer(vio.close_up_photo_buffer)) {
        errors.push(`${prefix}.close_up_photo_buffer must be a Buffer if set`);
      }
    });
  }

  // ---- stage-conditional rules ----
  if (ctx.stage === 'fine_assessed' && Array.isArray(v)) {
    const anyFine = v.some(x => x && Number.isFinite(Number(x.fine_amount)) && Number(x.fine_amount) > 0);
    if (!anyFine) {
      errors.push(`stage='fine_assessed' requires at least one violation with fine_amount > 0`);
    }
  }

  // Prior-notice expectation on escalated stages. certified_209 is intentionally
  // NOT required to have priors: a certified §209 notice can legitimately be the
  // FIRST and only notice ("skip courtesy notices"). Texas §209.006 requires the
  // certified notice ITSELF to give ≥30 days to cure + hearing rights — not a
  // prior courtesy. The letter renders a clean first-notice certified when priors
  // are absent (prior-notice history section is guarded on length > 0).
  // courtesy_2 (a 2nd courtesy implies a 1st) and fine_assessed (post-process)
  // still expect documented prior contact. (Ed 2026-07-14 — unblocks the
  // "30-day Certified §209 — skip courtesy notices" manual-violation path.)
  if (Array.isArray(v) && (ctx.stage === 'courtesy_2' || ctx.stage === 'fine_assessed')) {
    v.forEach((vio, idx) => {
      if (!vio || !Array.isArray(vio.prior_notices) || vio.prior_notices.length === 0) {
        errors.push(`violations[${idx}].prior_notices is empty but stage='${ctx.stage}' expects documented prior contact (§209 framework)`);
      }
    });
  }

  // ---- letter_date sanity ----
  if (ctx.letter_date != null) {
    // Accept Date object, ISO string, or anything new Date() can parse
    const d = ctx.letter_date instanceof Date ? ctx.letter_date : new Date(ctx.letter_date);
    if (isNaN(d.getTime())) {
      errors.push('letter_date must be a valid Date or ISO string if set');
    } else {
      // Sanity: letter_date should not be in the future by more than a week
      const weekFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      if (d > weekFromNow) {
        errors.push(`letter_date is more than a week in the future (${d.toISOString().slice(0,10)}) — likely a bug`);
      }
    }
  }

  // ---- Buffer fields at top level ----
  if (ctx.wide_photo_buffer != null && !Buffer.isBuffer(ctx.wide_photo_buffer)) {
    errors.push('ctx.wide_photo_buffer must be a Buffer if set');
  }
  if (ctx.community_logo_buffer != null && !Buffer.isBuffer(ctx.community_logo_buffer)) {
    errors.push('ctx.community_logo_buffer must be a Buffer if set');
  }

  // ---- certified-stage tracking number ----
  if ((ctx.stage === 'certified_209' || ctx.stage === 'fine_assessed') && ctx.options) {
    const tn = ctx.options.certified_tracking_number;
    if (tn != null && (typeof tn !== 'string' || tn.replace(/\s/g, '').length < 10)) {
      errors.push(`options.certified_tracking_number doesn't look like a USPS tracking number (${tn})`);
    }
  }

  return errors.length === 0
    ? { ok: true }
    : { ok: false, errors };
}

module.exports = { validateViolationLetterInput, ALLOWED_STAGES };
