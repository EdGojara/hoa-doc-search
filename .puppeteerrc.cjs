// Pin puppeteer's Chrome cache to a project-relative directory so the binary
// downloaded during `npm install` (via the `postinstall` hook) persists into
// the runtime container on Render. The default cache (~/.cache/puppeteer) is
// outside the build artifact and gets wiped between build and run.
const { join } = require('path');

module.exports = {
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
