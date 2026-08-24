// ============================================================================
// Welcome Packets API — the new-homeowner packet (mounted at /api/welcome)
// ----------------------------------------------------------------------------
// Ed 2026-08-24: "a new homeowner welcome packet in trusted for each community
// except eaglewood ... lets look at where we do resales and transfers and i
// think it should go there."
//
// It lives beside Home Sales because the closing IS the trigger. POST
// /api/home-sales/record-closing is the one moment the platform knows a new
// person owns a specific lot, and a packet that depends on somebody remembering
// is a packet that goes out for the diligent closings and not the busy ones.
//
// "except Eaglewood" is a lifecycle decision, not a name in this file. See
// lib/community/lifecycle.js — canDo('welcome') refuses while a community is
// terminating, which is what Eaglewood is until 2026-09-30. The refusal moves
// on its own when the facts move.
//
// Four routes, one pipeline:
//   GET  /preview      the bundle + readiness (what will print, what is missing)
//   GET  /preview.html the rendered packet, on screen
//   GET  /pdf          the same render through Chrome
//   POST /send         PDF -> storage -> email -> interactions (the record)
//
// Nothing auto-sends. The operator sees the packet and the gaps first, which is
// the same supervise-the-exception posture the rest of the platform runs on.
// ============================================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { assembleWelcomePacket } = require('../lib/welcome/assemble');
const { renderWelcomePacketHTML, renderWelcomeLetterHTML } = require('../lib/welcome/render');
const { SECTION_BY_KEY, SECTION_KEYS } = require('../lib/welcome/sections');
const { sendOutboundCorrespondence } = require('../lib/correspondence/dual_rail');
const BRAND = require('../lib/brand');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const router = express.Router();

// The QR on the printed letter points HERE, not at a live magic link — a start
// page where the owner enters their email and gets the link on a click. A live
// authenticated link on paper mail would sign in anyone who sees the envelope.
// (feedback_no_auto_consume_magic_links.)
function startUrl() {
  const base = (process.env.TRUSTED_URL || BRAND.service.websiteUrl || '').replace(/\/$/, '');
  return base ? `${base}/portal-login.html` : 'portal-login.html';
}

// Build the letter (QR generated server-side) from an assembled bundle.
async function renderLetter(bundle, mode) {
  const QRCode = require('qrcode');
  const url = startUrl();
  let qrDataUrl = null;
  try {
    qrDataUrl = await QRCode.toDataURL(url, { width: 360, margin: 1, color: { dark: '#0B1D34', light: '#FFFFFF' } });
  } catch (e) {
    // A letter without the QR is still a good letter; the URL prints under it.
    console.warn('[welcome] QR generation failed:', e.message);
  }
  return renderWelcomeLetterHTML(bundle, { qrDataUrl, startUrl: url, mode });
}

// Chrome is expensive to boot and this is an on-demand operator action, so it
// launches per request and is always closed, including on the error path.
async function htmlToPdf(html) {
  const puppeteer = require('puppeteer');
  let browser = null;
  try {
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.emulateMediaType('print');
    return await page.pdf({ format: 'Letter', printBackground: true, preferCSSPageSize: true });
  } finally {
    if (browser) { try { await browser.close(); } catch (_) { /* already gone */ } }
  }
}

