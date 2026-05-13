// Board sales pitch deck for prospective HOA communities.
// Variables come from a form filled in trustEd; image is optional.

const pptxgen = require("pptxgenjs");
const { COLORS, LOGO_PATH, addFooter, addSectionLabel, bufferToDataUri } = require("./shared");

const FOOTER = "Bedrock Association Management  ·  bEdrock Intelligence";

function build(config = {}, ctx = {}) {
  const community = (config.community || "[Community Name]").trim();
  const meetingDate = (config.meeting_date || "[Meeting date]").trim();
  const pricePerUnit = (config.price_per_unit || "[__]").trim();
  const onboardingFee = (config.onboarding_fee || "[__]").trim();
  const termLine = (config.term_line || "Term: month-to-month. No exit penalty.").trim();

  const coverImage = ctx.coverImageBuffer
    ? { data: bufferToDataUri(ctx.coverImageBuffer, ctx.coverImageMime || "image/jpeg") }
    : null;

  const pres = new pptxgen();
  pres.layout = "LAYOUT_16x9";
  pres.author = "Bedrock Association Management";
  pres.title = `Bedrock — Proposal for ${community}`;

  // ---------- Slide 1: Cover ----------
  {
    const s = pres.addSlide();
    s.background = { color: COLORS.NAVY_DEEP };

    // optional faint community photo behind everything
    if (coverImage) {
      s.addImage({ ...coverImage, x: 0, y: 0, w: 10, h: 5.625, sizing: { type: "cover", w: 10, h: 5.625 }, transparency: 70 });
      // navy overlay for readability
      s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 5.625, fill: { color: COLORS.NAVY_DEEP, transparency: 25 }, line: { color: COLORS.NAVY_DEEP, width: 0 } });
    }

    s.addImage({ path: LOGO_PATH, x: 0.5, y: 0.45, w: 0.55, h: 0.55 });
    s.addText("BEDROCK ASSOCIATION MANAGEMENT", {
      x: 1.15, y: 0.55, w: 7, h: 0.35,
      fontFace: "Calibri", fontSize: 11, color: COLORS.ICE, charSpacing: 4, bold: true, margin: 0,
    });
    s.addText("A proposal for", { x: 0.5, y: 2.0, w: 9, h: 0.4, fontFace: "Calibri", fontSize: 16, color: COLORS.ICE, italic: true, margin: 0 });
    s.addText(community, { x: 0.5, y: 2.45, w: 9, h: 1.4, fontFace: "Calibri", fontSize: 64, color: COLORS.WHITE, bold: true, margin: 0 });
    s.addShape(pres.shapes.RECTANGLE, { x: 0.55, y: 3.95, w: 0.6, h: 0.025, fill: { color: COLORS.ICE }, line: { color: COLORS.ICE, width: 0 } });
    s.addText("Community. Simplified.", { x: 0.5, y: 4.1, w: 9, h: 0.5, fontFace: "Calibri", fontSize: 20, color: COLORS.ICE, italic: true, margin: 0 });
    s.addText(`Board meeting  ·  ${meetingDate}  ·  bedrocktxai.com`, {
      x: 0.5, y: 5.1, w: 9, h: 0.35,
      fontFace: "Calibri", fontSize: 10, color: COLORS.SLATE_MUTED, charSpacing: 2, margin: 0,
    });
  }

  // ---------- Slide 2: Who we are ----------
  {
    const s = pres.addSlide();
    s.background = { color: COLORS.OFFWHITE };
    addSectionLabel(s, "01 / Who we are");
    s.addText("We've done this work. Now we've encoded it.", {
      x: 0.6, y: 0.9, w: 8.8, h: 1.0,
      fontFace: "Calibri", fontSize: 32, color: COLORS.NAVY, bold: true, margin: 0,
    });
    s.addText(
      "Bedrock Association Management has run real communities for seven years. Founded and led by Ed Gojara — CPA, Certified Fraud Examiner, former audit partner, former high-frequency-trading back office. Trained to spot what others miss, and to run operations that don't break under pressure.",
      { x: 0.6, y: 2.05, w: 8.8, h: 1.2, fontFace: "Calibri", fontSize: 15, color: COLORS.SLATE, margin: 0 }
    );
    const stats = [
      { n: "7", l: "communities currently managed" },
      { n: "7", l: "years of operating discipline" },
      { n: "1", l: "platform — trustEd — built on it all" },
    ];
    stats.forEach((st, i) => {
      const x = 0.6 + i * 3.0;
      s.addShape(pres.shapes.RECTANGLE, { x, y: 3.55, w: 2.8, h: 0.035, fill: { color: COLORS.NAVY }, line: { color: COLORS.NAVY, width: 0 } });
      s.addText(st.n, { x, y: 3.65, w: 2.8, h: 0.95, fontFace: "Calibri", fontSize: 56, color: COLORS.NAVY, bold: true, margin: 0 });
      s.addText(st.l, { x, y: 4.6, w: 2.8, h: 0.45, fontFace: "Calibri", fontSize: 12, color: COLORS.SLATE, margin: 0 });
    });
    addFooter(s, FOOTER);
  }

  // ---------- Slide 3: Honest assessment ----------
  {
    const s = pres.addSlide();
    s.background = { color: COLORS.OFFWHITE };
    addSectionLabel(s, "02 / The honest assessment");
    s.addText("Every property manager will say they have AI.", {
      x: 0.6, y: 0.9, w: 8.8, h: 0.7,
      fontFace: "Calibri", fontSize: 28, color: COLORS.NAVY, bold: true, margin: 0,
    });
    s.addText("The question is whose AI knows your community.", {
      x: 0.6, y: 1.65, w: 8.8, h: 0.7,
      fontFace: "Calibri", fontSize: 28, color: COLORS.NAVY, bold: true, italic: true, margin: 0,
    });
    s.addText(
      "Generic tools can read your bylaws once. Bedrock reads them, your roster, your decision history, your vendor performance, and your board's voice — and acts on all of it, every day. That difference is what shows up in your meetings, your minutes, and your reserves.",
      { x: 0.6, y: 2.75, w: 8.8, h: 1.2, fontFace: "Calibri", fontSize: 14, color: COLORS.SLATE, margin: 0 }
    );
    const cy = 4.05, ch = 1.2;
    s.addShape(pres.shapes.RECTANGLE, { x: 0.6, y: cy, w: 4.3, h: ch, fill: { color: "F1F5F9" }, line: { color: COLORS.RULE, width: 0.5 } });
    s.addText("GENERIC PLATFORMS", { x: 0.8, y: cy + 0.15, w: 4, h: 0.3, fontFace: "Calibri", fontSize: 10, color: COLORS.SLATE_MUTED, charSpacing: 3, bold: true, margin: 0 });
    s.addText("Built once for 10,000 communities. Identical for every board.", { x: 0.8, y: cy + 0.5, w: 4, h: 0.65, fontFace: "Calibri", fontSize: 12.5, color: COLORS.SLATE, margin: 0 });
    s.addShape(pres.shapes.RECTANGLE, { x: 5.1, y: cy, w: 4.3, h: ch, fill: { color: COLORS.NAVY }, line: { color: COLORS.NAVY, width: 0 } });
    s.addText(`BEDROCK FOR ${community.toUpperCase()}`, { x: 5.3, y: cy + 0.15, w: 4, h: 0.3, fontFace: "Calibri", fontSize: 10, color: COLORS.ICE, charSpacing: 3, bold: true, margin: 0 });
    s.addText("Tuned to your bylaws, your roster, your history. Yours.", { x: 5.3, y: cy + 0.5, w: 4, h: 0.65, fontFace: "Calibri", fontSize: 12.5, color: COLORS.WHITE, bold: true, margin: 0 });
    addFooter(s, FOOTER, COLORS.SLATE_MUTED);
  }

  // ---------- Slide 4: Six things ----------
  {
    const s = pres.addSlide();
    s.background = { color: COLORS.OFFWHITE };
    addSectionLabel(s, "03 / What we manage for you");
    s.addText("Six things, done properly.", {
      x: 0.6, y: 0.9, w: 8.8, h: 0.9,
      fontFace: "Calibri", fontSize: 32, color: COLORS.NAVY, bold: true, margin: 0,
    });
    const mods = [
      { t: "Homeowner intake", b: "ACC, gate fobs, requests — branded, fast, status visible to the owner." },
      { t: "Board communications", b: "Agendas, minutes, summaries — drafted in your board's voice, ready to review." },
      { t: "Financial controls", b: "CPA-grade, audit-ready. Reconciliations, reserves, and reporting that hold up." },
      { t: "Vendor management", b: "Bids documented, performance tracked. No quiet overcharging for three years." },
      { t: "Violations & enforcement", b: "Fair. Consistent. Documented. The same rule for every owner, every time." },
      { t: "Annual mailings", b: "Produced, mailed, archived. Statute-compliant, Bedrock-rendered, on schedule." },
    ];
    const startX = 0.6, startY = 1.95, cw = 2.95, ch = 1.4, gx = 0.15, gy = 0.15;
    mods.forEach((m, i) => {
      const col = i % 3, row = Math.floor(i / 3);
      const x = startX + col * (cw + gx);
      const y = startY + row * (ch + gy);
      s.addShape(pres.shapes.RECTANGLE, { x, y, w: cw, h: ch, fill: { color: COLORS.WHITE }, line: { color: COLORS.RULE, width: 0.5 } });
      s.addShape(pres.shapes.RECTANGLE, { x, y, w: 0.06, h: ch, fill: { color: COLORS.NAVY }, line: { color: COLORS.NAVY, width: 0 } });
      s.addText(m.t, { x: x + 0.2, y: y + 0.18, w: cw - 0.3, h: 0.4, fontFace: "Calibri", fontSize: 14, color: COLORS.NAVY, bold: true, margin: 0 });
      s.addText(m.b, { x: x + 0.2, y: y + 0.6, w: cw - 0.3, h: 0.75, fontFace: "Calibri", fontSize: 11, color: COLORS.SLATE, margin: 0 });
    });
    addFooter(s, FOOTER);
  }

  // ---------- Slide 5: Senior judgment ----------
  {
    const s = pres.addSlide();
    s.background = { color: COLORS.OFFWHITE };
    addSectionLabel(s, "04 / How we think");
    s.addText("Senior judgment, on every decision.", {
      x: 0.6, y: 0.9, w: 8.8, h: 1.0,
      fontFace: "Calibri", fontSize: 32, color: COLORS.NAVY, bold: true, margin: 0,
    });
    s.addText(
      "Every recommendation we put in front of you has been pressure-tested against the way a senior operator actually thinks. Four perspectives, applied together — so a fence approval doesn't become a lawsuit, and a vendor doesn't quietly overcharge for three years.",
      { x: 0.6, y: 2.05, w: 8.8, h: 1.2, fontFace: "Calibri", fontSize: 14, color: COLORS.SLATE, margin: 0 }
    );
    const lenses = [
      { t: "CPA", b: "Are the numbers right? Are the controls in place?" },
      { t: "Fraud examiner", b: "Does this pattern look wrong? Who benefits if no one's watching?" },
      { t: "Attorney's eye", b: "Is this decision defensible? Are notices proper?" },
      { t: "Senior operator", b: "Will this hold up in front of the board, the owner, and the inspector?" },
    ];
    const lx = 0.6, ly = 3.5, lw = 2.15, lh = 1.55, lgx = 0.07;
    lenses.forEach((L, i) => {
      const x = lx + i * (lw + lgx);
      s.addShape(pres.shapes.RECTANGLE, { x, y: ly, w: lw, h: lh, fill: { color: COLORS.WHITE }, line: { color: COLORS.RULE, width: 0.5 } });
      s.addShape(pres.shapes.RECTANGLE, { x, y: ly, w: lw, h: 0.06, fill: { color: COLORS.NAVY }, line: { color: COLORS.NAVY, width: 0 } });
      s.addText(L.t, { x: x + 0.15, y: ly + 0.18, w: lw - 0.2, h: 0.4, fontFace: "Calibri", fontSize: 14, color: COLORS.NAVY, bold: true, margin: 0 });
      s.addText(L.b, { x: x + 0.15, y: ly + 0.62, w: lw - 0.2, h: 0.85, fontFace: "Calibri", fontSize: 11, color: COLORS.SLATE, italic: true, margin: 0 });
    });
    addFooter(s, FOOTER);
  }

  // ---------- Slide 6: Compounds ----------
  {
    const s = pres.addSlide();
    s.background = { color: COLORS.OFFWHITE };
    addSectionLabel(s, "05 / It compounds for you");
    s.addText("The longer we know you, the sharper it gets.", {
      x: 0.6, y: 0.9, w: 8.8, h: 1.0,
      fontFace: "Calibri", fontSize: 30, color: COLORS.NAVY, bold: true, margin: 0,
    });
    s.addText(
      "Most software runs faster every year. Ours runs smarter every month. Every approved decision, every vendor invoice, every board comment becomes structured knowledge about your community. That asset belongs to you.",
      { x: 0.6, y: 2.05, w: 8.8, h: 1.2, fontFace: "Calibri", fontSize: 14, color: COLORS.SLATE, margin: 0 }
    );
    const steps = [
      { n: "MONTH 1", t: "Onboarded", b: "Bylaws, roster, financials ingested. Bedrock's encoded operator running day one." },
      { n: "MONTH 6", t: "Personalized", b: "Your board's voice. Your enforcement patterns. Vendor cost history. Owner preferences." },
      { n: "YEAR 2+", t: "Irreplaceable", b: "More knowledge about your community than any new manager could learn in five years." },
    ];
    const tx = 0.6, ty = 3.5, tw = 3.0, th = 1.6, tgx = 0.1;
    steps.forEach((st, i) => {
      const x = tx + i * (tw + tgx);
      s.addShape(pres.shapes.RECTANGLE, { x, y: ty, w: tw, h: th, fill: { color: COLORS.WHITE }, line: { color: COLORS.RULE, width: 0.5 } });
      s.addText(st.n, { x: x + 0.2, y: ty + 0.2, w: tw - 0.3, h: 0.3, fontFace: "Calibri", fontSize: 10, color: COLORS.NAVY, charSpacing: 3, bold: true, margin: 0 });
      s.addText(st.t, { x: x + 0.2, y: ty + 0.55, w: tw - 0.3, h: 0.4, fontFace: "Calibri", fontSize: 18, color: COLORS.NAVY, bold: true, margin: 0 });
      s.addText(st.b, { x: x + 0.2, y: ty + 1.0, w: tw - 0.3, h: 0.55, fontFace: "Calibri", fontSize: 11, color: COLORS.SLATE, margin: 0 });
    });
    addFooter(s, FOOTER);
  }

  // ---------- Slide 7: Transition ----------
  {
    const s = pres.addSlide();
    s.background = { color: COLORS.OFFWHITE };
    addSectionLabel(s, "06 / What month one looks like");
    s.addText("How we transition the community.", {
      x: 0.6, y: 0.9, w: 8.8, h: 1.0,
      fontFace: "Calibri", fontSize: 32, color: COLORS.NAVY, bold: true, margin: 0,
    });
    const steps = [
      { n: "WEEK 1", t: "Records & financials", b: "Governing docs ingested. Roster loaded. Bank handoff initiated. Outgoing manager engaged." },
      { n: "WEEK 2", t: "Homeowners onboarded", b: "ACC and request portal live. Welcome letter goes out. Staff trained on trustEd." },
      { n: "WEEK 4", t: "First board packet", b: "Agenda, financial summary, and AI-prepared briefing rendered in Bedrock's voice." },
      { n: "MONTH 3", t: "Quarterly review", b: "First compounded-data review. Vendor performance, financial trends, owner sentiment." },
    ];
    const sx = 0.6, sy = 2.15, sw = 2.15, sh = 2.95, sgap = 0.1;
    steps.forEach((st, i) => {
      const x = sx + i * (sw + sgap);
      s.addShape(pres.shapes.RECTANGLE, { x, y: sy, w: sw, h: sh, fill: { color: COLORS.WHITE }, line: { color: COLORS.RULE, width: 0.5 } });
      s.addShape(pres.shapes.RECTANGLE, { x, y: sy, w: 0.06, h: sh, fill: { color: COLORS.NAVY }, line: { color: COLORS.NAVY, width: 0 } });
      s.addText(st.n, { x: x + 0.18, y: sy + 0.2, w: sw - 0.25, h: 0.3, fontFace: "Calibri", fontSize: 10, color: COLORS.NAVY, charSpacing: 3, bold: true, margin: 0 });
      s.addText(st.t, { x: x + 0.18, y: sy + 0.55, w: sw - 0.25, h: 0.7, fontFace: "Calibri", fontSize: 15, color: COLORS.NAVY, bold: true, margin: 0 });
      s.addText(st.b, { x: x + 0.18, y: sy + 1.3, w: sw - 0.25, h: 1.6, fontFace: "Calibri", fontSize: 11, color: COLORS.SLATE, margin: 0 });
    });
    addFooter(s, FOOTER);
  }

  // ---------- Slide 8: Pricing (dark) ----------
  {
    const s = pres.addSlide();
    s.background = { color: COLORS.NAVY_DEEP };
    addSectionLabel(s, "07 / What's included", COLORS.ICE);
    s.addText("Everything. Not in tiers.", {
      x: 0.6, y: 0.95, w: 8.8, h: 1.0,
      fontFace: "Calibri", fontSize: 30, color: COLORS.WHITE, bold: true, margin: 0,
    });
    s.addText(
      "We don't sell the basic plan and upsell the rest. Every module, every workflow, every artifact is included. Your investment buys our judgment, our team, and the system we built — not a per-feature catalog.",
      { x: 0.6, y: 2.0, w: 8.8, h: 1.0, fontFace: "Calibri", fontSize: 14, color: COLORS.ICE, margin: 0 }
    );
    const ry = 3.2, rh = 1.65;
    s.addShape(pres.shapes.RECTANGLE, { x: 0.6, y: ry, w: 4.3, h: rh, fill: { color: COLORS.NAVY }, line: { color: COLORS.NAVY, width: 0 } });
    s.addText("INCLUDED", { x: 0.8, y: ry + 0.18, w: 4, h: 0.3, fontFace: "Calibri", fontSize: 10, color: COLORS.ICE, charSpacing: 3, bold: true, margin: 0 });
    s.addText([
      { text: "All six management modules", options: { bullet: true, breakLine: true, color: COLORS.WHITE } },
      { text: "trustEd platform and homeowner portal", options: { bullet: true, breakLine: true, color: COLORS.WHITE } },
      { text: "All mailings, agendas, minutes, packets", options: { bullet: true, breakLine: true, color: COLORS.WHITE } },
      { text: "Dedicated community manager + Ed's oversight", options: { bullet: true, color: COLORS.WHITE } },
    ], { x: 0.85, y: ry + 0.55, w: 3.9, h: 1.05, fontFace: "Calibri", fontSize: 12, color: COLORS.WHITE, paraSpaceAfter: 4, margin: 0 });
    s.addShape(pres.shapes.RECTANGLE, { x: 5.1, y: ry, w: 4.3, h: rh, fill: { color: COLORS.WHITE }, line: { color: COLORS.WHITE, width: 0 } });
    s.addText("INVESTMENT", { x: 5.3, y: ry + 0.18, w: 4, h: 0.3, fontFace: "Calibri", fontSize: 10, color: COLORS.NAVY, charSpacing: 3, bold: true, margin: 0 });
    s.addText(`$${pricePerUnit} / unit / month`, { x: 5.3, y: ry + 0.5, w: 4, h: 0.5, fontFace: "Calibri", fontSize: 22, color: COLORS.NAVY, bold: true, margin: 0 });
    s.addText(`One-time onboarding: $${onboardingFee}`, { x: 5.3, y: ry + 1.0, w: 4, h: 0.3, fontFace: "Calibri", fontSize: 12, color: COLORS.SLATE, margin: 0 });
    s.addText(termLine, { x: 5.3, y: ry + 1.3, w: 4, h: 0.3, fontFace: "Calibri", fontSize: 11, color: COLORS.SLATE, italic: true, margin: 0 });
    s.addShape(pres.shapes.RECTANGLE, { x: 0.6, y: 5.05, w: 0.6, h: 0.025, fill: { color: COLORS.ICE }, line: { color: COLORS.ICE, width: 0 } });
    s.addText("Community. Simplified.", { x: 0.6, y: 5.15, w: 9, h: 0.35, fontFace: "Calibri", fontSize: 14, color: COLORS.WHITE, italic: true, margin: 0 });
  }

  return pres;
}

module.exports = {
  slug: "board",
  title: "Board sales pitch",
  description: "Eight-slide pitch for prospective HOA community boards. Customized with community name, meeting date, and pricing.",
  variables: [
    { key: "community", label: "Community name", placeholder: "Lakes of Pine Forest", required: true },
    { key: "meeting_date", label: "Meeting date", placeholder: "May 28, 2026", required: true },
    { key: "price_per_unit", label: "Price per unit per month (no $)", placeholder: "18", required: true },
    { key: "onboarding_fee", label: "One-time onboarding fee (no $)", placeholder: "2,500", required: true },
    { key: "term_line", label: "Term language", placeholder: "Term: month-to-month. No exit penalty.", required: false },
  ],
  imageSlots: [
    { key: "cover_image", label: "Community photo for cover (optional)", required: false, accept: "image/jpeg,image/png" },
  ],
  build,
};
