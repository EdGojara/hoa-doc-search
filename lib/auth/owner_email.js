// lib/auth/owner_email.js
// ----------------------------------------------------------------------------
// The account owner's email (Ed). One definition, no database client, so pure
// helpers (and their tests) can use it without loading Supabase. Re-exported by
// api/_require_admin.js, which is where route code should keep importing it.
// ----------------------------------------------------------------------------
const OWNER_EMAIL = (process.env.OWNER_EMAIL || 'egojara@bedrocktx.com').toLowerCase();
module.exports = { OWNER_EMAIL };
