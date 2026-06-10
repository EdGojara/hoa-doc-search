// ============================================================================
// lib/voice/drv_command_parser.js — interpret an inspector's voice command
// ----------------------------------------------------------------------------
// Ed 2026-06-10 — the operator drives, sees a violation, speaks naturally
// while the phone is mounted on the dashboard. This parses what they said.
//
// DESIGN:
//   - Tight command grammar (not LLM intent classification) — operator
//     gets ~100% accuracy on the categories that matter, and ZERO API cost.
//   - One transcript can carry multiple findings: "trash and dead lawn" → 2.
//   - Categories map to Bedrock's enforcement_categories.slug values.
//   - Returns a structured action plan the caller acts on.
//
// COMMAND SHAPES:
//   "mark house" / "capture" / "snap"           — trigger capture
//   "mark trash"                                 — capture + tag trash
//   "trash and dead lawn"                        — multi-tag (implies capture)
//   "also paint"                                 — add a finding to last capture
//   "next house"                                 — clear property selection
//   "skip" / "cancel"                            — drop the last capture
//   "done" / "end drive"                         — end the session
//   "note [free text]"                           — operator note for next capture
//
// RETURNS:
//   {
//     action: 'capture' | 'add_finding' | 'next_house' | 'skip' | 'end' | 'note' | 'unknown',
//     findings: [{ category_slug, confidence }, ...],
//     note: string|null,
//     raw_transcript: string,
//   }
// ============================================================================

// Map of trigger phrases → canonical category slug. ORDER MATTERS:
// multi-word phrases checked first to avoid "lawn" stealing "dead lawn" hits.
// Slugs must match enforcement_categories.slug values in the DB.
const CATEGORY_LEXICON = [
  // Trash / waste
  { phrases: ['trash cans', 'trash bins', 'garbage cans', 'garbage bins', 'recycling bins'], slug: 'trash_cans_visible' },
  { phrases: ['trash', 'garbage', 'bins'],                                                     slug: 'trash_cans_visible' },

  // Lawn condition
  { phrases: ['dead lawn', 'brown lawn', 'dead grass', 'brown grass', 'dead patches'], slug: 'lawn_dead_or_dying' },
  { phrases: ['overgrown lawn', 'tall grass', 'long grass'],                            slug: 'lawn_overgrown' },
  { phrases: ['lawn', 'grass', 'yard'],                                                  slug: 'lawn_dead_or_dying' },
  { phrases: ['weeds', 'weed'],                                                          slug: 'weeds_in_flowerbeds' },

  // Paint / exterior
  { phrases: ['peeling paint', 'chipping paint', 'paint peeling'], slug: 'paint_peeling' },
  { phrases: ['paint', 'painting'],                                slug: 'paint_peeling' },

  // Fence
  { phrases: ['broken fence', 'damaged fence', 'fence damage'], slug: 'fence_damaged' },
  { phrases: ['fence'],                                          slug: 'fence_damaged' },

  // Roof
  { phrases: ['damaged roof', 'missing shingles', 'roof damage'], slug: 'roof_damage' },
  { phrases: ['roof', 'shingles'],                                slug: 'roof_damage' },

  // Vehicles
  { phrases: ['boat in driveway', 'boat'],                  slug: 'unapproved_vehicle' },
  { phrases: ['trailer'],                                    slug: 'unapproved_vehicle' },
  { phrases: ['rv', 'recreational vehicle', 'motor home'],  slug: 'unapproved_vehicle' },
  { phrases: ['inoperable vehicle', 'broken car', 'junk car'], slug: 'unapproved_vehicle' },
  { phrases: ['vehicle', 'car'],                            slug: 'unapproved_vehicle' },

  // Clutter / storage
  { phrases: ['clutter', 'junk', 'debris', 'storage of unapproved items', 'unapproved storage'], slug: 'storage_unapproved' },

  // Structure / unapproved addition
  { phrases: ['unapproved addition', 'unapproved shed', 'addition', 'shed'], slug: 'unapproved_structure' },

  // Mildew / mold
  { phrases: ['mildew', 'mold', 'green growth'], slug: 'mildew_on_siding' },

  // Mailbox
  { phrases: ['mailbox', 'damaged mailbox'], slug: 'mailbox_damaged' },
];