function slugify(s) {
  return String(s || 'packet').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

// The bundle every route starts from. Returns { bundle } or { httpStatus, body }.
async function loadBundle(q) {
  if (!q.community_id) return { httpStatus: 400, body: { error: 'community_id_required' } };
  if (!q.property_id) return { httpStatus: 400, body: { error: 'property_id_required' } };
  const bundle = await assembleWelcomePacket(supabase, {
    community_id: q.community_id,
    property_id: q.property_id,
    occasion: q.occasion,
    owner_name: q.owner_name,
    owner_email: q.owner_email,
    effective_date: q.effective_date,
  });
  if (!bundle.allowed) {
    // 404 for "these ids do not resolve", 409 for "we deliberately do not do
    // this for this community" — an operator needs to tell those apart.
    const notFound = ['community_not_found', 'property_not_found', 'property_not_in_community'];
    const status = notFound.indexOf(bundle.reason) !== -1 ? 404 : 409;
    return { httpStatus: status, body: { error: 'welcome_packet_unavailable', reason: bundle.reason } };
  }
  return { bundle };
}

// ----------------------------------------------------------------------------
// GET /api/welcome/preview?community_id&property_id[&owner_name&effective_date]
//   What will print, and what will not. The readiness half is the point: a
//   community with no contacts and no trash schedule produces a thin packet,
//   and the operator has to see that before the owner does.
// ----------------------------------------------------------------------------
router.get('/preview', async (req, res) => {
  try {
    const out = await loadBundle(req.query);
    if (out.httpStatus) return res.status(out.httpStatus).json(out.body);
    const b = out.bundle;
    res.json({
      community: { id: b.community.id, name: b.community.name },
      property: b.property,
      owner: b.owner,
      occasion: b.occasion,
      effective_date: b.effective_date,
      sections: b.sections,
      included: b.included.map((k) => ({ key: k, title: SECTION_BY_KEY[k].title })),
      missing: b.missing,
      // A section can print AND still have a gap inside it, so the denominator
      // is the section count, never included + missing.
      total_sections: SECTION_KEYS.length,
      ready: b.missing.filter((m) => m.required && !m.partial).length === 0,
    });
  } catch (err) {
    console.error('[welcome] preview failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /api/welcome/preview.html — the packet on screen, same renderer as the PDF
// ----------------------------------------------------------------------------
router.get('/preview.html', async (req, res) => {
  try {
    const out = await loadBundle(req.query);
    if (out.httpStatus) return res.status(out.httpStatus).type('html').send(`<p style="font-family:sans-serif;padding:24px">${out.body.reason || out.body.error}</p>`);
    res.type('html').send(renderWelcomePacketHTML(out.bundle, { mode: 'screen' }));
  } catch (err) {
    console.error('[welcome] preview.html failed:', err.message);
    res.status(500).type('html').send('<p style="font-family:sans-serif;padding:24px">Could not build the packet.</p>');
  }
});

// ----------------------------------------------------------------------------
// GET /api/welcome/letter.html — the one-page cover letter on screen
// ----------------------------------------------------------------------------
router.get('/letter.html', async (req, res) => {
  try {
    const out = await loadBundle(req.query);
    if (out.httpStatus) return res.status(out.httpStatus).type('html').send(`<p style="font-family:sans-serif;padding:24px">${out.body.reason || out.body.error}</p>`);
    res.type('html').send(await renderLetter(out.bundle, 'screen'));
  } catch (err) {
    console.error('[welcome] letter.html failed:', err.message);
    res.status(500).type('html').send('<p style="font-family:sans-serif;padding:24px">Could not build the letter.</p>');
  }
});

// ----------------------------------------------------------------------------
// GET /api/welcome/letter.pdf — the cover letter, print-ready
// ----------------------------------------------------------------------------
router.get('/letter.pdf', async (req, res) => {
  try {
    const out = await loadBundle(req.query);
    if (out.httpStatus) return res.status(out.httpStatus).json(out.body);
    const b = out.bundle;
    const pdf = await htmlToPdf(await renderLetter(b, 'print'));
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="welcome-letter-${slugify(b.community.name)}-${slugify(b.property.street_address)}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('[welcome] letter.pdf failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /api/welcome/pdf — the packet through Chrome
// ----------------------------------------------------------------------------
router.get('/pdf', async (req, res) => {
  try {
    const out = await loadBundle(req.query);
    if (out.httpStatus) return res.status(out.httpStatus).json(out.body);
    const b = out.bundle;
    const pdf = await htmlToPdf(renderWelcomePacketHTML(b, { mode: 'print' }));
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="welcome-${slugify(b.community.name)}-${slugify(b.property.street_address)}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('[welcome] pdf failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /api/welcome/history?community_id[&property_id]  — what has gone out
// ----------------------------------------------------------------------------
router.get('/history', async (req, res) => {
  try {
    const { community_id, property_id } = req.query;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    let q = supabase.from('welcome_packets')
      .select('id, property_id, owner_name, property_address, occasion, status, sent_at, sent_to_email, sections_included, sections_missing, effective_date, created_at, storage_path')
      .eq('community_id', community_id)
      .order('created_at', { ascending: false })
      .limit(200);
    if (property_id) q = q.eq('property_id', property_id);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ packets: data || [] });
  } catch (err) {
    console.error('[welcome] history failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// POST /api/welcome/send
//   body: { community_id, property_id, to_email?, owner_name?, effective_date?,
//           occasion?, home_sale_id?, sent_by?, save_only? }
//
//   Order matters: render, store, RECORD, then deliver. If the email fails the
//   packet is still on file and the failure is visible, instead of a send we
//   believe happened because nothing said otherwise.
// ----------------------------------------------------------------------------
router.post('/send', express.json({ limit: '64kb' }), async (req, res) => {
  const b = req.body || {};
  try {
    const out = await loadBundle(b);
    if (out.httpStatus) return res.status(out.httpStatus).json(out.body);
    const bundle = out.bundle;

    const toEmail = (b.to_email || bundle.owner.email || '').trim() || null;
    const saveOnly = b.save_only === true || !toEmail;

    // 1) Render + store. The PDF is the association's correspondence record.
    const pdf = await htmlToPdf(renderWelcomePacketHTML(bundle, { mode: 'print' }));
    const stamp = new Date().toISOString().slice(0, 10);
    const storagePath = `welcome-packets/${bundle.community.id}/${bundle.property.id}-${stamp}.pdf`;
    let storedPath = null;
    const { error: upErr } = await supabase.storage.from('documents')
      .upload(storagePath, pdf, { contentType: 'application/pdf', upsert: true });
    if (upErr) {
      // Not fatal to the send, but it must be loud: a packet nobody can retrieve
      // later is a correspondence record we do not actually have.
      console.warn('[welcome] storage upload failed:', upErr.message, storagePath);
    } else {
      storedPath = storagePath;
    }

    // 2) Record the packet row before delivery.
    const row = {
      community_id: bundle.community.id,
      property_id: bundle.property.id,
      contact_id: bundle.owner.contact_id || null,
      home_sale_id: b.home_sale_id || null,
      occasion: bundle.occasion,
      owner_name: bundle.owner.name || null,
      property_address: [bundle.property.street_address, bundle.property.unit].filter(Boolean).join(' '),
      effective_date: bundle.effective_date || null,
      sections_included: bundle.included,
      sections_missing: bundle.missing.map((m) => m.key),
      snapshot: { sections: bundle.sections, generated_at: bundle.generated_at },
      storage_path: storedPath,
      status: 'generated',
      generated_by: b.sent_by || null,
      notes: b.notes || null,
    };
    const { data: packet, error: insErr } = await supabase
      .from('welcome_packets').insert(row).select().maybeSingle();
    if (insErr) throw insErr;

    if (saveOnly) {
      return res.json({
        packet, emailed: false, stored: !!storedPath,
        reason: toEmail ? 'save_only' : 'no_owner_email',
      });
    }

    // 3) Deliver, then mark. A failure here leaves status='generated', which is
    // the truth, and the operator can retry.
    let interactionId = null;
    let emailed = false;
    let emailError = null;
    let vendorMessageId = null;
    try {
      const { sendEmail } = require('../lib/notifications/email');
      const first = bundle.owner.name ? String(bundle.owner.name).trim().split(/\s+/)[0] : '';
      const subject = `Welcome to ${bundle.community.name}`;
      const intro = first ? `Hi ${first},` : 'Hello,';
      const text = `${intro}

Welcome to ${bundle.community.name}. We manage the association, so we are the people to call about assessments, architectural requests, and anything that needs attention at ${row.property_address}.

Your welcome packet is attached. It has the trash schedule, the numbers worth keeping, how architectural approval works, and what owners here actually get written about, all specific to ${bundle.community.name}.

Anything at all, just reply or call ${require('../lib/brand').service.phone}.

Bedrock Association Management`;
      const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#334155;">
        <p>${intro}</p>
        <p>Welcome to ${bundle.community.name}. We manage the association, so we are the people to call about assessments, architectural requests, and anything that needs attention at ${row.property_address}.</p>
        <p>Your welcome packet is attached. It has the trash schedule, the numbers worth keeping, how architectural approval works, and what owners here actually get written about, all specific to ${bundle.community.name}.</p>
        <p>Anything at all, just reply or call ${require('../lib/brand').service.phone}.</p>
        <p style="margin-top:18px;">Bedrock Association Management</p>
      </div>`;
      // sendEmail RESOLVES with { ok:false } on failure rather than throwing,
      // including when Resend is not configured at all. Treating the absence of
      // an exception as success is how a send that never left the building gets
      // recorded as delivered.
      const sent = await sendEmail({
        to: toEmail,
        subject,
        html,
        text,
        tags: { module: 'welcome_packet' },
        attachments: [{
          filename: `Welcome-${slugify(bundle.community.name)}.pdf`,
          content: pdf.toString('base64'),
        }],
      });
      if (!sent || !sent.ok) throw new Error((sent && sent.error) || 'email_not_sent');
      vendorMessageId = sent.vendor_message_id || null;
      emailed = true;
    } catch (e) {
      emailError = e.message;
      console.warn('[welcome] send email failed:', e.message);
    }

    if (emailed) {
      // The canonical correspondence record. interactions is the single source
      // of truth for "what did we send this owner"; the packet row points at it.
      try {
        const rec = await sendOutboundCorrespondence(supabase, {
          community_id: bundle.community.id,
          contact_id: bundle.owner.contact_id || null,
          property_id: bundle.property.id,
          type: 'email_outbound',
          subject: `Welcome to ${bundle.community.name}`,
          content: `New-homeowner welcome packet sent to ${toEmail}.`,
          delivery_method: 'email',
          primary_delivery: { to_address: toEmail, vendor: 'resend', vendor_message_id: vendorMessageId },
          attachments: storedPath ? [{ storage_path: storedPath, filename: 'welcome-packet.pdf' }] : null,
          sent_by_user_id: null,
          // interactions.source is CHECK-constrained (migration 050). This is
          // forward-flow correspondence; 'welcome_packet' is not a member and
          // would fail the insert silently at the far end of the send.
          source: 'forward',
        });
        interactionId = rec.interaction_id;
      } catch (e) {
        console.warn('[welcome] correspondence record failed:', e.message);
      }

      const { data: updated, error: updErr } = await supabase.from('welcome_packets')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          sent_to_email: toEmail,
          interaction_id: interactionId,
        })
        .eq('id', packet.id).select().maybeSingle();
      if (updErr) throw updErr;
      return res.json({ packet: updated, emailed: true, stored: !!storedPath, interaction_id: interactionId });
    }

    res.status(502).json({
      packet, emailed: false, stored: !!storedPath,
      error: 'email_failed', detail: safeErrorMessage(new Error(emailError || 'unknown')),
    });
  } catch (err) {
    console.error('[welcome] send failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = router;
