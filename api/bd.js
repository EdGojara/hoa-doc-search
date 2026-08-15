// =============================================================================
// api/bd.js — Business Development: digital business cards
// =============================================================================
//
// WHY THIS EXISTS
// ---------------
// Paper business cards run out at exactly the wrong moment (a conference), and
// the ones that don't run out get thrown away. A card that lives at a URL and
// scans straight into someone's phone contacts doesn't run out, updates itself
// when a phone number changes, and lands the prospect on a Bedrock-branded page
// instead of a scrap of cardstock.
//
// Endpoints (all public by design — this is contact information whose entire
// purpose is to be handed to strangers):
// The card page itself is served at /card/:slug (NOT /c/:slug — that path is
// already the per-community public landing page).
//
//   GET /api/bd/people          → roster (slug + display name) for the BD tab
//   GET /api/bd/:slug           → one card, public-safe JSON
//   GET /api/bd/:slug/card.vcf  → vCard download; phone offers "Add Contact"
//   GET /api/bd/:slug/qr.svg    → QR code, SVG
//        ?mode=vcard (default)  → encodes the vCard itself. No server, no
//                                 network, nothing to be down at the moment
//                                 someone is standing there scanning.
//        ?mode=url              → encodes the card URL instead, when you want
//                                 them to land on the page rather than save
//                                 the contact.
//   GET /api/bd/:slug/scan.png  → full-screen QR image (hold this out)
//   GET /api/bd/:slug/card.png  → branded card image (text or email this)
//   GET /api/bd/:slug/cards.pdf → 10 printable 3.5x2in cards on US Letter
//
// ACCESS SCOPE: no community_id, no homeowner data, no DB read at all. The only
// data this router can reach is lib/bd/people.js, which is a static allowlist
// of Bedrock staff contact details. There is nothing here to scope.
//
// =============================================================================

const express = require('express');
const QRCode = require('qrcode');
const {
  listPeople,
  getPerson,
  buildVCard,
  publicPerson,
  displayName,
} = require('../lib/bd/people');
const { safeErrorMessage } = require('./_safe_error');

const router = express.Router();

