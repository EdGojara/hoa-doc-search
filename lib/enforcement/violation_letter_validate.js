// ============================================================================
// violation_letter_validate.js — Input validator for the violation letter
// renderer. Run BEFORE renderViolationLetterBundlePdf() to fail loud + early
// on bad data instead of letting the renderer produce a bad letter.
//
// Hand-rolled (no ajv dependency) because the input shape is finite and the
// validator is small. Schema at templates/violation-letter.schema.json is
// the authoritative reference; this validator implements the same rules.
//
// Returns { ok: true } or { ok: false, errors: [...] } — never throws so
// callers can decide whether to bail or warn.
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
      errors.push('property.street_address required (physical lot address — NOT mailing). See CLAUDE.md SSOT table.');
    }
  }

  // ---- owner ----
  const o = ctx.owner;
  if (!o || typeof o !== 'object') {
    errors.push('owner is required');
  } else {
    if (!o.name || typeof o.name !== 'string' || o.name.trim().length < 2) {
      errors.push('owner.name required (legal name of record)');
    }
    // mailing_address can be string or object
    const m = o.mailing_address;
    if (m == null) {
      errors.push('owner.mailing_address required (where the letter is mailed; for rentals this is off-site)');
    } else if (typeof m === 'string') {
      if (m.trim().length < 5) errors.push('owner.mailing_address (string) is too short to be a real address');
    } else if (typeof m === 'object') {
      if (!m.line1) errors.push('owner.mailing_address.line1 required');
      if (!m.city)  errors.push('owner.mailing_address.city required');
      if (!m.state || m.state.length !== 2) errors.push('owner.mailing_address.state must be 2-letter code');
      if (!m.zip || !/^[0-9]{5}(-[0-9]{4})?$/.test(m.zip)) errors.push('owner.mailing_address.zip must be 5-digit (or ZIP+4)');
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
        if (!Number.isInteger(c[k]) || c[k] < 1 || c[k] > 90) {
          errors.push(`community.${k} must be integer 1-90 if set (got ${c[k]})`);
        }
        if (k === 'letter_cure_days_certified_209' && c[k] < 30) {
          // Texas §209.006(d) floor
          errors.push(`community.${k} cannot be below 30 — Texas Property Code §209.006(d) floor`);
        }
      }
    });
    // Per-community fee sanity (cents, non-negative)
    ['letter_fee_courtesy_1_cents', 'letter_fee_courtesy_2_cents', 'letter_fee_certified_209_cents'].forEach((k) => {
      if (c[k] != null && (!Number.isInteger(c[k]) || c[k] < 0)) {
        errors.push(`community.${k} must be non-negative integer cents (got ${c[k]})`);
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
      if (!vio.type || typeof vio.type !== 'string' || vio.type.trim().length < 2) {
        errors.push(`${prefix}.type required (short category, e.g., 'Lawn maintenance')`);
      }
      if (!vio.description || typeof vio.description !== 'string' || vio.description.trim().length < 10) {
        errors.push(`${prefix}.description required (specific finding — what was observed, where; minimum 10 chars)`);
      }
      if (!vio.date_documented || !/^\d{4}-\d{2}-\d{2}/.test(vio.date_documented)) {
        errors.push(`${prefix}.date_documented required (YYYY-MM-DD); anchors the regulatory timeline`);
      }
      if (vio.prior_notice_dates != null) {
        if (!Array.isArray(vio.prior_notice_dates)) {
          errors.push(`${prefix}.prior_notice_dates must be array if set`);
        } else {
          vio.prior_notice_dates.forEach((d, di) => {
            if (!/^\d{4}-\d{2}-\d{2}/.test(d || '')) {
              errors.push(`${prefix}.prior_notice_dates[${di}] must be YYYY-MM-DD`);
            }
          });
        }
      }
      if (vio.fine_cents != null) {
        if (!Number.isInteger(vio.fine_cents) || vio.fine_cents < 0) {
          errors.push(`${prefix}.fine_cents must be non-negative integer cents`);
        }
      }
    });
  }

  // ---- stage-conditional rules ----
  if (ctx.stage === 'fine_assessed' && Array.isArray(v)) {
    const anyFine = v.some(x => x && Number.isInteger(x.fine_cents) && x.fine_cents > 0);
    if (!anyFine) {
      errors.push(`stage='fine_assessed' requires at least one violation with fine_cents > 0`);
    }
  }

  // Prior-notice expectation on escalated stages
  if (Array.isArray(v) && (ctx.stage === 'courtesy_2' || ctx.stage === 'certified_209' || ctx.stage === 'fine_assessed')) {
    v.forEach((vio, idx) => {
      if (!vio || !Array.isArray(vio.prior_notice_dates) || vio.prior_notice_dates.length === 0) {
        // This is a WARNING not a hard fail — the renderer can still produce
        // a letter, but Ed should know we're shipping an escalated stage
        // without documented prior contact. Surface it as an error so the
        // caller has to acknowledge.
        errors.push(`violations[${idx}].prior_notice_dates is empty but stage='${ctx.stage}' expects documented prior notices`);
      }
    });
  }

  // Wrong-house verification (5-signal — see project_drv_module memory note).
  // Letters with unverified violations must not ship.
  if (Array.isArray(v)) {
    v.forEach((vio, idx) => {
      if (vio && vio.wrong_house_verified === false) {
        errors.push(`violations[${idx}].wrong_house_verified is explicitly false — fix verification before mailing`);
      }
    });
  }

  // ---- letter_date ----
  if (ctx.letter_date != null) {
    if (typeof ctx.letter_date !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(ctx.letter_date)) {
      errors.push('letter_date must be YYYY-MM-DD if set');
    } else {
      // Sanity: letter_date should not be in the future by more than a week
      // (mail-queue lock may stamp 1-2 days ahead, but a year in the future is a bug)
      const d = new Date(ctx.letter_date);
      const weekFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      if (d > weekFromNow) {
        errors.push(`letter_date is more than a week in the future (${ctx.letter_date}) — likely a bug`);
      }
    }
  }

  // ---- certified-stage tracking number ----
  if ((ctx.stage === 'certified_209' || ctx.stage === 'fine_assessed') && ctx.options) {
    // Tracking number isn't required at render time (gets stamped at
    // mail-queue lock), but if it's set it should be plausibly USPS-formatted.
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
