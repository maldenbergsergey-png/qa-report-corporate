const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { createSessionToken } = require('../auth');

test('corporate report links keep sessions, CSRF, author ownership, revisions and revocation', { timeout: 30000 }, async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'corporate-sharing-'));
  const secret = 'isolated-corporate-sharing-fixture-secret-123456';
  const env = { ...process.env, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: '0', AUTH_SECRET: secret,
    REPORTS_DB_PATH: path.join(dir, 'reports.sqlite'), QA_REPORT_PUBLIC_URL: '', APP_PUBLIC_URL: '', PUBLIC_URL: '',
    QA_STORAGE_ENDPOINT: 'https://storage.example.test', QA_STORAGE_BUCKET: 'fixture-bucket', QA_STORAGE_REGION: 'us-east-1',
    QA_STORAGE_ACCESS_KEY: 'fixture-access', QA_STORAGE_SECRET_KEY: 'fixture-secret' };
  const server = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { server.kill(); rmSync(dir, { recursive: true, force: true }); });
  let stderr = '';
  server.stderr.on('data', bytes => { stderr += bytes; });
  const origin = await new Promise((resolve, reject) => {
    server.stdout.on('data', bytes => { const match = /QA Report: (http:\/\/127\.0\.0\.1:\d+)/.exec(bytes.toString()); if (match) resolve(match[1]); });
    server.once('exit', code => reject(new Error(`Server exited ${code}: ${stderr}`)));
  });
  const session = email => `query-port-session=${createSessionToken(email, { env: { AUTH_SECRET: secret } })}`;
  const author = session('author@example.test'), reader = session('reader@example.test');
  const call = (route, { cookie, bearer, csrf, body, method = body ? 'POST' : 'GET', originHeader = origin } = {}) => fetch(origin + route, {
    method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(csrf ? { 'X-QA-CSRF-Token': csrf } : {}), ...(body ? { 'Content-Type': 'application/json', Origin: originHeader } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal((await call('/api/shared-reports/availability')).status, 401);
  assert.equal((await call('/shared-report/' + '1'.repeat(32))).status, 302);
  const csrfResponse = await call('/api/auth/csrf', { cookie: author });
  const { csrfToken } = await csrfResponse.json();
  const csrfCookie = csrfResponse.headers.get('set-cookie').split(';')[0];
  const authorCookies = author + '; ' + csrfCookie, readerCookies = reader + '; ' + csrfCookie;
  // Parallel requests can reuse the same live cookie, without invalidating in-flight uploads.
  assert.equal((await (await call('/api/auth/csrf', { cookie: authorCookies })).json()).csrfToken, csrfToken);
  const input = { publishKey: randomBytes(32).toString('base64url'), earlyLink: true, batchUploads: true, files: [],
    snapshot: { title: 'QA-123', issueUrl: 'https://example.test/browse/QA-123', intro: { text: 'Context' },
      sections: [{ id: 'section', title: 'Checks', columns: [{ id: 'check', label: 'Проверка' }],
        rows: [{ id: 'row', number: '1', status: 'НЕ ОК', cells: { check: { text: 'Example check' } } }] }] } };
  assert.equal((await call('/api/shared-reports/prepare', { cookie: authorCookies, body: input })).status, 403);
  assert.equal((await call('/api/shared-reports/prepare', { cookie: authorCookies, csrf: csrfToken, body: input, originHeader: 'https://outside.example.test' })).status, 403);
  const prepared = await call('/api/shared-reports/prepare', { cookie: authorCookies, csrf: csrfToken, body: input });
  assert.equal(prepared.status, 200, await prepared.clone().text());
  const { publication } = await prepared.json();
  assert.ok(publication?.id);
  const route = '/api/shared-reports/' + publication.id;
  assert.equal((await call(route, { bearer: publication.replyToken })).status, 401);
  assert.equal((await call(route, { cookie: readerCookies })).status, 404);
  assert.equal((await call(route, { cookie: readerCookies, bearer: publication.replyToken })).status, 200);
  const html = await call('/shared-report/' + publication.id, { cookie: readerCookies });
  assert.equal(html.status, 200);
  assert.match(await html.text(), /data-corporate-session="required"/);
  const answer = { sectionId: 'section', rowId: 'row', status: 'fixed', comment: 'Done', revision: 0 };
  assert.equal((await call(route + '/answers', { cookie: readerCookies, bearer: publication.replyToken, body: answer })).status, 403);
  assert.equal((await call(route + '/answers', { cookie: readerCookies, bearer: publication.replyToken, csrf: csrfToken, body: answer })).status, 200);
  assert.equal((await call(route + '/answers', { cookie: readerCookies, bearer: publication.replyToken, csrf: csrfToken, body: { ...answer, comment: 'stale' } })).status, 409);
  assert.equal((await call(route, { method: 'DELETE', cookie: readerCookies, bearer: publication.ownerToken, csrf: csrfToken })).status, 403);
  const update = { ...input, publishKey: randomBytes(32).toString('base64url'), update: { id: publication.id, ownerToken: publication.ownerToken } };
  assert.equal((await call('/api/shared-reports/prepare', { cookie: readerCookies, csrf: csrfToken, body: update })).status, 403);
  assert.equal((await call(route, { method: 'DELETE', cookie: authorCookies, bearer: publication.ownerToken, csrf: csrfToken })).status, 200);
  assert.equal((await call(route, { cookie: readerCookies, bearer: publication.replyToken })).status, 404);
});
