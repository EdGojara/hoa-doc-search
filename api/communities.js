// ============================================================================
// Community Profile + Facts API
// ----------------------------------------------------------------------------
// Mounted at /api/community-profile (server.js).
//
// Routes:
//   GET   /:communityId/full              — profile + facts + computed in one
//   GET   /:communityId/profile           — structured JSONB profile
//   PATCH /:communityId/profile           — merge-update profile fields
//   GET   /:communityId/facts             — list facts (active + expired)
//   POST  /:communityId/facts             — create a new fact (re-embed)
//   PATCH /facts/:factId                  — update a fact (re-embed if text changed)
//   POST  /facts/:factId/mark-current     — bump last_updated_at + clear needs_review
//   DELETE /facts/:factId                 — soft delete (actually deletes for now)
//   GET   /:communityId/computed          — auto-pulled facts from existing tables
//                                             (current landscape vendor, etc.)
//
// All endpoints scoped to BEDROCK_MGMT_CO_ID for now (single-tenant).
// ============================================================================

const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Separate multer config for design-guidelines upload — bigger limit since
// recorded DGs run 500KB-2MB and Exhibit B docs can be larger. Up to 5 files
// per upload (DG + Exhibit B + amendments + cover letter etc.).
const designGuidelinesUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 5 },
});

const DESIGN_DOC_BUCKET = 'documents';
const BEDROCK_MGMT_CO_ID_DG = '00000000-0000-0000-0000-000000000001';

const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';
const EMBEDDING_MODEL = 'text-embedding-ada-002';

const router = express.Router();

// ----------------------------------------------------------------------------
// POST /extract-contact-from-email
// Body: { email_text }
// Returns: { ok, contact: { vendor_name, vendor_category, contact_name, role,
//                            phone, email, notes } }
// Used by the Profile → Contacts UI to pre-fill the structured contact form
// from a pasted email (or signature block). The model returns ONLY JSON; any
// field can be null if the email doesn't mention it.
// ----------------------------------------------------------------------------
router.post('/extract-contact-from-email', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const { email_text } = req.body || {};
    if (!email_text || email_text.trim().length < 20) {
      return res.status(400).json({ error: 'Provide the email text (at least 20 characters).' });
    }

    const system =
      "You extract a single business contact from an email body or signature block. " +
      "Output ONLY a JSON object — no prose, no markdown fences — with these keys " +
      "(use null when the email does not mention them):\n" +
      "  vendor_name: company name\n" +
      "  vendor_category: one of pool|landscape|security|gate|electrical|plumbing|hvac|pest_control|irrigation|cleaning|attorney|accountant|insurance|banking|board_member|onsite_staff|other\n" +
      "  contact_name: full name of the person\n" +
      "  role: title or role (e.g., 'Account manager')\n" +
      "  phone: formatted as 281-555-0100 (US 10-digit). If multiple, pick the most-likely-primary.\n" +
      "  email: best email address\n" +
      "  notes: anything useful that isn't already captured — license number, after-hours line, backup contact, scope of service, etc.\n" +
      "Never fabricate. If unsure of vendor_category, use 'other'.";

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system,
      messages: [{ role: 'user', content: 'Email:\n\n' + email_text }],
    });

    const raw = (response.content?.[0]?.text || '').trim();
    let contact = {};
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      contact = JSON.parse(m ? m[0] : raw);
    } catch (e) {
      console.warn('[extract-contact] JSON parse failed:', e.message);
    }

    res.json({ ok: true, contact });
  } catch (err) {
    console.error('[extract-contact-from-email] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

async function embed(text) {
  if (!text || !text.trim()) return null;
  const r = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.replace(/\n+/g, ' ').slice(0, 8000)
  });
  return r.data[0].embedding;
}

// Build the "computed facts" — pulls from existing tables to produce
// fact-shaped objects so the UI can show them alongside manual entries.
async function getComputedFacts(communityId) {
  const out = [];

  // 1) Current vendors by service category (active vendor_contracts)
  try {
    const { data: contracts } = await supabase
      .from('vendor_contracts')
      .select(`
        id, service_category, status, contract_start_date, contract_end_date,
        vendor:vendors(id, name, primary_contact_name, primary_contact_email, primary_contact_phone)
      `)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .eq('community_id', communityId)
      .eq('status', 'active');

    for (const c of contracts || []) {
      const v = c.vendor || {};
      out.push({
        kind: 'computed',
        source: 'vendor_contracts',
        source_ref: `vendor_contracts:${c.id}`,
        category: 'vendor',
        key: `current_vendor_${c.service_category}`,
        label: `Current ${c.service_category} vendor`,
        value: v.name || '(no name)',
        details: {
          vendor_name: v.name,
          contact_name: v.primary_contact_name,
          email: v.primary_contact_email,
          phone: v.primary_contact_phone,
          contract_id: c.id,
          contract_start: c.contract_start_date,
          contract_end: c.contract_end_date
        },
        last_updated_at: c.contract_start_date || null,
        expires_at: c.contract_end_date || null
      });
    }
  } catch (err) {
    console.warn('[community-profile] computed vendors failed:', err.message);
  }

  return out;
}

