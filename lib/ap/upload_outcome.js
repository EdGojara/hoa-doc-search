// ============================================================================
// lib/ap/upload_outcome.js — what the Payables-tab upload tells the screen
// (Issue #9 prerequisite: upload converges on canonical AP intake)
// ----------------------------------------------------------------------------
// POST /api/ap/invoices/upload now runs the SAME rail as Emma's email intake
// (lib/ap/intake.js autoIntake → stageInvoice → resolve vendor/community →
// commitInvoice). This pure mapper turns that rail's outcome into the response
// the Payables tab renders. Tested in tests/test_ap_upload_intake.js.
//
//   loaded                    200 status 'ok'             the bill is in payables
//   held_suspected_duplicate  200 status 'held_duplicate' in payables ON HOLD for a
//                                                          person to confirm (same as
//                                                          email; no retry flag)
//   blocked_duplicate         409 status 'duplicate_invoice'
//   needs_review / not_an_invoice
//                             200 status 'needs_review'   captured in the Payables
//                                                          exceptions list with its PDF
// ============================================================================
function mapUploadOutcome(result, ctx = {}) {
  const r = result || {};
  const inv = ctx.invoice || null;
  switch (r.outcome) {
    case 'loaded':
    case 'held_suspected_duplicate':
      return {
        http: 200,
        body: {
          status: r.outcome === 'loaded' ? 'ok' : 'held_duplicate',
          message: r.outcome === 'loaded' ? null : 'Possible duplicate of a bill already in payables. It was added ON HOLD for review; nothing will be paid until someone confirms it.',
          invoice: inv,
          vendor: ctx.vendor || null,
          lines: ctx.lines || [],
          auto_coded: !!(inv && inv.auto_coded),
          coding_confidence: inv ? inv.auto_coding_confidence || null : null,
          needs_review: !!r.needs_review,
          posted: !!r.posting_journal_entry_id,
          duplicate_of: r.duplicate_of || null,
          intake: 'canonical',
        },
      };
    case 'blocked_duplicate':
      return {
        http: 409,
        body: {
          status: 'duplicate_invoice',
          message: (r.matches && r.matches[0] && r.matches[0].reason) || 'This bill is already in payables.',
          duplicate_of: r.duplicate_of || null,
          intake: 'canonical',
        },
      };
    case 'needs_review':
    case 'not_an_invoice':
      return {
        http: 200,
        body: {
          status: 'needs_review',
          reason: r.outcome === 'not_an_invoice' ? 'This file does not look like an invoice.' : (r.reason || 'Needs a person to finish filing it.'),
          exception_id: ctx.exceptionId || null,
          exception_recorded: !!ctx.exceptionId,
          intake: 'canonical',
        },
      };
    default:
      return { http: 500, body: { error: 'Unexpected intake result.', outcome: r.outcome || null, intake: 'canonical' } };
  }
}

module.exports = { mapUploadOutcome };
