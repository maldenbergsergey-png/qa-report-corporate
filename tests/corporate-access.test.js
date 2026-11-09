const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { randomBytes, createHash } = require('node:crypto');
const { createSessionToken } = require('../auth');
const { passwordHash } = require('../admin/server');

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corporate-access-'));
  const secret = randomBytes(32).toString('hex'), salt = randomBytes(16).toString('hex');
  const adminFile = path.join(dir, 'admin.json'), s3Log = path.join(dir, 's3.log');
  fs.writeFileSync(adminFile, JSON.stringify({ version: 1, path: '/owner', username: 'owner', passwordSalt: salt,
    passwordHash: await passwordHash('fixture-only-long-password', salt), visitorSecret: randomBytes(32).toString('hex') }));
  fs.writeFileSync(s3Log, '');
  const server = spawn(process.execPath, ['--require', path.join(__dirname, 'fixtures/corporate-s3-preload.cjs'), 'server.js'], {
    cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      NODE_ENV: 'development', HOST: '127.0.0.1', PORT: '0', AUTH_SECRET: secret, AUTH_SECRET_FILE: '',
      QA_ADMIN_CONFIG_FILE: adminFile, REPORTS_DB_PATH: path.join(dir, 'reports.sqlite'),
      QA_REPORT_PUBLIC_URL: '', APP_PUBLIC_URL: '', PUBLIC_URL: '', QA_REPORT_TRUST_PROXY: 'false',
      QA_STORAGE_ENDPOINT: 'https://storage.example.test', QA_STORAGE_BUCKET: 'corporate-fixture-bucket', QA_STORAGE_REGION: 'eu-central-1',
      QA_STORAGE_ACCESS_KEY: 'corporate-fixture-access', QA_STORAGE_SECRET_KEY: 'corporate-fixture-secret', QA_STORAGE_ACCESS_KEY_FILE: '', QA_STORAGE_SECRET_KEY_FILE: '',
      QA_REPORT_TEST_S3: 'enabled', QA_REPORT_TEST_S3_LOG: s3Log },
  });
  t.after(async () => { const ended = new Promise(resolve => server.once('exit', resolve)); server.kill(); await ended; fs.rmSync(dir, { recursive: true, force: true }); });
  let stderr = '';
  server.stderr.on('data', bytes => { stderr += bytes; });
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Startup timeout: ' + stderr)), 10000);
    server.stdout.on('data', bytes => { const match = /QA Report: (http:\/\/127\.0\.0\.1:\d+)/.exec(String(bytes)); if (match) { clearTimeout(timer); resolve(match[1]); } });
    server.once('exit', code => { clearTimeout(timer); reject(new Error('Server exit: ' + code + ' ' + stderr)); });
  });
  const call = (route, { method = 'GET', body, headers = {} } = {}) => fetch(origin + route, {
    method, redirect: 'manual', headers: { ...(body ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  async function user(email) {
    let cookie = 'query-port-session=' + createSessionToken(email, { env: { AUTH_SECRET: secret } });
    const response = await call('/api/auth/csrf', { headers: { Cookie: cookie } });
    cookie += '; ' + response.headers.get('set-cookie').split(';')[0];
    return { Cookie: cookie, 'X-QA-CSRF-Token': (await response.json()).csrfToken };
  }
  const login = await call('/owner/login', { method: 'POST', body: { username: 'owner', password: 'fixture-only-long-password' }, headers: { 'X-QA-Admin': '1' } });
  assert.equal(login.status, 200);
  const admin = { 'X-QA-Admin': '1', Cookie: login.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': (await login.json()).csrf };
  const policy = async body => { const response = await call('/owner/storage', { method: 'POST', body, headers: admin }); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
  return { call, user, admin, policy, puts: () => fs.readFileSync(s3Log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(row => row.method === 'PUT').length };
}

test('corporate profiles keep verified identity, CSRF, private avatars and a separate administrator session', { timeout: 30000 }, async t => {
  const f = await fixture(t), a = await f.user('first@example.test'), b = await f.user('second@example.test');
  assert.equal((await f.call('/api/profile')).status, 401);
  const get = async headers => (await (await f.call('/api/profile', { headers })).json()).user;
  assert.equal((await get(a)).email, 'first@example.test');
  assert.equal((await get({ ...b, 'X-User-Email': 'first@example.test' })).email, 'second@example.test');
  const update = (body, headers = a) => f.call('/api/profile', { method: 'POST', body, headers });
  assert.equal((await update({ firstName: 'Анна', lastName: 'Тест' })).status, 200);
  assert.equal((await get(a)).name, 'Анна Тест'); assert.equal((await get(b)).name, '');
  assert.equal((await update({ email: 'second@example.test' })).status, 400);
  assert.equal((await update({ firstName: 'Changed' }, { Cookie: a.Cookie })).status, 403);
  assert.equal((await update({ firstName: 'Changed' }, { ...a, Origin: 'https://outside.example.test' })).status, 403);
  assert.equal((await update({ avatar: 'https://outside.example.test/avatar.png' })).status, 400);
  assert.equal((await update({ avatar: 'data:image/svg+xml;base64,PHN2Zz4=' })).status, 400);
  const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  assert.equal((await update({ avatar })).status, 200); assert.equal((await get(a)).avatar, avatar); assert.equal((await get(b)).avatar, null);
  assert.equal((await update({ avatar: null })).status, 200); assert.equal((await get(a)).avatar, null);
  assert.equal((await f.call('/owner/users', { headers: { ...a, 'X-QA-Admin': '1' } })).status, 401);
  assert.equal((await f.call('/owner/storage', { method: 'POST', body: { enabled: false }, headers: { ...a, 'X-QA-Admin': '1' } })).status, 401);
  assert.equal((await f.call('/owner/user-access', { method: 'POST', headers: { ...f.admin, 'X-CSRF-Token': 'wrong' }, body: { userId: 'first@example.test', publish: 'deny', uploadsEnabled: false, cloudEnabled: false } })).status, 403);
  const directory = await (await f.call('/owner/users?search=' + encodeURIComponent('АННА'), { headers: f.admin })).json();
  assert.equal(directory.users.length, 1); assert.equal(directory.users[0].email, 'first@example.test'); assert.equal(directory.users[0].role, 'Сотрудник'); assert.equal(directory.users[0].avatar, undefined);
  for (const route of ['/corporate-accounts.js', '/corporate-storage.js', '/scripts/check-corporate-storage.cjs']) assert.equal((await f.call(route, { headers: a })).status, 404);
});

test('global and per-user corporate policies block new writes while retaining existing reports and attachments', { timeout: 30000 }, async t => {
  const f = await fixture(t), a = await f.user('author@example.test'), b = await f.user('reader@example.test');
  await f.call('/api/profile', { headers: a }); await f.call('/api/profile', { headers: b });
  const grant = async (userId, access) => f.call('/owner/user-access', { method: 'POST', headers: f.admin, body: { userId, publish: 'role', uploadsEnabled: true, cloudEnabled: true, ...access } });
  assert.equal((await grant('missing@example.test', {})).status, 404);
  assert.equal((await grant('author@example.test', { role: 'admin' })).status, 400);
  const input = () => ({ publishKey: randomBytes(32).toString('base64url'), files: [], snapshot: { title: 'Policy fixture', sections: [{ id: 'section', title: 'Checks', columns: [{ id: 'check', label: 'Check' }], rows: [{ id: 'row', number: '1', status: 'НЕ ОК', cells: { check: { text: 'Example' } } }] }] } });
  const publish = (body = input(), headers = a) => f.call('/api/shared-reports', { method: 'POST', headers, body });
  const created = await publish(); assert.equal(created.status, 201); const { publication } = await created.json();
  const shared = '/api/shared-reports/' + publication.id;
  const file = { name: 'fixture.txt', type: 'text/plain', dataBase64: Buffer.from('fixture').toString('base64') };
  const upload = headers => f.call('/api/storage/upload', { method: 'POST', headers, body: { reportId: 'fixture', file } });
  const uploaded = await upload(a); assert.equal(uploaded.status, 201); const object = await uploaded.json();
  await f.policy({ cloudEnabled: true });
  const cloud = await f.call('/api/cloud-reports', { method: 'POST', headers: { ...a, 'X-QA-Cloud': '1' }, body: {} }); assert.equal(cloud.status, 201);
  const cloudId = (await cloud.json()).report.id, cloudRoute = '/api/cloud-reports/' + cloudId;
  const document = { schemaVersion: 3, issueUrl: '', environment: '', overallStatus: '', intro: 'Saved', numberingMode: 'section', sections: [{ id: 's', title: 'Checks', columns: [{ id: 'c', title: 'Check' }], rows: [{ id: 'r', status: 'НЕ ПРОВЕРЕНО', cells: { c: 'Saved' } }] }] };
  const cloudHeaders = { ...a, 'X-QA-Cloud': '1' };
  assert.equal((await f.call(cloudRoute, { method: 'PUT', headers: cloudHeaders, body: { title: 'Cloud', document, revision: 0 } })).status, 200);
  assert.equal((await grant('author@example.test', { publish: 'deny', uploadsEnabled: false, cloudEnabled: false })).status, 200);
  const puts = f.puts();
  assert.equal((await publish()).status, 403); assert.equal((await upload(a)).status, 403);
  assert.equal((await f.call(cloudRoute, { method: 'PUT', headers: cloudHeaders, body: { title: 'Cloud', document, revision: 1 } })).status, 403);
  assert.equal((await f.call(cloudRoute, { headers: a })).status, 200);
  assert.equal((await f.call(cloudRoute, { headers: b })).status, 403);
  assert.equal((await f.call(object.url, { headers: a })).status, 200); assert.equal((await f.call(object.url, { headers: b })).status, 404);
  assert.equal((await f.call(shared, { headers: { ...b, Authorization: 'Bearer ' + publication.replyToken } })).status, 200);
  assert.equal(f.puts(), puts);
  assert.equal((await grant('author@example.test', { publish: 'allow' })).status, 200);
  await f.policy({ enabled: false, publishEnabled: false });
  assert.equal((await publish()).status, 503); assert.equal((await upload(a)).status, 403);
  // Individual allow never overrides a global pause.
  assert.equal((await f.call(shared, { headers: { ...a, Authorization: 'Bearer ' + publication.ownerToken } })).status, 200);
  await f.policy({ publishEnabled: true });
  assert.equal((await publish()).status, 201);
  const bytes = Buffer.from('New file'), hash = createHash('sha256').update(bytes).digest('hex');
  const cloudFile = { hash, offset: 0, size: bytes.length, data: bytes.toString('base64') };
  assert.equal((await f.call(cloudRoute + '/files/' + hash, { method: 'POST', headers: cloudHeaders, body: cloudFile })).status, 403);
  assert.equal((await f.call(cloudRoute, { method: 'PUT', headers: cloudHeaders, body: { title: 'Text update', document, revision: 1 } })).status, 200);
  assert.equal((await f.call(cloudRoute, { method: 'DELETE', headers: cloudHeaders, body: {} })).status, 200);
  assert.equal((await f.call(shared, { method: 'DELETE', headers: { ...a, Authorization: 'Bearer ' + publication.ownerToken } })).status, 200);
});
