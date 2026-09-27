// Real browser regression: isolated local app; every Jira request is a fixture.
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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-report-import-'));
const output = process.env.QA_REPORT_SCREENSHOTS;
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
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
    return url.origin === origin ? route.continue() : route.abort();
  });
  page.setDefaultTimeout(10000);
  await page.goto(origin);
  await page.waitForSelector('#settingsButton');
  const screenshot = async name => {
    if (!output) return;
    fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, `${name}.png`) });
  };
  const tab = name => page.locator(`[data-import-source="${name}"]`);
  const action = page.locator('#applyImportButton');
  const geometry = () => page.evaluate(() => ['#importModal .modal', '#importModal .modal-header', '#importModal .import-source-tabs', '#importModal .modal-footer'].map(selector => {
    const {x,y,width,height} = document.querySelector(selector).getBoundingClientRect();
    return {x,y,width,height};
  }));
  const original = await page.evaluate(async () => {
    const parsed = parseJiraMarkup('Окружение: PROD\n||Номер||Проверка||Шаги||Ожидаемый результат||Фактический результат||Комментарий||Статус||\n|1|Исходная проверка|Шаги|Ожидание|Факт|Сохранить комментарий|НЕ ОК|');
    applyDraftLocally(importedDraftInCurrentReport({ ...parsed, numberingMode: 'manual' }));
    flushDraftFromDom(); await saveReportSnapshot('browser-fixture');
    return { id: draft.reportId, content: serializeDraft() };
  });
  const packed = await page.evaluate(async () => {
    const doc = clone(draft);
    doc.environment = 'STAGE'; doc.overallStatus = 'ПОЧТИ ОК';
    doc.intro = '<p>Восстановленное описание</p><span class="cell-file" data-file-name="log.txt" data-mime-type="text/plain" data-data-url="data:text/plain;base64,bG9n">log.txt</span>';
    doc.sections[0].rows[0].manualNumber = '4.2';
    const result = await window.QaReportFile.pack(doc);
    return { bytes: Array.from(new Uint8Array(await result.blob.arrayBuffer())), document: window.QaReportFile.documentFields(doc) };
  });
  const validFile = { name: 'regression-27-09.report', mimeType: 'application/octet-stream', buffer: Buffer.from(packed.bytes) };
  await page.click('#importButton');
  assert.equal(await page.locator('.import-source-tab').count(), 3);
  const desktop = await geometry();
  await page.fill('#importMarkup', 'Длинная строка\n'.repeat(1000));
  assert.deepEqual(await geometry(), desktop);
  assert(await page.locator('#importMarkup').evaluate(n => n.scrollHeight > n.clientHeight));
  for (const name of ['comment','report','markup','report']) {
    await tab(name).click(); assert.deepEqual(await geometry(), desktop);
  }
  assert.equal(await action.textContent(), 'Открыть отчёт');
  assert.equal(await action.isDisabled(), true);
  assert.equal(await page.locator('#reportFileEmpty').isVisible(), true);
  assert.equal(await page.locator('#chooseReportFileButton').innerText(), 'Выбрать файл');
  assert.equal(await page.locator('#reportDropZone').isVisible(), true);
  assert.equal(await page.locator('#importWithAttachments').isVisible(), false);
  // Both the chooser and empty zone surface open the native file picker.
  for (const selector of ['#chooseReportFileButton', '#reportDropZone']) {
    const picker = page.waitForEvent('filechooser');
    await page.locator(selector).click(selector.endsWith('Zone') ? { position: { x: 2, y: 2 } } : {});
    await (await picker).setFiles([]);
  }
  await page.locator('#reportFileInput').setInputFiles({ name: 'bad.txt', mimeType: 'text/plain', buffer: Buffer.from('no') });
  assert.match(await page.locator('#reportImportError').innerText(), /Выберите файл формата .report/);
  assert.equal(await action.isDisabled(), true);
  assert.deepEqual(await geometry(), desktop);
  await page.locator('#reportFileInput').setInputFiles(validFile);
  assert.equal(await page.locator('#selectedReportFileName').textContent(), validFile.name);
  assert.equal(await page.locator('#reportFileEmpty').isVisible(), false);
  assert.match(await page.locator('#selectedReportFileSize').innerText(), /\d.*[БКМ]/);
  assert.equal(await page.locator('#chooseReportFileButton').innerText(), 'Выбрать другой файл');
  assert.equal(await action.isDisabled(), false);
  assert.equal(await page.evaluate(() => serializeDraft()), original.content);
  assert.deepEqual(await geometry(), desktop);
  await screenshot('report-selected');
  await page.click('#removeReportFileButton');
  assert.equal(await action.isDisabled(), true);
  assert.equal(await page.locator('#reportFileEmpty').isVisible(), true);
  assert.equal(await page.locator('#chooseReportFileButton').innerText(), 'Выбрать файл');
  // Drag depth should keep highlighting while crossing descendants.
  const dragResult = await page.evaluate(bytes => {
    const zone = document.getElementById('reportDropZone');
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], 'dropped.REPORT'));
    const send = (type, target = zone) => {
      const event = new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true });
      target.dispatchEvent(event); return event.defaultPrevented;
    };
    send('dragenter'); send('dragenter', zone.firstElementChild); send('dragleave', zone.firstElementChild);
    const nested = zone.classList.contains('is-dragover');
    send('dragover'); const over = zone.classList.contains('is-dragover');
    const prevented = send('drop');
    return { nested, over, prevented, cleared: !zone.classList.contains('is-dragover') };
  }, packed.bytes);
  assert.deepEqual(dragResult, { nested: true, over: true, prevented: true, cleared: true });
  assert.equal(await page.evaluate(() => serializeDraft()), original.content);
  await page.evaluate(() => {
    const transfer = new DataTransfer(); transfer.items.add(new File(['bad'], 'bad.pdf'));
    document.getElementById('reportDropZone').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  });
  assert.equal(await action.isDisabled(), true);
  await page.evaluate(() => selectReportFiles([new File(['one'], 'one.report'), new File(['two'], 'two.report')]));
  assert.match(await page.locator('#reportImportError').innerText(), /один файл/);
  // Corrupt archive: stays in the import window and preserves the current report.
  await page.locator('#reportFileInput').setInputFiles({ name: 'corrupt.report', mimeType: 'application/octet-stream', buffer: Buffer.from('broken') });
  await action.click();
  await page.locator('#reportImportError').waitFor();
  assert.match(await page.locator('#reportImportError').innerText(), /повреждён|формат/);
  assert.equal(await page.evaluate(() => serializeDraft()), original.content);
  assert.equal(await page.locator('#reportFileModal').isVisible(), false);
  assert.deepEqual(await geometry(), desktop);
  // File read failure uses inline error handling, without native alerts.
  await page.evaluate(() => {
    const file = new File(['test'], 'unreadable.report');
    file.arrayBuffer = async () => { throw Error('Не удалось прочитать файл'); };
    selectReportFiles([file]);
  });
  await action.click();
  await page.locator('#reportImportError').waitFor();
  assert.match(await page.locator('#reportImportError').innerText(), /прочитать/);
  await screenshot('report-error');
  // Busy controls and footer stability while the original parser is awaiting IO.
  await page.evaluate(bytes => {
    const file = new File([new Uint8Array(bytes)], 'slow.report');
    const read = file.arrayBuffer.bind(file);
    file.arrayBuffer = () => new Promise(resolve => { window.finishReportRead = async () => resolve(await read()); });
    selectReportFiles([file]);
  }, packed.bytes);
  await action.click();
  assert.equal(await action.isDisabled(), true);
  assert.equal(await page.locator('#closeImportButton').isDisabled(), true);
  assert.equal(await page.locator('#chooseReportFileButton').isDisabled(), true);
  assert.deepEqual(await geometry(), desktop);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#importModal').isVisible(), true);
  await page.evaluate(() => window.finishReportRead());
  await page.waitForFunction(() => elements.importModal.hidden);
  const restored = await page.evaluate(async originalId => ({
    id: draft.reportId, document: window.QaReportFile.documentFields(draft),
    previous: (await getReportRecord(originalId)).document,
    attachments: (await window.QaReportFile.pack(draft)).count,
  }), original.id);
  assert.notEqual(restored.id, original.id);
  assert.equal(restored.document.environment, 'STAGE');
  assert.equal(restored.document.overallStatus, 'ПОЧТИ ОК');
  assert.equal(restored.document.numberingMode, 'manual');
  assert.equal(restored.document.sections[0].rows[0].manualNumber, '4.2');
  assert.deepEqual(restored.document.sections, packed.document.sections);
  assert.match(restored.document.intro, /Восстановленное описание/);
  assert.match(restored.document.intro, /data:text\/plain;base64,bG9n/);
  assert.equal(restored.attachments, 1);
  assert.equal(restored.previous.environment, 'PROD');
  // Successful retry uses the same chosen file flow; closing/reopening clears selection.
  await page.click('#importButton'); await tab('report').click();
  assert.equal(await action.isDisabled(), true);
  await page.locator('#reportFileInput').setInputFiles(validFile);
  await tab('markup').click(); await tab('report').click();
  assert.equal(await action.isDisabled(), false);
  await page.click('#closeImportButton');
  await page.click('#importButton'); await tab('report').click();
  assert.equal(await action.isDisabled(), true);
  // Source tabs support keyboard navigation.
  await tab('report').focus(); await page.keyboard.press('ArrowLeft');
  assert.equal(await tab('comment').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Home');
  assert.equal(await tab('markup').getAttribute('aria-selected'), 'true');
  // Markup keeps its existing analysis/configuration path.
  await page.fill('#importMarkup', '||Номер||Проверка||Статус||\n|1|Импорт разметки|OK|');
  await action.click(); await page.waitForFunction(() => preparedImport && !importBusy);
  assert.equal(await page.locator('#importConfigurator').isVisible(), true);
  assert.equal(await page.locator('#reportImportPane').isVisible(), false);
  await page.click('#closeImportButton');
  // Jira comment parsing uses an isolated response fixture and the same configurator.
  await page.evaluate(() => {
    window.originalJiraRequest = jiraRequest; window.originalValidateJiraSettings = window.validateJiraSettings;
    if (window.validateJiraSettings) window.validateJiraSettings = () => {};
    jiraRequest = async () => ({ format: 'wiki', body: '||Номер||Проверка||Статус||\n|1|Комментарий Jira|OK|', attachments: [], issueUrl: 'https://jira.example/browse/QA-1' });
    openImport('comment');
  });
  await page.locator('#importWithAttachments').uncheck();
  await page.fill('#commentImportUrl', 'https://jira.example/browse/QA-1?focusedCommentId=123');
  await action.click(); await page.waitForFunction(() => preparedImport && !importBusy);
  assert.match(await page.locator('#importConfigurator').innerText(), /Комментарий Jira/);
  await page.evaluate(() => { jiraRequest = window.originalJiraRequest; if (window.originalValidateJiraSettings) window.validateJiraSettings = window.originalValidateJiraSettings; });
  await page.click('#closeImportButton');
  // Exports remain accessible and use existing implementations.
  await page.click('#copyMenuButton');
  assert.equal(await page.locator('#openReportButton').count(), 0);
  for (const id of ['exportReportButton','copyVisualButton','copyButton','exportXlsxButton']) assert.equal(await page.locator(`#${id}`).isVisible(), true);
  const download = page.waitForEvent('download'); await page.click('#exportXlsxButton');
  assert.match((await download).suggestedFilename(), /\.xlsx$/);
  await page.click('#copyMenuButton');
  const reportDownload = page.waitForEvent('download'); await page.click('#exportReportButton');
  assert.match((await reportDownload).suggestedFilename(), /\.report$/);
  await page.waitForFunction(() => !reportFileBusy);
  await page.click('#closeReportFileButton');
  // Stable geometry with long names/errors, dark/light themes and short/mobile viewports.
  for (const viewport of [{width:1440,height:900},{width:1000,height:420},{width:390,height:844},{width:390,height:420},{width:320,height:568}]) {
    await page.setViewportSize(viewport);
    await page.click('#importButton');
    const baseline = await geometry();
    for (const source of ['markup','comment','report']) {
      await tab(source).click(); assert.deepEqual(await geometry(), baseline);
    }
    await page.locator('#reportFileInput').setInputFiles({...validFile, name: 'длинное-имя-'.repeat(20)+'.report'});
    assert.deepEqual(await geometry(), baseline);
    const [box,,,footer] = await geometry();
    assert(box.y >= 0 && box.y + box.height <= viewport.height);
    assert(footer.y + footer.height <= viewport.height);
    assert.equal(await page.locator('#importModal .modal').evaluate(n => n.scrollWidth <= n.clientWidth), true);
    await screenshot(`report-${viewport.width}x${viewport.height}`);
    await page.click('#closeImportButton');
  }
  await page.setViewportSize({width:1440,height:900});
  let themeGeometry;
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    await page.click('#importButton');
    const baseline = await geometry();
    if (themeGeometry) assert.deepEqual(baseline, themeGeometry);
    themeGeometry = baseline;
    for (const source of ['markup','comment','report']) {
      await tab(source).click(); assert.deepEqual(await geometry(), baseline);
      await screenshot(`compact-${theme}-${source}`);
    }
    await page.locator('#reportFileInput').setInputFiles(validFile);
    assert.deepEqual(await geometry(), baseline);
    await screenshot(`compact-${theme}-selected`);
    const picker = page.waitForEvent('filechooser');
    await page.click('#chooseReportFileButton');
    await (await picker).setFiles({ ...validFile, name: 'replacement.report' });
    assert.equal(await page.locator('#selectedReportFileName').innerText(), 'replacement.report');
    assert.deepEqual(await geometry(), baseline);
    await page.click('#closeImportButton');
  }
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await page.click('#importButton'); await tab('report').click(); await screenshot('report-dark');
  assert.deepEqual(errors, []);
  console.log('PASS: report picker/drop, validation/read errors, explicit open, restoration with attachments/history, busy state, fixed geometry, small viewports, source regressions, export downloads');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  if (child) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
});
