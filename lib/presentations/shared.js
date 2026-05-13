const path = require("path");

const COLORS = {
  NAVY: "1E2761",
  NAVY_DEEP: "12173A",
  SLATE: "475569",
  SLATE_MUTED: "94A3B8",
  ICE: "CADCFC",
  OFFWHITE: "FAFBFC",
  RULE: "E2E8F0",
  WHITE: "FFFFFF",
};

const ASSETS_DIR = path.join(__dirname, "..", "..", "public", "assets", "presentations");
const LOGO_PATH = path.join(__dirname, "..", "..", "public", "logos", "bedrock_logo.png");

function asset(filename) {
  return path.join(ASSETS_DIR, filename);
}

function bufferToDataUri(buffer, mime = "image/jpeg") {
  return `${mime};base64,${buffer.toString("base64")}`;
}

function addFooter(slide, text, color = COLORS.SLATE_MUTED) {
  slide.addText(text, {
    x: 0.6, y: 5.25, w: 9, h: 0.25,
    fontFace: "Calibri", fontSize: 9, color, charSpacing: 2, margin: 0,
  });
}

function addSectionLabel(slide, text, color = COLORS.SLATE_MUTED) {
  slide.addText(text, {
    x: 0.6, y: 0.45, w: 6, h: 0.3,
    fontFace: "Calibri", fontSize: 10, color, charSpacing: 3, bold: true, margin: 0,
  });
}

module.exports = {
  COLORS,
  ASSETS_DIR,
  LOGO_PATH,
  asset,
  bufferToDataUri,
  addFooter,
  addSectionLabel,
};
