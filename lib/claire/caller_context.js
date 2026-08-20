// ============================================================================
// lib/claire/caller_context.js  (Ed 2026-08-20)
// ----------------------------------------------------------------------------
// What Claire knows about the person in front of her.
//
// Ed: "i want claire to be able to know who she is talking to based on their
// portal when the log in."
//
// She already knew their NAME. The turn handler built her caller object as:
//
//     property: session.property_id ? { id, community_id } : null
//
// A primary key and nothing else. So Claire could greet Alexis by name and then
// had to ask Alexis for her address, her balance and what her notice was about,
// while the homeowner sat inside their own authenticated portal where all three
// were on screen. That is the gatekeeper behaviour the whole platform exists to
// remove, showing up in the one place a homeowner is most likely to meet it.
//
// NOTHING NEW IS DISCLOSED. Every field here is already visible to this person
// on their own portal tiles. The property id comes from resolveVisitor, which
// derives it from the signed portal cookie, never from anything the browser
// sends. A staffer using "view as" gets exactly the mimicked homeowner's
// context and no more.
//
// Read only, and deliberately thin. Claire coordinates and explains; she does
// not decide. Balance and violation STATUS are facts the homeowner can already
// read. A waiver, a fine decision or a §209 judgment still routes to a human
// through the guardrails, which run before this ever reaches the model.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/** Never let a context lookup break a visit. Claire degrades to knowing less. */
async function safe(label, fn) {
  try { return await fn(); }
  catch (e) { console.warn('[claire_context] ' + label + ' failed:', e.message); return null; }
}

/**
 * @param {string} propertyId  from the session, which got it from the cookie
 * @returns {Promise<null|object>} the caller's own account picture
 */
async function loadCallerContext(propertyId) {
  if (!propertyId) return null;

  const property = await safe('property', async () => {
    const { data, error } = await supabase.from('properties')
      .select('id, street_address, community_id, communities:community_id(name)')
      .eq('id', propertyId).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  });
  if (!property) return null;

  const ctx = {
    address: property.street_address || null,
    community: (property.communities && property.communities.name) || null,
  };

  // Balance from the canonical view. v_homeowner_current_balance is the SSOT;
  // v_property_summary is the stale one that stamps today's date on months-old
  // data, and Claire reading a wrong balance out loud is worse than her not
  // knowing it.
  const bal = await safe('balance', async () => {
    const { data, error } = await supabase.from('v_homeowner_current_balance')
      .select('balance_cents, as_of').eq('property_id', propertyId).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  });
  if (bal) {
    ctx.balance = {
      amount: Number(bal.balance_cents || 0) / 100,
      // Say how current the number is. A confident stale balance is the exact
      // failure the portal as-of labelling was fixed for.
      as_of: bal.as_of || null,
    };
  }

  // Open enforcement, as STATUS not judgment. She can say a case is open and
  // what stage it is at. She cannot decide it, waive it, or predict it.
  ctx.open_violations = await safe('violations', async () => {
    const { data, error } = await supabase.from('violations')
      .select('current_stage, opened_at, enforcement_categories(label)')
      .eq('property_id', propertyId)
      .not('current_stage', 'in', '(cured,closed,voided)').limit(10);
    if (error) throw new Error(error.message);
    return (data || []).map((v) => ({
      what: (v.enforcement_categories && v.enforcement_categories.label) || 'open matter',
      stage: v.current_stage,
      opened: v.opened_at ? String(v.opened_at).slice(0, 10) : null,
    }));
  }) || [];

  ctx.open_acc = await safe('acc', async () => {
    const { data, error } = await supabase.from('acc_decisions')
      .select('decision_type, status, project_summary, created_at')
      .eq('property_id', propertyId).in('status', ['pending', 'in_review', 'submitted']).limit(5);
    if (error) throw new Error(error.message);
    return (data || []).map((a) => ({
      what: a.project_summary || a.decision_type || 'application',
      status: a.status,
      submitted: a.created_at ? String(a.created_at).slice(0, 10) : null,
    }));
  }) || [];

  return ctx;
}

/**
 * The same picture as a short block for the model. Kept deliberately terse:
 * this is context she may USE, never a script to read back. Ed's rule is no
 * patronising read-backs, so nothing here instructs her to recite it.
 */
function callerContextPrompt(ctx) {
  if (!ctx) return '';
  const lines = [];
  if (ctx.address) lines.push('Their property: ' + ctx.address + (ctx.community ? ', ' + ctx.community : ''));
  if (ctx.balance) {
    const amt = ctx.balance.amount;
    lines.push('Their balance: ' + (amt > 0 ? '$' + amt.toFixed(2) + ' owing'
      : amt < 0 ? '$' + Math.abs(amt).toFixed(2) + ' credit' : 'nothing owing')
      + (ctx.balance.as_of ? ' as of ' + String(ctx.balance.as_of).slice(0, 10) : ''));
  }
  if (ctx.open_violations && ctx.open_violations.length) {
    lines.push('Open compliance matters: ' + ctx.open_violations
      .map((v) => v.what + ' (' + v.stage + (v.opened ? ', opened ' + v.opened : '') + ')').join('; '));
  }
  if (ctx.open_acc && ctx.open_acc.length) {
    lines.push('Open architectural requests: ' + ctx.open_acc
      .map((a) => a.what + ' (' + a.status + ')').join('; '));
  }
  if (!lines.length) return '';

  return 'WHO YOU ARE TALKING TO. They are signed into their own portal, so this is '
    + 'their own information and they can already see all of it on their screen.\n'
    + lines.map((l) => '  ' + l).join('\n') + '\n'
    + 'Use it so they never have to tell you what you already know. Do not recite '
    + 'it back at them unprompted and do not open by listing their account. If they '
    + 'ask about something here, answer from it directly. If they ask you to change, '
    + 'waive or decide any of it, that is a person\'s call, not yours.';
}

module.exports = { loadCallerContext, callerContextPrompt };
