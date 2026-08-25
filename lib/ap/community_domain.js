// ============================================================================
// lib/ap/community_domain.js  (Ed 2026-08-25)
// ----------------------------------------------------------------------------
// Resolve a community from the sender's email DOMAIN using the community-owned
// domain map (migration 389). This is the authoritative envelope signal that
// was missing when an Amazon bill from propertymanager@canyongateatcincoranch.com
// posted to Waterview — "everyone uses Amazon", so the vendor is no help and
// the sender's own domain is the strongest clue.
//
// Community-owned domains ONLY live in the map (never vendor domains), so a
// match here is trustworthy. Generic mailbox providers can never match because
// they are never seeded. Deploy-safe: if the table isn't applied yet, returns
// null rather than throwing.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Belt-and-suspenders: even though only community-owned domains are seeded,
// never resolve a community from a generic mailbox provider.
const GENERIC_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com', 'live.com',
  'msn.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com', 'comcast.net', 'att.net',
  'sbcglobal.net', 'verizon.net', 'bellsouth.net', 'proton.me', 'protonmail.com',
  'bedrocktx.com',
]);

function domainOf(email) {
  const m = String(email || '').trim().toLowerCase().match(/@([^@\s>]+)$/);
  return m ? m[1] : null;
}

// Returns the community_id for a sender's community-owned domain, or null.
async function resolveCommunityByEmailDomain(email) {
  const domain = domainOf(email);
  if (!domain || GENERIC_DOMAINS.has(domain)) return null;
  try {
    const { data, error } = await supabase
      .from('community_email_domains')
      .select('community_id')
      .eq('domain', domain)
      .maybeSingle();
    if (error) return null;                 // table not applied yet, etc. — never throw
    return data ? data.community_id : null;
  } catch (_) {
    return null;
  }
}

module.exports = { resolveCommunityByEmailDomain, domainOf };
