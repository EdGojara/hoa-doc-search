// ============================================================================
// lib/voice/reason.js — Claire's reasoning layer
// ----------------------------------------------------------------------------
// Streams a Claude response to a homeowner utterance, scoped to the caller's
// community via the same hybrid-retrieval pipeline askEd Chat uses. Emits
// completed SENTENCES (not raw token deltas) so the TTS layer can begin
// speaking the first sentence while the rest is still generating — that's
// what gets us under the 1.5s first-audio-out latency budget.
//
// Inputs come from the bridge:
//   - utterance text (the homeowner's most recent fully-transcribed turn)
//   - conversation history (prior turns this call)
//   - community context (resolved once per call from voice_phone_routes)
//
// Output: an async generator yielding sentences, in order. Each sentence is
// already stripped of the casual-tone banned phrases (defense in depth on
// top of the system-prompt rules).
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');
const { stripBannedPhrasesForVoice } = require('./persona_helpers');
const { getRelevantChunks } = require('../hybrid_retrieval');
const { buildCommunityContextBlock } = require('../../api/communities');
const { getRelevantPlaybook, formatPlaybookContext } = require('../../playbook');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Sentence boundary detector — same regex pattern the chat surface uses for
// streaming TTS. Splits on terminator + whitespace OR blank line.
function flushSentences(buffer) {
  const sentences = [];
  let remainder = buffer;
  const re = /([.!?])\s+|\n{2,}/g;
  let lastIdx = 0;
  let m;
  while ((m = re.exec(buffer)) !== null) {
    const end = m.index + (m[1] ? 1 : 0);
    const piece = buffer.slice(lastIdx, end).trim();
    if (piece) sentences.push(piece);
    lastIdx = re.lastIndex;
  }
  remainder = buffer.slice(lastIdx);
  return { sentences, remainder };
}

/** Run one conversational turn. Yields sentences as they complete.
 *
 *  @param {object} opts
 *  @param {string} opts.utterance — the user's latest fully-transcribed turn
 *  @param {Array} opts.history — prior turns as [{role, content}]
 *  @param {object} opts.community — { id, name, profile_block, doc_context }
 *  @param {AbortSignal} [opts.abort] — set if caller hangs up mid-stream
 *
 *  @yields {string} — each completed sentence
 */
async function* streamTurn(opts) {
  const { utterance, history = [], community, caller, abort } = opts;

  // STEP 1 — per-turn context fetch — SAME pipeline askEd Chat uses.
  // Three context sources, all running in parallel to keep latency bounded:
  //   (a) Hybrid retrieval over the documents table — governing docs, CC&Rs,
  //       bylaws, rules, policies. ~500-800ms.
  //   (b) Community profile block — vendor directory, amenities (pool/gate
  //       hours), key personnel, contact info, key facts. Scoped to caller's
  //       community. ~100-300ms.
  //   (c) Playbook entries — Ed's institutional guidelines on how to handle
  //       specific situations. ~100-300ms.
  //
  // Without (b) and (c), Claire only knows what's in the document library —
  // misses operational data like pool hours (amenities table) and vendor
  // phone numbers (community_contacts table). Bug surfaced 2026-05-23 during
  // voice testing when Claire said "I don't have the current pool hours for
  // Waterview Estates" — those hours ARE in the amenities table, just not
  // in the documents table.
  //
  // Best-effort: any one of these failing falls back to empty for that
  // context source; the others still run. Catches at the source so one
  // slow query doesn't time out the whole turn.
  const utt = utterance && utterance.trim() ? utterance : 'general guidance';
  const [docContext, profileBlock, playbookEntries] = await Promise.all([
    getRelevantChunks(utt, community?.name || '')
      .catch((e) => { console.warn(`[voice/reason] doc retrieval failed: ${e.message}`); return ''; }),
    community?.name
      ? buildCommunityContextBlock(community.name)
          .catch((e) => { console.warn(`[voice/reason] community profile failed: ${e.message}`); return ''; })
      : Promise.resolve(''),
    getRelevantPlaybook(utt, { matchCount: 6 })
      .catch((e) => { console.warn(`[voice/reason] playbook lookup failed: ${e.message}`); return []; }),
  ]);
  const playbookContext = formatPlaybookContext(playbookEntries, {
    heading: 'INSTITUTIONAL GUIDELINES FROM PAST SITUATIONS',
  }) || '';

  const systemPrompt = buildVoiceSystemPrompt(community, caller, docContext, profileBlock, playbookContext);
  const messages = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: utterance },
  ];

  const streamResp = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 400, // voice = concise by design; short answers travel faster
    system: systemPrompt,
    messages,
    stream: true,
  });

  let buffer = '';
  for await (const event of streamResp) {
    if (abort?.aborted) break;
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      buffer += event.delta.text;
      const { sentences, remainder } = flushSentences(buffer);
      buffer = remainder;
      for (const s of sentences) {
        const cleaned = stripBannedPhrasesForVoice(s);
        if (cleaned && cleaned.length >= 2) yield cleaned;
      }
    }
  }
  // Flush any remaining tail (final sentence may not have terminal punctuation)
  if (buffer.trim().length > 0) {
    const cleaned = stripBannedPhrasesForVoice(buffer.trim());
    if (cleaned) yield cleaned;
  }
}

