// ============================================================================
// lib/portal/live_tiles.js  (Ed 2026-11-27: Claire names only real, live tiles)
// ----------------------------------------------------------------------------
// Which portal tiles a homeowner of this community actually sees as live, with the
// exact titles on screen. Status comes from the same presented module config the
// portal's /me sends (lib/portal/financial_access presentedModuleConfig, so a hidden
// balance tile is never named); titles come from the tile list in public/portal.html,
// the one place they are defined, so Claire can never invent "Clubhouse Rental".
// ============================================================================
const fs = require('fs');
const path = require('path');

let _titles = null;
/** PURE-ish: { key: title } parsed once from the MODULES array in public/portal.html. */
function tileTitles() {
  if (_titles) return _titles;
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'portal.html'), 'utf8');
  const start = html.indexOf('const MODULES = [');
  const block = start >= 0 ? html.slice(start, html.indexOf('\n];', start)) : '';
  const out = {};
  const re = /key:\s*'([a-z_]+)',\s*\n\s*title:\s*'((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = re.exec(block))) out[m[1]] = m[2].replace(/\\'/g, "'");
  _titles = out;
  return out;
}

/** The live tiles for a community: [{ key, title }] in portal order, excluding Claire herself. */
async function liveTiles(supabase, communityId) {
  const FA = require('./financial_access');
  const { data, error } = await supabase.from('communities').select('portal_module_config').eq('id', communityId).maybeSingle();
  if (error) throw new Error('community config read failed: ' + error.message);
  const access = await FA.financialAccessFor(supabase, communityId);
  const cfg = FA.presentedModuleConfig((data && data.portal_module_config) || {}, access);
  const titles = tileTitles();
  return Object.keys(titles).filter((k) => k !== 'claire' && cfg[k] && cfg[k].status === 'live').map((k) => ({ key: k, title: titles[k] }));
}

module.exports = { tileTitles, liveTiles };