// Apply a manual override on top of a computed fact: if a manual community_facts
// row exists with the same key, hide the computed version and prefer the manual.
function mergeComputedAndManual(computed, manualFacts) {
  const manualKeys = new Set(manualFacts.map((f) => f.key));
  const filteredComputed = computed.filter((c) => !manualKeys.has(c.key));
  return { computed: filteredComputed, manual: manualFacts };
}

// ----------------------------------------------------------------------------
// GET / — minimal list for admin pickers (id, name, slug, builder_arc_active)
// ----------------------------------------------------------------------------
router.get('/', async (_req, res) => {
  try {
    const { data, error } = await supabase.from('communities')
      .select('id, name, slug, builder_arc_active, active')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('name', { ascending: true });
    if (error) throw error;
    res.json({ communities: data || [] });
  } catch (err) {
    console.error('[community-profile] / list failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /:communityId/full — everything in one call (for the admin page)
// ----------------------------------------------------------------------------
router.get('/:communityId/full', async (req, res) => {
  try {
    const { communityId } = req.params;

    // Try the full select first; if a not-yet-run migration leaves columns
    // absent, fall back to a minimal select so the page still loads.
    async function loadCommunity() {
      try {
        const r = await supabase.from('communities')
          .select('id, name, slug, legal_name, total_lots, vantaca_code, profile, active, fines_enabled, letter_sender_name, letter_sender_title, letter_fee_courtesy_1_cents, letter_fee_courtesy_2_cents, letter_fee_certified_209_cents, letter_fee_fine_assessed_cents, letter_cure_days_courtesy_1, letter_cure_days_courtesy_2, letter_cure_days_certified_209, letter_payment_url, letter_pay_to_name, letter_pay_to_address, enforcement_authority_citation, bundle_certified_letters_separately, declaration_doc_number, declaration_county, declaration_short_name, force_mow_section_full, cleanup_section_full, force_mow_admin_fee_cents, builder_arc_standards, logo_storage_path, logo_mime_type, logo_width, logo_height, logo_uploaded_at, brand_primary_color, brand_accent_color, brand_text_on_primary, logo_height_px, signoff_signature')
          .eq('id', communityId).single();
        if (r.error) throw r.error;
        return r;
      } catch (_) {
        return supabase.from('communities')
          .select('id, name, slug, legal_name, total_lots, vantaca_code, profile, active')
          .eq('id', communityId).single();
      }
    }
    const [communityResp, factsResp, computed] = await Promise.all([
      loadCommunity(),
      supabase.from('v_community_facts')
        .select('*')
        .eq('community_id', communityId)
        .order('category', { ascending: true })
        .order('label', { ascending: true }),
      getComputedFacts(communityId)
    ]);

    if (communityResp.error) throw communityResp.error;
    if (factsResp.error) throw factsResp.error;
    const community = communityResp.data;

    const manualFacts = factsResp.data || [];
    const merged = mergeComputedAndManual(computed, manualFacts);

    // Sign the logo URL so the Settings UI can render an immediate preview
    // without a separate round-trip. Expires in 24h; UI re-fetches on each
    // community selection anyway.
    let logo_preview_url = null;
    if (community && community.logo_storage_path) {
      try {
        const { data: signed } = await supabase.storage
          .from('documents').createSignedUrl(community.logo_storage_path, 60 * 60 * 24);
        if (signed) logo_preview_url = signed.signedUrl;
      } catch (_) {}
    }

    res.json({
      community,
      profile: community?.profile || {},
      facts: merged.manual,
      computed_facts: merged.computed,
      logo_preview_url,
    });
  } catch (err) {
    console.error('[community-profile] /full failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /:communityId/logo — upload the community logo image. PNG / JPG.
// Stored at community_assets/<id>/logo.<ext> in the 'documents' bucket.
// Path + dimensions persisted on the community row so the renderer can do
// aspect-ratio math without re-decoding on every packet.
// ----------------------------------------------------------------------------
router.post('/:communityId/logo', upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'logo file is required (multipart field "logo")' });
    const mt = req.file.mimetype || '';
    const allowed = ['image/png', 'image/jpeg', 'image/jpg'];
    if (!allowed.includes(mt)) {
      return res.status(400).json({ error: `unsupported mime type ${mt} — PNG or JPG only` });
    }
    const ext = mt.includes('png') ? 'png' : 'jpg';
    const storagePath = `community_assets/${req.params.communityId}/logo.${ext}`;
    const { error: upErr } = await supabase.storage
      .from('documents')
      .upload(storagePath, req.file.buffer, { contentType: mt, upsert: true });
    if (upErr) return res.status(500).json({ error: `storage: ${upErr.message}` });

    // Decode dimensions (best-effort; needed for aspect-ratio math in renderer).
    // Uses node-canvas if available, falls back to null dims.
    let width = null, height = null;
    try {
      const { loadImage } = require('canvas');
      const img = await loadImage(req.file.buffer);
      width = img.width;
      height = img.height;
    } catch (_) {}

    const { data, error: dbErr } = await supabase
      .from('communities')
      .update({
        logo_storage_path: storagePath,
        logo_mime_type:    mt,
        logo_width:        width,
        logo_height:       height,
        logo_uploaded_at:  new Date().toISOString(),
      })
      .eq('id', req.params.communityId)
      .select('id, logo_storage_path, logo_mime_type, logo_width, logo_height, logo_uploaded_at')
      .single();
    if (dbErr) throw dbErr;

    // Return a 24-hour signed URL so the UI can render an immediate preview.
    let preview_url = null;
    try {
      const { data: signed } = await supabase.storage.from('documents').createSignedUrl(storagePath, 60 * 60 * 24);
      if (signed) preview_url = signed.signedUrl;
    } catch (_) {}

    res.json({ ok: true, community: data, preview_url });
  } catch (err) {
    console.error('[community-profile] logo upload failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// DELETE /:communityId/logo — remove the community logo
// ----------------------------------------------------------------------------
router.delete('/:communityId/logo', async (req, res) => {
  try {
    const { data: comm } = await supabase
      .from('communities').select('logo_storage_path').eq('id', req.params.communityId).maybeSingle();
    if (comm && comm.logo_storage_path) {
      try { await supabase.storage.from('documents').remove([comm.logo_storage_path]); } catch (_) {}
    }
    await supabase.from('communities').update({
      logo_storage_path: null, logo_mime_type: null, logo_width: null, logo_height: null, logo_uploaded_at: null,
    }).eq('id', req.params.communityId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[community-profile] logo delete failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// PATCH /:communityId/letter-config — letter generator + enforcement config
// Fields are top-level columns on the communities row (not the profile JSONB).
// Used by the Community Settings UI for letter fees, cure days, sender,
// payment routing (lockbox), and the fines master toggle.
// ----------------------------------------------------------------------------
router.patch('/:communityId/letter-config', express.json(), async (req, res) => {
  try {
    const { communityId } = req.params;
    const body = req.body || {};

    // Whitelist editable columns + coerce types
    const allowed = {
      fines_enabled:                     (v) => v === true || v === 'true',
      letter_sender_name:                (v) => String(v || '').trim() || null,
      letter_sender_title:               (v) => String(v || '').trim() || null,
      letter_payment_url:                (v) => String(v || '').trim() || null,
      letter_pay_to_name:                (v) => String(v || '').trim() || null,
      letter_pay_to_address:             (v) => String(v || '').trim() || null,
      letter_fee_courtesy_1_cents:       (v) => Math.max(0, Math.round(Number(v) || 0)),
      letter_fee_courtesy_2_cents:       (v) => Math.max(0, Math.round(Number(v) || 0)),
      letter_fee_certified_209_cents:    (v) => Math.max(0, Math.round(Number(v) || 0)),
      letter_fee_fine_assessed_cents:    (v) => Math.max(0, Math.round(Number(v) || 0)),
      letter_cure_days_courtesy_1:       (v) => Math.max(1, Math.round(Number(v) || 20)),
      letter_cure_days_courtesy_2:       (v) => Math.max(1, Math.round(Number(v) || 20)),
      letter_cure_days_certified_209:    (v) => Math.max(1, Math.round(Number(v) || 30)),
      enforcement_authority_citation:    (v) => String(v || '').trim() || null,
      // §209 bundling-opt-out (migration 133). TRUE = each letter_209
      // (certified + fine_assessed) gets its own letter + envelope.
      // Courtesy stages still combine. Default FALSE preserves existing
      // combined behavior.
      bundle_certified_letters_separately: (v) => v === true || v === 'true',
      // Force-mow Declaration citation (migration 126 columns) — required
      // before the lawn_force_mow_10day letter dispatch can render. One
      // row per community in the portfolio.
      declaration_doc_number:            (v) => String(v || '').trim() || null,
      declaration_county:                (v) => String(v || '').trim() || null,
      declaration_short_name:            (v) => String(v || '').trim() || null,
      force_mow_section_full:            (v) => String(v || '').trim() || null,
      // Trash/debris self-help authority (migration 269) — separate article
      // from force-mow; the 10-day cleanup letter cites this, no fallback.
      cleanup_section_full:              (v) => String(v || '').trim() || null,
      force_mow_admin_fee_cents:         (v) => Math.max(0, Math.round(Number(v) || 0)),
      // Structured Builder ARC standards (migration 135). JSONB; the UI
      // sends an object or a JSON-encoded string. AI review pipeline reads
      // this before falling back to the Design Guidelines PDF.
      builder_arc_standards:             (v) => {
        if (v && typeof v === 'object' && !Array.isArray(v)) return v;
        if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) { return {}; } }
        return {};
      },
    };

    const patch = { updated_at: new Date().toISOString() };
    for (const [k, coerce] of Object.entries(allowed)) {
      if (k in body) patch[k] = coerce(body[k]);
    }

    if (Object.keys(patch).length === 1) {
      return res.status(400).json({ error: 'no editable fields provided' });
    }

    const { data: updated, error: setErr } = await supabase
      .from('communities')
      .update(patch)
      .eq('id', communityId)
      .select('id, fines_enabled, letter_sender_name, letter_sender_title, letter_fee_courtesy_1_cents, letter_fee_courtesy_2_cents, letter_fee_certified_209_cents, letter_fee_fine_assessed_cents, letter_cure_days_courtesy_1, letter_cure_days_courtesy_2, letter_cure_days_certified_209, letter_payment_url, letter_pay_to_name, letter_pay_to_address, enforcement_authority_citation, bundle_certified_letters_separately, declaration_doc_number, declaration_county, declaration_short_name, force_mow_section_full, cleanup_section_full, force_mow_admin_fee_cents, builder_arc_standards')
      .single();
    if (setErr) throw setErr;

    res.json({ ok: true, community: updated });
  } catch (err) {
    console.error('[community-profile] PATCH /letter-config failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// PATCH /:communityId/brand-kit — community brand colors + signoff + logo height
// Body: { brand_primary_color?, brand_accent_color?, brand_text_on_primary?,
//         logo_height_px?, signoff_signature? }
//
// Ed 2026-06-08 — Bedrock-as-invisible-plumbing principle. Each community
// owns its visual identity on customer-facing artifacts (emails first,
// portal + PDFs next). This endpoint is the staff-facing setter.
// Logo upload goes through POST /:communityId/logo (existing endpoint).
// ----------------------------------------------------------------------------
router.patch('/:communityId/brand-kit', express.json(), async (req, res) => {
  try {
    const { communityId } = req.params;
    const b = req.body || {};
    const HEX_RE = /^#[0-9a-fA-F]{6}$/;
    const allowed = {
      brand_primary_color:   (v) => {
        const s = String(v || '').trim();
        if (s === '' || s === null) return null;
        return HEX_RE.test(s) ? s.toLowerCase() : null;
      },
      brand_accent_color:    (v) => {
        const s = String(v || '').trim();
        if (s === '' || s === null) return null;
        return HEX_RE.test(s) ? s.toLowerCase() : null;
      },
      brand_text_on_primary: (v) => {
        const s = String(v || '').trim().toLowerCase();
        return (s === 'light' || s === 'dark') ? s : null;
      },
      logo_height_px:        (v) => {
        const n = Math.round(Number(v));
        if (!isFinite(n) || n < 12 || n > 200) return null;
        return n;
      },
      signoff_signature:     (v) => {
        const s = String(v || '').trim();
        return s ? s.slice(0, 200) : null;
      },
    };
    const updates = {};
    for (const [key, coerce] of Object.entries(allowed)) {
      if (key in b) updates[key] = coerce(b[key]);
    }
    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'no_brand_fields_provided' });
    }
    updates.updated_at = new Date().toISOString();
    const { data, error } = await supabase
      .from('communities')
      .update(updates)
      .eq('id', communityId)
      .select('id, brand_primary_color, brand_accent_color, brand_text_on_primary, logo_height_px, signoff_signature')
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ community: data });
  } catch (err) {
    console.error('[communities] brand-kit PATCH failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// PATCH /:communityId/profile — merge-update the profile JSONB
// Body: arbitrary fields to set/override (deep merge for objects, replace for scalars)
// ----------------------------------------------------------------------------
router.patch('/:communityId/profile', express.json(), async (req, res) => {
  try {
    const { communityId } = req.params;
    const updates = req.body || {};

    // Fetch existing profile, merge, write back
    const { data: existing, error: getErr } = await supabase
      .from('communities')
      .select('profile')
      .eq('id', communityId)
      .single();
    if (getErr) throw getErr;

    const merged = { ...(existing?.profile || {}), ...updates };

    const { data: updated, error: setErr } = await supabase
      .from('communities')
      .update({ profile: merged, updated_at: new Date().toISOString() })
      .eq('id', communityId)
      .select('id, profile')
      .single();
    if (setErr) throw setErr;

    res.json({ ok: true, profile: updated.profile });
  } catch (err) {
    console.error('[community-profile] PATCH /profile failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /:communityId/facts — create a fact
// Body: { category, key, label, value, details?, expires_at?, review_note? }
// ----------------------------------------------------------------------------
router.post('/:communityId/facts', express.json(), async (req, res) => {
  try {
    const { communityId } = req.params;
    const { category, key, label, value, details, expires_at, review_note } = req.body || {};
    if (!key || !value) return res.status(400).json({ error: 'key and value are required' });

    const embedding = await embed(`${label || key}. ${value}`);

    const { data, error } = await supabase
      .from('community_facts')
      .insert({
        community_id: communityId,
        category: category || null,
        key,
        label: label || null,
        value,
        details: details || null,
        expires_at: expires_at || null,
        review_note: review_note || null,
        source_type: 'manual',
        embedding
      })
      .select()
      .single();
    if (error) throw error;

    res.json({ ok: true, fact: data });
  } catch (err) {
    console.error('[community-profile] POST /facts failed:', err.message);
    // unique violation → fact with this key exists for this community
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A fact with that key already exists for this community. Use PATCH to update it.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// PATCH /facts/:factId — update a fact (re-embeds if text changed)
// Body: any subset of { category, label, value, details, expires_at, review_note }
// ----------------------------------------------------------------------------
router.patch('/facts/:factId', express.json(), async (req, res) => {
  try {
    const { factId } = req.params;
    const updates = req.body || {};

    // If value/label changed, re-embed.
    const patch = {};
    let willReembed = false;
    if ('category' in updates) patch.category = updates.category;
    if ('label' in updates) { patch.label = updates.label; willReembed = true; }
    if ('value' in updates) { patch.value = updates.value; willReembed = true; }
    if ('details' in updates) patch.details = updates.details;
    if ('expires_at' in updates) patch.expires_at = updates.expires_at;
    if ('review_note' in updates) patch.review_note = updates.review_note;

    patch.last_updated_at = new Date().toISOString();
    patch.needs_review = false;            // editing implicitly marks it fresh
    patch.manual_override = updates.manual_override ?? true;

    if (willReembed) {
      const { data: row } = await supabase
        .from('community_facts')
        .select('label, value')
        .eq('id', factId)
        .single();
      const label = patch.label ?? row?.label;
      const value = patch.value ?? row?.value;
      patch.embedding = await embed(`${label || ''}. ${value || ''}`);
    }

    const { data, error } = await supabase
      .from('community_facts')
      .update(patch)
      .eq('id', factId)
      .select()
      .single();
    if (error) throw error;

    res.json({ ok: true, fact: data });
  } catch (err) {
    console.error('[community-profile] PATCH /facts failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /facts/:factId/mark-current — bump freshness without changing value
// ----------------------------------------------------------------------------
router.post('/facts/:factId/mark-current', async (req, res) => {
  try {
    const { factId } = req.params;
    const { data, error } = await supabase
      .from('community_facts')
      .update({
        last_updated_at: new Date().toISOString(),
        needs_review: false
      })
      .eq('id', factId)
      .select()
      .single();
    if (error) throw error;
    res.json({ ok: true, fact: data });
  } catch (err) {
    console.error('[community-profile] mark-current failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// DELETE /facts/:factId
// ----------------------------------------------------------------------------
router.delete('/facts/:factId', async (req, res) => {
  try {
    const { factId } = req.params;
    const { error } = await supabase
      .from('community_facts')
      .delete()
      .eq('id', factId);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[community-profile] DELETE /facts failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /:communityId/ingest-design-guidelines — ingest PDFs as design_document
// for this community. Two modes via form field `supersede_current`:
//   "true"  → mark all existing current design_document rows as superseded
//             before ingesting (replace mode — for "wrong DG was ingested,
//             swap to the right one")
//   "false" → leave existing current rows in place (additive mode — for
//             "add a new amendment / exhibit alongside the original")
//
// Default behavior is supersede=true to match the original "replace" UX
// (and the route still answers to the legacy /replace-design-guidelines
// path below for backward compatibility).
//
// Multipart form: design_pdfs[] — up to 5 PDFs, 25MB each
//                 supersede_current=true|false
//
// Hash dedup: if a PDF with the same SHA-256 already exists in
// library_documents, reuses that row (just promotes it to status='current').
//
// Returns: { ok, mode, ingested: [{id, title, file_size_bytes}],
//            superseded: [{id, title}], skipped: [{file, reason}] }
// ----------------------------------------------------------------------------
async function _handleDesignGuidelinesIngest(req, res) {
    try {
      const { requireAdmin } = require('./users');
      const ctx = await requireAdmin(req, res);
      if (!ctx) return;

      const { communityId } = req.params;
      const files = req.files || [];
      if (files.length === 0) return res.status(400).json({ error: 'design_pdfs files required' });
      const supersedeCurrent = String(req.body?.supersede_current ?? 'true').toLowerCase() === 'true';

      // Resolve community for storage path + sanity check
      const { data: community, error: cErr } = await supabase.from('communities')
        .select('id, name, slug')
        .eq('id', communityId)
        .eq('management_company_id', BEDROCK_MGMT_CO_ID_DG)
        .maybeSingle();
      if (cErr) throw cErr;
      if (!community) return res.status(404).json({ error: 'community_not_found' });

      // Step 1: optionally supersede existing current design_document rows
      let superseded = [];
      if (supersedeCurrent) {
        const { data: supData, error: supErr } = await supabase
          .from('library_documents')
          .update({ status: 'superseded' })
          .eq('community_id', communityId)
          .eq('category', 'design_document')
          .eq('status', 'current')
          .select('id, title');
        if (supErr) throw supErr;
        superseded = supData || [];
      }

      // Step 2: ingest each new PDF
      const ingested = [];
      const skipped = [];
      for (const file of files) {
        const filename = file.originalname || 'design.pdf';
        if (file.mimetype !== 'application/pdf') {
          skipped.push({ file: filename, reason: `not a PDF (got ${file.mimetype})` });
          continue;
        }
        try {
          const fileHash = require('crypto').createHash('sha256').update(file.buffer).digest('hex');

          // Hash dedup: if this exact PDF is already in library_documents,
          // just promote it to current for this community (works whether it
          // was previously superseded or attached to a different community).
          const { data: existing } = await supabase
            .from('library_documents')
            .select('id, title, file_path, status, community_id')
            .eq('file_hash', fileHash)
            .maybeSingle();

          if (existing) {
            await supabase.from('library_documents').update({
              status: 'current',
              community_id: communityId,
              category: 'design_document',
              uploaded_at: new Date().toISOString(),
            }).eq('id', existing.id);
            ingested.push({ id: existing.id, title: existing.title || filename, reused: true });
            continue;
          }

          // New file — upload + insert
          const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
          const stamp = Date.now() + '-' + Math.floor(Math.random() * 10000);
          const storagePath = `communities/${community.slug || communityId}/design-guidelines/${stamp}_${safeName}`;
          const { error: upErr } = await supabase.storage.from(DESIGN_DOC_BUCKET)
            .upload(storagePath, file.buffer, { contentType: 'application/pdf', upsert: false });
          if (upErr) { skipped.push({ file: filename, reason: 'storage upload: ' + upErr.message }); continue; }

          const { data: doc, error: insErr } = await supabase.from('library_documents').insert({
            management_company_id: BEDROCK_MGMT_CO_ID_DG,
            community_id: communityId,
            category: 'design_document',
            title: `${community.name} — ${filename.replace(/\.pdf$/i, '')}`,
            file_path: storagePath,
            file_name_original: filename,
            file_name_normalized: `${(community.slug || 'community')}-${safeName}`,
            file_hash: fileHash,
            file_size_bytes: file.size,
            status: 'current',
            index_status: 'pending',
            uploaded_at: new Date().toISOString(),
          }).select('id, title').single();
          if (insErr) {
            try { await supabase.storage.from(DESIGN_DOC_BUCKET).remove([storagePath]); } catch (_) {}
            skipped.push({ file: filename, reason: 'db insert: ' + insErr.message });
            continue;
          }
          ingested.push({ id: doc.id, title: doc.title, file_size_bytes: file.size, reused: false });
        } catch (perFileErr) {
          skipped.push({ file: filename, reason: perFileErr.message });
        }
      }

      res.json({
        ok: true,
        mode: supersedeCurrent ? 'replace' : 'add',
        community: { id: community.id, name: community.name },
        ingested,
        superseded,
        skipped,
      });
    } catch (err) {
      console.error('[community-profile] ingest-design-guidelines failed:', err.message);
      res.status(500).json({ error: err.message });
    }
}

// Canonical route name + backward-compat alias for the original /replace path
router.post('/:communityId/ingest-design-guidelines',
  designGuidelinesUpload.array('design_pdfs', 5),
  _handleDesignGuidelinesIngest);
router.post('/:communityId/replace-design-guidelines',
  designGuidelinesUpload.array('design_pdfs', 5),
  _handleDesignGuidelinesIngest);

// ----------------------------------------------------------------------------
// GET /:communityId/library-audit — what library_documents exist for this
// community, grouped by category. Compares against the canonical category
// list and flags expected categories that are missing (so the operator
// knows "this community has no current bylaws on file" without scanning).
// ----------------------------------------------------------------------------
router.get('/:communityId/library-audit', async (req, res) => {
  try {
    const { requireAdmin } = require('./users');
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;
    const { communityId } = req.params;

    // 1. Pull all library_documents for this community (any status — caller
    //    sees current + superseded counts so they can spot stale state)
    const { data: docs, error: docsErr } = await supabase
      .from('library_documents')
      .select('id, category, title, file_name_original, status, effective_date, expiration_date, uploaded_at, file_size_bytes')
      .eq('community_id', communityId)
      .order('category', { ascending: true })
      .order('uploaded_at', { ascending: false });
    if (docsErr) throw docsErr;

    // 2. Pull category catalog so the response can label & sort
    const { data: cats, error: catsErr } = await supabase
      .from('document_categories')
      .select('category, display_name, required_for_resale, typical_frequency, sort_order')
      .order('sort_order');
    if (catsErr) throw catsErr;
    const catByKey = Object.fromEntries((cats || []).map((c) => [c.category, c]));

    // 3. Group docs by category
    const byCategory = {};
    for (const d of (docs || [])) {
      (byCategory[d.category] ||= []).push(d);
    }

    // 4. Build response: every canonical category gets a row (present or
    //    missing). Plus any "unknown" categories that aren't in the catalog.
    const categories = (cats || []).map((c) => {
      const items = byCategory[c.category] || [];
      const currentCount = items.filter((i) => i.status === 'current').length;
      return {
        category: c.category,
        display_name: c.display_name,
        required_for_resale: c.required_for_resale,
        typical_frequency: c.typical_frequency,
        sort_order: c.sort_order,
        total_count: items.length,
        current_count: currentCount,
        missing: items.length === 0,
        items,
      };
    });

    // Unknown / extra categories that appear in library_documents but aren't
    // in the catalog — surface them so we know to add them or recategorize.
    const unknownCats = Object.keys(byCategory).filter((k) => !catByKey[k]);
    for (const k of unknownCats) {
      categories.push({
        category: k,
        display_name: k,
        required_for_resale: false,
        typical_frequency: 'unknown',
        sort_order: 9999,
        total_count: byCategory[k].length,
        current_count: byCategory[k].filter((i) => i.status === 'current').length,
        missing: false,
        items: byCategory[k],
        unknown_category: true,
      });
    }

    res.json({
      ok: true,
      community_id: communityId,
      total_documents: (docs || []).length,
      current_documents: (docs || []).filter((d) => d.status === 'current').length,
      missing_required_for_resale: categories.filter((c) => c.required_for_resale && c.missing).map((c) => c.category),
      categories,
    });
  } catch (err) {
    console.error('[community-profile] /library-audit failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /:communityId/computed — just the computed facts (no manual overlay)
// ----------------------------------------------------------------------------
router.get('/:communityId/computed', async (req, res) => {
  try {
    const computed = await getComputedFacts(req.params.communityId);
    res.json({ computed_facts: computed });
  } catch (err) {
    console.error('[community-profile] /computed failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// Helper for server.js: build a prompt-ready context block for a community
// ----------------------------------------------------------------------------
async function buildCommunityContextBlock(communityNameOrId) {
  if (!communityNameOrId) return '';

  // Resolve community
  const q = supabase.from('communities')
    .select('id, name, total_lots, profile')
    .eq('management_company_id', BEDROCK_MGMT_CO_ID)
    .limit(1);
  const isUuid = /^[0-9a-f-]{36}$/i.test(communityNameOrId);
  const { data: comm } = await (isUuid
    ? q.eq('id', communityNameOrId).maybeSingle()
    : q.eq('name', communityNameOrId).maybeSingle());
  if (!comm) return '';

  const profile = comm.profile || {};
  const lines = [];
  lines.push(`COMMUNITY PROFILE — ${comm.name}`);
  if (comm.total_lots) lines.push(`  Total homes/lots: ${comm.total_lots}`);
  for (const [k, v] of Object.entries(profile)) {
    if (v == null || v === '') continue;
    const label = k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    if (typeof v === 'object') {
      lines.push(`  ${label}: ${JSON.stringify(v)}`);
    } else {
      lines.push(`  ${label}: ${v}`);
    }
  }

  // Active manual facts (non-expired or recently-expired with override)
  const { data: facts } = await supabase
    .from('v_community_facts')
    .select('category, label, value, details, is_expired, last_updated_at, expires_at')
    .eq('community_id', comm.id)
    .order('category', { ascending: true });

  if (facts && facts.length > 0) {
    lines.push('');
    lines.push('COMMUNITY FACTS (operational — current as of dates shown)');
    for (const f of facts) {
      const stamp = f.expires_at ? ` [expires ${f.expires_at.slice(0, 10)}]` : '';
      const stale = f.is_expired ? ' [⚠ EXPIRED — verify before quoting]' : '';
      const label = f.label || f.category || 'note';
      lines.push(`  • ${label}: ${f.value}${stamp}${stale}`);
    }
  }

  // Computed facts (current vendors etc.) — only include those NOT shadowed by a manual override
  const computed = await getComputedFacts(comm.id);
  if (computed.length > 0) {
    const manualKeys = new Set((facts || []).map((f) => f.key));
    const visibleComputed = computed.filter((c) => !manualKeys.has(c.key));
    if (visibleComputed.length > 0) {
      lines.push('');
      lines.push('CURRENT VENDORS / SYSTEM-MAINTAINED');
      for (const c of visibleComputed) {
        const d = c.details || {};
        const contact = [d.contact_name, d.phone, d.email].filter(Boolean).join(' / ');
        lines.push(`  • ${c.label}: ${c.value}${contact ? ' — ' + contact : ''}`);
      }
    }
  }

  // Recent decisions (last 90 days) — gives AskEd the institutional-memory layer
  // that today only lives in inboxes.
  try {
    const sinceIso = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { data: decisions } = await supabase
      .from('community_decisions')
      .select('decision_summary, category, decided_at, decided_by')
      .eq('community_id', comm.id)
      .gte('decided_at', sinceIso)
      .order('decided_at', { ascending: false })
      .limit(15);
    if (decisions && decisions.length > 0) {
      lines.push('');
      lines.push('RECENT DECISIONS (last 90 days)');
      for (const d of decisions) {
        const when = d.decided_at ? new Date(d.decided_at).toISOString().slice(0, 10) : 'date unknown';
        const who = d.decided_by ? ` — ${d.decided_by}` : '';
        lines.push(`  • ${d.decision_summary} (${when}${who})`);
      }
    }
  } catch (_) { /* table may not exist yet; silent */ }

  // Amenities — pool hours, clubhouse, gates, key fobs. Without this block,
  // askEd / Claire have no idea about operational schedules. Bug surfaced
  // 2026-05-23 when Claire said "I don't have the pool hours for Waterview"
  // — they were sitting in the amenities table the whole time.
  try {
    const { data: amenities } = await supabase
      .from('amenities')
      .select('name, amenity_type, hours_text, contact_name, contact_phone, contact_email, description, is_rentable, offseason_hours_text, status')
      .eq('community_id', comm.id)
      .eq('status', 'active')
      .order('amenity_type', { ascending: true });
    if (amenities && amenities.length > 0) {
      lines.push('');
      lines.push('AMENITIES (operational schedule + contact — quote hours verbatim, do not paraphrase)');
      for (const a of amenities) {
        const parts = [];
        if (a.hours_text) parts.push(`hours: ${a.hours_text}`);
        if (a.offseason_hours_text) parts.push(`off-season: ${a.offseason_hours_text}`);
        if (a.contact_name) parts.push(a.contact_name);
        if (a.contact_phone) parts.push(`phone: ${a.contact_phone}`);
        if (a.contact_email) parts.push(`email: ${a.contact_email}`);
        if (a.is_rentable) parts.push('reservable');
        if (a.description) parts.push(a.description);
        const detail = parts.length > 0 ? ` — ${parts.join(' · ')}` : '';
        lines.push(`  • ${a.name}${a.amenity_type ? ` (${a.amenity_type})` : ''}${detail}`);
      }
    }
  } catch (_) { /* silent */ }

  // Community contacts directory — vendor phone numbers, key personnel,
  // utility lookups. Without this, Claire can't answer "what's the pool
  // company phone" or "who do I call about trash?" These are in their own
  // table (community_contacts), separate from `current vendors / system-
  // maintained` above which is computed from contracts.
  try {
    const { data: contacts } = await supabase
      .from('community_contacts')
      .select('name, category, phone, email, notes, is_published')
      .eq('community_id', comm.id)
      .eq('is_published', true)
      .order('category', { ascending: true });
    if (contacts && contacts.length > 0) {
      lines.push('');
      lines.push('LOCAL CONTACTS (vendor + utility directory — quote phone numbers verbatim)');
      for (const c of contacts) {
        const parts = [];
        if (c.phone) parts.push(c.phone);
        if (c.email) parts.push(c.email);
        if (c.notes) parts.push(c.notes);
        const detail = parts.length > 0 ? ` — ${parts.join(' · ')}` : '';
        lines.push(`  • ${c.name}${c.category ? ` (${c.category})` : ''}${detail}`);
      }
    }
  } catch (_) { /* silent */ }

  // Upcoming + recently-completed events — so AskEd knows about the pool party
  // when a homeowner asks "is there a community event coming up?"
  try {
    const now = new Date();
    const past30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const future60 = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000).toISOString();
    const { data: events } = await supabase
      .from('events')
      .select('name, event_type, location, scheduled_start_at, status')
      .eq('community_id', comm.id)
      .gte('scheduled_start_at', past30)
      .lte('scheduled_start_at', future60)
      .order('scheduled_start_at', { ascending: true })
      .limit(10);
    if (events && events.length > 0) {
      lines.push('');
      lines.push('EVENTS (recent + upcoming, ±30/60 days)');
      for (const e of events) {
        const when = new Date(e.scheduled_start_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const where = e.location ? ` at ${e.location}` : '';
        lines.push(`  • ${e.name} — ${when}${where} [${e.status}]`);
      }
    }
  } catch (_) { /* silent */ }

  // Historical ACC decisions — INFORMATIONAL CONTEXT ONLY, not precedent.
  // We surface the 10 most recent decisions so AskEd has a sense of what
  // this community has approved/denied in the past. Semantic matching of
  // specific applications happens in the AI assessment engine route.
  try {
    const { data: arcDecisions } = await supabase
      .from('arc_historical_decisions')
      .select('property_address, project_type, decision_type, decided_at, summary, conditions')
      .eq('community_id', comm.id)
      .order('decided_at', { ascending: false, nullsFirst: false })
      .limit(10);
    if (arcDecisions && arcDecisions.length > 0) {
      lines.push('');
      lines.push('HISTORICAL ACC DECISIONS (informational context only — NOT binding precedent. Current governing documents are the authority.)');
      for (const d of arcDecisions) {
        const when = d.decided_at ? new Date(d.decided_at).toISOString().slice(0, 10) : 'date unknown';
        const tag = d.decision_type ? d.decision_type.toUpperCase() : '?';
        const cond = d.conditions ? ` [conditions: ${d.conditions.slice(0, 80)}${d.conditions.length > 80 ? '…' : ''}]` : '';
        lines.push(`  • [${tag}] ${when} — ${d.project_type || 'project'} at ${d.property_address || 'address unknown'}: ${d.summary || ''}${cond}`);
      }
    }
  } catch (_) { /* silent */ }

  return lines.join('\n');
}

module.exports = { router, buildCommunityContextBlock };
