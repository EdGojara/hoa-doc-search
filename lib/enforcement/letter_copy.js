// ============================================================================
// letter_copy.js — per-community editable copy blocks for violation letters
// ----------------------------------------------------------------------------
// Lets each community override the title + opening paragraph + closing
// paragraph of each stage variant without changing the renderer. Statutory
// blocks (§209 cure language, hearing-request, SCRA notice, postmark anchor,
// §209.006(b)(1) fee disclosure, §209.0064 fine-schedule reference) stay
// hard-locked in violation_letter.js — those are catastrophic-output
// surfaces and require counsel review to change.
//
// Placeholder substitution at render time:
//   {{community_name}}       community.name
//   {{community_legal_name}} community.legal_name
//   {{cure_days}}            integer cure days for stage
//   {{cure_by_date}}         long-format date (Monday, June 30, 2026)
//   {{property_address}}     property.street_address (no city/zip)
//   {{category_label}}       primary violation category label
//   {{phone}}                Bedrock contact phone (from BRAND)
//   {{email}}                Bedrock violations email (from BRAND)
//   {{owner_salutation}}     "Dear Mr. Smith" / "Dear Property Owner"
//
// Public API:
//   await loadOverrides(supabase, community_id, stage) → { title?, opening_paragraph?, closing_paragraph? }
//   getDefault(stage, block_key) → string (the canonical Bedrock default)
//   resolveBlock(overrides, stage, block_key, ctx) → string (override or default with placeholders applied)
// ============================================================================

// ----------------------------------------------------------------------------
// DEFAULTS — what every community gets if no override is set. Copy here
// mirrors the existing renderer language so behavior is unchanged for
// communities that never edit anything.
// ----------------------------------------------------------------------------
// Signature defaults — courtesy stages use the warmer "Sincerely,",
// certified + fine use "Respectfully,". {{sender_name}} and
// {{sender_title}} fall back to community.letter_sender_name /
// letter_sender_title at render time.
const _SIGN_COURTESY =
  "Sincerely,\n\n" +
  "{{sender_name}}\n" +
  "{{sender_title}}\n" +
  "Issued by Bedrock Association Management, LLC, managing agent.";
const _SIGN_FORMAL =
  "Respectfully,\n\n" +
  "{{sender_name}}\n" +
  "{{sender_title}}\n" +
  "Issued by Bedrock Association Management, LLC, managing agent.";

const DEFAULTS = {
  courtesy_1: {
    title: 'Courtesy Notice',
    opening_paragraph:
      "We're sure that this was just an oversight, and the Board respectfully requests that you promptly correct " +
      "the matter upon receipt of this notice. If you do not feel that you are in non-compliance of the above-cited " +
      "provisions and this letter has been sent in error, please email {{email}} or call {{phone}} so we can resolve " +
      "this with you.",
    closing_paragraph:
      "Please remember that this letter is being sent as a courtesy. We appreciate your cooperation in correcting " +
      "this matter as quickly as possible. Thank you for doing your part to keep the community a beautiful place to live.",
    signature_block: _SIGN_COURTESY,
    footer_note: '',
  },
  courtesy_2: {
    title: 'Second Notice — Covenant Violation',
    opening_paragraph:
      "The above-cited violation needs to be cured in order to bring your lot into compliance with the Declaration " +
      "of Covenants, Conditions and Restrictions. Please correct the matter on or before {{cure_by_date}}.",
    closing_paragraph:
      "If the matter remains uncured after that date, our next correspondence will be a certified notice under " +
      "Texas Property Code §209, which preserves the Association's right to assess fines and recover attorney " +
      "fees and costs. We would much rather resolve this with you — if there are any extenuating circumstances, " +
      "please email {{email}} or call {{phone}}.",
    signature_block: _SIGN_COURTESY,
    footer_note: '',
  },
  certified_209: {
    title: 'FORMAL NOTICE OF COVENANT VIOLATION',
    opening_paragraph:
      "This is a formal notice under Texas Property Code §209.006 that the condition(s) described below at " +
      "{{property_address}} constitute a violation of the Association's governing documents. You have the right " +
      "to cure within {{cure_days}} days of the postmark of this notice and the right to request a hearing before " +
      "the Board within 30 days.",
    closing_paragraph:
      "We encourage you to address this matter promptly. If you have questions or believe this notice was sent " +
      "in error, please contact our office at {{phone}} or email {{email}}.",
    signature_block: _SIGN_FORMAL,
    footer_note: '',
  },
  fine_assessed: {
    title: 'NOTICE OF FINE ASSESSMENT',
    opening_paragraph:
      "Following prior notice and an opportunity to cure under Texas Property Code §209.006, the Association has " +
      "assessed a fine in connection with the condition(s) at {{property_address}}. The fine schedule and the " +
      "specific amount are stated below.",
    closing_paragraph:
      "Further fines may continue to accrue until the violation is cured. If you have questions about this notice " +
      "or wish to discuss a payment arrangement, please contact our office at {{phone}} or email {{email}}.",
    signature_block: _SIGN_FORMAL,
    footer_note: '',
  },
};

