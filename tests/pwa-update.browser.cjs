// Isolated update regression: missing packaged asset, waiting worker UI,
// latest-build selection, two open tabs and preservation of both checklists.
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
  const storageWorkerEntry = source.match(/^ *["'](\/draft-storage-worker\.js\?v=\d+)["'],\n/m);
  assert.ok(storageWorkerEntry, 'The draft storage worker must be precached');
  const buildSource = label => source.replace(/(const CACHE_NAME = ['"])([^'"]+)/, `$1$2-test-${label}`);
  let buildLabel = 'baseline';
  let workerSource = buildSource(buildLabel).replace(storageWorkerEntry[0], '');
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
      if (url.pathname === '/release-notes.js') {
        const label = buildLabel;
        const chunks = [];
        incoming.on('data', chunk => chunks.push(chunk));
        incoming.on('end', () => {
          const headers = { ...incoming.headers }; delete headers['content-length'];
          response.writeHead(incoming.statusCode, headers);
          response.end(`window.testShellBuild = ${JSON.stringify(label)};\n` + Buffer.concat(chunks));
        });
      } else {
        response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response);
      }
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
  const other = await context.newPage();
  other.on('pageerror', error => errors.push(error.message));
  await other.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await other.goto(origin);
  await other.waitForSelector('#settingsButton');
  await other.evaluate(async () => {
    cloudHistoryEnabled = false;
    applyDraftLocally(normalizeDraft({ ...clone(DEFAULT_DRAFT), reportId: crypto.randomUUID(),
      draftId: crypto.randomUUID(), publicId: 'a1b2c3d4' }));
    await saveDraft();
    window.testTabToken = 'still-open';
  });
  const otherId = await other.evaluate(() => draft.reportId);

  // Reproduce the incomplete Docker image. Failed install keeps the working
  // controller and its old cache; an unavailable update is never announced.
  missingWorker = true; buildLabel = 'incomplete'; workerSource = buildSource(buildLabel);
  await page.evaluate(async () => { window.testUpdateState = ''; await testRegistration.update(); });
  await page.waitForFunction(() => window.testUpdateState === 'redundant');
  assert.equal(missingRequests > 0, true);
  assert.equal(await page.locator('#updateAppContainer').isVisible(), false);
  assert.equal(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), true);
  assert.equal(await page.evaluate(() => draft.reportId), original.reportId);

  // Correct the packaged asset and retry. The actual user-facing button must
  // appear, then save late edits before replacing the controller and reloading.
  missingWorker = false; buildLabel = 'intermediate'; workerSource = buildSource(buildLabel);
  await page.evaluate(async () => { window.testUpdateState = ''; await testRegistration.update(); });
  await page.waitForFunction(() => Boolean(testRegistration.waiting));
  await page.locator('#updateAppContainer').waitFor({ state: 'visible' });
  // The button advertises an intermediate build. Two more releases arrive
  // before the click; the click must replace it with the latest complete one.
  buildLabel = 'next'; workerSource = buildSource(buildLabel);
  buildLabel = 'latest'; workerSource = buildSource(buildLabel);
  await other.locator('#introEditor').fill('Second tab keeps its pending edits');
  await other.evaluate(() => { clearTimeout(saveTimer); });
  await page.locator('#introEditor').fill('Unsaved checklist text before PWA update');
  const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await page.locator('#updateAppButton').click();
  await navigation;
  await page.waitForSelector('#settingsButton');
  await page.waitForFunction(() => htmlToText(draft.intro) === 'Unsaved checklist text before PWA update');
  assert.equal(await page.evaluate(() => draft.reportId), original.reportId);
  assert.equal(await page.evaluate(() => draft.publicId), original.publicId);
  assert.equal(await page.evaluate(async () => htmlToText((await getReportRecord(draft.reportId)).document.intro)), 'Unsaved checklist text before PWA update');
  assert.equal(await page.evaluate(async workerUrl => {
    const keys = await caches.keys();
    for (const key of keys) if (!key.endsWith('-test-baseline') && await (await caches.open(key)).match(workerUrl)) return true;
    return false;
  }, storageWorkerEntry[1]), true);
  assert.equal(await page.evaluate(() => window.testShellBuild), 'latest');
  const keys = await page.evaluate(() => caches.keys());
  assert.equal(keys.some(key => key.endsWith('-test-latest')), true);
  assert.equal(keys.some(key => /-test-(baseline|intermediate|next)$/.test(key)), false);
  assert.equal(await page.locator('#updateAppContainer').isVisible(), false);
  assert.equal(await other.evaluate(() => window.testTabToken), 'still-open');
  assert.equal(await other.evaluate(() => draft.reportId), otherId);
  assert.equal(await other.locator('#introEditor').innerText(), 'Second tab keeps its pending edits');
  await other.evaluate(async () => { await saveDraft(); await saveReportSnapshot('test-after-update'); });
  assert.equal(await other.evaluate(async () => htmlToText((await getReportRecord(draft.reportId)).document.intro)), 'Second tab keeps its pending edits');
  assert.deepEqual(errors, []);
  console.log('PASS: incomplete build is rejected; one click loads the latest build across skipped releases with two tabs open; both checklists and edits survive');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
  if (proxy) await new Promise(resolve => proxy.close(resolve));
});
