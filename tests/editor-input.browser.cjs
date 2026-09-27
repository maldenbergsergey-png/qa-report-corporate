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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-headerless-'));
const output = process.env.QA_REPORT_INPUT_RESULTS;
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
  page.setDefaultTimeout(10000);
  await page.goto(origin);
  await page.waitForSelector('#settingsButton');
  await page.evaluate(async () => {
    cloudHistoryEnabled = false;
    const columns = ['text', 'attachment', 'expected', 'actual'].map(id => ({ id, title: id }));
    const attachment = window.QaReportAttachments.render({ id: 'fixture', name: 'fixture.txt',
      type: 'text/plain', size: 48 * 1024, dataUrl: 'data:text/plain;base64,' + 'YWFh'.repeat(16 * 1024) });
    const rows = Array.from({ length: 240 }, (_, index) => ({ id: `row-${index}`, status: 'НЕ ПРОВЕРЕНО',
      cells: { text: index === 239 ? '' : `Check ${index}`, attachment: index % 6 === 0 ? attachment : '', expected: '', actual: '' } }));
    applyDraftLocally({ ...draft, intro: '<p>Introduction</p>', sections: [{ id: 'fixture-section', title: 'Large fixture', columns, rows }] });
    await saveDraft(); // Deliberately replace the row objects captured by render().
    window.fixtureAttachment = draft.sections[0].rows[0].cells.attachment;
    historyCurrent = serializeDraft(); undoStack = []; redoStack = [];
  });
  const metrics = await page.evaluate(() => {
    const editor = document.querySelector('tr[data-row-id="row-1"] .cell-editor[data-column-id="text"]');
    const originalCollect = collectDocumentFields, originalClean = cleanEditorHtml, originalSummary = renderSummary;
    const counts = { collections: 0, cleanups: 0, summaries: 0 };
    collectDocumentFields = (...args) => { counts.collections++; return originalCollect(...args); };
    cleanEditorHtml = (...args) => { counts.cleanups++; return originalClean(...args); };
    renderSummary = (...args) => { counts.summaries++; return originalSummary(...args); };
    const samples = [];
    try {
      for (let index = 0; index < 18; index++) {
        editor.textContent = `Typed ${index}`;
        const start = performance.now();
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        const elapsed = performance.now() - start;
        if (index >= 3) samples.push(elapsed);
      }
      clearTimeout(saveTimer); clearTimeout(historyTimer);
    } finally {
      collectDocumentFields = originalCollect; cleanEditorHtml = originalClean; renderSummary = originalSummary;
    }
    samples.sort((a, b) => a - b);
    return { rows: draft.sections[0].rows.length, cells: 960, attachmentCount: 40,
      documentBytes: new Blob([JSON.stringify(draft)]).size, events: 18, ...counts,
      medianInputMs: samples[Math.floor(samples.length / 2)], maxInputMs: samples.at(-1) };
  });
  console.log(JSON.stringify(metrics));
  if (output) fs.writeFileSync(output, JSON.stringify(metrics, null, 2) + '\n');
  if (process.env.QA_REPORT_INPUT_BASELINE) return;
  assert.equal(metrics.collections, 0);
  assert.equal(metrics.cleanups, metrics.events);
  assert.equal(metrics.summaries, 0);
  assert.equal(await page.evaluate(() => draft.sections[0].rows[1].cells.text), 'Typed 17');

  // Actual DOM input + timer-driven autosave, undo/redo, and a second edit after normalization.
  const selector = 'tr[data-row-id="row-1"] .cell-editor[data-column-id="text"]';
  const waitStoredText = expected => page.waitForFunction(async text => {
    const record = await getReportRecord(draft.reportId);
    return record?.document.sections[0].rows[1].cells.text === text && !hasUnsavedLocalChanges;
  }, expected);
  await page.evaluate(() => { historyCurrent = serializeDraft(); undoStack = []; redoStack = []; });
  await page.locator(selector).fill('Persist after autosave');
  await page.waitForFunction(() => !hasUnsavedLocalChanges && historyCurrent.includes('Persist after autosave'));
  await waitStoredText('Persist after autosave');
  await page.evaluate(() => undo());
  assert.equal(await page.locator(selector).innerText(), 'Typed 17');
  await waitStoredText('Typed 17');
  await page.evaluate(() => redo());
  assert.equal(await page.locator(selector).innerText(), 'Persist after autosave');
  await waitStoredText('Persist after autosave');
  await page.locator(selector).evaluate(editor => {
    editor.focus();
    const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await page.locator(selector).pressSequentially(' again');
  await page.waitForFunction(() => !hasUnsavedLocalChanges && historyCurrent.includes('Persist after autosave again'));
  await waitStoredText('Persist after autosave again');
  assert.equal(await page.evaluate(() => draft.sections[0].rows[0].cells.attachment === window.fixtureAttachment), true);

  // Empty/nonempty transitions update the summary immediately, including pasted images.
  const emptySelector = 'tr[data-row-id="row-239"] .cell-editor[data-column-id="text"]';
  assert.equal(await page.locator('#summaryTotal').innerText(), '239');
  await page.locator(emptySelector).fill('New check');
  assert.equal(await page.locator('#summaryTotal').innerText(), '240');
  await page.locator(emptySelector).fill('');
  assert.equal(await page.locator('#summaryTotal').innerText(), '239');
  await page.locator(emptySelector).evaluate(editor => {
    editor.innerHTML = '<figure class="cell-image"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII="></figure>';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal(await page.locator('#summaryTotal').innerText(), '240');
  await page.locator(emptySelector).fill('');

  // Intro and report fields also avoid scanning unrelated cells during input.
  const fieldCounts = await page.evaluate(() => {
    let collections = 0;
    const original = collectDocumentFields;
    collectDocumentFields = (...args) => { collections++; return original(...args); };
    try {
      elements.introEditor.innerHTML = '<p>Updated introduction</p>';
      elements.introEditor.dispatchEvent(new Event('input', { bubbles: true }));
      elements.issueUrl.value = 'QA-321';
      elements.issueUrl.dispatchEvent(new Event('input', { bubbles: true }));
      elements.environment.value = 'PERFORMANCE';
      elements.environment.dispatchEvent(new Event('input', { bubbles: true }));
      return collections;
    } finally { collectDocumentFields = original; }
  });
  assert.equal(fieldCounts, 0);
  await page.waitForFunction(() => !hasUnsavedLocalChanges && historyCurrent.includes('Updated introduction'));
  const beforeReload = await page.evaluate(() => ({ text: draft.sections[0].rows[1].cells.text,
    attachment: draft.sections[0].rows[0].cells.attachment, intro: draft.intro, issueUrl: draft.issueUrl, environment: draft.environment }));
  await page.reload();
  await page.waitForSelector(selector);
  assert.deepEqual(await page.evaluate(() => ({ text: draft.sections[0].rows[1].cells.text,
    attachment: draft.sections[0].rows[0].cells.attachment, intro: draft.intro, issueUrl: draft.issueUrl, environment: draft.environment })), beforeReload);
  assert.deepEqual(errors, []);
  console.log('PASS: large-report input, autosave, typing after autosave, summary, attachments, undo/redo, report fields and reload');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
});
