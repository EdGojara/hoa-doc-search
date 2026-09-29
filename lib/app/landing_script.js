// ============================================================================
// lib/app/landing_script.js — builds /app-landing.js (Issue #6, staff landing)
// ----------------------------------------------------------------------------
// index.html loads /app-landing.js synchronously at the very top of <head>, so
// the landing decision runs before the legacy app renders. The script is the
// shared pure decision (public/app/landing-core.js) plus the current flags:
//
//   TRUSTED_LANDING=1        turn the landing redirect ON. Default OFF: deploying
//                            the capability and activating it are separate steps
//                            (ChatGPT review, Issue #6).
//   TRUSTED_APP_DISABLED=1   existing emergency switch for all of /app/*; also
//                            forces the landing redirect off, so disabled /app/*
//                            (which redirects to /) can never loop with /.
// Served no-store so a flag change applies on the next page load.
// ============================================================================
const fs = require('fs');
const path = require('path');

const CORE = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app', 'landing-core.js'), 'utf8');

function landingFlags(env) {
  env = env || process.env;
  return { enabled: env.TRUSTED_LANDING === '1', appDisabled: env.TRUSTED_APP_DISABLED === '1' };
}

function landingScript(env) {
  const f = landingFlags(env);
  return CORE + '\n;(function () { try { window.TXLanding.run(window, ' + JSON.stringify(f) + '); } catch (e) { /* never block the legacy app */ } })();\n';
}

module.exports = { landingFlags, landingScript };