const TRIGGER_PHRASES = [
  'mark house', 'mark this house', 'mark', 'capture', 'snap', 'photo', 'shoot it', 'shot',
];

const ALSO_PHRASES = ['also', 'plus', 'and add', 'also add', 'add'];
const NEXT_HOUSE_PHRASES = ['next house', 'move on', 'done with this house', 'next one'];
const SKIP_PHRASES = ['skip', 'cancel', 'undo', 'never mind', 'nevermind', 'forget it'];
const END_PHRASES = ['end drive', 'done driving', 'end inspection', 'stop inspection', 'finish drive'];
const NOTE_LEADIN = ['note', 'note that', 'remember', 'add a note'];

/**
 * Parse a transcript into a structured command.
 * @param {string} transcript
 * @returns {object}
 */
function parseDrvCommand(transcript) {
  const raw = String(transcript || '').trim();
  const text = raw.toLowerCase();
  if (!text) return { action: 'unknown', findings: [], note: null, raw_transcript: raw };

  // Whole-utterance commands first
  if (matchesAny(text, END_PHRASES))        return { action: 'end',         findings: [], note: null, raw_transcript: raw };
  if (matchesAny(text, NEXT_HOUSE_PHRASES)) return { action: 'next_house',  findings: [], note: null, raw_transcript: raw };
  if (matchesAny(text, SKIP_PHRASES))       return { action: 'skip',        findings: [], note: null, raw_transcript: raw };

  // Note-only utterance ("note: their dog was loose")
  for (const lead of NOTE_LEADIN) {
    if (text.startsWith(lead + ' ') || text.startsWith(lead + ':')) {
      const note = raw.slice(lead.length).replace(/^[:\s]+/, '').trim();
      return { action: 'note', findings: [], note: note || null, raw_transcript: raw };
    }
  }

  // "Also paint" / "also add paint" — additive finding for current property
  const isAlso = ALSO_PHRASES.some(p => text.startsWith(p + ' ') || text === p);

  // Otherwise: extract findings from the utterance. If we find any, default
  // action is 'capture' (or 'add_finding' if "also" was the lead-in).
  const findings = extractFindings(text);

  // Explicit trigger phrase even with no findings — that's a "snap a photo
  // and figure it out later" capture.
  const hasTrigger = TRIGGER_PHRASES.some(p =>
    text === p || text.startsWith(p + ' ') || text.endsWith(' ' + p)
  );

  if (isAlso && findings.length > 0) {
    return { action: 'add_finding', findings, note: null, raw_transcript: raw };
  }
  if (findings.length > 0 || hasTrigger) {
    return { action: 'capture', findings, note: null, raw_transcript: raw };
  }

  return { action: 'unknown', findings: [], note: null, raw_transcript: raw };
}

function matchesAny(text, phrases) {
  for (const p of phrases) {
    if (text === p || text.includes(p)) return true;
  }
  return false;
}

function extractFindings(text) {
  const found = [];
  const seenSlugs = new Set();
  // Walk lexicon in order — longest/most-specific phrases first
  for (const entry of CATEGORY_LEXICON) {
    for (const phrase of entry.phrases) {
      // Word-boundary match so "weeds" doesn't trigger inside "tweeds"
      const re = new RegExp(`\\b${escapeRegex(phrase)}\\b`, 'i');
      if (re.test(text) && !seenSlugs.has(entry.slug)) {
        found.push({
          category_slug: entry.slug,
          confidence: 'medium',  // operator-spoken — medium is a fair default
          matched_phrase: phrase,
        });
        seenSlugs.add(entry.slug);
        break;  // move to next entry once one of its phrases matched
      }
    }
  }
  return found;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { parseDrvCommand, CATEGORY_LEXICON };