const VALID_STAGES = Object.keys(DEFAULTS);
const VALID_BLOCKS = ['title', 'opening_paragraph', 'closing_paragraph', 'signature_block', 'footer_note'];

function isValidStage(s) { return VALID_STAGES.includes(s); }
function isValidBlock(b) { return VALID_BLOCKS.includes(b); }

function getDefault(stage, block_key) {
  if (!isValidStage(stage) || !isValidBlock(block_key)) return '';
  return DEFAULTS[stage][block_key] || '';
}

function getAllDefaults() {
  // Returns a deep copy so callers can't mutate the canonical defaults
  const out = {};
  for (const s of VALID_STAGES) {
    out[s] = { ...DEFAULTS[s] };
  }
  return out;
}

// ----------------------------------------------------------------------------
// Placeholder substitution. Tolerant of missing context values — replaces
// with empty string rather than throwing. Render context is shaped by the
// caller; we don't fetch anything from the DB here.
// ----------------------------------------------------------------------------
function applyPlaceholders(text, ctx) {
  if (!text || typeof text !== 'string') return '';
  const c = ctx || {};
  const map = {
    community_name:       c.community_name       || '',
    community_legal_name: c.community_legal_name || '',
    cure_days:            c.cure_days != null ? String(c.cure_days) : '',
    cure_by_date:         c.cure_by_date         || '',
    property_address:     c.property_address     || '',
    category_label:       c.category_label       || '',
    phone:                c.phone                || '',
    email:                c.email                || '',
    owner_salutation:     c.owner_salutation     || '',
    sender_name:          c.sender_name          || '',
    sender_title:         c.sender_title         || '',
  };
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (full, key) => {
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : full;
  });
}

// ----------------------------------------------------------------------------
// Resolve a single block — checks overrides first, falls back to default,
// then applies placeholders.
// ----------------------------------------------------------------------------
function resolveBlock(overrides, stage, block_key, ctx) {
  if (!isValidStage(stage) || !isValidBlock(block_key)) return '';
  const ov = overrides && overrides[block_key];
  const raw = (typeof ov === 'string' && ov.trim()) ? ov : getDefault(stage, block_key);
  return applyPlaceholders(raw, ctx);
}

// ----------------------------------------------------------------------------
// loadOverrides(supabase, community_id, stage) — fetches the row map for
// one (community, stage) pair. Returns {} when nothing is overridden.
// ----------------------------------------------------------------------------
async function loadOverrides(supabase, community_id, stage) {
  if (!supabase || !community_id || !stage) return {};
  if (!isValidStage(stage)) return {};
  try {
    const { data, error } = await supabase
      .from('letter_copy_overrides')
      .select('block_key, body')
      .eq('community_id', community_id)
      .eq('stage', stage);
    if (error) {
      // Migration not yet applied — fail safe by returning {}
      if (/letter_copy_overrides/i.test(error.message || '') && /does not exist|not found/i.test(error.message || '')) {
        return {};
      }
      console.warn('[letter_copy.loadOverrides]', error.message);
      return {};
    }
    const out = {};
    for (const row of (data || [])) {
      if (isValidBlock(row.block_key)) out[row.block_key] = row.body;
    }
    return out;
  } catch (e) {
    console.warn('[letter_copy.loadOverrides] threw:', e.message);
    return {};
  }
}

module.exports = {
  DEFAULTS,
  VALID_STAGES,
  VALID_BLOCKS,
  isValidStage,
  isValidBlock,
  getDefault,
  getAllDefaults,
  applyPlaceholders,
  resolveBlock,
  loadOverrides,
};
