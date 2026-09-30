// ============================================================================
// lib/characters/spec.js  (Ed 2026-09-26)  Trusted Character System
// ----------------------------------------------------------------------------
// One validator per identity component (schema_version 1). A spec describes WHO
// the character is. It never names a provider object: provider IDs live only in
// provider_mappings, so no provider can become the place a character exists.
//
// Adding a character is data. Nothing here may name a specific character
// (enforced by tests/test_character_registry.js).
// ============================================================================

const COMPONENTS = ['face', 'voice', 'body', 'wardrobe', 'persona', 'guardrails'];
const SCHEMA_VERSION = 1;

// Keys that would smuggle a provider object into identity.
const PROVIDER_KEY = /(^|_)(avatar|look|voice|talking_photo|group|asset|provider|external|model|preset)_?id$|^(heygen|elevenlabs|runway|veo|remotion|vapi|twilio|azure|polly)(_|$)/i;
// Values shaped like provider object ids (HeyGen 32-hex, ElevenLabs 20-char) or signed URLs.
const PROVIDER_VALUE = [/^[0-9a-f]{32}$/i, /^[A-Za-z0-9]{20}$/, /[?&](Signature|X-Amz-Signature|Expires|token)=/i];

const str = (v) => typeof v === 'string' && v.trim().length > 0;
const strList = (v) => Array.isArray(v) && v.every(str);
const intRange = (v, lo, hi) => Array.isArray(v) && v.length === 2 && v.every(Number.isInteger) && v[0] >= lo && v[1] <= hi && v[0] <= v[1];

// field -> checker. `required` lists the minimum a version must state.
const SCHEMAS = {
  face: {
    required: ['apparent_age_range', 'hair', 'eyes', 'skin_tone'],
    fields: {
      apparent_age_range: (v) => intRange(v, 18, 90) || 'must be [min, max] whole years',
      hair: (v) => (v && typeof v === 'object' && !Array.isArray(v) && str(v.color) && str(v.style)
        && (v.sanctioned_variants === undefined || strList(v.sanctioned_variants))) || 'needs color, style, optional sanctioned_variants[]',
      eyes: (v) => str(v) || 'must be text',
      skin_tone: (v) => str(v) || 'must be text',
      distinguishing: (v) => strList(v) || 'must be a list of text',
      visual_vibe: (v) => str(v) || 'must be text',
      canonical_image_notes: (v) => str(v) || 'must be text',
      notes: (v) => str(v) || 'must be text',
    },
  },
  body: {
    required: ['height_range_in', 'build'],
    fields: {
      height_range_in: (v) => intRange(v, 48, 84) || 'must be [min, max] whole inches',
      build: (v) => str(v) || 'must be text',
      proportions: (v) => str(v) || 'must be text',
      posture: (v) => str(v) || 'must be text',
      movement_style: (v) => str(v) || 'must be text',
      notes: (v) => str(v) || 'must be text',
    },
  },
  voice: {
    required: ['status', 'description'],
    fields: {
      status: (v) => ['under_evaluation', 'canonical'].includes(v) || 'must be under_evaluation | canonical',
      description: (v) => str(v) || 'must be text (provider-independent description of the voice)',
      delivery: (v) => (v && typeof v === 'object' && !Array.isArray(v)
        && Object.entries(v).every(([k, x]) => ['pace_wpm'].includes(k) ? intRange(x, 60, 260) : str(x) || strList(x)))
        || 'delivery fields are text; pace_wpm is [min, max]',
      pronunciation: (v) => (Array.isArray(v) && v.every((p) => p && str(p.term) && str(p.say))) || 'must be [{term, say}]',
      notes: (v) => str(v) || 'must be text',
    },
  },
  wardrobe: {
    required: ['contexts'],
    fields: {
      contexts: (v) => {
        const allowed = ['boardroom', 'business_casual', 'field_community', 'bedrock_branded', 'casual_life'];
        if (!v || typeof v !== 'object' || Array.isArray(v)) return 'must be an object of context -> list';
        const bad = Object.keys(v).filter((k) => !allowed.includes(k));
        if (bad.length) return `unknown context(s): ${bad.join(', ')}`;
        return Object.values(v).every(strList) || 'each context is a list of text';
      },
      sanctioned_alternates: (v) => strList(v) || 'must be a list of text',
      palette: (v) => strList(v) || 'must be a list of text',
      jewelry_signature: (v) => str(v) || 'must be text',
      never: (v) => strList(v) || 'must be a list of text',
      notes: (v) => str(v) || 'must be text',
    },
  },
  persona: {
    required: ['role_snapshot', 'temperament', 'communication_style'],
    fields: {
      role_snapshot: (v) => (v && str(v.display_name) && str(v.title)) || 'needs display_name and title (as of this version)',
      temperament: (v) => str(v) || 'must be text',
      communication_style: (v) => str(v) || 'must be text',
      humor: (v) => str(v) || 'must be text',
      confidence: (v) => str(v) || 'must be text',
      warmth: (v) => str(v) || 'must be text',
      firmness: (v) => str(v) || 'must be text',
      presence: (v) => str(v) || 'must be text',
      mannerisms: (v) => strList(v) || 'must be a list of text',
      would_say: (v) => strList(v) || 'must be a list of text',
      would_never_say: (v) => strList(v) || 'must be a list of text',
      persona_prompt_ref: (v) => str(v) || 'must be text (where the live behavior prompt lives)',
      notes: (v) => str(v) || 'must be text',
    },
  },
  guardrails: {
    required: [],
    atLeastOne: ['face_drift', 'body_drift', 'age_drift', 'wardrobe_drift', 'voice_drift', 'personality_drift'],
    fields: {
      face_drift: (v) => strList(v) || 'must be a list of text',
      body_drift: (v) => strList(v) || 'must be a list of text',
      age_drift: (v) => strList(v) || 'must be a list of text',
      wardrobe_drift: (v) => strList(v) || 'must be a list of text',
      voice_drift: (v) => strList(v) || 'must be a list of text',
      personality_drift: (v) => strList(v) || 'must be a list of text',
      notes: (v) => str(v) || 'must be text',
    },
  },
};

