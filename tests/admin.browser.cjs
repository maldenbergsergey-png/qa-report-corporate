// Isolated end-to-end check: real editor signals, independent admin login,
// PWA/browser classification, search, mobile layout and logout.
const { chromium } = require(process.env.QA_REPORT_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { passwordHash } = require('../admin/server');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-admin-browser-'));
let app; let browser;
async function main() {
  const listener = http.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const adminPath = '/_manage_' + crypto.randomBytes(16).toString('hex');
  const password = crypto.randomBytes(24).toString('hex'); const salt = crypto.randomBytes(16).toString('hex');
  const secret = crypto.randomBytes(32).toString('hex');
  const configFile = path.join(temp, 'credentials.json');
  fs.writeFileSync(configFile, JSON.stringify({ version: 1, path: adminPath, username: 'owner', passwordSalt: salt,
    passwordHash: await passwordHash(password, salt), visitorSecret: crypto.randomBytes(32).toString('hex') }), { mode: 0o600 });
  app = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env,
    HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'development', QA_REPORT_PUBLIC_URL: origin,
    QA_ADMIN_CONFIG_FILE: configFile, REPORTS_DB_PATH: path.join(temp, 'reports', 'reports.sqlite'),
    FEEDBACK_DIR: path.join(temp, 'feedback'), AUTH_SECRET: secret, AUTH_SECRET_FILE: '', QA_REPORT_TRUST_PROXY: 'false',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let output = ''; let errors = '';
    const timer = setTimeout(() => reject(Error('Startup timeout: ' + errors)), 10000);
    app.stdout.on('data', chunk => { output += chunk; if (output.includes('QA Report:')) { clearTimeout(timer); resolve(); } });
    app.stderr.on('data', chunk => errors += chunk);
    app.once('exit', code => { clearTimeout(timer); reject(Error(`Server exited ${code}: ${errors}`)); });
  });
  browser = await chromium.launch({ headless: true });
  const corporate = fs.existsSync(path.join(root, 'auth.js'));
  async function context(options = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...options });
    if (corporate) await ctx.addCookies([{ name: 'query-port-session', url: origin,
      value: require('../auth').createSessionToken('fixture@example.test', { env: { AUTH_SECRET: secret } }), httpOnly: true, sameSite: 'Lax' }]);
    await ctx.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    return ctx;
  }
  const users = await context(); const editor = await users.newPage();
  const signal = editor.waitForResponse(response => response.url().endsWith('/api/usage/visit'));
  await editor.goto(origin); assert.equal((await signal).status(), 200);
  const again = editor.waitForResponse(response => response.url().endsWith('/api/usage/visit'));
  await editor.reload(); assert.equal((await again).status(), 200);
  const pwa = await context({ viewport: { width: 390, height: 844 }, isMobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36' });
  await pwa.addInitScript(() => { const original = window.matchMedia.bind(window); window.matchMedia = query => query === '(display-mode: standalone)' ? { ...original(query), matches: true } : original(query); });
  const installed = await pwa.newPage(); const pwaSignal = installed.waitForResponse(response => response.url().endsWith('/api/usage/visit'));
  await installed.goto(origin); assert.equal((await pwaSignal).status(), 200);

  // A fresh administrator context has no ordinary user session.
  const admins = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  const page = await admins.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + adminPath); await page.locator('#login-panel').waitFor({ state: 'visible' });
  assert.equal(new URL(page.url()).pathname, adminPath + '/');
  await page.locator('#username').fill('owner'); await page.locator('#password').fill('incorrect');
  await page.locator('#login-submit').click(); await page.getByText('Неверный логин или пароль').waitFor();
  await page.locator('#password').fill(password); await page.locator('#login-submit').click();
  await page.locator('#dashboard').waitFor({ state: 'visible' });
  assert.deepEqual(await page.locator('#summary strong').allTextContents(), ['2', '2', '1', '1']);
  assert.equal(await page.locator('#visitors > tr').count(), 2);
  assert.match(await page.locator('#visitors').textContent(), /Android/);
  assert.match(await page.locator('#visitors').textContent(), /127\.0\.0\.1/);
  await page.locator('#search').fill('203.0.113.200'); await page.locator('#search-form button').click();
  await page.locator('#visitors-empty').waitFor({ state: 'visible' });
  await page.locator('#search').fill(''); await page.locator('#search-form button').click();
  await page.locator('#visitors > tr').first().waitFor();
  const screenshots = process.env.QA_ADMIN_SCREENSHOT_DIR;
  if (screenshots) { fs.mkdirSync(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, path.basename(root) + '-admin-desktop.png'), fullPage: true }); }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile page must not scroll horizontally');
  assert.ok((await page.locator('#from').boundingBox()).width >= 120, 'date fields must remain readable on mobile');
  if (screenshots) await page.screenshot({ path: path.join(screenshots, path.basename(root) + '-admin-mobile.png'), fullPage: true });
  const cookies = await admins.cookies(); const adminCookie = cookies.find(item => item.name === 'qa-admin-session');
  assert.equal(adminCookie.httpOnly, true); assert.equal(adminCookie.sameSite, 'Strict'); assert.equal(adminCookie.path, adminPath + '/');
  if (corporate) assert.equal((await admins.request.get(origin + '/api/auth/session')).status(), 401);
  await page.locator('#logout').click(); await page.locator('#login-panel').waitFor({ state: 'visible' });
  assert.equal((await admins.request.get(origin + adminPath + '/stats', { headers: { 'X-QA-Admin': '1' } })).status(), 401);
  await page.reload(); await page.locator('#login-panel').waitFor({ state: 'visible' });
  assert.deepEqual(errors, []);
  console.log(`${path.basename(root)}: admin login, editor/PWA statistics, deduplication, search, mobile layout and logout passed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  if (app && app.exitCode === null) { app.kill(); await new Promise(resolve => app.once('exit', resolve)); }
  fs.rmSync(temp, { recursive: true, force: true });
});
