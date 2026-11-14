// History publication metadata and actions; synthetic fixtures, no external requests.
const { chromium } = require(process.env.QA_REPORT_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const corporate = fs.existsSync(path.join(root, 'auth.js'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-history-volume-'));
const screenshots = process.env.QA_REPORT_SCREENSHOTS;
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
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
  if (corporate) {
    const { createSessionToken } = require(path.join(root, 'auth'));
    await context.addCookies([{ name: 'query-port-session', value: createSessionToken('qa@example.com', { env: { AUTH_SECRET: secret } }), url: origin, httpOnly: true, sameSite: 'Lax' }]);
  }
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  if (process.env.QA_HISTORY_APP_SOURCE) await page.route('**/app.js?*', route => route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(process.env.QA_HISTORY_APP_SOURCE, 'utf8') }));
  await page.goto(origin);
  await page.waitForSelector('.cell-editor');

  const count = Number(process.env.QA_HISTORY_REPORTS || 50);
  const attachmentBytes = Number(process.env.QA_HISTORY_ATTACHMENT_BYTES || 2 * 1024 * 1024);
  const metrics = [];
  const cdp = await context.newCDPSession(page);
  async function measure(name, action) {
    const before = Date.now();
    await action();
    const heap = await cdp.send('Runtime.getHeapUsage');
    metrics.push({ name, elapsedMs: Date.now() - before, heapMiB: Math.round(heap.usedSize / 1024 / 1024) });
  }
  await page.evaluate(async ({ count, attachmentBytes }) => {
    clearTimeout(saveTimer); clearTimeout(historyTimer); await draftWriteQueue;
    await clearReportHistory();
    const attachment = 'data:application/octet-stream;base64,' + 'A'.repeat(attachmentBytes);
    const records = Array.from({ length: count }, (_, index) => {
      const project = ['SHOP', 'APP', 'CLOUD', 'WEB'][index % 4];
      const issueUrl = `https://jira.example.test/browse/${project}-${index + 1}`;
      const document = normalizeDraft({ ...clone(DEFAULT_DRAFT), reportId: `volume-${index}`, draftId: `volume-draft-${index}`,
        publicId: `abc${String(index).padStart(5, '0')}`, issueUrl, environment: 'STAGE',
        taskInfo: { issueUrl, summary: `Проверка ${index + 1} с названием задачи`,
          ...(index % 3 ? { parent: { issueUrl: `https://jira.example.test/browse/${project}-1000`, summary: `Родитель ${project}` } } : {}) },
        createdAt: '2026-11-01T10:00:00.000Z', updatedAt: `2026-11-${String(index % 10 + 1).padStart(2, '0')}T10:00:00.000Z` });
      const section = document.sections[0], template = section.rows[0];
      section.rows = Array.from({ length: 100 }, (_, row) => ({ ...clone(template), id: `row-${index}-${row}`, cells: Object.fromEntries(section.columns.map(column => [column.id, `<p>Проверка ${index + 1}, пункт ${row + 1}</p>`])) }));
      section.rows[0].cells[section.columns[0].id] += `<span class="cell-file" contenteditable="false" data-file-name="log-${index}.bin" data-data-url="${attachment}" data-mime-type="application/octet-stream">log-${index}.bin</span>`;
      if (index % 5 === 0) document.jiraPublication = { reportId: document.reportId, issueUrl, format: 'wiki',
        firstPublishedAt: '2026-11-01T10:00:00.000Z', lastPublishedAt: '2026-11-01T10:00:00.000Z',
        parts: [{ commentId: String(10000 + index), bodyHash: 'a'.repeat(64) }] };
      return { id: document.reportId, publicId: document.publicId, issueKey: `${project}-${index + 1}`, issueUrl, taskInfo: document.taskInfo,
        title: `${project}-${index + 1}`, document, createdAt: document.createdAt, updatedAt: document.updatedAt };
    });
    await dbTransaction('readwrite', store => records.forEach(record => store.put(record)));
    applyDraftLocally(records[0].document);
    await saveDraft({ collect: false });
  }, { count, attachmentBytes });
  // Instrument in a separate scope so the read counter cannot retain the seeded documents.
  await page.evaluate(() => {
    window.historyVolumeReads = 0;
    const original = getAllReports;
    getAllReports = async () => { window.historyVolumeReads++; return original(); };
  });
  const selectedId = await page.evaluate(() => draft.reportId);
  async function choose(id, value) {
    await page.click(`#${id}Button`);
    await page.locator(`.history-filter-popover:popover-open button[data-value="${value}"]`).click();
    await page.waitForFunction(() => !historyLoading && !document.querySelector('.history-filter-popover:popover-open'));
  }
  await measure('open', async () => {
    await page.click('#historyButton');
    await page.waitForFunction(count => document.querySelectorAll('.history-item').length === count, count);
  });
  await measure('selection-and-filters', async () => {
    for (let iteration = 0; iteration < 3; iteration++) {
      await page.click('#historySelectionToggle');
      await page.waitForSelector('[data-history-select="volume-0"]');
      await page.locator('[data-history-select="volume-0"]').check();
      await page.locator('#historySelectAll').check();
      assert.equal(await page.locator('[data-history-select]:checked').count(), count);
      await choose('historyProjectFilter', 'SHOP');
      await page.waitForFunction(count => document.querySelectorAll('.history-item').length === Math.ceil(count / 4), count);
      await choose('historyProjectFilter', '');
      await page.waitForFunction(count => document.querySelectorAll('.history-item').length === count, count);
      await choose('historyParentFilter', 'none');
      await page.waitForFunction(count => document.querySelectorAll('.history-item').length === Math.ceil(count / 3), count);
      await choose('historyParentFilter', '');
      await page.waitForFunction(count => document.querySelectorAll('.history-item').length === count, count);
      await page.fill('#historySearch', 'APP-2');
      await page.waitForFunction(() => document.querySelectorAll('.history-item').length < 50);
      await page.fill('#historySearch', '');
      await page.waitForFunction(count => document.querySelectorAll('.history-item').length === count, count);
      await page.selectOption('#historySort', iteration % 2 ? 'updated' : 'created');
      await page.click('#historySelectionExit');
      await page.waitForFunction(() => !document.querySelector('[data-history-select]'));
      assert.equal(await page.locator('#historyModal').isVisible(), true);
      assert.equal(await page.evaluate(() => draft.reportId), selectedId);
    }
  });
  const viewReads = await page.evaluate(() => historyVolumeReads);
  if (!process.env.QA_HISTORY_BASELINE) {
    assert.equal(viewReads, 1, 'view changes reuse the loaded reports');
    // A write in this tab and a save notification from another tab must invalidate the snapshot.
    await page.evaluate(async () => {
      const record = await getReportRecord('volume-1');
      record.historyComment = 'Новая заметка после загрузки';
      await dbTransaction('readwrite', store => store.put(record));
    });
    await page.fill('#historySearch', 'Новая заметка после загрузки');
    await page.waitForFunction(() => document.querySelectorAll('.history-item').length === 1);
    assert.equal(await page.locator('.history-item h3').innerText(), 'APP-2');
    assert.equal(await page.evaluate(() => historyVolumeReads), 2);
    await page.fill('#historySearch', '');
    await page.waitForFunction(count => document.querySelectorAll('.history-item').length === count, count);
    const remote = await context.newPage();
    await remote.goto(origin); await remote.waitForSelector('.cell-editor');
    await remote.evaluate(async () => {
      clearTimeout(saveTimer); clearTimeout(historyTimer); await draftWriteQueue;
      const db = await openDatabase();
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(REPORT_STORE, 'readwrite'), store = transaction.objectStore(REPORT_STORE);
        const request = store.get('volume-2');
        request.onsuccess = () => { const record = request.result; record.historyComment = 'Заметка из другой вкладки'; store.put(record); };
        transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
      });
      broadcastDraftUpdate({ ...draft, reportId: 'volume-2' });
    });
    await page.waitForFunction(() => historyReportsCache === null);
    await page.fill('#historySearch', 'Заметка из другой вкладки');
    await page.waitForFunction(() => document.querySelectorAll('.history-item').length === 1);
    assert.equal(await page.locator('.history-item h3').innerText(), 'CLOUD-3');
    assert.equal(await page.evaluate(() => historyVolumeReads), 3);
    await remote.close();
    await page.fill('#historySearch', '');
    await page.waitForFunction(count => document.querySelectorAll('.history-item').length === count, count);
  }
  await measure('close', () => page.click('#closeHistoryButton'));
  await cdp.send('HeapProfiler.collectGarbage');
  metrics.push({ name: 'after-close-gc', heapMiB: Math.round((await cdp.send('Runtime.getHeapUsage')).usedSize / 1024 / 1024) });
  const reads = await page.evaluate(() => historyVolumeReads);
  console.log(JSON.stringify({ version: corporate ? 'corporate' : 'public', reports: count, storedMiB: count * attachmentBytes / 1024 / 1024, reads, viewReads, metrics, errors }));
  if (!process.env.QA_HISTORY_BASELINE) {
    assert.equal(reads, 3, 'only the initial load and the two actual updates read saved reports');
    assert.equal(await page.locator('#historyList .history-item').count(), 0, 'closing history releases cards and their report documents');
  }
  if (!process.env.QA_HISTORY_BASELINE) {
    await page.click('#historyButton');
    await page.waitForFunction(count => document.querySelectorAll('.history-item').length === count, count);
    assert.equal(await page.evaluate(() => historyVolumeReads), 4);
    await page.evaluate(() => {
      window.releaseVolumeComments = [];
      const field = document.querySelector('.history-comment-field');
      field.__saveHistoryComment = () => new Promise(resolve => releaseVolumeComments.push(resolve));
      const original = setHistorySelectionMode;
      setHistorySelectionMode = async (...args) => { try { await original(...args); } finally { window.volumeSelectionFinished = true; } };
    });
    await page.click('#historySelectionToggle');
    await page.waitForFunction(() => releaseVolumeComments.length > 0);
    await page.click('#closeHistoryButton');
    await page.evaluate(() => releaseVolumeComments.forEach(resolve => resolve()));
    await page.waitForFunction(() => window.volumeSelectionFinished);
    assert.equal(await page.locator('#historyList .history-item').count(), 0, 'a delayed selection must not rebuild cards after closing');
    assert.equal(await page.evaluate(() => historyVolumeReads), 4);
  }
  assert.deepEqual(errors, []);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  child?.kill();
  fs.rmSync(temp, { recursive: true, force: true });
});
