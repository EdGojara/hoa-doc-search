// =============================================================================
// tests/test_bd_card.js — BD digital business cards
// =============================================================================
//
// What this protects, and why each one is a check instead of a comment:
//
// 1. QR PAYLOAD SIZE. Scan reliability is set by how many screen pixels each
//    QR module gets. Measured on the rendered images: at QR version <= 11 the
//    code reads under blur, glare, 40 degrees of rotation and a capture as
//    small as 300px wide. Adding the postal address and both URLs pushed it to
//    version 15 and the smaller surfaces started failing to read at all.
//    Nothing about that failure is visible by looking at the card — it renders
//    beautifully and simply does not scan. So the version is asserted.
//
// 2. NO RAW COMMAS in FN / ORG / ADR. vCard escaping of a comma is
//    spec-correct, but an importer that mishandles it drops a literal
//    backslash into a prospect's contact list, on the most visible field there
//    is. Credentials belong in the N suffix field instead.
//
// 3. PHONE LABELS. Cell, direct and office are three different numbers and are
//    not interchangeable. They were wrong once already: the "Direct" line from
//    the email signature went onto the card as the cell. A prospect calling
//    the wrong number is exactly the small failure that reads as sloppy.
//
// 4. CELL IS FIRST. Phones surface the first TEL as the default call target.
//
// Run: node tests/test_bd_card.js   (wired into npm test)
// =============================================================================

const assert = require('assert');
const QRCode = require('qrcode');
const {
  listPeople, getPerson, buildVCard, publicPerson,
} = require('../lib/bd/people');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

// The version ceiling that was actually measured against rendered output.
// Raising this number is not a fix — it means the code got denser and the
// smaller surfaces need re-verifying against real captures first.
const MAX_QR_VERSION = 11;

console.log('\nBD digital business cards\n');

const people = listPeople();
assert(people.length > 0, 'roster is empty');

for (const person of people) {
  const p = publicPerson(person);
  const scan = buildVCard(person, { scan: true });
  const full = buildVCard(person);
  console.log(`${p.displayName} (${p.slug})`);

  check('scan payload stays inside the measured QR size', () => {
    const qr = QRCode.create(scan, { errorCorrectionLevel: 'M' });
    assert(
      qr.version <= MAX_QR_VERSION,
      `QR version ${qr.version} exceeds ${MAX_QR_VERSION} `
      + `(payload ${scan.length} chars). Denser codes lost scans to blur and `
      + 'glare on the card and print surfaces. Trim a field instead.',
    );
  });

  check('vCard is well formed', () => {
    for (const v of [scan, full]) {
      assert(v.startsWith('BEGIN:VCARD\r\nVERSION:3.0\r\n'), 'bad header');
      assert(v.endsWith('END:VCARD\r\n'), 'bad terminator');
      // Bare LF breaks some Android importers.
      assert(!/[^\r]\n/.test(v), 'found a bare LF; every line must end CRLF');
    }
  });

  check('no raw comma in FN / ORG / ADR', () => {
    for (const v of [scan, full]) {
      for (const field of ['FN', 'ORG', 'ADR']) {
        const line = v.split('\r\n').find((l) => l.startsWith(`${field}:`)
          || l.startsWith(`${field};`));
        if (!line) continue;
        assert(
          !line.includes(','),
          `${field} contains a comma (${line}). Escaping is spec-correct but a `
          + 'mishandling importer leaves a literal backslash in the contact.',
        );
      }
    }
  });

  check('credentials never appear in FN', () => {
    if (!person.credentials) return;
    const fn = full.split('\r\n').find((l) => l.startsWith('FN:'));
    assert(
      !fn.includes(person.credentials),
      `FN carries "${person.credentials}"; it belongs in the N suffix field`,
    );
  });

  check('every roster phone reaches the vCard, cell first', () => {
    const tels = full.split('\r\n').filter((l) => l.startsWith('TEL'));
    const present = (raw) => {
      if (!raw) return true;
      const e164 = `+1${String(raw).replace(/\D/g, '')}`;
      return tels.some((t) => t.endsWith(e164));
    };
    assert(present(person.phoneCell), 'cell missing from vCard');
    assert(present(person.phoneDirect), 'direct missing from vCard');
    assert(present(person.phoneOffice), 'office missing from vCard');

    if (person.phoneCell) {
      assert(
        /TYPE=CELL/.test(tels[0]),
        'first TEL is not the cell; phones call the first entry by default',
      );
    }
  });

  check('the three numbers are distinct', () => {
    const nums = [person.phoneCell, person.phoneDirect, person.phoneOffice]
      .filter(Boolean).map((n) => String(n).replace(/\D/g, ''));
    assert(
      new Set(nums).size === nums.length,
      'two phone fields hold the same number, so one label is wrong',
    );
  });

  check('public payload exposes no unexpected field', () => {
    // Explicit allowlist: adding an internal-only field to the roster must not
    // silently start shipping it to a stranger's browser.
    const allowed = new Set([
      'slug', 'first', 'last', 'name', 'displayName', 'credentials', 'title',
      'org', 'orgShort', 'titleSecondary', 'orgSecondary', 'email',
      'phoneCell', 'phoneCellHref', 'phoneDirect', 'phoneDirectHref',
      'phoneOffice', 'phoneOfficeHref',
      'addressLine1', 'addressLine2', 'addressInline', 'mapsUrl',
      'websites', 'blurb', 'cardUrl', 'vcfUrl', 'qrUrl', 'qrVcardUrl',
    ]);
    const extra = Object.keys(p).filter((k) => !allowed.has(k));
    assert(extra.length === 0, `unexpected public field(s): ${extra.join(', ')}`);
  });

  console.log('');
}

check('unknown slug resolves to nothing', () => {
  assert.strictEqual(getPerson('definitely-not-a-person'), null);
  assert.strictEqual(getPerson(''), null);
  assert.strictEqual(getPerson(null), null);
});

console.log('');
if (failures) {
  console.log(`BD card tests: ${failures} FAILED\n`);
  process.exit(1);
}
console.log('BD card tests: all passed\n');
