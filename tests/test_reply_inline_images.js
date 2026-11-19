// ============================================================================
// tests/test_reply_inline_images.js  (Ed 2026-11-19)
// A threaded reply shows ONE picture per person. createReply copies the quoted
// message's inline images, which reuse our signature's contentIds (headshot,
// bedrocklogo): an Annie reply quoting her earlier email carried her old
// portrait and the approved one under the same cid. Same person quoted: the
// quoted copy is dropped and the approved image serves both. Another teammate
// quoted: ours is renamed so neither replaces the other.
// Run: node tests/test_reply_inline_images.js
// ============================================================================
const { _dedupeReplyInlineImages, _altForCid } = require('../lib/email/graph_send');

let failures = 0;
const check = (name, cond, detail) => { if (cond) console.log(`  \x1b[32m✓\x1b[0m ${name}`); else { failures++; console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? '\n      ' + detail : ''}`); } };

const sig = (alt) => `<img src="cid:headshot" width="64" height="64" alt="${alt}"><img src="cid:bedrocklogo" alt="Bedrock Association Management">`;
const OURS = () => [
  { '@odata.type': '#microsoft.graph.fileAttachment', name: 'headshot.jpg', contentId: 'headshot', isInline: true, contentBytes: 'NEW' },
  { '@odata.type': '#microsoft.graph.fileAttachment', name: 'bedrock-logo.png', contentId: 'bedrocklogo', isInline: true, contentBytes: 'LOGO' },
];

function mockFetch(existing, { listFails = false } = {}) {
  const deleted = [];
  global.fetch = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'DELETE') { deleted.push(decodeURIComponent(url.split('/attachments/')[1])); return { ok: true, status: 204 }; }
    if (listFails) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ value: existing }) };
  };
  return deleted;
}
const run = async (quoted, existing, ourHtml, opts) => {
  const deleted = mockFetch(existing, opts);
  let body = ourHtml;
  const atts = await _dedupeReplyInlineImages({ base: 'https://g/users/annie', H: {}, draftId: 'd1', quoted, attachments: OURS(), ours: () => body, setOurs: (b) => { body = b; } });
  return { atts, body, deleted };
};

(async () => {
  console.log('\nOne picture per person in a threaded reply');
  const oldAnnie = [{ id: 'q-head', isInline: true, contentId: 'headshot' }, { id: 'q-logo', isInline: true, contentId: 'bedrocklogo' }];
  let r = await run(`<p>earlier</p>${sig('Annie Reeves')}`, oldAnnie, `<p>reply</p>${sig('Annie Reeves')}`);
  check('Annie quoting Annie: the quoted old portrait is dropped', r.deleted.includes('q-head'), JSON.stringify(r.deleted));
  check('...and the duplicate logo too', r.deleted.includes('q-logo'));
  check('...our approved portrait is attached under the same cid, serving both', r.atts.find((a) => a.contentId === 'headshot' && a.contentBytes === 'NEW') && /cid:headshot"/.test(r.body));

  r = await run(`<p>earlier</p>${sig('Claire Bennett')}`, oldAnnie, `<p>reply</p>${sig('Annie Reeves')}`);
  check('Annie quoting Claire: Claire\'s quoted portrait is kept', !r.deleted.includes('q-head'));
  const renamed = r.atts.find((a) => a.contentBytes === 'NEW');
  check('...and Annie\'s is renamed, body and attachment together', renamed && renamed.contentId !== 'headshot' && r.body.includes(`cid:${renamed.contentId}"`) && !/cid:headshot"/.test(r.body), JSON.stringify(renamed));

  r = await run('<p>homeowner wrote</p>', [], `<p>reply</p>${sig('Annie Reeves')}`);
  check('no quoted images: nothing dropped or renamed', !r.deleted.length && r.atts.every((a, i) => a.contentId === OURS()[i].contentId));

  r = await run(`${sig('Annie Reeves')}`, oldAnnie, `<p>reply</p>${sig('Annie Reeves')}`, { listFails: true });
  check('cannot read the draft\'s images: the reply still goes out unchanged (fail open)', r.atts.length === 2 && !r.deleted.length);

  check('alt lookup', _altForCid(sig('Annie Reeves'), 'headshot') === 'annie reeves' && _altForCid('<p>x</p>', 'headshot') === null);

  console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall reply inline-image checks passed\x1b[0m');
  process.exit(failures ? 1 : 0);
})();
