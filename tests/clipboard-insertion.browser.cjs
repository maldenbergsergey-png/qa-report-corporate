// Clipboard regression: isolated database, synthetic files and held metadata responses.
// QA_REPORT_PLAYWRIGHT may point at an existing Playwright installation.
const { chromium } = require(process.env.QA_REPORT_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-clipboard-'));

let child, browser;
async function main() {
  const listener = http.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const secret = crypto.randomBytes(32).toString('hex');
  child = spawn(process.execPath, ['server.js'], { cwd: root, env: {
    ...process.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'development',
    AUTH_SECRET: secret, AUTH_SECRET_FILE: '', DEV_LOGIN_EMAIL: 'qa@example.com',
    DEV_LOGIN_PASSWORD: crypto.randomBytes(24).toString('hex'),
    REPORTS_DB_PATH: path.join(temp, 'reports.sqlite'), QA_REPORT_PUBLIC_URL: origin,
    QA_STORAGE_ACCESS_KEY: '', QA_STORAGE_SECRET_KEY: '',
    QA_STORAGE_ACCESS_KEY_FILE: '', QA_STORAGE_SECRET_KEY_FILE: '',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let log = '';
    child.stdout.on('data', chunk => { log += chunk; if (log.includes('QA Report:')) resolve(); });
    child.stderr.on('data', chunk => fs.appendFileSync(path.join(temp, 'server.log'), chunk));
    child.once('exit', code => reject(Error(`Server exited: ${code}`)));
    setTimeout(() => reject(Error('Server startup timeout')), 10000).unref();
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  if (fs.existsSync(path.join(root, 'auth.js'))) {
    const { createSessionToken } = require(path.join(root, 'auth'));
    await context.addCookies([{ name: 'query-port-session', value: createSessionToken('qa@example.com', { env: { AUTH_SECRET: secret } }), url: origin, httpOnly: true, sameSite: 'Lax' }]);
  }
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let holdMetadata = false;
  const pendingMetadata = [];
  let metadataRequests = 0;
  // Never contact a real Jira or external attachment service.
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    const jira = /\/attachment-manifest$/.test(url.pathname);
    if (url.pathname === '/api/health' || jira) {
      if (jira) metadataRequests++;
      if (holdMetadata) await new Promise(resolve => pendingMetadata.push(resolve));
      return route.fulfill({ json: { ok: true, attachmentLimits: {
        appMaxFileBytes: 50 * 1024 * 1024, requestMaxBytes: 150 * 1024 * 1024,
        jiraEnabled: true, jiraUploadLimit: jira ? 1 : null,
      } } });
    }
    return route.continue();
  });
  page.setDefaultTimeout(10000);
  await page.goto(origin);
  await page.waitForSelector('#settingsButton');
  await page.waitForFunction(() => localAttachmentLimitCache && !localAttachmentLimitCache.pending);
  holdMetadata = true;
  const selector = '.cell-editor';
  await page.evaluate(() => {
    cloudHistoryEnabled = false;
    elements.issueUrl.value = 'https://jira-a.example.test/browse/QA-1';
    draft.issueUrl = elements.issueUrl.value;
    historyCurrent = serializeDraft(); undoStack = []; redoStack = [];
  });
  async function pasteFiles() {
    await page.locator(selector).first().focus();
    await page.locator(selector).first().evaluate(editor => {
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='), char => char.charCodeAt(0));
      const clipboard = new DataTransfer();
      clipboard.items.add(new File([bytes], 'clipboard.png', { type: 'image/png' }));
      clipboard.items.add(new File(['clipboard text'], 'clipboard.txt', { type: 'text/plain' }));
      editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));
    });
  }
  const started = Date.now();
  await pasteFiles();
  await page.locator('.cell-editor .cell-image').waitFor({ state: 'attached', timeout: 2000 });
  await page.locator('.cell-editor .cell-file').waitFor({ state: 'attached', timeout: 2000 });
  const visibleMs = Date.now() - started;
  assert.equal(await page.evaluate(() => Boolean(localAttachmentLimitCache.pending)), true);
  assert.equal(await page.evaluate(() => pwaPendingOperations), 0);
  assert.equal(metadataRequests, 1, 'the mixed batch shares one metadata request');
  await page.waitForFunction(async () => {
    const record = await getReportRecord(draft.reportId);
    return record && JSON.stringify(record.document).includes('clipboard.txt') && historyCurrent.includes('clipboard.txt');
  });
  assert.equal(await page.locator('.cell-file').getAttribute('data-data-url'), 'data:text/plain;base64,Y2xpcGJvYXJkIHRleHQ=');
  await page.evaluate(() => undo());
  assert.equal(await page.locator('.cell-editor .cell-file').count(), 0);
  await page.waitForFunction(async () => {
    const record = await getReportRecord(draft.reportId);
    return record && !JSON.stringify(record.document).includes('clipboard.txt');
  });
  await page.evaluate(() => redo());
  assert.equal(await page.locator('.cell-editor .cell-file').count(), 1);
  await page.waitForFunction(async () => {
    const record = await getReportRecord(draft.reportId);
    return record && JSON.stringify(record.document).includes('clipboard.txt');
  });
  // Complete the slow metadata response: existing local attachments stay intact.
  holdMetadata = false;
  pendingMetadata.splice(0).forEach(resolve => resolve());
  await page.waitForFunction(() => !localAttachmentLimitCache.pending);
  await pasteFiles();
  assert.equal(await page.locator('.cell-editor .cell-file').count(), 1, 'known limits prevent another oversized insertion');
  assert.equal(await page.locator('.cell-editor .cell-image').count(), 1);
  assert.match(await page.locator('#toast').innerText(), /лимит Jira/);
  await page.reload();
  await page.locator('.cell-editor .cell-file').waitFor();
  assert.equal(await page.locator('.cell-editor .cell-image').count(), 1);
  assert.equal(await page.locator('.cell-file').getAttribute('data-data-url'), 'data:text/plain;base64,Y2xpcGJvYXJkIHRleHQ=');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ visibleMs, heldResponses: true, metadataRequests }));
  console.log('PASS: clipboard image+file before network responses, shared metadata, bytes, autosave, undo/redo, known limits and reload');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
});
