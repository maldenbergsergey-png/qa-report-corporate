// Test-only S3 endpoint. No external network requests are permitted in this process.
const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { appendFileSync } = require('node:fs');
if (process.env.QA_REPORT_TEST_S3 !== 'enabled') throw new Error('S3 fixture must be explicitly enabled');
const objects = new Map();
const failures = new Set();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  if (url.origin !== 'https://storage.example.test') throw new Error('Unexpected network destination in S3 fixture');
  const headers = new Headers(options.headers);
  const method = options.method || 'GET';
  const bytes = options.body == null ? Buffer.alloc(0) : Buffer.from(options.body);
  const authorization = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/([^,]+), SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/.exec(headers.get('authorization') || '');
  let valid = false;
  if (authorization && authorization[1] === 'corporate-fixture-access') {
    const scope = authorization[2], names = authorization[3].split(';');
    const canonicalHeaders = names.map(name => `${name}:${headers.get(name)}\n`).join('');
    const canonical = [method, url.pathname, url.search.slice(1), canonicalHeaders, names.join(';'), hash(bytes)].join('\n');
    const [day, region, service, terminator] = scope.split('/');
    const signing = hmac(hmac(hmac(hmac('AWS4corporate-fixture-secret', day), region), service), terminator);
    const expected = createHmac('sha256', signing).update(['AWS4-HMAC-SHA256', headers.get('x-amz-date'), scope, hash(canonical)].join('\n')).digest();
    valid = region === 'eu-central-1' && service === 's3' && terminator === 'aws4_request' &&
      headers.get('x-amz-content-sha256') === hash(bytes) && timingSafeEqual(expected, Buffer.from(authorization[4], 'hex'));
  }
  const key = decodeURIComponent(url.pathname);
  appendFileSync(process.env.QA_REPORT_TEST_S3_LOG, JSON.stringify({ method, key, valid, size: bytes.length }) + '\n');
  if (!valid || !key.startsWith('/corporate-fixture-bucket/')) return new Response('AccessDenied', { status: 403 });
  if (method === 'PUT') {
    if (key.endsWith('/retry-file') && !failures.has(key)) { failures.add(key); return new Response('Unavailable', { status: 503 }); }
    objects.set(key, bytes);
    return new Response(null, { status: 200 });
  }
  if (method === 'GET') return objects.has(key) ? new Response(objects.get(key), { status: 200 }) : new Response(null, { status: 404 });
  if (method === 'DELETE') { objects.delete(key); return new Response(null, { status: 204 }); }
  throw new Error('Unexpected S3 operation');
};
