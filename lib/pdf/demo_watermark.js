// ============================================================================
// lib/pdf/demo_watermark.js
// ----------------------------------------------------------------------------
// Diagonal "DEMO COMMUNITY" watermark for PDFs rendered against demo
// communities. Same brand-defense rule as the gold ribbon on the portal:
// any screenshot, leaked email attachment, or accidentally-shared file
// must self-identify as a demo artifact.
//
// USAGE PATTERN:
//
//   const { installDemoWatermark } = require('./lib/pdf/demo_watermark');
//   const doc = new PDFDocument({ size: 'LETTER' });
//   installDemoWatermark(doc, { community });   // one call, applies to all pages
//   // ... draw content as usual
//
// The helper:
//   - No-ops when community.is_demo is not truthy (safe to call always)
//   - Subscribes to 'pageAdded' so multi-page docs are covered automatically
//   - Draws on the first page synchronously (pageAdded only fires for
//     subsequent pages)
//   - Returns the watermark text for tests/logging
//
// VISUAL:
//   - Diagonal stripe across the page center, rotated -30 degrees
//   - "DEMO · <community name> · All data shown is fictional"
//   - Light gold (#D4AF37) at low opacity so the document stays readable
// ============================================================================

const FILL_COLOR = '#D4AF37';
const OPACITY = 0.18;            // light enough to read through, heavy enough to spot
const FONT_SIZE = 56;
const ANGLE_DEG = -30;

// Hardcoded allowlist of demo community IDs. Defense-in-depth: if a caller
// forgets to populate is_demo on the community object passed in, Drama
// Creek's UUID still triggers the watermark. Same pattern used in
// api/portal.js for the schema-cache-resilient demo resolution.
const KNOWN_DEMO_COMMUNITY_IDS = new Set([
  'dc100000-0000-4000-a000-000000000000', // Drama Creek Estates
]);

function installDemoWatermark(doc, opts) {
  const community = (opts && opts.community) || null;
  if (!community) return null;
  const isDemo = community.is_demo === true
              || KNOWN_DEMO_COMMUNITY_IDS.has(String(community.id || ''));
  if (!isDemo) return null;

  const text = `DEMO · ${community.name || 'Demo Community'} · All data shown is fictional`;
  const draw = () => drawDemoStripe(doc, text);

  // Subscribe FIRST so subsequent pages get covered automatically.
  // PDFKit's 'pageAdded' fires for every page after the first.
  doc.on('pageAdded', draw);

  // Draw on the first/current page now — pageAdded won't fire for it.
  draw();

  return text;
}

function drawDemoStripe(doc, text) {
  // Save current graphics state so we can restore color/opacity/transform
  // after the watermark is drawn. Otherwise downstream draws inherit our
  // tinted state.
  doc.save();
  try {
    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const cx = pageWidth / 2;
    const cy = pageHeight / 2;

    // PDFKit honors fillOpacity for text + shapes drawn after it.
    doc
      .fillColor(FILL_COLOR)
      .fillOpacity(OPACITY)
      .font('Helvetica-Bold')
      .fontSize(FONT_SIZE);

    // Rotate around page center, then draw centered text.
    doc.rotate(ANGLE_DEG, { origin: [cx, cy] });

    // PDFKit's text() doesn't auto-center across arbitrary points — compute
    // the bounding-box manually and offset.
    const textWidth = doc.widthOfString(text);
    const textHeight = doc.currentLineHeight();
    doc.text(text, cx - textWidth / 2, cy - textHeight / 2, {
      lineBreak: false,
      width: textWidth + 4,
    });
  } catch (e) {
    // Watermark failure must NEVER block document generation. Log and move on.
    // Stale opacity / rotation state is risky — restore() in finally handles it.
    if (typeof console !== 'undefined') {
      console.warn(`[demo_watermark] draw failed: ${e.message}`);
    }
  } finally {
    doc.restore();
    // Restore opacity explicitly — older PDFKit versions don't always reset
    // fillOpacity via restore().
    try { doc.fillOpacity(1); } catch (_) {}
  }
}

module.exports = { installDemoWatermark };
