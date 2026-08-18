// Board sales pitch deck for prospective HOA communities.
// Variables come from a form filled in trustEd; image is optional.

const pptxgen = require("pptxgenjs");
const { COLORS, LOGO_PATH, asset, addFooter, addSectionLabel, bufferToDataUri } = require("./shared");

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
      // Deliberately NO personal credentials here (Ed 2026-08-18). Naming CPA /
      // Certified Fraud Examiner / audit partner in HOA management marketing
      // implies assurance work Bedrock is not engaged to perform, and a board
      // can reasonably read it as "our books are audited" or "fraud is being
      // detected." That is false assurance and a liability. The claim belongs to
      // the system, which is also what makes it repeatable by a franchise
      // operator who does not hold those licenses.
      "Bedrock Association Management has run real communities for seven years. Every judgment call we learned in those years, the ones that keep a fence approval from becoming a lawsuit and catch a vendor drifting upward on price, is now built into the platform that runs your community. The discipline does not depend on who is at the desk that day.",
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
      // Carries the same structural claim as the board-facing page (Ed
      // 2026-08-18): depth of knowledge AND no single person to queue behind.
      // Commas, not em-dashes, per the house voice rule.
      "Generic tools can read your bylaws once. Bedrock reads them, your roster, your decision history, your vendor performance, and your board's voice, and acts on all of it every day. It is also a team that never clocks out, so nothing waits in a queue behind one busy person and nothing sits in an inbox until Monday. That is what shows up in your meetings, your minutes, and your reserves.",
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

  // ---------- Slide 4: You have seen this before ----------
  // Ed 2026-08-18. The category argument, cast for a BOARD.
  // Deliberately NOT Salesforce / AWS / Apple: those are B2B stories five
  // volunteer board members have no relationship with, and "we are like Apple"
  // from an eight-community firm invites a comparison we lose. The analogies
  // that land are the ones they have personally lived, where a gatekeeper
  // disappeared and nobody wanted it back. The bank one carries the most weight
  // because it maps exactly onto our structure: the teller line vanished, the
  // humans stayed for the decisions that matter.
  {
    const s = pres.addSlide();
    s.background = { color: COLORS.OFFWHITE };
    addSectionLabel(s, "03 / You have seen this before");
    s.addText("Every industry that removed the middle step never went back.", {
      x: 0.6, y: 0.9, w: 8.8, h: 1.0,
      fontFace: "Calibri", fontSize: 30, color: COLORS.NAVY, bold: true, margin: 0,
    });
    s.addText(
      "None of this was a technology argument at the time. It was about whether you had to ask someone, and wait, to find out something that was already yours.",
      { x: 0.6, y: 2.05, w: 8.8, h: 0.9, fontFace: "Calibri", fontSize: 14, color: COLORS.SLATE, margin: 0 }
    );
    const priors = [
      { t: "Your bank", b: "You used to stand in line, during banking hours, to learn your own balance. The teller never got faster. The line was removed. People still handle the loan and the dispute." },
      { t: "Your travel", b: "You used to call an agent and wait for a callback to find out what a seat cost. Now you look, at midnight, in your kitchen." },
      { t: "Your photos", b: "You used to drop off film and wait a week to find out whether the picture even came out. Nobody misses the waiting." },
    ];
    const px = 0.6, py = 3.2, pw = 2.9, ph = 1.75, pgx = 0.05;
    priors.forEach((P, i) => {
      const x = px + i * (pw + pgx);
      s.addShape(pres.shapes.RECTANGLE, { x, y: py, w: pw, h: ph, fill: { color: COLORS.WHITE }, line: { color: COLORS.RULE, width: 0.5 } });
      s.addShape(pres.shapes.RECTANGLE, { x, y: py, w: pw, h: 0.06, fill: { color: COLORS.NAVY }, line: { color: COLORS.NAVY, width: 0 } });
      s.addText(P.t, { x: x + 0.16, y: py + 0.18, w: pw - 0.24, h: 0.4, fontFace: "Calibri", fontSize: 14, color: COLORS.NAVY, bold: true, margin: 0 });
      s.addText(P.b, { x: x + 0.16, y: py + 0.6, w: pw - 0.24, h: 1.05, fontFace: "Calibri", fontSize: 10.5, color: COLORS.SLATE, margin: 0 });
    });
    s.addText(
      "Community management is one of the last places where you still have to call a person, and wait, to learn something about the property you own.",
      { x: 0.6, y: 5.15, w: 8.8, h: 0.5, fontFace: "Calibri", fontSize: 14, color: COLORS.NAVY, bold: true, italic: true, margin: 0 }
    );
    addFooter(s, FOOTER);
  }

  // ---------- Slide 5: The team ----------
  // Ed 2026-08-18. The faces are the point: an AI team described in the
  // abstract reads as "we automated your community", and the same team with
  // names and faces reads as people who work here. Nine across in one lineup
  // rather than a grid — a grid of nine on 16:9 forces the type down to sizes
  // nobody can read from the back of a board room.
  // The honest-AI line is NOT a hedge and must not be softened: every persona
  // identifies itself as AI on every call and every email, and saying so plainly
  // here is what makes the rest of the deck credible.
  {
    const s = pres.addSlide();
    s.background = { color: COLORS.NAVY_DEEP };
    addSectionLabel(s, "04 / The team", COLORS.ICE);
    s.addText("Nine teammates. None of them go home.", {
      x: 0.6, y: 0.9, w: 8.8, h: 0.7,
      fontFace: "Calibri", fontSize: 32, color: COLORS.WHITE, bold: true, margin: 0,
    });
    s.addText(
      "They are Bedrock AI teammates, and they say so on every call and every email. Nobody is out sick, nobody is buried in another community's crisis, and nothing sits in an inbox until Monday.",
      { x: 0.6, y: 1.7, w: 8.8, h: 0.6, fontFace: "Calibri", fontSize: 13.5, color: COLORS.ICE, margin: 0 }
    );
    const team = [
      { f: "claire.jpg",   n: "Claire",   r: "Front office" },
      { f: "isabella.jpg", n: "Isabella", r: "Front office, Espanol" },
      { f: "amanda.jpg",   n: "Amanda",   r: "Sr community mgr" },
      { f: "annie.jpg",    n: "Annie",    r: "Architectural review" },
      { f: "paige.jpg",    n: "Paige",    r: "Relationship mgr" },
      { f: "kat.jpg",      n: "Kat",      r: "Accounting mgr" },
      { f: "miranda.jpg",  n: "Miranda",  r: "Compliance" },
      { f: "reese.jpg",    n: "Reese",    r: "Resale, estoppels" },
      { f: "emma.jpg",     n: "Emma",     r: "Accounts payable" },
    ];
    const tw = 0.86, tgap = 0.135, ty = 2.55;
    const totalW = team.length * tw + (team.length - 1) * tgap;
    const tx0 = (10 - totalW) / 2;
    team.forEach((m, i) => {
      const x = tx0 + i * (tw + tgap);
      s.addImage({ path: asset("team/" + m.f), x, y: ty, w: tw, h: tw });
      s.addShape(pres.shapes.RECTANGLE, { x, y: ty + tw, w: tw, h: 0.022, fill: { color: "D4AF37" }, line: { color: "D4AF37", width: 0 } });
      s.addText(m.n, { x: x - 0.06, y: ty + tw + 0.09, w: tw + 0.12, h: 0.22, fontFace: "Calibri", fontSize: 10, color: COLORS.WHITE, bold: true, align: "center", margin: 0 });
      s.addText(m.r, { x: x - 0.1, y: ty + tw + 0.31, w: tw + 0.2, h: 0.34, fontFace: "Calibri", fontSize: 7, color: COLORS.SLATE_MUTED, align: "center", margin: 0 });
    });
    s.addText(
      "Fines, liens, and architectural denials are decided by a person, and money does not leave your account without one. Not because the work needs checking, but because your board is entitled to have someone answer for those decisions.",
      { x: 0.6, y: 4.5, w: 8.8, h: 0.6, fontFace: "Calibri", fontSize: 12, color: COLORS.ICE, italic: true, margin: 0 }
    );
    addFooter(s, FOOTER);
  }

  // ---------- Slide 6: Six things ----------
  {
    const s = pres.addSlide();
    s.background = { color: COLORS.OFFWHITE };
    addSectionLabel(s, "05 / What we manage for you");
    s.addText("Six things, done properly.", {
      x: 0.6, y: 0.9, w: 8.8, h: 0.9,
      fontFace: "Calibri", fontSize: 32, color: COLORS.NAVY, bold: true, margin: 0,
    });
    const mods = [
      { t: "Homeowner intake", b: "ACC, gate fobs, requests — branded, fast, status visible to the owner." },
      { t: "Board communications", b: "Agendas, minutes, summaries — drafted in your board's voice, ready to review." },
      // Not "CPA-grade, audit-ready" (Ed 2026-08-18) — both imply assurance work
      // Bedrock is not engaged to perform. The traceability claim is stronger and
      // it is something a board can actually test in the meeting.
      { t: "Financial controls", b: "Reconciled every month, reserves tracked, every figure traceable to the document behind it." },
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

  // ---------- Slide 7: Senior judgment ----------
  {
    const s = pres.addSlide();
    s.background = { color: COLORS.OFFWHITE };
    addSectionLabel(s, "06 / How we think");
    s.addText("Senior judgment, on every decision.", {
      x: 0.6, y: 0.9, w: 8.8, h: 1.0,
      fontFace: "Calibri", fontSize: 32, color: COLORS.NAVY, bold: true, margin: 0,
    });
    s.addText(
      "Every recommendation we put in front of you has been pressure-tested against the way a senior operator actually thinks. Four perspectives, applied together — so a fence approval doesn't become a lawsuit, and a vendor doesn't quietly overcharge for three years.",
      { x: 0.6, y: 2.05, w: 8.8, h: 1.2, fontFace: "Calibri", fontSize: 14, color: COLORS.SLATE, margin: 0 }
    );
    // Lenses are named by the QUESTION they ask, never by a professional
    // credential (Ed 2026-08-18). "CPA" / "Fraud examiner" / "Attorney's eye"
    // imply accounting, fraud-examination, and legal services that Bedrock is
    // not engaged to provide, which is false assurance to a board and, in the
    // legal case, edges toward holding out to practice. The substance is
    // unchanged and the labels are more distinctive this way.
    const lenses = [
      { t: "The numbers", b: "Do they add up? Are the controls actually in place?" },
      { t: "The pattern", b: "Does this look wrong over time? Who benefits if nobody is watching?" },
      { t: "The exposure", b: "Is this decision defensible? Were the notices proper and on time?" },
      { t: "The room", b: "Will this hold up in front of the board, the owner, and the inspector?" },
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

  // ---------- Slide 8: Compounds ----------
  {
    const s = pres.addSlide();
    s.background = { color: COLORS.OFFWHITE };
    addSectionLabel(s, "07 / It compounds for you");
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

  // ---------- Slide 9: Transition ----------
  {
    const s = pres.addSlide();
    s.background = { color: COLORS.OFFWHITE };
    addSectionLabel(s, "08 / What month one looks like");
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

  // ---------- Slide 10: Pricing (dark) ----------
  {
    const s = pres.addSlide();
    s.background = { color: COLORS.NAVY_DEEP };
    addSectionLabel(s, "09 / What's included", COLORS.ICE);
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
