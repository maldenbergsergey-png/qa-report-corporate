// Required report metadata regression with synthetic data and no external requests.
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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-report-metadata-'));
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
  await page.goto(origin);
  await page.waitForSelector('.cell-editor');
  const empty = async () => {
    assert.equal(await page.inputValue('#environment'), '');
    assert.equal(await page.inputValue('#overallStatus'), '');
    assert.equal(await page.locator('#overallStatus').evaluate(node => node.className), '');
  };
  const aligned = async () => {
    if (page.viewportSize().width < 1100) return;
    const boxes = await page.evaluate(() => ['issueUrl', 'environment', 'overallStatus'].map(id => {
      const rect = document.getElementById(id).getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height };
    }));
    for (const edge of ['top', 'bottom', 'height']) {
      assert.ok(Math.max(...boxes.map(box => box[edge])) - Math.min(...boxes.map(box => box[edge])) < 1, `Metadata ${edge}: ${JSON.stringify(boxes)}`);
    }
  };
  await empty();
  await aligned();
  await page.evaluate(async () => { cloudHistoryEnabled = false; await saveDraft(); });
  await page.reload();
  await page.waitForSelector('.cell-editor');
  await empty();

  // Unfinished content can be backed up, previewed and exported without an invented outcome.
  const exported = await page.evaluate(async () => {
    cloudHistoryEnabled = false;
    elements.introEditor.innerHTML = '<p>Незавершённая проверка</p>';
    collectDocumentFields();
    const packed = await window.QaReportFile.pack(draft);
    const unpacked = await window.QaReportFile.unpack(packed.blob);
    const record = await saveReportSnapshot('metadata-fixture');
    const saved = await getReportRecord(draft.reportId);
    return { environment: unpacked.document.environment, overallStatus: unpacked.document.overallStatus,
      savedEnvironment: saved.document.environment, savedStatus: saved.document.overallStatus,
      markup: generateMarkup(), html: generatePortableHtml(), xlsx: JSON.stringify(buildXlsxWorksheet()),
      adf: typeof generateAdfDocument === 'function' ? JSON.stringify(generateAdfDocument()) : '', record: Boolean(record) };
  });
  assert.equal(exported.environment, ''); assert.equal(exported.overallStatus, '');
  assert.equal(exported.savedEnvironment, ''); assert.equal(exported.savedStatus, '');
  for (const format of ['markup', 'html', 'adf']) assert.doesNotMatch(exported[format], /ТЕСТ —|Проверено на/);
  assert.match(exported.xlsx, /Не указан/);
  await page.evaluate(() => {
    window.publicationFixture = { ready: 0, scopes: 0, uploads: 0, sent: [], changeDuringScope: false };
    isJiraReadyToPublish = async () => { publicationFixture.ready++; return true; };
    askPublishScope = async () => {
      publicationFixture.scopes++;
      if (publicationFixture.changeDuringScope) elements.overallStatus.value = '';
      return { sectionIds: null, statuses: null };
    };
    checkBackendCompatibility = async () => {};
    uploadPendingImages = async () => { publicationFixture.uploads++; };
    publishCommentWithFallback = async (settings, issue, comment) => {
      publicationFixture.sent.push(comment); return [{ verified: true, commentId: 'fixture' }];
    };
    if (typeof jiraSettings !== 'undefined') jiraSettings = { transport: 'agent', baseUrl: 'https://jira.example', type: 'data-center' };
    if (typeof validateJiraSettings === 'function') validateJiraSettings = () => {};
  });
  await page.click('#copyMenuButton');
  await page.click('#publishExportButton');
  await page.waitForFunction(() => document.querySelector('#environment').getAttribute('aria-invalid') === 'true');
  assert.equal(await page.locator('#overallStatus').getAttribute('aria-invalid'), 'true');
  assert.equal(await page.locator('#environmentError').innerText(), 'Укажите окружение');
  assert.equal(await page.locator('#overallStatusError').innerText(), 'Выберите итог проверки');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'environment');
  assert.equal(await page.evaluate(() => publicationFixture.ready), 0);
  assert.equal(await page.locator('#publishScopeModal').isVisible(), false);

  if (screenshots) fs.mkdirSync(screenshots, { recursive: true });
  for (const width of [1600, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    for (const theme of ['light', 'dark', 'graphite']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.locator('.metadata-grid').scrollIntoViewIfNeeded();
      assert.equal(await page.locator('#environment').evaluate(node => getComputedStyle(node).borderTopColor),
        await page.locator('#environmentError').evaluate(node => getComputedStyle(node).color));
      assert.equal(await page.locator('#overallStatus').evaluate(node => getComputedStyle(node).borderTopColor),
        await page.locator('#overallStatusError').evaluate(node => getComputedStyle(node).color));
      assert.equal(await page.locator('.metadata-grid').evaluate(grid => [...grid.querySelectorAll('input, select, .field-error')]
        .every(node => node.getBoundingClientRect().right <= innerWidth && node.getBoundingClientRect().left >= 0)), true);
      await aligned();
      if (screenshots) await page.locator('.metadata-grid').screenshot({ animations: 'disabled', path: path.join(screenshots, `${theme}-${width}-validation.png`) });
    }
  }
  await page.fill('#environment', '   ');
  await page.evaluate(() => publishToJira());
  assert.equal(await page.evaluate(() => publicationFixture.ready), 0);
  await page.fill('#environment', 'Не указано');
  await page.evaluate(() => publishToJira());
  assert.equal(await page.evaluate(() => publicationFixture.ready), 0);
  // Picking a suggested environment removes its error, leaving the outcome required.
  await page.click('#environmentToggle');
  await page.getByRole('option', { name: 'DEV', exact: true }).click();
  assert.equal(await page.locator('#environment').getAttribute('aria-invalid'), null);
  assert.equal(await page.locator('#environmentError').isVisible(), false);
  await page.evaluate(() => publishToJira());
  assert.equal(await page.evaluate(() => document.activeElement.id), 'overallStatus');
  assert.equal(await page.evaluate(() => publicationFixture.ready), 0);
  await page.fill('#issueUrl', 'https://jira.example/browse/QA-1');
  await page.selectOption('#overallStatus', 'НЕ ПРОВЕРЕНО');
  assert.equal(await page.locator('#overallStatus').getAttribute('aria-invalid'), null);
  assert.equal(await page.locator('#overallStatusError').isVisible(), false);
  // Explicit НЕ ПРОВЕРЕНО is a valid choice; publication uses the actual values.
  await page.evaluate(() => publishToJira());
  assert.equal(await page.evaluate(() => publicationFixture.sent.length), 1);
  assert.match(await page.evaluate(() => publicationFixture.sent[0].body), /ТЕСТ — НЕ ПРОВЕРЕНО/);
  assert.match(await page.evaluate(() => publicationFixture.sent[0].body), /Проверено на DEV/);
  await page.evaluate(() => closePublishProgress());
  // An asynchronous change while choosing the publication scope cannot bypass validation.
  await page.evaluate(() => { publicationFixture.changeDuringScope = true; });
  await page.evaluate(() => publishToJira());
  assert.equal(await page.evaluate(() => publicationFixture.sent.length), 1);
  assert.equal(await page.locator('#overallStatus').getAttribute('aria-invalid'), 'true');
  await page.evaluate(() => { publicationFixture.changeDuringScope = false; });
  await page.fill('#environment', '');
  await page.selectOption('#overallStatus', 'НЕ ОК');
  await page.evaluate(() => publishToJira());
  assert.equal(await page.evaluate(() => publicationFixture.sent.length), 1);
  assert.equal(await page.locator('#environment').getAttribute('aria-invalid'), 'true');

  for (const width of [1600, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    for (const theme of ['light', 'dark', 'graphite']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.selectOption('#overallStatus', 'НЕ ПРОВЕРЕНО');
      const gap = await page.locator('.overall-status-input').evaluate(wrapper => {
        const select = wrapper.querySelector('select'), arrow = wrapper.querySelector('svg');
        return { right: select.getBoundingClientRect().right - arrow.getBoundingClientRect().right,
          appearance: getComputedStyle(select).appearance, padding: parseFloat(getComputedStyle(select).paddingRight) };
      });
      assert.equal(gap.right, 12); assert.equal(gap.appearance, 'none'); assert.ok(gap.padding >= 40);
      await aligned();
      if (screenshots) await page.locator('.metadata-grid').screenshot({ animations: 'disabled', path: path.join(screenshots, `${theme}-${width}-outcome.png`) });
    }
  }
  // Existing selected values survive loading; creating a new report resets only its metadata.
  await page.evaluate(async () => {
    applyDraftLocally({ ...draft, environment: 'PROD', overallStatus: 'НЕ ОК' });
    await saveDraft();
  });
  await page.reload();
  await page.waitForSelector('.cell-editor');
  assert.equal(await page.inputValue('#environment'), 'PROD');
  assert.equal(await page.inputValue('#overallStatus'), 'НЕ ОК');
  await page.click('#clearButton');
  await page.waitForFunction(() => document.querySelector('#environment').value === '');
  await empty();
  assert.equal(await page.locator('#environmentError').isVisible(), false);
  assert.equal(await page.locator('#overallStatusError').isVisible(), false);
  assert.deepEqual(errors, []);
  console.log('Passed: blank metadata, persistence, unfinished exports, required-field publication gate, correction, explicit unchecked outcome, scope revalidation, themes, mobile arrow spacing and existing reports.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }
  fs.rmSync(temp, { recursive: true, force: true });
});
