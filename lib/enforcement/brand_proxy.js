// Thin re-export — letter generator only needs the contact-info fields,
// not the SVG helpers. Keeps the PDF library import lean.
// brand.js exports BRAND as the default (module.exports = BRAND).
const BRAND = require('../brand');
module.exports = { BRAND };
