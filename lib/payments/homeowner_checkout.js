// ============================================================================
// lib/payments/homeowner_checkout.js  (Ed 2026-09-27)
// ----------------------------------------------------------------------------
// Who may start a homeowner payment, and for which lot. The lot comes ONLY from
// the signed-in portal session's own scope; nothing the browser sends can point
// the payment at another property.
// ============================================================================

const PAYING_ROLES = new Set(['homeowner', 'board_member']);

// scoped = resolveScopedProperty() result for this session.
// -> { ok:true, propertyId } | { ok:false, status, error }
function authorizeHomeownerPayment({ user, mimic, scoped, requestedPropertyId }) {
  if (!user) return { ok: false, status: 401, error: 'not_signed_in' };
  if (mimic) return { ok: false, status: 403, error: 'staff_view_cannot_pay', detail: 'A staff "view as homeowner" session cannot make a payment.' };
  if (!PAYING_ROLES.has(user.role)) return { ok: false, status: 403, error: 'role_cannot_pay' };
  if (!scoped || scoped.isManager) return { ok: false, status: 403, error: 'role_cannot_pay' };
  const own = (scoped.allProperties || []).map((p) => String(p.id));
  if (!own.length) return { ok: false, status: 404, error: 'no_property' };
  if (requestedPropertyId) {
    // Explicitly asking for a lot that is not yours is refused, never silently redirected.
    if (!own.includes(String(requestedPropertyId))) return { ok: false, status: 403, error: 'property_not_yours' };
    return { ok: true, propertyId: String(requestedPropertyId) };
  }
  if (own.length > 1) return { ok: false, status: 400, error: 'property_required', detail: 'You have more than one property; choose which to pay.' };
  return { ok: true, propertyId: own[0] };
}

module.exports = { authorizeHomeownerPayment, PAYING_ROLES };