// Every component may state what is still unresolved, explicitly. A version
// with open questions can be proposed but never approved
// (lib/characters/approval.js). Confirming them means a new version without them.
const openQuestionsCheck = (v) => (Array.isArray(v) && v.every((q) => q && typeof q === 'object' && !Array.isArray(q)
  && str(q.field) && str(q.question) && Object.keys(q).every((k) => ['field', 'question'].includes(k))))
  || 'must be a list of { field, question }';
for (const c of COMPONENTS) SCHEMAS[c].fields.open_questions = openQuestionsCheck;

// Walk the whole spec: forbid provider keys/values and non-integer numbers anywhere.
function scan(value, path, errors) {
  if (typeof value === 'number' && !Number.isInteger(value)) errors.push(`${path}: non-integer numbers are not allowed`);
  if (typeof value === 'string' && PROVIDER_VALUE.some((re) => re.test(value.trim()))) {
    errors.push(`${path}: looks like a provider id or signed URL; provider objects belong in provider_mappings`);
  }
  if (Array.isArray(value)) value.forEach((x, i) => scan(x, `${path}[${i}]`, errors));
  else if (value && typeof value === 'object') {
    for (const [k, x] of Object.entries(value)) {
      if (PROVIDER_KEY.test(k)) errors.push(`${path}.${k}: provider references are not allowed in identity specs`);
      scan(x, `${path}.${k}`, errors);
    }
  }
}

function validateSpec(component, spec, schemaVersion = SCHEMA_VERSION) {
  const errors = [];
  if (!COMPONENTS.includes(component)) return { ok: false, errors: [`unknown component "${component}"`] };
  if (schemaVersion !== SCHEMA_VERSION) return { ok: false, errors: [`unsupported schema_version ${schemaVersion}`] };
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { ok: false, errors: ['spec must be an object'] };
  const schema = SCHEMAS[component];
  for (const k of schema.required) if (spec[k] === undefined) errors.push(`${component}.${k} is required`);
  if (schema.atLeastOne && !schema.atLeastOne.some((k) => spec[k] !== undefined)) {
    errors.push(`${component} needs at least one of: ${schema.atLeastOne.join(', ')}`);
  }
  for (const [k, v] of Object.entries(spec)) {
    const check = schema.fields[k];
    if (!check) { errors.push(`${component}.${k} is not a known field (schema v${SCHEMA_VERSION})`); continue; }
    const r = check(v);
    if (r !== true) errors.push(`${component}.${k} ${r}`);
  }
  scan(spec, component, errors);
  return { ok: errors.length === 0, errors };
}

module.exports = { COMPONENTS, SCHEMA_VERSION, validateSpec };
