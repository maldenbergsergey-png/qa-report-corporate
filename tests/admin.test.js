const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { createAdminService, passwordHash, deviceInfo } = require('../admin/server');
const root = path.resolve(__dirname, '..');
const password = 'fixture-only-long-password';
const adminPath = '/_manage_' + 'a'.repeat(32);
const configPromise = passwordHash(password, 'b'.repeat(32)).then(hash => ({ version: 1, path: adminPath, username: 'owner', passwordSalt: 'b'.repeat(32), passwordHash: hash, visitorSecret: 'c'.repeat(64) }));
const cookie = response => response.headers.get('set-cookie')?.split(';')[0] || '';

async function fixture(t, { configured = true, production = false, trustProxy = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-admin-'));
  const configFile = path.join(dir, 'credentials.json');
  if (configured) fs.writeFileSync(configFile, JSON.stringify(await configPromise));
  let now = Date.parse('2026-10-21T10:00:00Z');
  let service;
  const server = http.createServer(async (request, response) => {
    if (await service.handle(request, response)) return;
    if (request.url === '/api/usage/visit') return service.collect(request, response);
    response.writeHead(404); response.end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = { NODE_ENV: production ? 'production' : 'development', QA_ADMIN_CONFIG_FILE: configFile, QA_REPORT_PUBLIC_URL: production ? 'https://admin.example.test' : origin, QA_REPORT_TRUST_PROXY: String(trustProxy) };
  service = createAdminService({ root, reportsPath: path.join(dir, 'reports.sqlite'), env, clock: () => now });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); service.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  async function request(route, { method = 'GET', body, headers = {} } = {}) {
    return fetch(origin + route, { method, redirect: 'manual', headers: {
      'X-QA-Admin': '1', ...(method === 'POST' ? { Origin: env.QA_REPORT_PUBLIC_URL, 'Content-Type': 'application/json' } : {}),
      ...(production && trustProxy ? { 'X-Forwarded-Proto': 'https' } : {}), ...headers,
    }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  }
  async function login() {
    const response = await request(adminPath + '/login', { method: 'POST', body: { username: 'owner', password } });
    assert.equal(response.status, 200, await response.clone().text());
    return { cookie: cookie(response), csrf: (await response.json()).csrf, response };
  }
  async function signal(options = {}) {
    return request('/api/usage/visit', { method: 'POST', body: { mode: 'browser' }, ...options });
  }
  return { service, dir, configFile, request, login, signal, setTime(value) { now = typeof value === 'string' ? Date.parse(value) : value; }, advance(ms) { now += ms; } };
}

test('absent configuration leaves admin and collection disabled', async t => {
  const f = await fixture(t, { configured: false });
  assert.equal((await f.request(adminPath + '/')).status, 404);
  const response = await f.signal();
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(fs.existsSync(path.join(f.dir, 'admin')), false);
});

test('independent login, CSRF, session rotation, logout and expiry', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(adminPath + '/stats', { headers: { Cookie: 'query-port-session=ordinary-user' } })).status, 401);
  const form = await f.request(adminPath + '/');
  assert.equal(form.status, 200); assert.match(form.headers.get('cache-control'), /no-store/);
  assert.match(form.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(form.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  const credentials = { username: 'owner', password };
  for (const headers of [{ Origin: 'https://evil.test' }, { 'X-QA-Admin': '' }, { Origin: '' }, { 'Sec-Fetch-Site': 'same-site' }]) {
    assert.equal((await f.request(adminPath + '/login', { method: 'POST', body: credentials, headers })).status, 403);
  }
  assert.equal((await f.request(adminPath + '/login', { method: 'POST', body: { ...credentials, password: 'wrong' } })).status, 401);
  const session = await f.login();
  assert.match(session.response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.match(session.response.headers.get('set-cookie'), new RegExp(`Path=${adminPath}/`));
  const stats = await f.request(adminPath + '/stats', { headers: { Cookie: session.cookie } });
  assert.equal(stats.status, 200); assert.equal((await stats.json()).summary.visitors, 0);
  assert.equal((await f.request(adminPath + '/logout', { method: 'POST', body: {}, headers: { Cookie: session.cookie } })).status, 403);
  const renewedResponse = await f.request(adminPath + '/login', { method: 'POST', body: credentials, headers: { Cookie: session.cookie } });
  const renewed = { cookie: cookie(renewedResponse), csrf: (await renewedResponse.json()).csrf };
  assert.equal((await f.request(adminPath + '/session', { headers: { Cookie: session.cookie } })).status, 401);
  assert.equal((await f.request(adminPath + '/logout', { method: 'POST', body: {}, headers: { Cookie: renewed.cookie, 'X-CSRF-Token': renewed.csrf } })).status, 200);
  assert.equal((await f.request(adminPath + '/stats', { headers: { Cookie: renewed.cookie } })).status, 401);
  const expiring = await f.login(); f.advance(8 * 3600000 + 1);
  assert.equal((await f.request(adminPath + '/session', { headers: { Cookie: expiring.cookie } })).status, 401);
});

test('login limits apply before password hashing and expire', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++) {
    // Invalid input still consumes an attempt, without expensive hashing.
    assert.equal((await f.request(adminPath + '/login', { method: 'POST', body: {} })).status, 401);
  }
  const limited = await f.request(adminPath + '/login', { method: 'POST', body: { username: 'owner', password } });
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '900');
  f.advance(15 * 60000 + 1); await f.login();
});

test('production requires HTTPS and uses Secure cookies; forwarding is explicitly trusted', async t => {
  const f = await fixture(t, { production: true, trustProxy: true });
  assert.equal((await f.request(adminPath + '/', { headers: { 'X-Forwarded-Proto': 'http' } })).status, 403);
  const session = await f.login();
  assert.match(session.response.headers.get('set-cookie'), /; Secure/);
  const first = await f.signal({ headers: { 'X-Forwarded-For': '203.0.113.25' } });
  assert.match(first.headers.get('set-cookie'), /; Secure/);
  const stats = await (await f.request(adminPath + '/stats', { headers: { Cookie: session.cookie } })).json();
  assert.equal(stats.visitors[0].devices[0].ip, '203.0.113.25');
  const untrusted = await fixture(t, { production: true, trustProxy: false });
  assert.equal((await untrusted.request(adminPath + '/', { headers: { 'X-Forwarded-Proto': 'https' } })).status, 403);
  assert.throws(() => createAdminService({ root, reportsPath: path.join(f.dir, 'unused.sqlite'), env: { NODE_ENV: 'production', QA_ADMIN_CONFIG_FILE: f.configFile, QA_REPORT_PUBLIC_URL: 'http://unsafe.test' } }), /HTTPS/);
});

test('visits deduplicate tabs, preserve IDs across IPs, separate modes and roll over at local midnight', async t => {
  const f = await fixture(t); const session = await f.login();
  const first = await f.signal({ headers: { 'X-Forwarded-For': '203.0.113.99', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0' } });
  const idCookie = cookie(first);
  assert.match(idCookie, /^qa-usage-id=[a-f0-9]{32}\.[a-f0-9]{64}$/);
  const headers = { Cookie: idCookie, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0' };
  await f.signal({ headers }); f.advance(5 * 60000); await f.signal({ headers });
  f.advance(31 * 60000); await f.signal({ headers });
  await f.signal({ body: { mode: 'pwa' }, headers });
  const second = await f.signal({ headers: { 'User-Agent': 'Mozilla/5.0 (iPhone) Version/17.0 Mobile Safari/604.1' } });
  assert.notEqual(cookie(second), idCookie);
  let stats = await (await f.request(adminPath + '/stats', { headers: { Cookie: session.cookie } })).json();
  assert.deepEqual(stats.summary, { visitors: 2, visits: 4, pwa: 1, browser: 2 });
  const visitor = stats.visitors.find(v => v.id === idCookie.split('=')[1].split('.')[0]);
  assert.equal(visitor.visits, 3); assert.equal(visitor.devices[0].os, 'Windows');
  assert.ok(visitor.devices.every(d => d.ip !== '203.0.113.99'), 'untrusted proxy headers must not determine IP');
  // Moscow midnight occurs at 21:00 UTC; these two pings are only 10 minutes apart.
  f.setTime('2026-10-21T20:55:00Z'); await f.signal({ headers });
  f.setTime('2026-10-21T21:05:00Z'); await f.signal({ headers });
  const newSession = await f.login();
  stats = await (await f.request(adminPath + '/stats', { headers: { Cookie: newSession.cookie } })).json();
  assert.equal(stats.daily[0].day, '2026-10-22'); assert.equal(stats.daily[0].visits, 1);
  assert.equal(stats.daily[1].day, '2026-10-21'); assert.equal(stats.daily[1].visits, 5);
});

test('IP changes retain identity, malformed IDs are replaced, queries are bounded and retention removes old rows', async t => {
  const f = await fixture(t, { trustProxy: true });
  const first = await f.signal({ headers: { 'X-Forwarded-For': '203.0.113.1' } });
  await f.signal({ headers: { Cookie: cookie(first), 'X-Forwarded-For': '203.0.113.2' } });
  const tampered = await f.signal({ headers: { Cookie: cookie(first).slice(0, -1) + 'z' } });
  assert.notEqual(cookie(tampered), cookie(first));
  const session = await f.login(); const auth = { Cookie: session.cookie };
  let stats = await (await f.request(adminPath + '/stats', { headers: auth })).json();
  assert.equal(stats.summary.visitors, 2); assert.equal(stats.summary.visits, 2);
  const matching = await (await f.request(adminPath + '/stats?search=203.0.113.2', { headers: auth })).json();
  assert.equal(matching.total, 1); assert.equal(matching.visitors[0].devices.length, 2);
  assert.equal((await f.request(adminPath + '/stats?from=2026-02-30', { headers: auth })).status, 400);
  assert.equal((await f.request(adminPath + '/stats?from=2020-01-01', { headers: auth })).status, 400);
  assert.equal((await f.request(adminPath + '/stats?to=2099-01-01', { headers: auth })).status, 400);
  const injection = await (await f.request(adminPath + '/stats?search=' + encodeURIComponent("' OR 1=1 --"), { headers: auth })).json();
  assert.equal(injection.total, 0);
  assert.equal((await f.signal({ body: { mode: 'fingerprint' } })).status, 400);
  assert.equal((await f.signal({ body: { mode: 'browser' }, headers: { Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await f.signal({ body: { mode: 'browser' }, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await f.signal({ body: { mode: 'browser', oversized: 'x'.repeat(3000) } })).status, 413);
  f.advance(91 * 86400000); const fresh = await f.login();
  stats = await (await f.request(adminPath + '/stats', { headers: { Cookie: fresh.cookie } })).json();
  assert.equal(stats.summary.visitors, 0);
  const db = new DatabaseSync(path.join(f.dir, 'admin', 'usage.sqlite'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM visitors').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM activity').get().count, 0);
  db.close();
});

test('internal files, encoded paths and symlink aliases are private', async t => {
  const f = await fixture(t);
  for (const file of ['admin/server.js', 'admin/page.html', 'admin/ui.js', 'admin-config/admin.json.abcd.tmp', 'secrets/admin/admin.json', '.env', '.git/config', 'scripts/setup-admin.cjs']) assert.equal(f.service.isPrivateFile(path.join(root, file)), true, file);
  assert.equal(f.service.isPrivateFile(f.configFile), true);
  assert.equal(f.service.isPrivateFile(path.join(f.dir, 'admin', 'usage.sqlite-wal')), true);
  assert.equal(f.service.isPrivateFile(path.join(root, 'usage.js')), false);
  const alias = path.join(f.dir, 'alias.txt'); fs.symlinkSync(f.configFile, alias);
  assert.equal(f.service.isPrivateFile(alias), true);
});

test('device parsing handles Edge, phones and tablets without storing raw UA', () => {
  assert.deepEqual(deviceInfo('Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36 Edg/130.0'), { browser: 'Edge 130', os: 'Windows', device: 'Компьютер' });
  assert.equal(deviceInfo('Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile').device, 'Телефон');
  assert.equal(deviceInfo('Mozilla/5.0 (Linux; Android 14) Chrome/130.0').device, 'Планшет');
});

test('a database configured beside application files does not hide the editor', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-admin-static-'));
  const service = createAdminService({ root, reportsPath: path.join(root, 'custom.sqlite'), env: { NODE_ENV: 'development', QA_ADMIN_CONFIG_FILE: path.join(dir, 'absent.json') } });
  t.after(() => { service.close(); fs.rmSync(dir, { recursive: true }); });
  assert.equal(service.isPrivateFile(path.join(root, 'index.html')), false);
  assert.equal(service.isPrivateFile(path.join(root, 'usage.js')), false);
  assert.equal(service.isPrivateFile(path.join(root, 'custom.sqlite')), true);
  assert.equal(service.isPrivateFile(path.join(root, 'custom.sqlite-wal')), true);
});

test('visitor pagination returns bounded, distinct pages', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 52; i++) assert.equal((await f.signal()).status, 200);
  const session = await f.login(); const headers = { Cookie: session.cookie };
  const first = await (await f.request(adminPath + '/stats?page=1', { headers })).json();
  const second = await (await f.request(adminPath + '/stats?page=2', { headers })).json();
  assert.equal(first.total, 52); assert.equal(first.visitors.length, 50); assert.equal(second.visitors.length, 2);
  assert.equal(new Set([...first.visitors, ...second.visitors].map(v => v.id)).size, 52);
});

test('real app preserves ordinary authorization while serving independent admin and collection gates', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-admin-app-'));
  const configFile = path.join(dir, 'credentials.json'); fs.writeFileSync(configFile, JSON.stringify(await configPromise));
  const listener = http.createServer(); await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`; const secret = crypto.randomBytes(32).toString('hex');
  const app = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'development', QA_REPORT_PUBLIC_URL: origin,
    QA_ADMIN_CONFIG_FILE: configFile, REPORTS_DB_PATH: path.join(dir, 'reports', 'reports.sqlite'), FEEDBACK_DIR: path.join(dir, 'feedback'), AUTH_SECRET: secret, AUTH_SECRET_FILE: '', QA_REPORT_TRUST_PROXY: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (app.exitCode === null) { app.kill(); await new Promise(resolve => app.once('exit', resolve)); } fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    let output = ''; let errors = '';
    const timer = setTimeout(() => reject(new Error('Startup timeout: ' + errors)), 10000);
    app.stdout.on('data', chunk => { output += chunk; if (output.includes('QA Report:')) { clearTimeout(timer); resolve(); } });
    app.stderr.on('data', chunk => errors += chunk);
    app.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited: ' + code + ' ' + errors)); });
  });
  const corporate = fs.existsSync(path.join(root, 'auth.js'));
  const userCookie = corporate ? 'query-port-session=' + require('../auth').createSessionToken('user@example.test', { env: { AUTH_SECRET: secret } }) : '';
  const visit = headers => fetch(origin + '/api/usage/visit', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ mode: 'browser' }) });
  assert.equal((await visit({})).status, corporate ? 401 : 200);
  assert.equal((await visit({ Cookie: userCookie })).status, 200);
  for (const file of ['/admin/server.js', '/%61dmin/page.html', '/secrets/admin/admin.json', '/.env', '/scripts/setup-admin.cjs']) {
    assert.equal((await fetch(origin + file, { headers: { Cookie: userCookie }, redirect: 'manual' })).status, 404, file);
  }
  assert.equal((await fetch(origin + adminPath + '/')).status, 200);
  assert.equal((await fetch(origin + adminPath + '/stats', { headers: { 'X-QA-Admin': '1', Cookie: userCookie } })).status, 401);
  const login = await fetch(origin + adminPath + '/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-QA-Admin': '1' }, body: JSON.stringify({ username: 'owner', password }) });
  assert.equal(login.status, 200);
  assert.equal((await fetch(origin + adminPath + '/stats', { headers: { 'X-QA-Admin': '1', Cookie: cookie(login) } })).status, 200);
  if (corporate) {
    assert.equal((await fetch(origin + '/api/auth/session', { headers: { Cookie: cookie(login) } })).status, 401);
    assert.equal((await visit({ Cookie: cookie(login) })).status, 401);
    assert.equal((await fetch(origin + '/api/auth/session', { headers: { Cookie: userCookie } })).status, 200);
  }
  const html = await (await fetch(origin, { headers: { Cookie: userCookie } })).text();
  assert.match(html, /usage\.js\?v=1/); assert.doesNotMatch(html, new RegExp(adminPath));
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'release-notes.js'), 'utf8'), /админк|статистик[аи] посещени/i);
});
