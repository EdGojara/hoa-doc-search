// ============================================================================
// lib/close/ownership.js  (Ed 2026-10-15: the accounting department as one team)
// ----------------------------------------------------------------------------
// Who owns the next step on each month-end close control. ONE map, read by
// Mission Control (lib/mission_control/operations.js) and Amanda's close cadence
// (lib/close/cadence.js), so a control is never Kat's on one screen and Emma's
// on another.
//   Kat    cash, GL, homeowners, recognition, interfund, conversion, cutoff
//          (CUT-02/03), deferred/prepaid schedules, other required sources
//   Emma   bills: AP-*, CUT-01 (late-arriving bills), DATA-04 (bills received but
//          not booked), DATA-05 (recurring vendors not billed)
//   Ed     DATA-02: a missing bank/investment statement only Ed can obtain
//   Amanda the board side: meeting dates, close deadlines, the packet
// ============================================================================
'use strict';

const OWNER = 'Ed';
const CONTROL_OWNER = { 'DATA-02': OWNER, 'CUT-01': 'Emma', 'DATA-04': 'Emma', 'DATA-05': 'Emma' };
const BOARD_OWNER = 'Amanda';

function controlOwner(code) {
  const c = String(code || '');
  if (CONTROL_OWNER[c]) return CONTROL_OWNER[c];
  if (c.startsWith('AP-')) return 'Emma';
  return 'Kat';
}

module.exports = { controlOwner, CONTROL_OWNER, OWNER, BOARD_OWNER };
