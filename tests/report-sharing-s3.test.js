const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes, createHash } = require('node:crypto');
const { createSessionToken } = require('../auth');

test('corporate login publishes, reads, updates and revokes S3 reports and developer attachments', { timeout: 30000 }, async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'corporate-s3-'));
  const secret = 'isolated-corporate-s3-session-secret-123456789';
  const accessFile = path.join(dir, 'access'), secretFile = path.join(dir, 'secret'), logFile = path.join(dir, 's3.log');
  writeFileSync(accessFile, 'corporate-fixture-access\n'); writeFileSync(secretFile, 'corporate-fixture-secret\n'); writeFileSync(logFile, '');
  const server = spawn(process.execPath, ['--require', path.join(__dirname, 'fixtures/corporate-s3-preload.cjs'), 'server.js'], {
    cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: '0', AUTH_SECRET: secret,
      DEV_LOGIN_EMAIL: 'author@example.test', DEV_LOGIN_PASSWORD: 'local-test-only',
      QA_REPORT_PUBLIC_URL: '', APP_PUBLIC_URL: '', PUBLIC_URL: '', REPORTS_DB_PATH: path.join(dir, 'reports.sqlite'),
      QA_STORAGE_ENDPOINT: 'https://storage.example.test', QA_STORAGE_BUCKET: 'corporate-fixture-bucket', QA_STORAGE_REGION: 'eu-central-1',
      QA_STORAGE_ACCESS_KEY: '', QA_STORAGE_SECRET_KEY: '', QA_STORAGE_ACCESS_KEY_FILE: accessFile, QA_STORAGE_SECRET_KEY_FILE: secretFile,
      QA_REPORT_S3_CONFIG_FILE: path.join(dir, 'unused-personal-config.json'), QA_REPORT_TEST_S3: 'enabled', QA_REPORT_TEST_S3_LOG: logFile },
  });
  t.after(() => { server.kill(); rmSync(dir, { recursive: true, force: true }); });
  let stderr = '';
  server.stderr.on('data', bytes => { stderr += bytes; });
  const origin = await new Promise((resolve, reject) => {
    server.stdout.on('data', bytes => { const match = /QA Report: (http:\/\/127\.0\.0\.1:\d+)/.exec(bytes.toString()); if (match) resolve(match[1]); });
    server.once('exit', code => reject(new Error(`Server exited ${code}: ${stderr}`)));
  });
  let cookie = '', csrf = '';
  const call = (route, { body, method = body ? 'POST' : 'GET', token, session = cookie, csrfToken = csrf } = {}) => fetch(origin + route, {
    method, redirect: 'manual', headers: { ...(session ? { Cookie: session } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(csrfToken ? { 'X-QA-CSRF-Token': csrfToken } : {}), ...(body ? { Origin: origin, 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const csrfResponse = await call('/api/auth/csrf'); csrf = (await csrfResponse.json()).csrfToken;
  cookie = csrfResponse.headers.get('set-cookie').split(';')[0];
  const login = await call('/api/auth/login', { body: { email: 'author@example.test', password: 'local-test-only', csrfToken: csrf, callbackUrl: '/' } });
  assert.equal(login.status, 200);
  cookie += '; ' + login.headers.get('set-cookie').split(';')[0];
  const main = await (await call('/')).text();
  assert.match(main, /id="publicationMenuButton"/); assert.match(main, /id="linkPublication"/); assert.match(main, /id="shareReportButton"/);
  const availability = await (await call('/api/shared-reports/availability')).json();
  assert.equal(availability.enabled, true); assert.equal(availability.requiresPublishToken, false); assert.equal(availability.publishableKey, undefined);
  const bytes = Buffer.alloc(1024 * 1024, 42), digest = createHash('sha256').update(bytes).digest('hex');
  const file = { id: 'snapshot-file', name: 'evidence.png', type: 'image/png', size: bytes.length, sha256: digest };
  const input = { publishKey: randomBytes(32).toString('base64url'), batchUploads: true, earlyLink: true, files: [file],
    snapshot: { title: 'QA-123', issueUrl: 'https://example.test/browse/QA-123', intro: { text: 'Context', attachments: [file.id] },
      sections: [{ id: 'section', title: '1. Checks', columns: [{ id: 'check', label: 'Проверка' }], rows: [
        { id: 'row', number: '1.1', status: 'НЕ ОК', cells: { check: { text: 'Example' } } },
      ] }] } };
  const preparedResponse = await call('/api/shared-reports/prepare', { body: input });
  assert.equal(preparedResponse.status, 200, await preparedResponse.clone().text());
  const prepared = await preparedResponse.json(), { publication } = prepared;
  assert.deepEqual(prepared.uploads, [{ id: file.id, viaServer: true }]);
  const route = '/api/shared-reports/' + publication.id;
  assert.equal((await call(route + '/files/' + file.id, { token: publication.replyToken, session: '' })).status, 401);
  const batch = await call('/api/shared-reports/upload-batch', { body: { publishKey: input.publishKey, files: [{ id: file.id, data: bytes.toString('base64') }] } });
  assert.equal(batch.status, 200, await batch.clone().text()); assert.equal((await batch.json()).results[0].status, 200);
  assert.equal((await call('/api/shared-reports/complete', { body: { publishKey: input.publishKey } })).status, 200);
  assert.deepEqual(Buffer.from(await (await call(route + '/files/' + file.id, { token: publication.replyToken })).arrayBuffer()), bytes);
  const developerFile = { id: 'answer-image', sectionId: 'section', rowId: 'row', name: 'reply.png', type: 'image/png', data: bytes.toString('base64') };
  const uploadReply = await call(route + '/answer-files', { token: publication.replyToken, body: developerFile });
  assert.equal(uploadReply.status, 200, await uploadReply.clone().text()); assert.equal((await uploadReply.json()).file.id, developerFile.id);
  const document = [{ tag: 'p', children: ['Done', { tag: 'attachment', id: developerFile.id }] }];
  const reply = { sectionId: 'section', rowId: 'row', status: 'fixed', comment: 'Done', revision: 0, commentDocument: document };
  assert.equal((await call(route + '/answers', { token: publication.replyToken, body: reply })).status, 200);
  assert.deepEqual(Buffer.from(await (await call(route + '/answer-files/' + developerFile.id, { token: publication.replyToken })).arrayBuffer()), bytes);
  const read = await (await call(route, { token: publication.replyToken })).json();
  assert.equal(read.report.answers[0].status, 'fixed'); assert.deepEqual(read.report.answers[0].commentDocument, document);
  assert.equal(read.report.answerFiles.length, 1);
  const beforeUpdate = readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse).filter(x => x.method === 'PUT').length;
  const update = { ...input, publishKey: randomBytes(32).toString('base64url'), snapshot: { ...input.snapshot, title: 'Updated' },
    update: { id: publication.id, ownerToken: publication.ownerToken }, reuseFrom: [{ id: publication.id, ownerToken: publication.ownerToken }] };
  assert.equal((await call('/api/shared-reports/prepare', { body: update })).status, 200);
  const updated = await (await call(route, { token: publication.replyToken })).json();
  assert.equal(updated.report.title, 'Updated'); assert.equal(updated.report.answers[0].status, 'fixed'); assert.equal(updated.report.answerFiles.length, 1);
  assert.equal(readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse).filter(x => x.method === 'PUT').length, beforeUpdate);
  const expired = 'query-port-session=' + createSessionToken('author@example.test', { env: { AUTH_SECRET: secret }, now: Date.now() - 7 * 86400000 });
  assert.equal((await call(route, { token: publication.replyToken, session: expired })).status, 401);
  assert.equal((await call(route + '/answers', { token: publication.replyToken, body: reply, csrfToken: 'wrong' })).status, 403);
  // Transient S3 failures retain the publication attempt and allow the same upload to resume.
  const retryFile = { ...file, id: 'retry-file' }, retryInput = { ...input, publishKey: randomBytes(32).toString('base64url'),
    files: [retryFile], snapshot: { ...input.snapshot, intro: { text: 'Retry', attachments: [retryFile.id] } } };
  assert.equal((await call('/api/shared-reports/prepare', { body: retryInput })).status, 200);
  const retryBody = { publishKey: retryInput.publishKey, files: [{ id: retryFile.id, data: bytes.toString('base64') }] };
  const interrupted = await (await call('/api/shared-reports/upload-batch', { body: retryBody })).json();
  assert.equal(interrupted.results[0].status, 502);
  const resumed = await (await call('/api/shared-reports/upload-batch', { body: retryBody })).json();
  assert.equal(resumed.results[0].status, 200);
  assert.equal((await call('/api/shared-reports/complete', { body: { publishKey: retryInput.publishKey } })).status, 200);
  assert.equal((await call(route, { token: publication.ownerToken, method: 'DELETE' })).status, 200);
  assert.equal((await call(route, { token: publication.replyToken })).status, 404);
  assert.equal((await call(route + '/answer-files/' + developerFile.id, { token: publication.replyToken })).status, 404);
  // The advertised raw batch budget must leave room for Base64 and JSON.
  // Three valid 20 MiB files must be split before they reach the 72 MiB request limit.
  const largeFiles = Array.from({ length: 3 }, (_, index) => ({ ...file, id: `large-${index}`, size: 20 * 1024 * 1024 }));
  const large = await (await call('/api/shared-reports/prepare', { body: { ...input,
    publishKey: randomBytes(32).toString('base64url'), files: largeFiles,
    snapshot: { ...input.snapshot, intro: { text: 'Batch limits', attachments: largeFiles.map(item => item.id) } },
  } })).json();
  assert.equal(large.uploads.length, 3); assert.ok(large.uploads.every(item => item.viaServer));
  assert.ok(large.batchUploadBytes >= largeFiles[0].size);
  assert.ok(Math.ceil(large.batchUploadBytes / 3) * 4 + 8192 < 72 * 1024 * 1024);
  assert.ok(large.batchUploadBytes < largeFiles.reduce((sum, item) => sum + item.size, 0));
  const operations = readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(operations.length >= 5); assert.ok(operations.every(x => x.valid));
  assert.ok(operations.every(x => x.key.startsWith('/corporate-fixture-bucket/shared-reports/') || x.key.startsWith('/corporate-fixture-bucket/shared-report-uploads/')));
});
