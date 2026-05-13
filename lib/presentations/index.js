const partner = require("./partner");
const board = require("./board");

const TEMPLATES = { partner, board };

function listTemplates() {
  return Object.values(TEMPLATES).map((t) => ({
    slug: t.slug,
    title: t.title,
    description: t.description,
    variables: t.variables || [],
    imageSlots: t.imageSlots || [],
  }));
}

function getTemplate(slug) {
  return TEMPLATES[slug] || null;
}

module.exports = { listTemplates, getTemplate };
