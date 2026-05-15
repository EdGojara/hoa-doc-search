// Builds a self-contained preview of the public nomination form so Ed can
// open it offline and click through everything — toggle self/other, see
// the photo preview render, expand the scanned-form upload, etc. — without
// needing the server running.
//
// Strategy: read public/nominate.html as-is, inject a small bootstrap script
// that monkey-patches window.fetch BEFORE the page's own script runs.
// All /api/nominations/public/* calls return mocked data; everything else
// passes through. Submit is intercepted with an alert so we don't try to
// actually send anywhere.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'public', 'nominate.html');
const OUT_DIR = path.join(process.env.USERPROFILE || process.env.HOME || '.', 'Downloads');

// Mock cycle data — what /api/nominations/public/:slug would return live.
const MOCK_CYCLE = {
  cycle: {
    id: 'preview-cycle',
    community_name: 'Waterview Estates',
    annual_meeting_date: '2026-06-23',
    annual_meeting_time: '6:00 PM',
    annual_meeting_location: 'Waterview Estates Clubhouse, 5110 Waterview Estates Trail, Richmond, TX 77407',
    nominations_open_at: '2026-04-01',
    nominations_close_at: '2026-05-29',
    seats_open: 1,
    description: null,
    status: 'open',
    public_slug: 'wve-2026',
  },
  is_open: true,
  today: '2026-05-15',
};

const MOCK_SCRIPT = `
<script>
  // Preview mode — intercept fetch calls so the form loads against mocked
  // cycle data and submission doesn't try to actually post anywhere.
  (function () {
    const realFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf('/api/nominations/public/') !== -1 && url.indexOf('/submit') === -1) {
        // GET cycle data
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(${JSON.stringify(MOCK_CYCLE)})
        });
      }
      if (url.indexOf('/api/nominations/public/') !== -1 && url.indexOf('/submit') !== -1) {
        // POST submission — show a friendly alert, simulate success.
        alert('PREVIEW MODE — submission was not actually sent. In the live app this nomination would be saved to trustEd with all attached files (photo, scanned form).');
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, nomination_id: 'preview', attached: { photo: false, scanned_form: false } })
        });
      }
      return realFetch(input, init);
    };
  })();
</script>
`;

const html = fs.readFileSync(SRC, 'utf8');
// Inject the mock right before the closing </head> so it runs before the
// page's own DOMContentLoaded handlers.
const injected = html.replace('</head>', MOCK_SCRIPT + '</head>');

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
const outPath = path.join(OUT_DIR, 'PREVIEW_Public_Nomination_Form.html');
fs.writeFileSync(outPath, injected, 'utf8');
console.log('Public form preview: ' + outPath);
