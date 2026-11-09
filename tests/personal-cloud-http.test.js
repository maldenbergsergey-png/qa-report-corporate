const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const corporate = fs.existsSync(path.join(root, 'auth.js'));

test('personal cloud uses real version-specific sessions, admin policy and CSRF without granting publication or foreign access', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-cloud-http-'));
  const listener = http.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`, secret = crypto.randomBytes(32).toString('hex');
  const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'development', REPORTS_DB_PATH: path.join(directory, 'reports.sqlite'),
    QA_REPORT_PUBLIC_URL: origin, QA_ADMIN_CONFIG_FILE: path.join(directory, 'admin.json'), AUTH_SECRET: secret, AUTH_SECRET_FILE: '',
    QA_STORAGE_ACCESS_KEY: 'fixture', QA_STORAGE_SECRET_KEY: 'fixture-secret', QA_STORAGE_ACCESS_KEY_FILE: '', QA_STORAGE_SECRET_KEY_FILE: '',
    CLERK_PUBLISHABLE_KEY: '', CLERK_JWT_KEY: '', CLERK_JWT_KEY_FILE: '' };
  let accountHeaders;
  if (corporate) {
    const { passwordHash } = require('../admin/server');
    const salt = 'b'.repeat(32);
    fs.writeFileSync(env.QA_ADMIN_CONFIG_FILE, JSON.stringify({ version: 1, path: '/owner', username: 'owner', passwordSalt: salt,
      passwordHash: await passwordHash('fixture-only-long-password', salt), visitorSecret: 'c'.repeat(64) }));
    const { createSessionToken } = require('../auth');
    accountHeaders = owner => ({ Cookie: `query-port-session=${createSessionToken(owner + '@example.test', { env })}` });
  } else {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    env.CLERK_PUBLISHABLE_KEY = 'pk_test_' + Buffer.from('clerk.example.test$').toString('base64');
    env.CLERK_JWT_KEY = publicKey.export({ type: 'spki', format: 'pem' });
    env.QA_REPORT_S3_CONFIG_FILE = path.join(directory, 's3.json');
    fs.writeFileSync(env.QA_REPORT_S3_CONFIG_FILE, '{}');
    fs.writeFileSync(path.join(directory, 'clerk-admin.json'), JSON.stringify({ version: 1, ownerId: 'user_admin', visitorSecret: 'c'.repeat(64) }));
    fs.writeFileSync(path.join(directory, 'clerk-secret-key'), 'sk_test_fixture');
    accountHeaders = owner => {
      const time = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ iss: 'https://clerk.example.test', azp: origin, sub: 'user_' + owner,
        sid: 'sess_fixture', iat: time, nbf: time - 1, exp: time + 600, sts: 'active' })).toString('base64url');
      const data = header + '.' + payload;
      return { 'X-QA-Report-Session': data + '.' + crypto.sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url') };
    };
  }
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { const closed = new Promise(resolve => child.once('close', resolve)); child.kill(); await closed; fs.rmSync(directory, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    let log = ''; const timeout = setTimeout(() => reject(Error(log)), 10_000);
    child.stderr.on('data', chunk => { log += chunk; }); child.stdout.on('data', chunk => { log += chunk; if (log.includes('QA Report:')) { clearTimeout(timeout); resolve(); } });
    child.once('exit', code => { clearTimeout(timeout); reject(Error(`Server ${code}: ${log}`)); });
  });
  async function csrfFor(owner) {
    const headers = accountHeaders(owner);
    if (corporate) {
      const response = await fetch(origin + '/api/auth/csrf', { headers });
      const { csrfToken } = await response.json(); headers.Cookie += '; ' + response.headers.get('set-cookie').split(';')[0];
      headers['X-QA-CSRF-Token'] = csrfToken;
    }
    return headers;
  }
  const a = await csrfFor('alpha'), b = await csrfFor('beta');
  async function call(route, method = 'GET', body, headers = a) {
    return fetch(origin + route, { method, redirect: 'manual', headers: { ...headers, 'X-QA-Cloud': '1',
      ...(method === 'GET' ? {} : { Origin: origin, 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  assert.equal((await call('/api/cloud-reports', 'GET', undefined, {})).status, 401);
  assert.equal((await call('/api/cloud-reports', 'POST', {})).status, 403);
  let adminHeaders;
  if (corporate) {
    const response = await fetch(origin + '/owner/login', { method: 'POST', headers: { 'X-QA-Admin': '1', Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'fixture-only-long-password' }) });
    assert.equal(response.status, 200); const { csrf } = await response.json();
    adminHeaders = { 'X-QA-Admin': '1', Cookie: response.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': csrf };
  } else adminHeaders = { ...accountHeaders('admin'), 'X-QA-Admin': '1' };
  const adminRoute = '/owner/' + (corporate ? 'cloud' : 'storage');
  assert.equal((await call(adminRoute, 'POST', { cloudEnabled: true }, a)).status, 403);
  assert.equal((await call(adminRoute, 'POST', { cloudEnabled: true }, adminHeaders)).status, 200);
  const created = await call('/api/cloud-reports', 'POST', {}); assert.equal(created.status, 201, await created.clone().text());
  const { report: { id } } = await created.json();
  const document = { schemaVersion: 3, issueUrl: '', environment: '', overallStatus: '', intro: 'Private', numberingMode: 'section', sections: [{ id: 's', title: 'Test', columns: [{ id: 'check', title: 'Check' }], rows: [{ id: 'r', status: 'НЕ ПРОВЕРЕНО', cells: { check: 'Private data' } }] }] };
  const body = { title: 'Private report', document, revision: 0, ownerId: 'user_beta' };
  const invalid = { ...a }; if (corporate) delete invalid['X-QA-CSRF-Token']; else invalid['X-QA-Report-Session'] = accountHeaders('alpha')['X-QA-Report-Session'].slice(0, -8) + 'tampered';
  assert.equal((await call('/api/cloud-reports/' + id, 'PUT', body, invalid)).status, corporate ? 403 : 401);
  assert.equal((await call('/api/cloud-reports/' + id, 'PUT', body)).status, 200);
  assert.equal((await call('/api/cloud-reports/' + id, 'GET', undefined, b)).status, 403);
  assert.equal((await call('/api/cloud-reports/' + id + '/access', 'GET', undefined, b)).status, 403);
  assert.equal((await call('/api/cloud-reports/' + id + '/access', 'GET', undefined, {})).status, 401);
  assert.deepEqual(await (await call('/api/cloud-reports/' + id + '/access')).json().then(({ ok }) => ({ ok })), { ok: true });
  const cloudShell = await call('/cloud-report/' + id);
  assert.equal(cloudShell.status, 200);
  assert.equal(cloudShell.headers.get('cache-control'), 'no-store');
  const shell = await cloudShell.text(); assert.match(shell, /cloudReportAccess/); assert.doesNotMatch(shell, /Private data/);
  const anonymousShell = await call('/cloud-report/' + id, 'GET', undefined, {});
  assert.equal(anonymousShell.status, corporate ? 302 : 200);
  if (corporate) assert.ok(anonymousShell.headers.get('location').startsWith('/login?callbackUrl='));
  assert.equal((await call('/api/cloud-reports/' + id, 'PUT', body, b)).status, 403);
  assert.equal((await call('/api/cloud-reports/' + id, 'DELETE', {}, b)).status, 403);
  assert.equal((await (await call('/api/cloud-reports', 'GET', undefined, b)).json()).reports.length, 0);
  assert.equal((await call('/api/reports')).status, 410);
  assert.equal((await call('/personal-cloud.js')).status, 404);
  assert.equal((await call(adminRoute, 'POST', { cloudEnabled: false }, adminHeaders)).status, 200);
  assert.equal((await call('/api/cloud-reports/' + id, 'PUT', { ...body, revision: 1 })).status, 403);
  assert.equal((await call('/api/cloud-reports/' + id)).status, 200);
});
