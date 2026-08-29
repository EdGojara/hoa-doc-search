// ============================================================================
// lib/team/operator_actions.js  (Ed 2026-08-29)
// ----------------------------------------------------------------------------
// The action layer — where a teammate stops just answering and starts DOING.
// The north star is a management company that executes autonomously with humans
// watching; the only way that is safe is if "what may run on its own" is a hard,
// enforced-in-code distinction, not a prompt's good intentions.
//
// Two risk classes, and the boundary is absolute:
//   safe      reversible, append-only, no money/legal/records-of-decision.
//             MAY run autonomously once its lane is trusted.
//   reserved  irreversible or authority-bearing (waive, pay, approve, send a
//             §209 letter, delete). May ONLY ever be proposed for a human. There
//             is no autonomy setting that lets these self-execute.
//
// And it is DARK by default: autonomy = 'propose' means even safe actions are
// only described, never run, so the whole layer can be built and trained before
// anything mutates. Flip a lane to 'execute' when its exception rate has earned
// it — the same discipline as auto-send.
//
// Every executed action returns an audit record. Humans watching is a north-star
// requirement, not a nicety: the team's work must always be on the record.
// ============================================================================

// ---- Actions -------------------------------------------------------------
// Each: { name, risk, summarize(args), async execute(ctx, args) -> result }

const log_interaction = {
  name: 'log_interaction',
  risk: 'safe', // append-only row on the property/community timeline
  summarize: (args) => `Log a ${args.type || 'note'} on the timeline: "${String(args.subject || '').slice(0, 80)}"`,
  async execute(ctx, args) {
    if (!ctx.supabase) throw new Error('no supabase in context');
    if (!ctx.communityId) throw new Error('community_id is required to log an interaction');
    const row = {
      community_id: ctx.communityId,
      property_id: ctx.propertyId || null,
      contact_id: ctx.contactId || null,
      type: args.type || 'internal_note',
      direction: args.direction || 'internal',
      subject: args.subject || null,
      content: args.content || null,
      created_by: `${ctx.persona || 'operator'} (Bedrock AI)`,
      sent_at: args.occurredAt || new Date().toISOString(),
    };
    const { data, error } = await ctx.supabase.from('interactions').insert(row).select('id').single();
    if (error) throw error;
    return { interaction_id: data.id };
  },
};

const ACTIONS = Object.freeze({ log_interaction });

function resolveAction(name) {
  return ACTIONS[name] || null;
}

// The gate. reserved is never executed. safe runs only when the lane is on
// 'execute'; otherwise it is proposed. Returns an audit-shaped result either way.
async function runAction(action, args, ctx, { autonomy = 'propose' } = {}) {
  if (!action || typeof action.execute !== 'function') {
    return { status: 'error', error: 'unknown_action' };
  }
  const base = { action: action.name, risk: action.risk, summary: action.summarize ? action.summarize(args) : action.name, at: (ctx && ctx.now) || null };

  if (action.risk === 'reserved') {
    return { ...base, status: 'proposed', reason: 'reserved action — a human must approve and perform it' };
  }
  if (action.risk === 'safe' && autonomy === 'execute') {
    try {
      const result = await action.execute(ctx, args);
      return { ...base, status: 'done', result };
    } catch (e) {
      return { ...base, status: 'error', error: e.message };
    }
  }
  // safe but the lane is dark
  return { ...base, status: 'proposed', reason: 'autonomy is off for this lane (propose-only)' };
}

module.exports = { ACTIONS, resolveAction, runAction, log_interaction };
