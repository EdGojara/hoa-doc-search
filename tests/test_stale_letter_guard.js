// Locks the mail-run stale-letter guard (Ed 2026-09-08). A letter sealed before
// an over-escalation correction / void must be HELD at confirm-mailed, never
// mailed. Regression scar: 17715 Sunset River Lane's certified §209 was marked
// "do not mail" but mailed + billed anyway because the note was prose, not state.
const assert = require('assert');
const { partitionMailable } = require('../lib/enforcement/stale_letter_guard');

// Mock supabase: from('violations').select(...).in('id', ids) -> { data, error }.
function mockDb(stages) {
  return {
    from() {
      return {
        select() {
          return {
            in(_col, ids) {
              const data = ids.map((id) => ({ id, current_stage: stages[id]?.stage, status: stages[id]?.status }));
              return Promise.resolve({ data, error: null });
            },
          };
        },
      };
    },
  };
}

let p = 0, f = 0;
const ck = (n, fn) => fn().then(() => { console.log('  PASS ', n); p++; }).catch((e) => { console.log('  FAIL ', n, '\n    ' + e.message); f++; });

(async () => {
  await ck('certified §209 held when violation was reduced to courtesy_2 (the 17715 scar)', async () => {
    const db = mockDb({ v1: { stage: 'courtesy_2' } });
    const { mailable, stale } = await partitionMailable(db, [{ id: 'L1', type: 'letter_209', violation_id: 'v1', status: null }]);
    assert.strictEqual(mailable.length, 0);
    assert.strictEqual(stale.length, 1);
    assert.match(stale[0].reason, /outranks corrected stage courtesy_2/);
  });

  await ck('courtesy_2 held when violation was corrected down to courtesy_1', async () => {
    const db = mockDb({ v1: { stage: 'courtesy_1' } });
    const { mailable, stale } = await partitionMailable(db, [{ id: 'L1', type: 'letter_courtesy_2', violation_id: 'v1' }]);
    assert.strictEqual(stale.length, 1);
    assert.strictEqual(mailable.length, 0);
  });

  await ck('letter at the SAME stage as the corrected violation mails (the corrected letter itself)', async () => {
    const db = mockDb({ v1: { stage: 'courtesy_1' } });
    const { mailable, stale } = await partitionMailable(db, [{ id: 'L1', type: 'letter_courtesy_1', violation_id: 'v1' }]);
    assert.strictEqual(mailable.length, 1);
    assert.strictEqual(stale.length, 0);
  });

  await ck('any letter on a VOIDED violation is held', async () => {
    const db = mockDb({ v1: { stage: 'voided' } });
    const { stale } = await partitionMailable(db, [{ id: 'L1', type: 'letter_courtesy_1', violation_id: 'v1' }]);
    assert.strictEqual(stale.length, 1);
    assert.match(stale[0].reason, /voided/);
  });

  await ck('a first notice that CURED after issue is NOT blocked (no false hold)', async () => {
    const db = mockDb({ v1: { stage: 'cured' } });
    const { mailable, stale } = await partitionMailable(db, [{ id: 'L1', type: 'letter_courtesy_1', violation_id: 'v1' }]);
    assert.strictEqual(mailable.length, 1);
    assert.strictEqual(stale.length, 0);
  });

  await ck('an already-rejected letter is never mailed', async () => {
    const db = mockDb({ v1: { stage: 'courtesy_1' } });
    const { mailable, stale } = await partitionMailable(db, [{ id: 'L1', type: 'letter_courtesy_1', violation_id: 'v1', status: 'rejected' }]);
    assert.strictEqual(mailable.length, 0);
    assert.strictEqual(stale.length, 1);
  });

  await ck('a letter with no violation link is left alone (mails)', async () => {
    const db = mockDb({});
    const { mailable } = await partitionMailable(db, [{ id: 'L1', type: 'letter_courtesy_1', violation_id: null }]);
    assert.strictEqual(mailable.length, 1);
  });

  console.log(`\nstale_letter_guard: ${p} passed, ${f} failed`);
  if (f) process.exit(1);
})();
