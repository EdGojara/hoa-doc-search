// ============================================================================
// lib/team/growth_reply.js  (Ed 2026-08-30)
// ----------------------------------------------------------------------------
// Maggie's draft path. The engine is now shared across the whole internal
// Bedrock-ops team (see bedrock_ops_reply.js) — one engine, config-driven — so
// this file just re-exports it under the name Maggie's trainer/tests import.
// draftGrowthReply == draftBedrockOpsReply.
// ============================================================================
const { draftBedrockOpsReply } = require('./bedrock_ops_reply');
module.exports = { draftGrowthReply: draftBedrockOpsReply };