// -----------------------------------------------------------------------------
// Absolute base URL for this request.
// The QR has to encode an absolute URL — a relative path is meaningless once
// it's a pattern of squares on a stranger's camera. Honor x-forwarded-proto
// because Render terminates TLS at the proxy, so req.protocol is 'http' there
// and a QR encoding http:// would send every prospect through a redirect.
// -----------------------------------------------------------------------------
function baseUrlFor(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https')
    .split(',')[0]
    .trim();
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

// A card slug is a URL segment we generate ourselves; keep it boring so no
// user-supplied string ever reaches a filesystem or a template raw.
function cleanSlug(raw) {
  return String(raw || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

// -----------------------------------------------------------------------------
// GET /api/bd/people — roster for the BD tab picker
// -----------------------------------------------------------------------------
router.get('/people', (req, res) => {
  try {
    const base = baseUrlFor(req);
    const people = listPeople()
      .map((p) => publicPerson(p, { baseUrl: base }))
      // Alphabetical by display name — selection lists are sorted A–Z.
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    res.json({ people });
  } catch (err) {
    console.error('[bd] roster failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// -----------------------------------------------------------------------------
// GET /api/bd/:slug/card.vcf — the contact file itself
// -----------------------------------------------------------------------------
// The '.vcf' sits inside a LITERAL path segment rather than as a suffix on the
// :slug param. Express 5 parses routes with path-to-regexp v8, where a dot
// immediately after a param is an easy place to get a surprise — and a route
// that silently 404s is a card that silently doesn't save. A literal segment
// has no ambiguity to get wrong.
//
// Content-Disposition: attachment is what makes iOS/Android show the "Add to
// Contacts" sheet rather than dumping the raw vCard text on screen.
// -----------------------------------------------------------------------------
router.get('/:slug/card.vcf', (req, res) => {
  try {
    const person = getPerson(cleanSlug(req.params.slug));
    if (!person) return res.status(404).json({ error: 'card_not_found' });

    const vcf = buildVCard(person, { lean: false });
    const filename = `${person.first}-${person.last}`.replace(/[^A-Za-z0-9-]/g, '');

    res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.vcf"`);
    // Short cache: the card must reflect a phone-number change same-day, but
    // re-fetching on every tap of a slow conference wifi is worse.
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.send(vcf);
  } catch (err) {
    console.error('[bd] vcf failed:', err.message);
    return res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// -----------------------------------------------------------------------------
// GET /api/bd/:slug/qr.svg — the thing people point a camera at
// -----------------------------------------------------------------------------
// mode=vcard (DEFAULT): encodes the vCard text directly, so the camera saves
//   the contact with no network at all. This is the default because a QR that
//   needs a page to load can fail at the exact moment it matters — a cold
//   server or a dead ballroom wifi turns a smooth introduction into a spinner.
// mode=url: encodes https://<host>/card/<slug> instead. Use when you want them
//   to land on the branded page rather than save a contact.
//
// SVG (not PNG) so it stays razor sharp when it's blown up full-screen on a
// phone held out for someone else to scan, and when it's printed.
// -----------------------------------------------------------------------------
router.get('/:slug/qr.svg', async (req, res) => {
  try {
    const person = getPerson(cleanSlug(req.params.slug));
    if (!person) return res.status(404).json({ error: 'card_not_found' });

    const mode = req.query.mode === 'url' ? 'url' : 'vcard';
    const payload = mode === 'url'
      ? `${baseUrlFor(req)}/card/${person.slug}`
      : buildVCard(person, { scan: true });

    // Error correction level:
    //   'M' for the vCard. Measured on the rendered images: raising it to H
    //        adds modules and shrinks each one, and the smaller modules lost
    //        more scans to blur and glare than the extra recovery won back.
    //   'H' for the short URL — cheap at that length, and survives glare,
    //        a fingerprint on the screen, and an off-angle scan.
    const svg = await QRCode.toString(payload, {
      type: 'svg',
      errorCorrectionLevel: mode === 'url' ? 'H' : 'M',
      margin: 1,
      color: { dark: '#0B1D34', light: '#FFFFFF' },
    });

    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.send(svg);
  } catch (err) {
    console.error('[bd] qr failed:', err.message);
    return res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// -----------------------------------------------------------------------------
// Rendered assets — scan.png / card.png / cards.pdf
// -----------------------------------------------------------------------------
// One roster entry produces the whole kit, so onboarding a new person to cards
// is a roster edit rather than a design task. Each render spawns a headless
// browser (a few seconds), which is why these are downloads and not something
// the page loads inline.
// -----------------------------------------------------------------------------
// Three literal routes rather than one regex-constrained param. Express 5
// parses routes with path-to-regexp v8, which dropped the `:p(a|b)` syntax
// entirely — that pattern throws at boot, taking the whole server with it.
// Same reasoning as card.vcf above: literal segments have nothing to get wrong.
function serveAsset(renderFn, contentType, suffix) {
  return async (req, res) => {
    try {
      const person = getPerson(cleanSlug(req.params.slug));
      if (!person) return res.status(404).json({ error: 'card_not_found' });

      const buffer = await renderFn(person);
      const base = `${person.first}-${person.last}`.replace(/[^A-Za-z0-9-]/g, '');
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition',
        `attachment; filename="${base}${suffix}"`);
      return res.send(buffer);
    } catch (err) {
      // Rendering runs a headless browser, the most failure-prone thing in this
      // router. Log loudly — a silent empty download is the worst outcome.
      console.error(`[bd] render ${suffix} failed:`, err.message);
      return res.status(500).json({ error: safeErrorMessage(err) });
    }
  };
}

const render = require('../lib/bd/render');
router.get('/:slug/scan.png', serveAsset(render.renderScanPng, 'image/png', '-SCAN.png'));
router.get('/:slug/card.png', serveAsset(render.renderCardPng, 'image/png', '-card.png'));
router.get('/:slug/cards.pdf', serveAsset(render.renderPrintPdf, 'application/pdf', '-cards-print.pdf'));

// -----------------------------------------------------------------------------
// GET /api/bd/:slug — public-safe card JSON (drives public/card.html)
// -----------------------------------------------------------------------------
router.get('/:slug', (req, res) => {
  try {
    const person = getPerson(cleanSlug(req.params.slug));
    if (!person) return res.status(404).json({ error: 'card_not_found' });
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.json({
      person: publicPerson(person, { baseUrl: baseUrlFor(req) }),
    });
  } catch (err) {
    console.error('[bd] card failed:', err.message);
    return res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = router;
module.exports.displayName = displayName;
