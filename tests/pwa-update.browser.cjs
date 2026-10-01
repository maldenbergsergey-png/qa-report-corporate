// Isolated update regression: missing packaged asset, waiting worker UI,
// durable save before activation, and preservation of the open checklist.
const { chromium } = require(process.env.QA_REPORT_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-pwa-update-'));
let child, browser, proxy;
async function main() {
  const listener = http.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const upstreamPort = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const source = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  let workerSource = source.replace(/(const CACHE_NAME = ['"])([^'"]+)/, '$1$2-test-baseline')
    .replace('  "/draft-storage-worker.js?v=1",\n', '');
  let missingWorker = false;
  let missingRequests = 0;
  proxy = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/sw.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
      response.end(workerSource); return;
    }
    if (missingWorker && url.pathname === '/draft-storage-worker.js') {
      missingRequests++; response.writeHead(404); response.end('missing packaged asset'); return;
    }
    const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort,
      path: request.url, method: request.method, headers: request.headers }, incoming => {
      response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response);
    });
    upstream.on('error', error => { response.writeHead(502); response.end(error.message); });
    request.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${proxy.address().port}`;
  const secret = crypto.randomBytes(32).toString('hex');
  child = spawn(process.execPath, ['server.js'], { cwd: root, env: {
    ...process.env, HOST: '127.0.0.1', PORT: String(upstreamPort), NODE_ENV: 'development',
    AUTH_SECRET: secret, AUTH_SECRET_FILE: '', DEV_LOGIN_EMAIL: 'qa@example.com',
    DEV_LOGIN_PASSWORD: crypto.randomBytes(24).toString('hex'),
    REPORTS_DB_PATH: path.join(temp, 'reports.sqlite'), QA_REPORT_PUBLIC_URL: origin,
    QA_STORAGE_ACCESS_KEY: '', QA_STORAGE_SECRET_KEY: '', QA_STORAGE_ACCESS_KEY_FILE: '', QA_STORAGE_SECRET_KEY_FILE: '',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let log = '';
    child.stdout.on('data', chunk => { log += chunk; if (log.includes('QA Report:')) resolve(); });
    child.stderr.on('data', chunk => fs.appendFileSync(path.join(temp, 'server.log'), chunk));
    child.once('exit', code => reject(Error(`Server exited: ${code}`)));
    setTimeout(() => reject(Error('Server startup timeout')), 10000).unref();
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  if (fs.existsSync(path.join(root, 'auth.js'))) {
    const { createSessionToken } = require(path.join(root, 'auth'));
    await context.addCookies([{ name: 'query-port-session', value: createSessionToken('qa@example.com', { env: { AUTH_SECRET: secret } }),
      url: origin, httpOnly: true, sameSite: 'Lax' }]);
  }
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(origin);
  await page.waitForSelector('#settingsButton');
  await page.evaluate(async () => {
    cloudHistoryEnabled = false;
    const registration = await navigator.serviceWorker.ready;
    window.testRegistration = registration;
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      installing?.addEventListener('statechange', () => { window.testUpdateState = installing.state; });
    });
  });
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  const original = await page.evaluate(() => ({ reportId: draft.reportId, publicId: draft.publicId }));

  // Reproduce the incomplete Docker image. Failed install keeps the working
  // controller and its old cache; an unavailable update is never announced.
  missingWorker = true; workerSource = source + '\n// incomplete build\n';
  await page.evaluate(async () => { window.testUpdateState = ''; await testRegistration.update(); });
  await page.waitForFunction(() => window.testUpdateState === 'redundant');
  assert.equal(missingRequests > 0, true);
  assert.equal(await page.locator('#updateAppContainer').isVisible(), false);
  assert.equal(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), true);
  assert.equal(await page.evaluate(() => draft.reportId), original.reportId);

  // Correct the packaged asset and retry. The actual user-facing button must
  // appear, then save late edits before replacing the controller and reloading.
  missingWorker = false; workerSource = source + '\n// corrected build\n';
  await page.evaluate(async () => { window.testUpdateState = ''; await testRegistration.update(); });
  await page.waitForFunction(() => Boolean(testRegistration.waiting));
  await page.locator('#updateAppContainer').waitFor({ state: 'visible' });
  await page.locator('#introEditor').fill('Unsaved checklist text before PWA update');
  const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await page.locator('#updateAppButton').click();
  await navigation;
  await page.waitForSelector('#settingsButton');
  await page.waitForFunction(() => htmlToText(draft.intro) === 'Unsaved checklist text before PWA update');
  assert.equal(await page.evaluate(() => draft.reportId), original.reportId);
  assert.equal(await page.evaluate(() => draft.publicId), original.publicId);
  assert.equal(await page.evaluate(async () => htmlToText((await getReportRecord(draft.reportId)).document.intro)), 'Unsaved checklist text before PWA update');
  assert.equal(await page.evaluate(async () => {
    const keys = await caches.keys();
    for (const key of keys) if (!key.endsWith('-test-baseline') && await (await caches.open(key)).match('/draft-storage-worker.js?v=1')) return true;
    return false;
  }), true);
  assert.deepEqual(errors, []);
  console.log('PASS: missing Docker asset blocks installation safely; corrected build reveals update; activation preserves unsaved text and checklist IDs');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
  if (proxy) await new Promise(resolve => proxy.close(resolve));
});
