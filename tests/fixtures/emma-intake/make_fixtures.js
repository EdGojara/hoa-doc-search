// Regenerates the synthetic Emma-intake fixtures (Issue #14). Look-alikes of the
// two September 2026 bills that sat unread: a photographed JPG invoice and a
// Word .docx invoice. Names and details are FICTIONAL (public repo, no PII);
// the shape, amounts and file formats match the real ones.
//   node tests/fixtures/emma-intake/make_fixtures.js
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { createCanvas } = require('canvas');
const dir = __dirname;

function makeJpg() {
  const c = createCanvas(900, 1100); const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 900, 1100); g.fillStyle = '#111';
  const lines = [
    ['bold 44px sans-serif', 'INVOICE', 60, 90],
    ['26px sans-serif', 'Party Beats DJ Services', 60, 150],
    ['22px sans-serif', 'Invoice #: 1010', 60, 230],
    ['22px sans-serif', 'Date: October 10, 2026', 60, 270],
    ['22px sans-serif', 'Bill To: Waterview HOA', 60, 330],
    ['22px sans-serif', 'Event: Fall Community Festival', 60, 370],
    ['22px sans-serif', 'DJ services, 4 hours ................ $300.00', 60, 470],
    ['bold 28px sans-serif', 'TOTAL DUE: $300.00', 60, 560],
    ['20px sans-serif', 'Thank you!', 60, 640],
  ];
  for (const [font, text, x, y] of lines) { g.font = font; g.fillText(text, x, y); }
  return c.toBuffer('image/jpeg', { quality: 0.9 });
}

async function makeDocx(paragraphs) {
  const zip = new JSZip();
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const ZOO = ['Happy Hooves Petting Zoo', 'INVOICE', 'Customer: Waterview HOA', 'Event date: October 10, 2026',
  'Petting zoo, 3 hours, 12 animals', 'Amount: $625.00', 'Total due: $625.00', 'Please make checks payable to Happy Hooves Petting Zoo.'];

if (require.main === module) {
  (async () => {
    fs.writeFileSync(path.join(dir, 'dj-invoice-photo.jpg'), makeJpg());
    fs.writeFileSync(path.join(dir, 'petting-zoo-invoice.docx'), await makeDocx(ZOO));
    console.log('fixtures written');
  })();
}
module.exports = { makeDocx, ZOO };