// ---- Voice system prompt --------------------------------------------------
// Distilled version of askEdSystem() — voice-shaped. Same Ed-voice rules,
// same Texas-property-code awareness, but compressed because (a) tokens cost
// latency, and (b) voice answers must be terse by design. The TONE_CASUAL
// rules from server.js are inlined here.

function buildVoiceSystemPrompt(community, caller, docContextOverride, profileBlockOverride, playbookContextOverride) {
  // Community profile — vendor directory, amenities (pool/gate hours), key
  // personnel, key facts. Per-turn fetched value preferred over the
  // call-start cached value.
  const profileBlock = profileBlockOverride || community?.profile_block || '';
  const communityBlock = profileBlock
    ? `\n\nCALLER'S COMMUNITY: ${community?.name || '(unknown)'}\n${profileBlock}\n(Quote facts above verbatim when relevant — vendor phone numbers, amenity hours, key personnel names. Don't paraphrase numbers or contact info.)\n`
    : (community?.name ? `\n\nCALLER'S COMMUNITY: ${community.name}\n` : '');

  // Per-turn doc context (preferred) takes priority over any call-setup-time
  // doc_context that might be cached on the community object. Per-turn is
  // always fresher because it's scoped to the actual question being asked.
  const docContext = docContextOverride || community?.doc_context || '';
  const docBlock = docContext
    ? `\n\nRELEVANT GOVERNING DOCUMENTS (retrieved for THIS question — quote facts directly from these, don't paraphrase numbers/dates/percentages):\n${docContext}\n`
    : '';

  // Ed's institutional guidelines — how to handle specific situations
  // (homeowner complaints, vendor issues, enforcement, etc.). Same retrieval
  // pipeline askEd Chat uses.
  const playbookBlock = playbookContextOverride
    ? `\n\n${playbookContextOverride}\n`
    : '';

  // Caller-ID-matched homeowner context. When present, Claire knows who
  // she's talking to from the moment the call connects — no "may I have
  // your name?" friction. Privacy guard: caller ID can be spoofed, so
  // we DON'T inject sensitive info (AR balance, payment history) here.
  // Just identity for greeting/context. Sensitive operations still
  // require Claire to verify before sharing.
  const callerBlock = caller
    ? `\n\nWHO'S CALLING (matched by phone number):
- Name: ${caller.full_name || caller.first_name || '(unknown)'}
- Property: ${caller.property_address || '(unknown)'}
- Use their first name naturally — don't ask for it.
- If they ask about anything sensitive (account balance, payment history, fine details, ARC decisions), verify identity first: "Just to confirm I'm looking at the right account — can you tell me the address you're calling about?" Then proceed once they confirm.
- If caller-ID-matched info is wrong (e.g., they say "no I'm not John, I'm John's wife"), trust what they say and adjust.
`
    : `\n\nWHO'S CALLING: Unknown (no phone match in our system). Don't address them by name. If you need to identify them, ask naturally: "What's your name and address so I can pull up the right info?"\n`;

  return `You are Claire, Bedrock Association Management's AI voice assistant. You answer phone calls from homeowners. A human is one transfer away if needed.

YOUR ROLE:
- Answer concisely. Voice replies must be 1-3 sentences for most turns. Long lists get summarized.
- Use the caller's community-specific data when you have it. If you don't know something, say so — never invent dates, policies, or authority.
- For anything that needs board approval, an enforcement decision, a fine waiver, a deadline change, a fair-housing question, money/legal disputes, or distress — DON'T answer. Offer to put them through to the team.
- You're openly AI. Don't pretend to be a specific employee. If asked "who am I talking to," say "I'm Claire, Bedrock's AI assistant — I can connect you with someone on the team whenever you'd like."

TONE — match the email casual tone:
- Plain sentences, contractions (I'll, we're, don't, can't).
- NEVER open with "Thank you for reaching out", "Great question", "Certainly", or "Of course".
- NEVER close with "Is there anything else I can help you with" or "Please don't hesitate".
- Use the caller's name if you have it. Reference something specific they mentioned.
- Light humor about safe shared things (weather, the day) is fine. Never about their concern.
- Don't pre-empt edge cases — answer what they asked, stop there.

TRANSFER OFFER PHRASING:
- Default: "Want me to put you through to someone on the team?"
- Compliance/enforcement: "That one touches our enforcement process — let me put you through to make sure the right person handles it."
- Distressed caller: "I hear you. Let me put you through to someone right now."

${callerBlock}${communityBlock}${playbookBlock}${docBlock}

Answer the next message conversationally and briefly.`;
}

module.exports = { streamTurn, flushSentences, buildVoiceSystemPrompt };
