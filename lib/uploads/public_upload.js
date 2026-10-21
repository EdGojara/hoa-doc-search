// ============================================================================
// publicUpload — the ONE way an unauthenticated route accepts multipart uploads.
// ----------------------------------------------------------------------------
// multer parses the whole request into memory BEFORE the route handler runs,
// so on a no-login route (server.js _STAFF_GATE_PUBLIC) every limit here is the
// only thing standing between an anonymous request and the process. Bare
// multer() leaves most of them at Infinity:
//
//   - files / fields          unbounded → upload.any() at 20 MB per file had no
//                             ceiling at all on a single request's memory
//   - fieldArrayIndexLimit    unbounded → `a[4294967294]` + `a[b]` pins the CPU
//                             (GHSA-535w-7cp7-47q4; multer 2.4 only fixes it
//                             when this limit is set)
//   - fieldNestingDepth       unbounded (GHSA-72gw-mp4g-v24j, same opt-in)
//   - total request bytes     multer has no such limit; files × fileSize can be
//                             hundreds of MB held in memory
//
// Every rejection is a clean JSON 400/413 with a plain-English message, never
// an Express 500 page, and is logged with the route and reason.
// Enforced by tests/test_public_upload_limits.js: a public multer route that
// doesn't go through this helper fails the build.
// ============================================================================

const { Transform } = require('stream');
const multer = require('multer');

// No public form sends bracketed field names; a little headroom, no more.
const PUBLIC_FIELD_LIMITS = Object.freeze({
  fields: 50,
  fieldNameSize: 100,
  fieldSize: 1024 * 1024,
  fieldNestingDepth: 2,
  fieldArrayIndexLimit: 100,
});

const MB = 1024 * 1024;
const mb = (n) => `${Math.round(n / MB)} MB`;

class UploadTooLargeError extends Error {
  constructor(max) {
    super(`upload exceeds ${max} bytes`);
    this.code = 'UPLOAD_TOO_LARGE';
    this.max = max;
  }
}

function rejection(err, opts) {
  switch (err && err.code) {
    case 'UPLOAD_TOO_LARGE':
      return [413, `The upload is too large. Please keep the total under ${mb(opts.maxTotalBytes)}.`];
    case 'LIMIT_FILE_SIZE':
      return [413, `${err.filename ? `"${err.filename}"` : 'One of the files'} is larger than ${mb(opts.fileSize)}. Please attach a smaller file.`];
    case 'LIMIT_FILE_COUNT':
    case 'LIMIT_UNEXPECTED_FILE':
      return [413, `Too many files. Please attach no more than ${opts.files}.`];
    case 'LIMIT_PART_COUNT':
    case 'LIMIT_FIELD_COUNT':
      return [400, 'The form sent too many fields.'];
    case 'LIMIT_FIELD_KEY':
    case 'LIMIT_FIELD_VALUE':
    case 'LIMIT_FIELD_NESTING':
    case 'LIMIT_FIELD_ARRAY_INDEX':
    case 'INVALID_FIELD_NAME':
    case 'MISSING_FIELD_NAME':
      return [400, 'The form contained a field we could not accept.'];
    default:
      // busboy parse errors ("Unexpected end of form", "Malformed part header", …)
      return [400, 'The upload could not be read. Please try again.'];
  }
}

function uploadedFiles(req) {
  if (req.file) return [req.file];
  if (Array.isArray(req.files)) return req.files;
  if (req.files && typeof req.files === 'object') return Object.values(req.files).flat();
  return [];
}

/**
 * @param {object} opts
 * @param {string} opts.route       label for logs, e.g. 'applications.public.submit'
 * @param {number} opts.fileSize    max bytes per file
 * @param {number} opts.files       max number of files
 * @param {number} opts.maxTotalBytes  max bytes for the whole request body
 * @returns {{single, array, fields, any}} same surface as a multer instance
 */
function publicUpload(opts) {
  const { route, fileSize, files, maxTotalBytes } = opts;
  if (!route || !Number.isInteger(fileSize) || !Number.isInteger(files) || !Number.isInteger(maxTotalBytes)) {
    throw new TypeError('publicUpload needs route, fileSize, files and maxTotalBytes');
  }

  // Count bytes on the way into busboy; past maxTotalBytes, fail the parse so
  // multer aborts, drops what it buffered, drains the rest of the body and only
  // then answers (so the client sees the 413, not a reset). Covers chunked
  // bodies and a Content-Length that lies.
  function streamHandler(req, busboy) {
    let seen = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        seen += chunk.length;
        if (seen > maxTotalBytes) {
          detach();
          busboy.destroy(new UploadTooLargeError(maxTotalBytes));
          return cb();
        }
        cb(null, chunk);
      },
    });
    // multer only unpipes req from busboy; with the counter in between, detach
    // both hops when busboy ends for any reason, so nothing writes to a
    // destroyed parser.
    function detach() {
      req.unpipe(counter);
      counter.unpipe(busboy);
    }
    counter.on('error', () => {});
    busboy.once('close', detach);
    req.pipe(counter).pipe(busboy);
  }

  const m = multer({
    storage: multer.memoryStorage(),
    limits: { ...PUBLIC_FIELD_LIMITS, fileSize, files, parts: files + PUBLIC_FIELD_LIMITS.fields },
    streamHandler,
  });

  function respond(err, req, res) {
    const [status, message] = rejection(err, opts);
    console.warn(`[public-upload] ${route} rejected ${status} ${err && err.code ? err.code : 'PARSE_ERROR'}: ${err && err.message}`);
    // req.destroyed is true after a normal end (autoDestroy), so judge by the
    // response side: only skip when it is already answered or the socket is gone.
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    res.status(status).json({ error: message, code: (err && err.code) || 'MALFORMED_UPLOAD' });
  }

  const wrap = (mw) => function publicUploadMiddleware(req, res, next) {
    // Declared too big: never parse it. Drain (nothing is kept) and answer
    // once the client has finished sending, as multer does for its own limits.
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxTotalBytes) {
      let answered = false;
      const answer = () => { if (!answered) { answered = true; respond(new UploadTooLargeError(maxTotalBytes), req, res); } };
      req.once('end', answer);
      req.once('close', answer);
      req.once('error', answer);
      req.resume();
      return;
    }
    mw(req, res, (err) => {
      if (err) return respond(err, req, res);
      // multer >= 2.3 decodes %0A/%0D/%22 in filenames (WHATWG escapes), so a
      // client-supplied name can now carry CR/LF. Strip control characters
      // before it reaches a stored record or a download header.
      for (const f of uploadedFiles(req)) {
        if (typeof f.originalname === 'string') f.originalname = f.originalname.replace(/[\u0000-\u001f\u007f]/g, '');
      }
      next();
    });
  };

  return {
    single: (name) => wrap(m.single(name)),
    array: (name, maxCount) => wrap(m.array(name, maxCount)),
    fields: (spec) => wrap(m.fields(spec)),
    any: () => wrap(m.any()),
    limits: Object.freeze({ fileSize, files, maxTotalBytes, ...PUBLIC_FIELD_LIMITS }),
  };
}

module.exports = { publicUpload, PUBLIC_FIELD_LIMITS, UploadTooLargeError };
