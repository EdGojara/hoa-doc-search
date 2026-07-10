// Partner / franchise overview pitch deck.
// No customer-specific variables — single canonical deck.

const pptxgen = require("pptxgenjs");
const { COLORS, LOGO_PATH, asset, addFooter, addSectionLabel } = require("./shared");

const FOOTER = "trustEd  ·  bEdrock Intelligence";

function build(config = {}) {
  const preparedForRaw = (config.prepared_for || "").trim();
  const preparedFor = preparedForRaw
    ? preparedForRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const meetingDate = (config.meeting_date || "").trim();
  const personalized = preparedFor.length > 0 || meetingDate.length > 0;

  const pres = new pptxgen();
  pres.layout = "LAYOUT_16x9";
  pres.author = "bEdrock Intelligence";
  pres.title = "trustEd — Partner Overview";

  // ---------- Slide 1: Cover (dark) ----------
  {
    const s = pres.addSlide();
    s.background = { color: COLORS.NAVY_DEEP };
    // New brand lockup is wide (~3.37:1) — size by that ratio, not a square.
    s.addImage({ path: LOGO_PATH, x: 0.5, y: 0.5, w: 1.35, h: 0.4 });
    s.addText("bEdrock Intelligence", {
      x: 2.0, y: 0.55, w: 5, h: 0.35,
      fontFace: "Calibri", fontSize: 13, color: COLORS.ICE, bold: true, margin: 0,
    });
    s.addText("trustEd", {
      x: 0.5, y: 1.65, w: 9, h: 1.4,
      fontFace: "Calibri", fontSize: 96, color: COLORS.WHITE, bold: true, margin: 0,
    });
    s.addShape(pres.shapes.RECTANGLE, {
      x: 0.55, y: 3.2, w: 0.6, h: 0.025, fill: { color: COLORS.ICE }, line: { color: COLORS.ICE, width: 0 },
    });
    s.addText("Community. Simplified.", {
      x: 0.5, y: 3.35, w: 9, h: 0.5,
      fontFace: "Calibri", fontSize: 22, color: COLORS.ICE, italic: true, margin: 0,
    });

    if (personalized) {
      // PREPARED FOR block — small caps label + names + date
      s.addText("PREPARED FOR", {
        x: 0.5, y: 4.15, w: 9, h: 0.25,
        fontFace: "Calibri", fontSize: 10, color: COLORS.SLATE_MUTED, charSpacing: 4, bold: true, margin: 0,
      });
      if (preparedFor.length > 0) {
        s.addText(preparedFor.join("    ·    "), {
          x: 0.5, y: 4.45, w: 9, h: 0.55,
          fontFace: "Calibri", fontSize: 18, color: COLORS.WHITE, bold: true, margin: 0,
        });
      }
      if (meetingDate) {
        s.addText(meetingDate, {
          x: 0.5, y: 5.05, w: 9, h: 0.3,
          fontFace: "Calibri", fontSize: 12, color: COLORS.ICE, italic: true, margin: 0,
        });
      }
      s.addText("bEdrock Intelligence  ·  bedrocktxai.com", {
        x: 0.5, y: 5.4, w: 9, h: 0.2,
        fontFace: "Calibri", fontSize: 9, color: COLORS.SLATE_MUTED, charSpacing: 2, margin: 0,
      });
    } else {
      s.addText("Partner overview  ·  Bedrock Management Co.  ·  2026", {
        x: 0.5, y: 5.05, w: 9, h: 0.35,
        fontFace: "Calibri", fontSize: 10, color: COLORS.SLATE_MUTED, charSpacing: 2, margin: 0,
      });
    }
  }

  // ---------- Slide 2: The insight ----------
  {
    const s = pres.addSlide();
    s.background = { color: COLORS.OFFWHITE };
    addSectionLabel(s, "01 / The insight");
    s.addText("HOA software was built for the wrong customer.", {
      x: 0.6, y: 0.9, w: 8.8, h: 1.0,
      fontFace: "Calibri", fontSize: 32, color: COLORS.NAVY, bold: true, margin: 0,
    });
    s.addText(
      "For 40 years, every tool in this industry has been sold to management companies — back-office software for processing fees, mailing notices, and tracking work orders. The people who actually live in the community, and the boards who govern it, have been an afterthought.",
      {
        x: 0.6, y: 2.05, w: 8.8, h: 1.2,
        fontFace: "Calibri", fontSize: 15, color: COLORS.SLATE, margin: 0, paraSpaceAfter: 6,
      }
    );
    const cols = [
      { label: "BUILT FOR", body: "Property management companies. Generic, low-margin, one-size-fits-all." },
      { label: "HOMEOWNERS GET", body: "A portal they rarely log into. PDFs forwarded from a vendor. No voice." },
      { label: "BOARDS GET", body: "Quarterly binders. Generic templates. No real analysis of their community." },
    ];
    cols.forEach((c, i) => {
      const x = 0.6 + i * 3.0;
      s.addShape(pres.shapes.RECTANGLE, {
        x, y: 3.55, w: 2.8, h: 0.035, fill: { color: COLORS.NAVY }, line: { color: COLORS.NAVY, width: 0 },
      });
      s.addText(c.label, {
        x, y: 3.67, w: 2.8, h: 0.3,
        fontFace: "Calibri", fontSize: 10, color: COLORS.NAVY, bold: true, charSpacing: 3, margin: 0,
      });
      s.addText(c.body, {
        x, y: 4.05, w: 2.8, h: 0.85,
        fontFace: "Calibri", fontSize: 13, color: COLORS.SLATE, margin: 0,
      });
    });
    addFooter(s, FOOTER);
  }

  // ---------- Slide 3: The result ----------
  {
    const s = pres.addSlide();
    s.background = { color: COLORS.OFFWHITE };
    addSectionLabel(s, "02 / The result");
    s.addText("A generic industry. Mistakes that repeat.", {
      x: 0.6, y: 0.9, w: 8.8, h: 1.0,
      fontFace: "Calibri", fontSize: 32, color: COLORS.NAVY, bold: true, margin: 0,
    });
    const items = [
      { n: "01", head: "Generic templates instead of judgment", sub: "An ACC denial letter looks the same whether it's a fence in Phoenix or a roof in Houston. Boards can tell. Homeowners can tell." },
      { n: "02", head: "Knowledge that walks out the door", sub: "Every time a property manager leaves, the community loses years of context. The software never learned it." },
      { n: "03", head: "Tools that get faster, not smarter", sub: "Year 5 of using the same platform looks identical to year 1. AP gets processed quicker. Nothing else compounds." },
    ];
    items.forEach((it, i) => {
      const y = 2.15 + i * 1.0;
      s.addText(it.n, { x: 0.6, y, w: 0.7, h: 0.7, fontFace: "Calibri", fontSize: 36, color: COLORS.ICE, bold: true, margin: 0 });
      s.addText(it.head, { x: 1.35, y: y + 0.02, w: 8, h: 0.4, fontFace: "Calibri", fontSize: 17, color: COLORS.NAVY, bold: true, margin: 0 });
      s.addText(it.sub, { x: 1.35, y: y + 0.42, w: 8, h: 0.5, fontFace: "Calibri", fontSize: 13, color: COLORS.SLATE, margin: 0 });
    });
    addFooter(s, FOOTER);
  }

  // ---------- Slide 4: There is no substitute (PORSCHE / dark) ----------
  {
    const s = pres.addSlide();
    s.background = { color: COLORS.NAVY_DEEP };
    addSectionLabel(s, "03 / Our philosophy", COLORS.ICE);
    s.addImage({
      path: asset("porsche_911.jpg"),
      x: 0.6, y: 0.95, w: 4.5, h: 3.4,
      sizing: { type: "cover", w: 4.5, h: 3.4 },
    });
    s.addText("Porsche 911  ·  every one built to its owner", {
      x: 0.6, y: 4.4, w: 4.5, h: 0.25,
      fontFace: "Calibri", fontSize: 9, color: COLORS.SLATE_MUTED, italic: true, charSpacing: 1, margin: 0,
    });
    s.addText("“There is no substitute.”", {
      x: 5.4, y: 0.95, w: 4.2, h: 0.7,
      fontFace: "Calibri", fontSize: 28, color: COLORS.WHITE, italic: true, bold: true, margin: 0,
    });
    s.addShape(pres.shapes.RECTANGLE, {
      x: 5.4, y: 1.7, w: 0.5, h: 0.025, fill: { color: COLORS.ICE }, line: { color: COLORS.ICE, width: 0 },
    });
    s.addText(
      "Almost no two 911s leave Zuffenhausen alike. Thousands of options — stitching, gearbox ratio, paint, leather — mean each car is configured to its owner. That is what “no substitute” means: bespoke at scale.",
      { x: 5.4, y: 1.9, w: 4.2, h: 1.4, fontFace: "Calibri", fontSize: 13, color: COLORS.ICE, margin: 0 }
    );
    s.addText(
      "bEdrock builds the same way. Each community gets trustEd tuned to its bylaws, its board, its history. Not a product we push, hoping it fits. A system we configure.",
      { x: 5.4, y: 3.4, w: 4.2, h: 1.3, fontFace: "Calibri", fontSize: 13, color: COLORS.WHITE, bold: true, margin: 0 }
    );
    s.addImage({
      path: asset("porsche_factory.jpg"),
      x: 8.05, y: 4.5, w: 1.0, h: 0.65,
      sizing: { type: "cover", w: 1.0, h: 0.65 },
    });
    s.addText("Zuffenhausen", {
      x: 5.4, y: 4.65, w: 2.6, h: 0.3,
      fontFace: "Calibri", fontSize: 9, color: COLORS.SLATE_MUTED, italic: true, align: "right", margin: 0,
    });
    addFooter(s, FOOTER);
  }

  // ---------- Slide 5: Senior judgment encoded ----------
  {
    const s = pres.addSlide();
    s.background = { color: COLORS.OFFWHITE };
    addSectionLabel(s, "04 / What we're building");
    s.addText("Senior judgment, encoded as software.", {
      x: 0.6, y: 0.9, w: 8.8, h: 1.0,
      fontFace: "Calibri", fontSize: 32, color: COLORS.NAVY, bold: true, margin: 0,
    });
    s.addText(
      "trustEd is an operating system for HOA management. It reads the bylaws, the roster, the budget, and the board's voice — and acts the way a seasoned CPA, fraud examiner, and 7-year HOA operator would act. Not faster. Better. And it gets sharper every month it's in use.",
      { x: 0.6, y: 2.05, w: 8.8, h: 1.3, fontFace: "Calibri", fontSize: 15, color: COLORS.SLATE, margin: 0 }
    );
    const ay = 3.65, ah = 1.5;
    s.addShape(pres.shapes.RECTANGLE, { x: 0.6, y: ay, w: 4.3, h: ah, fill: { color: "F1F5F9" }, line: { color: COLORS.RULE, width: 0.5 } });
    s.addText("MOST HOA AI", { x: 0.8, y: ay + 0.15, w: 4, h: 0.3, fontFace: "Calibri", fontSize: 10, color: COLORS.SLATE_MUTED, charSpacing: 3, bold: true, margin: 0 });
    s.addText("Process the same thing faster.", { x: 0.8, y: ay + 0.48, w: 4, h: 0.4, fontFace: "Calibri", fontSize: 16, color: COLORS.SLATE, bold: true, margin: 0 });
    s.addText("Year 5 looks like year 1. Replaceable.", { x: 0.8, y: ay + 0.9, w: 4, h: 0.5, fontFace: "Calibri", fontSize: 12, color: COLORS.SLATE_MUTED, italic: true, margin: 0 });
    s.addShape(pres.shapes.RECTANGLE, { x: 5.1, y: ay, w: 4.3, h: ah, fill: { color: COLORS.NAVY }, line: { color: COLORS.NAVY, width: 0 } });
    s.addText("trustEd", { x: 5.3, y: ay + 0.15, w: 4, h: 0.3, fontFace: "Calibri", fontSize: 10, color: COLORS.ICE, charSpacing: 3, bold: true, margin: 0 });
    s.addText("Process the same thing better.", { x: 5.3, y: ay + 0.48, w: 4, h: 0.4, fontFace: "Calibri", fontSize: 16, color: COLORS.WHITE, bold: true, margin: 0 });
    s.addText("Every decision sharpens the next one.", { x: 5.3, y: ay + 0.9, w: 4, h: 0.5, fontFace: "Calibri", fontSize: 12, color: COLORS.ICE, italic: true, margin: 0 });
    addFooter(s, FOOTER);
  }

  // ---------- Slide 6: Four layer moat ----------
  {
    const s = pres.addSlide();
    s.background = { color: COLORS.OFFWHITE };
    addSectionLabel(s, "05 / Why this can't be copied");
    s.addText("Four layers. Each one compounds.", {
      x: 0.6, y: 0.9, w: 8.8, h: 1.0,
      fontFace: "Calibri", fontSize: 32, color: COLORS.NAVY, bold: true, margin: 0,
    });
    const cards = [
      { n: "01", title: "Community-specific data", body: "Roster, governing docs, decision history, vendor performance — structured per community, not a generic database." },
      { n: "02", title: "Encoded judgment", body: "Eight expert lenses — CPA, fraud examiner, attorney, operator — applied to every recommendation. Not a generic LLM." },
      { n: "03", title: "End-to-end workflow", body: "Intake → AI assessment → manager queue → finalize → status update. One loop. Competitors sell standalone modules." },
      { n: "04", title: "Brand ownership", body: "Every artifact a homeowner sees is Bedrock-rendered. No vendor PDFs forwarded. The output is the proof." },
    ];
    const startX = 0.6, startY = 2.15, cw = 4.3, ch = 1.45, gx = 0.2, gy = 0.2;
    cards.forEach((c, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const x = startX + col * (cw + gx);
      const y = startY + row * (ch + gy);
      s.addShape(pres.shapes.RECTANGLE, { x, y, w: cw, h: ch, fill: { color: COLORS.WHITE }, line: { color: COLORS.RULE, width: 0.5 } });
      s.addShape(pres.shapes.RECTANGLE, { x, y, w: 0.08, h: ch, fill: { color: COLORS.NAVY }, line: { color: COLORS.NAVY, width: 0 } });
      s.addText(c.n, { x: x + 0.25, y: y + 0.18, w: 0.6, h: 0.3, fontFace: "Calibri", fontSize: 11, color: COLORS.ICE, bold: true, charSpacing: 2, margin: 0 });
      s.addText(c.title, { x: x + 0.25, y: y + 0.42, w: cw - 0.4, h: 0.4, fontFace: "Calibri", fontSize: 16, color: COLORS.NAVY, bold: true, margin: 0 });
      s.addText(c.body, { x: x + 0.25, y: y + 0.85, w: cw - 0.4, h: 0.55, fontFace: "Calibri", fontSize: 11.5, color: COLORS.SLATE, margin: 0 });
    });
    addFooter(s, FOOTER);
  }

  // ---------- Slide 7: Operators not franchisees ----------
  {
    const s = pres.addSlide();
    s.background = { color: COLORS.OFFWHITE };
    addSectionLabel(s, "06 / Where you fit");
    s.addText("Operators, not franchisees.", {
      x: 0.6, y: 0.9, w: 8.8, h: 1.0,
      fontFace: "Calibri", fontSize: 32, color: COLORS.NAVY, bold: true, margin: 0,
    });
    s.addText(
      "You don't buy a kit and put a logo on your door. You join a small partnership of operators, each running a book of communities they'd be proud to serve. The brand and the operating system are shared. The relationships are yours. You don't need fifteen years in this industry — trustEd carries that for you.",
      { x: 0.6, y: 2.05, w: 8.8, h: 1.3, fontFace: "Calibri", fontSize: 14.5, color: COLORS.SLATE, margin: 0 }
    );
    const ry = 3.55, rh = 1.55;
    s.addShape(pres.shapes.RECTANGLE, { x: 0.6, y: ry, w: 4.3, h: rh, fill: { color: COLORS.WHITE }, line: { color: COLORS.RULE, width: 0.5 } });
    s.addText("WHAT YOU BRING", { x: 0.8, y: ry + 0.15, w: 4, h: 0.3, fontFace: "Calibri", fontSize: 10, color: COLORS.NAVY, charSpacing: 3, bold: true, margin: 0 });
    s.addText([
      { text: "Business judgment, not code skill", options: { bullet: true, breakLine: true } },
      { text: "Local network and presence", options: { bullet: true, breakLine: true } },
      { text: "Willingness to invest in a real book", options: { bullet: true, breakLine: true } },
      { text: "Care about doing the work properly", options: { bullet: true } },
    ], { x: 0.85, y: ry + 0.5, w: 3.9, h: 1.0, fontFace: "Calibri", fontSize: 12.5, color: COLORS.SLATE, paraSpaceAfter: 4, margin: 0 });
    s.addShape(pres.shapes.RECTANGLE, { x: 5.1, y: ry, w: 4.3, h: rh, fill: { color: COLORS.NAVY }, line: { color: COLORS.NAVY, width: 0 } });
    s.addText("WHAT BEDROCK CARRIES", { x: 5.3, y: ry + 0.15, w: 4, h: 0.3, fontFace: "Calibri", fontSize: 10, color: COLORS.ICE, charSpacing: 3, bold: true, margin: 0 });
    s.addText([
      { text: "Brand and customer-facing artifacts", options: { bullet: true, breakLine: true, color: COLORS.WHITE } },
      { text: "The trustEd platform on day one", options: { bullet: true, breakLine: true, color: COLORS.WHITE } },
      { text: "Training, playbook, and ongoing support", options: { bullet: true, breakLine: true, color: COLORS.WHITE } },
      { text: "Senior-grade judgment in every workflow", options: { bullet: true, color: COLORS.WHITE } },
    ], { x: 5.35, y: ry + 0.5, w: 3.9, h: 1.0, fontFace: "Calibri", fontSize: 12.5, color: COLORS.WHITE, paraSpaceAfter: 4, margin: 0 });
    addFooter(s, FOOTER);
  }

  // ---------- Slide 8: Where this goes (dark close) ----------
  {
    const s = pres.addSlide();
    s.background = { color: COLORS.NAVY_DEEP };
    addSectionLabel(s, "07 / Where this goes", COLORS.ICE);
    s.addText("The same operating system, across markets and verticals.", {
      x: 0.6, y: 0.95, w: 8.8, h: 1.4,
      fontFace: "Calibri", fontSize: 26, color: COLORS.WHITE, bold: true, margin: 0,
    });
    const steps = [
      { n: "NOW", t: "Bedrock Management", s: "Seven communities. trustEd live." },
      { n: "YEAR 2", t: "Second market", s: "Prove the model is geography-agnostic." },
      { n: "YEAR 3", t: "Operator network", s: "Second-act professionals, Bedrock brand." },
      { n: "YEAR 4+", t: "Vendor verticals", s: "Pool. Landscape. Same architecture." },
    ];
    const sx = 0.6, ty = 2.85, sw = 2.15, sgap = 0.1;
    steps.forEach((st, i) => {
      const x = sx + i * (sw + sgap);
      s.addShape(pres.shapes.RECTANGLE, { x, y: ty, w: 0.45, h: 0.025, fill: { color: COLORS.ICE }, line: { color: COLORS.ICE, width: 0 } });
      s.addText(st.n, { x, y: ty + 0.12, w: sw, h: 0.3, fontFace: "Calibri", fontSize: 10, color: COLORS.ICE, charSpacing: 3, bold: true, margin: 0 });
      s.addText(st.t, { x, y: ty + 0.45, w: sw, h: 0.4, fontFace: "Calibri", fontSize: 15, color: COLORS.WHITE, bold: true, margin: 0 });
      s.addText(st.s, { x, y: ty + 0.88, w: sw, h: 0.7, fontFace: "Calibri", fontSize: 11, color: COLORS.ICE, margin: 0 });
    });
    s.addShape(pres.shapes.RECTANGLE, { x: 0.6, y: 4.65, w: 0.6, h: 0.025, fill: { color: COLORS.ICE }, line: { color: COLORS.ICE, width: 0 } });
    s.addText("Community. Simplified.", {
      x: 0.6, y: 4.78, w: 9, h: 0.5,
      fontFace: "Calibri", fontSize: 22, color: COLORS.WHITE, italic: true, margin: 0,
    });
    s.addText("bEdrock Intelligence  ·  bedrocktxai.com", {
      x: 0.6, y: 5.3, w: 9, h: 0.25,
      fontFace: "Calibri", fontSize: 10, color: COLORS.ICE, charSpacing: 2, margin: 0,
    });
  }

  return pres;
}

module.exports = {
  slug: "partner",
  title: "Partner / operator overview",
  description: "Eight-slide pitch for prospective operators and partners. Cover can be personalized with attendee names and a meeting date — both optional.",
  variables: [
    { key: "prepared_for", label: "Prepared for — attendee names (comma-separated)", placeholder: "Jane Smith, John Doe, Robert Chen", required: false },
    { key: "meeting_date", label: "Meeting date", placeholder: "May 13, 2026", required: false },
  ],
  imageSlots: [],
  build,
};
