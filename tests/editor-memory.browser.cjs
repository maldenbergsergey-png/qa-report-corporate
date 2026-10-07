// Real browser regression for large reports, using an isolated database and synthetic attachments.
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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-editor-memory-'));
const output = process.env.QA_REPORT_MEMORY_RESULTS;
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
  // Never contact a real Jira or external attachment service.
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin && url.pathname === '/app.js' && process.env.QA_REPORT_INPUT_BASELINE) return route.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(process.env.QA_REPORT_INPUT_BASELINE, 'utf8') });
    return url.origin === origin ? route.continue() : route.abort();
  });
  page.setDefaultTimeout(60000);
  await page.goto(origin);
  await page.waitForSelector('#settingsButton');


  await page.evaluate(async () => {
    cloudHistoryEnabled = false;
    const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 500;
    const ctx = canvas.getContext('2d'), pixels = ctx.createImageData(900, 500);
    let seed = 937;
    for (let i = 0; i < pixels.data.length; i += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      pixels.data[i] = seed & 255; pixels.data[i + 1] = seed >>> 8 & 255;
      pixels.data[i + 2] = seed >>> 16 & 255; pixels.data[i + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
    const png = canvas.toDataURL('image/png');
    const rows = Array.from({ length: 500 }, (_, i) => ({ id: `memory-row-${i}`, status: 'НЕ ПРОВЕРЕНО',
      cells: { text: `<p>Check ${i}</p>`, attachment: '' } }));
    for (let i = 0; i < 8; i++) rows[i * 60].cells.attachment = `<figure class="cell-image" contenteditable="false" data-align="left"><img src="${png}" alt="fixture" data-attachment-id="memory-image-${i}" data-file-name="fixture-${i}.png" data-mime-type="image/png"></figure>`;
    rows[1].cells.attachment = `<a class="cell-file" contenteditable="false" data-attachment-id="memory-file" data-file-name="fixture.txt" data-mime-type="text/plain" data-data-url="data:text/plain;base64,${'YWFh'.repeat(256 * 1024)}">fixture.txt</a>`;
    applyDraftLocally({ ...draft, intro: '<p>Memory diagnostic</p>', sections: [{ id: 'memory-section', title: 'Memory diagnostic',
      columns: [{ id: 'text', title: 'Text' }, { id: 'attachment', title: 'Files' }], rows }] });
    await saveDraft();
    await Promise.all([...document.images].map(image => image.decode().catch(() => {})));
    historyCurrent = serializeDraft(); undoStack = []; redoStack = [];
    window.memoryFixture = { rows: rows.length, images: 8, files: 1,
      documentBytes: new Blob([historyCurrent]).size, reportId: draft.reportId };
    window.attachmentFingerprint = async value => {
      const data = new TextEncoder().encode(JSON.stringify(value.sections.map(section => section.rows.map(row => row.cells.attachment))));
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), value => value.toString(16).padStart(2, '0')).join('');
    };
    window.expectedAttachments = await attachmentFingerprint(draft);
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const sample = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]));
    return page.evaluate(heapBytes => ({ heapBytes, undoSteps: undoStack.length, redoSteps: redoStack.length,
      historyBytes: 2 * (historyCurrent.length + [...undoStack, ...redoStack].reduce((sum, value) => sum + value.length, 0)) }), metrics.JSHeapUsedSize);
  };
  const before = await sample();
  const waitSavedText = text => page.waitForFunction(text => !hasUnsavedLocalChanges
    && savedContentForHistory?.draft === draft && savedContentForHistory.generation === localEditGeneration
    && savedContentForHistory.content.includes(text), text);
  const selector = 'tr[data-row-id="memory-row-3"] .cell-editor[data-column-id="text"]';
  const edits = 24;
  for (let i = 0; i < edits; i++) {
    const text = `Memory edit ${i}.`;
    await page.locator(selector).fill(text);
    await page.waitForFunction(text => !hasUnsavedLocalChanges && historyCurrent.includes(text), text);
  }
  const after = await sample();
  if (!process.env.QA_REPORT_INPUT_BASELINE) {
    assert.equal(after.undoSteps, 1, 'oversized report keeps only the nearest undo');
    assert.ok(after.historyBytes < 3 * before.historyBytes, 'history stays within two complete oversized snapshots');
    await page.evaluate(() => undo());
    await waitSavedText('Memory edit 22.');
    assert.match(await page.locator(selector).innerText(), /Memory edit 22\./);
    assert.equal(await page.evaluate(() => attachmentFingerprint(draft)), await page.evaluate(() => expectedAttachments));
    await page.evaluate(() => redo());
    await waitSavedText('Memory edit 23.');
    assert.match(await page.locator(selector).innerText(), /Memory edit 23\./);
    await page.evaluate(async () => {
      const record = await getReportRecord(draft.reportId);
      if (await attachmentFingerprint(record.document) !== expectedAttachments) throw Error('Saved attachment data changed');
      if (!record.document.sections[0].rows[3].cells.text.includes('Memory edit 23.')) throw Error('Last edit was not saved');
    });
    const fixture = await page.evaluate(() => ({ ...memoryFixture, hash: expectedAttachments }));
    await page.reload();
    await page.waitForSelector(selector);
    await page.evaluate(() => { cloudHistoryEnabled = false; });
    assert.match(await page.locator(selector).innerText(), /Memory edit 23\./);
    const reopened = await page.evaluate(async () => {
      const data = new TextEncoder().encode(JSON.stringify(draft.sections.map(section => section.rows.map(row => row.cells.attachment))));
      return { reportId: draft.reportId, hash: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), value => value.toString(16).padStart(2, '0')).join('') };
    });
    assert.equal(reopened.reportId, fixture.reportId);
    assert.equal(reopened.hash, fixture.hash);
  }
  const result = { version: path.basename(root), baseline: Boolean(process.env.QA_REPORT_INPUT_BASELINE),
    fixture: { rows: 500, images: 8, files: 1, edits: 24, documentBytes: before.historyBytes / 2 }, before, after,
    verified: process.env.QA_REPORT_INPUT_BASELINE ? ['history growth'] : ['bounded history', 'undo', 'redo', 'attachment integrity', 'IndexedDB save', 'reload'] };
  console.log(JSON.stringify(result, null, 2));
  if (output) fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  assert.deepEqual(errors, []);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
});
