// ============================================================================
// lib/community_branding.js — community visual branding (logo + hero photo)
// ----------------------------------------------------------------------------
// Single source for the hard-coded per-community branding map (not to be
// confused with the community_assets TABLE of physical assets, migration 440). Moved here from
// api/board_packets.js (Issue #6, 2026-09-29) so the board packet renderer and
// the Operator Home hero read the SAME map instead of two copies.
//
// Hardcoded for now (only 3 communities have full assets); later this moves
// to a logo_path / hero_path column on the communities table so Ed can upload
// new community photos from the UI. Uploaded assets (community.logo_signed_url,
// community.hero_signed_url) still win over this map in resolveCommunityAssets
// (api/board_packets.js).
// ============================================================================
const COMMUNITY_ASSETS = {
  'Lakes of Pine Forest': {
    hero: '/photos/communities/LPF_hero.jpg',
    logo: '/logos/lakes_of_pine_forest_logo.png',
    legal_suffix: 'Homeowners Association'
  },
  'Canyon Gate at Cinco Ranch': {
    hero: null,
    logo: '/logos/canyon_gate_logo.png',
    legal_suffix: 'Homeowners Association'
  },
  'Waterview Estates': {
    hero: null,
    logo: '/logos/waterview_logo.jpg',
    legal_suffix: 'Homeowners Association'
  }
};

function getCommunityAssets(communityName) {
  return COMMUNITY_ASSETS[communityName] || { hero: null, logo: null, legal_suffix: '' };
}

module.exports = { COMMUNITY_ASSETS, getCommunityAssets };
