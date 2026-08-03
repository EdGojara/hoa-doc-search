// ============================================================================
// lib/newsletters/section_types.js
// ----------------------------------------------------------------------------
// The canonical library of newsletter section types. The DB column
// newsletter_sections.section_type is deliberately NOT CHECK-constrained (the
// library grows); this is the single place that validates it, so the generator,
// the section CRUD, and the renderer all agree on what a valid block is.
//
// Each entry:
//   label   — human name shown in the Studio
//   icon    — chip/card icon
//   source  — 'data' (assembled from platform data), 'ai' (AI-drafted prose),
//             'manual' (staff fills in), or 'mixed'
// ============================================================================

const NEWSLETTER_SECTION_TYPES = {
  cover:              { label: 'Cover',               icon: '🖼️', source: 'mixed'  },
  table_of_contents:  { label: 'Contents',            icon: '📑', source: 'data'   },
  board_message:      { label: 'Message from the Board', icon: '📣', source: 'ai'  },
  community_contacts: { label: 'Community contacts',  icon: '☎️', source: 'data'   },
  hoa_corner:         { label: 'HOA Corner',          icon: '💡', source: 'ai'     },
  project_update:     { label: 'Project update',      icon: '🏗️', source: 'data'   },
  amenity_update:     { label: 'Amenity update',      icon: '🏊', source: 'mixed'  },
  event_feature:      { label: 'Featured event',      icon: '⭐', source: 'mixed'  },
  event_grid:         { label: 'Upcoming events',     icon: '📅', source: 'data'   },
  calendar:           { label: 'Calendar',            icon: '🗓️', source: 'data'   },
  amenity_schedule:   { label: 'Amenity schedule',    icon: '⏰', source: 'manual' },
  resident_spotlight: { label: 'Resident spotlight',  icon: '🌟', source: 'manual' },
  vendor_spotlight:   { label: 'Vendor spotlight',    icon: '🔧', source: 'manual' },
  advertisement:      { label: 'Advertisement',       icon: '📢', source: 'manual' },
  important_links:    { label: 'Important links',     icon: '🔗', source: 'data'   },
  emergency_contacts: { label: 'Emergency contacts',  icon: '🚨', source: 'data'   },
  custom_article:     { label: 'Article',             icon: '📝', source: 'manual' },
  recipe:             { label: 'Recipe',              icon: '🍴', source: 'ai'     },
  seasonal_tips:      { label: 'Seasonal tips',       icon: '🍂', source: 'ai'     },
  flyer:              { label: 'Event flyer',         icon: '🎏', source: 'mixed'  },
};

function isValidSectionType(t) {
  return Object.prototype.hasOwnProperty.call(NEWSLETTER_SECTION_TYPES, t);
}

module.exports = { NEWSLETTER_SECTION_TYPES, isValidSectionType };
