// ============================================================================
// lib/team/attachment_vision.js  (Ed 2026-08-29)
// ----------------------------------------------------------------------------
// Give the team EYES. When a resident attaches a photo (or video still), the
// drafter must actually look at it before writing — and above all before citing
// anything. The 5943 Baldwin Elm dog case is why: a human glanced, misread a
// bench in the driveway as the dog's enclosure, and cited the wrong covenant. A
// citation grounded in a glance (or in text alone) is the failure mode.
//
// describeMessageImages() loads the stored image attachments for a message and
// returns a FACTUAL description of what's visible — objects and their location —
// with no speculation about intent, legality, or which rule applies. That read
// feeds the draft as evidence; grounds-before-action then cites only what the
// image actually supports. Fail-soft: any problem returns '' so drafting is
// never blocked by vision.
// ============================================================================

const IMAGE_MEDIA = { 'image/jpeg': 'image/jpeg', 'image/jpg': 'image/jpeg', 'image/png': 'image/png', 'image/gif': 'image/gif', 'image/webp': 'image/webp' };
const MAX_IMAGES = 4;
const MAX_BYTES = 4.5 * 1024 * 1024;

const VISION_SYSTEM = `You are assisting an HOA management team reviewing a resident's photo. Describe ONLY what is factually visible and could matter for property standards or a welfare concern: the objects present, WHERE each is (front yard, driveway, garage, porch, curb, street, backyard if shown), and their visible condition. Name concrete things — a vehicle, furniture, a cage or crate, trash/debris, a structure, an animal, a sign. Be neutral and precise. Do NOT guess intent, do NOT say whether a rule is violated, do NOT interpret the law. 2 to 5 sentences.`;

async function _blockFromStored(supabase, att) {
  try {
    const media = IMAGE_MEDIA[String(att.mime || '').toLowerCase().split(';')[0].trim()];
    if (!media) return null;
    const { data, error } = await supabase.storage.from('documents').download(att.storage_path);
    if (error || !data) return null;
    const buf = Buffer.from(await data.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) return null;
    return { type: 'image', source: { type: 'base64', media_type: media, data: buf.toString('base64') } };
  } catch (_) { return null; }
}

// Returns { description, imageCount, filenames } — description is '' when there's
// nothing to see or vision is unavailable.
async function describeMessageImages(supabase, messageId, { mailbox, graphId } = {}) {
  const empty = { description: '', imageCount: 0, filenames: [] };
  if (!supabase || (!messageId && !graphId)) return empty;

  let blocks = []; let filenames = [];
  try {
    if (messageId) {
      const { data, error } = await supabase.from('email_attachments')
        .select('filename, mime, storage_path, is_image').eq('email_message_id', messageId).eq('is_image', true).limit(MAX_IMAGES);
      if (!error && data && data.length) {
        for (const att of data) {
          const b = await _blockFromStored(supabase, att);
          if (b) { blocks.push(b); filenames.push(att.filename); }
        }
      }
    }
    // Fallback to a live Graph fetch (e.g. an inbound not yet archived).
    if (!blocks.length && graphId && mailbox) {
      try {
        const { fetchAttachmentBlocks } = require('../email/graph_attachments');
        const res = await fetchAttachmentBlocks(mailbox, graphId);
        blocks = (res.blocks || []).filter((b) => b.type === 'image').slice(0, MAX_IMAGES);
      } catch (_) { /* ignore */ }
    }
    if (!blocks.length) return empty;

    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 400, system: VISION_SYSTEM,
      messages: [{ role: 'user', content: [...blocks, { type: 'text', text: 'Describe what is visible in the attached photo(s).' }] }],
    });
    const description = (resp.content || []).map((b) => b.text || '').join('').trim();
    return { description, imageCount: blocks.length, filenames };
  } catch (e) {
    console.warn('[attachment_vision] describe failed:', e.message);
    return empty;
  }
}

module.exports = { describeMessageImages };
