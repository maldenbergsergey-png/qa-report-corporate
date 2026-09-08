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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-markup-references-'));
const output = process.env.QA_REPORT_SCREENSHOTS;
const markup = [
  'Материалы: [^report notes.pdf]',
  'h2. Авторизация',
  '||Проверка||Ожидаемый результат||Фактический результат||Комментарий||Статус||',
  '|Вход|Ожидание|!screenshot-4.png|thumbnail!|Комментарий|OK|',
  '|Повторный вход|Два: !Screenshot 2.png|thumbnail,width=320! !full-size.png!|[^log.txt]|alpha\\|beta [Документация|https://docs.example/path]|НЕ ОК|',
].join('\n');
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
  const errors = [], downloads = [], uploads = [], comments = [];
  page.on('pageerror', error => errors.push(error.message));
  // Never contact a real Jira or external attachment service.
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === origin ? route.continue() : route.abort();
  });
  await page.route('**/api/jira/import-attachment', route => { downloads.push(1); return route.fulfill({ status: 404, json: { error: 'Fixture: unavailable' } }); });
  await page.route('**/api/jira/attachments', route => { uploads.push(1); return route.fulfill({ status: 400, json: { error: 'Unexpected upload of a markup reference' } }); });
  await page.route('**/api/jira/attachment-manifest', route => route.fulfill({ json: { ok: true, attachmentReuse: true, issueUrl: 'https://jira.example/browse/QA-1', attachments: [] } }));
  await page.route('**/api/jira/comment', route => {
    comments.push(route.request().postDataJSON().comment.body);
    return route.fulfill({ json: { ok: true, verified: true, apiRevision: 8, commentId: '1' } });
  });
  const configure = () => page.evaluate(() => {
    document.documentElement.dataset.theme = 'graphite';
    if (typeof jiraSettings !== 'undefined') {
      jiraSettings = { ...jiraSettings, transport: 'server', baseUrl: 'https://jira.example', type: 'data-center', authMethod: 'pat' };
      jiraSecret = 'fixture-token';
    }
  });
  await page.goto(origin); await page.waitForSelector('#jiraMenuButton'); await configure();
  const roundTrip = async () => {
    const result = await page.evaluate(() => {
      const wiki = generateMarkup();
      return { wiki, parsed: parseJiraMarkup(wiki), assets: QaReportJiraReuse.collect(draft).length };
    });
    for (const reference of ['[^report notes.pdf]', '!screenshot-4.png|thumbnail!|', '!Screenshot 2.png|thumbnail,width=320!', '!full-size.png!', '[^log.txt]']) {
      assert.ok(result.wiki.includes(reference), `Missing reference: ${reference}\n${result.wiki}`);
    }
    assert.doesNotMatch(result.wiki, /не удалось загрузить|без вложения|JIRA|@@JIRA/);
    assert.equal(result.assets, 0, 'Markup references are not binary uploads');
    const [section] = result.parsed.sections;
    assert.equal(result.parsed.sections.length, 1); assert.equal(section.rows.length, 2);
    assert.deepEqual(section.columns.map(column => column.title), ['Проверка', 'Ожидаемый результат', 'Фактический результат', 'Комментарий']);
    assert.deepEqual(section.rows.map(row => row.status), ['OK', 'НЕ ОК']);
    assert.equal(section.rows[0].cells[section.columns[3].id], 'Комментарий');
    assert.match(section.rows[1].cells[section.columns[3].id], /^alpha\|beta /);
    assert.match(section.rows[1].cells[section.columns[3].id], /href="https:\/\/docs.example\/path"/);
    return result.wiki;
  };
  await page.click('#jiraMenuButton'); await page.click('#importButton');
  assert.equal(await page.locator('#importWithAttachments').isVisible(), false);
  await page.fill('#importMarkup', markup); await page.click('#applyImportButton');
  await page.waitForFunction(() => !document.querySelector('#importAttachmentChoices').hidden && !document.querySelector('#applyImportButton').disabled);
  assert.equal(await page.locator('#importTitle').textContent(), 'Чек-лист готов к импорту');
  assert.equal(await page.locator('#importSelectionCount').textContent(), 'Ссылок на вложения: 5');
  assert.equal(await page.locator('#importColumnList input').count(), 0);
  assert.doesNotMatch(await page.locator('#importColumnList').textContent(), /Недоступно/);
  await page.locator('.import-files-toggle').nth(1).click();
  assert.ok(await page.locator('.import-file-list:not([hidden]) li').count());
  if (output) {
    fs.mkdirSync(output, { recursive: true });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#toast')).opacity === '0');
    for (const theme of ['graphite', 'light']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.locator('#importModal .modal').screenshot({ path: path.join(output, `preview-${theme}.png`) });
    }
    await configure(); await page.setViewportSize({ width: 390, height: 844 });
    const box = await page.locator('#importModal .modal').boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 390);
    await page.locator('#importModal .modal').screenshot({ path: path.join(output, 'preview-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await page.click('#applyImportButton');
  await page.waitForFunction(() => document.querySelector('#importModal').hidden);
  await roundTrip();
  assert.equal(await page.locator('.jira-image-placeholder, .jira-file-placeholder').count(), 5);
  await page.locator('.cell-editor').first().fill('Вход — проверено');
  await page.fill('#issueUrl', 'https://jira.example/browse/QA-1');
  await page.evaluate(() => saveDraft());
  await page.reload(); await page.waitForSelector('.jira-image-placeholder'); await configure();
  const wiki = await roundTrip(); assert.match(wiki, /Вход — проверено/);
  assert.equal(await page.locator('.jira-image-placeholder[data-jira-name="Screenshot 2.png"]').getAttribute('data-jira-options'), 'thumbnail,width=320');
  if (output) await page.locator('.check-table').first().screenshot({ path: path.join(output, 'cells.png') });
  // Actual publication pipeline, with the outgoing Jira call captured locally.
  await page.click('#jiraMenuButton'); await page.click('#publishButton'); await page.click('#acceptPublishScopeButton');
  await page.waitForFunction(() => !publishInProgress);
  assert.equal(await page.locator('#publishErrorText').isVisible(), false, await page.locator('#publishErrorText').textContent());
  assert.equal(comments.length, 1); assert.equal(comments[0], wiki);
  assert.equal(downloads.length, 0); assert.equal(uploads.length, 0);
  // Missing metadata and download failures preserve source syntax too.
  const failed = await page.evaluate(async markup => {
    let calls = 0;
    const source = parseJiraMarkup(markup);
    const result = await QaReportAttachments.localize(source, { include: true, load: () => { calls++; throw Error('Should not download an unknown file'); } });
    const html = result.document.intro + result.document.sections.flatMap(section => section.rows.flatMap(row => Object.values(row.cells))).join('');
    return { errors: result.errors.length, calls, wiki: htmlToWiki(html) };
  }, markup);
  assert.equal(failed.errors, 5); assert.equal(failed.calls, 0);
  assert.match(failed.wiki, /!screenshot-4.png\|thumbnail!/); assert.match(failed.wiki, /\[\^log.txt\]/);
  assert.doesNotMatch(failed.wiki, /не удалось загрузить|без вложения/);
  const unavailable = await page.evaluate(async markup => {
    const attachment = { id: '4', filename: 'screenshot-4.png', mimeType: 'image/png', content: 'https://jira.example/secure/attachment/4/screenshot-4.png' };
    const source = parseJiraMarkup(markup, [attachment]);
    let calls = 0;
    const result = await QaReportAttachments.localize(source, {
      attachments: [attachment], sourceIssueUrl: 'https://jira.example/browse/QA-1',
      load: async () => { calls++; throw Error('Fixture: download failed'); },
    });
    const cell = result.document.sections[0].rows[0].cells[result.document.sections[0].columns[2].id];
    const skipped = await QaReportAttachments.localize(parseJiraMarkup(markup), {
      include: false, load: async () => { calls++; throw Error('Unexpected download'); },
    });
    return { calls, errors: result.errors, cellWiki: htmlToWiki(cell), skippedErrors: skipped.errors, skippedIntro: htmlToWiki(skipped.document.intro) };
  }, markup);
  assert.equal(unavailable.calls, 1);
  assert.ok(unavailable.errors.some(error => error.includes('download failed')));
  assert.equal(unavailable.cellWiki, '!screenshot-4.png|thumbnail!');
  assert.deepEqual(unavailable.skippedErrors, []);
  assert.match(unavailable.skippedIntro, /\[\^report notes.pdf\]/);
  assert.deepEqual(errors, []);
  console.log('PASS: raw markup preview, import, editing, persistence, image options, table boundaries, file references and publication without downloads/uploads.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (child) { const closed = new Promise(resolve => child.once('exit', resolve)); child.kill(); if (child.exitCode === null) await closed; }
  fs.rmSync(temp, { recursive: true, force: true });
});
