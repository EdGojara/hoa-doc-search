// ============================================================================
// lib/company.js  (2026-09-20)
// ----------------------------------------------------------------------------
// The ONE authoritative definition of the Bedrock management company's identity.
//
// trustEd runs a single management company today — Bedrock Association Management
// — and its id was re-typed as a literal in 70+ modules. This file records that
// fact in exactly one place so the value cannot drift and there is a single
// point to change.
//
// This is DELIBERATELY NOT a tenant-resolution layer. We do not resolve identity
// from request/auth context, and importing this constant is not "multi-tenant".
// When (if) the platform becomes multi-tenant, the fix is to replace imports of
// this constant with a context-derived id — this file is the seam that makes
// that future change local instead of a 70-file sweep. (Ed 2026-09-20: consolidate
// the existing value; do not implement multi-tenancy.)
// ============================================================================
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

module.exports = { BEDROCK_MGMT_CO_ID };
