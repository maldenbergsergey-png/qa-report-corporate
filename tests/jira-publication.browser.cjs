// Synthetic publication workflow; all external traffic is blocked.
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
const api = require(path.join(root, 'jira-publication'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-jira-publication-'));
let child, browser;
(async () => {
  const listener = http.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`, secret = crypto.randomBytes(32).toString('hex');
  child = spawn(process.execPath, ['server.js'], { cwd: root, env: {
    ...process.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'development', AUTH_SECRET: secret, AUTH_SECRET_FILE: '',
    DEV_LOGIN_EMAIL: 'qa@example.com', DEV_LOGIN_PASSWORD: crypto.randomBytes(24).toString('hex'),
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  if (corporate) {
    const { createSessionToken } = require(path.join(root, 'auth'));
    await context.addCookies([{ name: 'query-port-session', value: createSessionToken('qa@example.com', { env: { AUTH_SECRET: secret } }), url: origin, httpOnly: true, sameSite: 'Lax' }]);
  }
  let creates = 0, updates = 0, preflights = 0, failureStatus = 0;
  const comments = new Map();
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (/\/api\/(?:agent\/)?jira\/(?:update-comment|comment)$/.test(url.pathname)) {
      const body = route.request().postDataJSON();
      let id, publishedAt;
      if (url.pathname.endsWith('/update-comment')) {
        id = String(body.commentId);
        if (failureStatus || !comments.has(id)) return route.fulfill({ status: failureStatus || 404, json: { error: failureStatus ? 'Synthetic Jira failure' : 'Связанный комментарий удалён или недоступен. Можно опубликовать отчёт заново.' } });
        assert.equal(api.fingerprint(comments.get(id)), body.expectedBodyHash);
        if (body.checkOnly) { preflights++; return route.fulfill({ json: { ok: true, verified: true, commentId: id } }); }
        updates++; publishedAt = '2026-10-08T10:00:00.000Z';
      } else { creates++; id = String(10000 + creates); publishedAt = `2026-10-08T09:0${creates}:00.000Z`; }
      comments.set(id, body.comment.body);
      return route.fulfill({ status: url.pathname.endsWith('/update-comment') ? 200 : 201, json: {
        apiRevision: 9, verified: true, commentId: id, bodyHash: api.fingerprint(body.comment.body), publishedAt,
        commentUrl: api.commentUrl(body.issueUrl, id),
      } });
    }
    return route.continue();
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.goto(origin); await page.waitForSelector('.cell-editor');
  async function prepare() {
    await page.evaluate(() => {
      cloudHistoryEnabled = false;
      isJiraReadyToPublish = async () => true;
      uploadPendingImages = async () => {};
      window.open = () => null;
      if (typeof jiraSettings !== 'undefined') jiraSettings = { transport: 'agent', baseUrl: 'https://jira.example', type: 'data-center' };
      if (typeof validateJiraSettings === 'function') validateJiraSettings = () => {};
    });
  }
  await prepare();
  const conversion = await page.evaluate(() => {
    const html = '<p>GET /items/{id} {color:red}literal{color} unmatched { }</p>'
      + '<p><span style="color:#0052cc">Color {value}</span></p>'
      + '<ul><li><a href="https://example.test/?value={original}">Label {name}</a></li></ul>'
      + '<pre class="cell-code-block"><code>{"id": {"value": 1}}</code></pre>'
      + '<p><code>const item = { id: 1 };</code></p>'
      + '<span class="jira-file-placeholder" data-jira-name="log{original}.json">file</span>'
      + '<img data-jira-name="shot{original}.png">';
    const wiki = jiraCell(html, {forPublication: true});
    const imported = parseJiraMarkup('h2. 1. Endpoint \\[id\\]\n||Text \\[value\\]||Status||\n|' + wiki + '|OK|').sections[0];
    const importedHtml = document.createElement('div');
    importedHtml.innerHTML = Object.values(imported.rows[0].cells)[0];
    return { wiki, original: jiraCell(html), imported, importedCode: importedHtml.querySelector('pre').textContent,
      adf: typeof htmlToAdfBlocks === 'function' ? htmlToAdfBlocks(html, {forPublication: true}) : null };
  });
  for (const literal of [String.raw`/items/\[id\]`,
    String.raw`\[color:red\]literal\[color\]`, String.raw`unmatched \[ \]`,
    String.raw`{color:#0052cc}Color \[value\]{color}`,
    String.raw`[Label \[name\]|https://example.test/?value={original}]`,
    '{code}\n{"id": {"value": 1}}\n{code}', '{{const item = { id: 1 };}}',
    '[^log{original}.json]', '!shot{original}.png|thumbnail!']) {
    assert.ok(conversion.wiki.includes(literal), literal);
  }
  assert.ok(conversion.original.includes('/items/{id}'), 'Ordinary export keeps source braces');
  assert.equal(conversion.imported.title, 'Endpoint [id]');
  assert.equal(conversion.imported.columns[0].title, 'Text [value]');
  assert.equal(conversion.imported.rows.length, 1);
  assert.equal(conversion.imported.columns.length, 1);
  const importedCell = Object.values(conversion.imported.rows[0].cells)[0];
  assert.ok(importedCell.includes('/items/[id]'));
  assert.equal(conversion.importedCode, '{"id": {"value": 1}}');
  if (conversion.adf) {
    const text = JSON.stringify(conversion.adf);
    assert.ok(text.includes('/items/[id]'));
    assert.ok(text.includes('const item = { id: 1 };'));
    assert.equal(conversion.adf.find(node => node.type === 'codeBlock').content[0].text, '{"id": {"value": 1}}');
    assert.ok(!text.includes(String.raw`\[id\]`), 'ADF contains no wiki escapes');
  }
  await page.fill('#issueUrl', 'https://jira.example/browse/QA-1');
  await page.fill('#environment', 'STAGE {zone}'); await page.selectOption('#overallStatus', 'НЕ ОК');
  await page.locator('.cell-editor').first().fill('GET /api/items/{id}');
  await page.evaluate(() => {
    document.querySelector('.section-title').value = 'Endpoints {group}';
    document.querySelector('th[data-column-id] input').value = 'Check {column}';
    elements.introEditor.innerHTML = '<p>Description {context}</p><pre class="cell-code-block"><code>{"id": 1}</code></pre>';
    collectDocumentFields();
  });
  const publicationSource = await page.evaluate(() => JSON.stringify(draftContentSnapshot()));
  const preparedWiki = await page.evaluate(() => generateMarkup({forPublication: true}));
  for (const literal of [String.raw`STAGE \[zone\]`, String.raw`Endpoints \[group\]`,
    String.raw`Check \[column\]`, String.raw`Description \[context\]`, String.raw`/api/items/\[id\]`,
    '{code}\n{"id": 1}\n{code}']) assert.ok(preparedWiki.includes(literal), literal);
  assert.equal(await page.evaluate(() => JSON.stringify(draftContentSnapshot())), publicationSource, 'Preparing a comment keeps the draft');
  if (!corporate) {
    const adf = await page.evaluate(() => JSON.stringify(generateAdfDocument({forPublication: true})));
    for (const literal of ['STAGE [zone]', 'Endpoints [group]', 'Check [column]', 'Description [context]', '/api/items/[id]']) assert.ok(adf.includes(literal), literal);
    assert.equal(await page.evaluate(() => JSON.stringify(draftContentSnapshot())), publicationSource);
  }
  await page.click('#publishButton'); await page.click('#acceptPublishScopeButton');
  await page.waitForFunction(() => !publishInProgress);
  assert.equal(creates, 1); assert.equal(await page.locator('#publishButton').innerText(), 'Обновить отчёт');
  assert.equal(comments.get('10001'), preparedWiki, 'Jira receives the converted comment');
  assert.equal(await page.locator('.cell-editor').first().innerText(), 'GET /api/items/{id}');
  const first = await page.evaluate(() => structuredClone(draft.jiraPublication));
  assert.equal(first.firstPublishedAt, '2026-10-08T09:01:00.000Z');
  assert.match(await page.locator('#publicationInfo').innerText(), /Опубликован/);
  await page.click('#publishCancelButton');
  await page.locator('.cell-editor').first().fill('PATCH /api/items/{itemId}');
  await page.click('#copyMenuButton'); await page.click('#publishExportButton'); await page.click('#acceptPublishScopeButton');
  await page.waitForFunction(() => !publishInProgress);
  assert.equal(creates, 1); assert.equal(updates, 1); assert.equal(preflights, 1);
  assert.ok(comments.get('10001').includes(String.raw`/api/items/\[itemId\]`), 'Updates also convert the text');
  assert.equal(await page.locator('.cell-editor').first().innerText(), 'PATCH /api/items/{itemId}');
  assert.equal(await page.evaluate(() => draft.jiraPublication.firstPublishedAt), first.firstPublishedAt);
  assert.equal(await page.evaluate(() => draft.jiraPublication.lastPublishedAt), '2026-10-08T10:00:00.000Z');
  await page.click('#publishCancelButton');
  await page.reload(); await page.waitForSelector('.cell-editor'); await prepare();
  assert.equal(await page.locator('#publishButton').innerText(), 'Обновить отчёт');
  await page.evaluate(() => openHistory());
  assert.equal(await page.locator('.history-publication-info a').first().getAttribute('href'), 'https://jira.example/browse/QA-1?focusedCommentId=10001#comment-10001');
  assert.match(await page.locator('.history-publication-info').first().innerText(), /Опубликован[\s\S]*Обновлён/);
  await page.evaluate(() => closeHistory());
  await page.click('#publicationMenuButton'); await page.click('#publishAgainButton');
  assert.equal(await page.locator('#confirmModal').isVisible(), true);
  await page.click('#acceptConfirmButton'); await page.click('#acceptPublishScopeButton');
  await page.waitForFunction(() => !publishInProgress);
  assert.equal(creates, 2); assert.equal(comments.size, 2); assert.equal(await page.evaluate(() => draft.jiraPublication.parts[0].commentId), '10002');
  await page.click('#publishCancelButton');
  await page.fill('#issueUrl', 'https://jira.example/browse/QA-2');
  assert.equal(await page.locator('#publishButton').innerText(), 'Опубликовать отчёт');
  await page.fill('#issueUrl', 'https://jira.example/browse/QA-1');
  assert.equal(await page.locator('#publishButton').innerText(), 'Обновить отчёт');
  // Verify the real server round trip and the lighter history-list response.
  const persisted = await page.evaluate(async () => {
    const document = structuredClone(draft), id = crypto.randomUUID();
    document.reportId = id; document.publicId = createPublicId();
    document.jiraPublication.reportId = id; document.jiraPublication.token = "should-not-persist";
    document.jiraPublication.includeImages = false; document.jiraPublication.includeFiles = true;
    await reportApi("/api/reports", { method: "POST", body: JSON.stringify({ id, document }) });
    const { reports } = await reportApi("/api/reports");
    const { report } = await reportApi("/api/reports/" + id);
    const list = reports.find(record => record.id === id);
    await reportApi("/api/reports/" + id, { method: "DELETE" });
    return { list: list.jiraPublication, document: report.document.jiraPublication };
  });
  assert.equal(persisted.list.parts[0].commentId, '10002');
  assert.equal(persisted.list.includeImages, false);
  assert.equal(persisted.list.includeFiles, true);
  assert.deepEqual(persisted.document, persisted.list);
  assert.equal(JSON.stringify(persisted).includes('should-not-persist'), false);
  const screenshots = process.env.QA_REPORT_SCREENSHOTS;
  if (screenshots) fs.mkdirSync(screenshots, { recursive: true });
  for (const width of [1440, 390]) for (const theme of ['light', 'dark', 'graphite']) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    const bounds = await page.locator('.report-heading').evaluate(node => [...node.querySelectorAll('button, a, time')].map(child => ({ left: child.getBoundingClientRect().left, right: child.getBoundingClientRect().right })));
    assert.ok(bounds.every(rect => rect.left >= 0 && rect.right <= width), `${theme}/${width}: heading overflow`);
    if (screenshots) await page.locator('.report-heading').screenshot({ animations: 'disabled', path: path.join(screenshots, `${corporate ? 'corporate' : 'public'}-${theme}-${width}.png`) });
    await page.click('#publicationMenuButton');
    assert.equal(await page.locator('#publishAgainButton').isVisible(), true);
    const placement = await page.locator('.report-publication-buttons').evaluate(node => {
      const trigger = node.querySelector('#publicationMenuButton').getBoundingClientRect(), menu = node.querySelector('#publicationMenu').getBoundingClientRect();
      const main = getComputedStyle(node.querySelector('#publishButton')), arrow = getComputedStyle(node.querySelector('#publicationMenuButton'));
      return { triggerBottom: trigger.bottom, menuTop: menu.top, menuLeft: menu.left, menuRight: menu.right, mainColor: main.color, arrowColor: arrow.color,
        menuReceivesPointer: !!document.elementFromPoint(menu.left + menu.width / 2, menu.top + menu.height / 2)?.closest('#publicationMenu') };
    });
    assert.ok(placement.menuTop >= placement.triggerBottom && placement.menuLeft >= 0 && placement.menuRight <= width);
    assert.equal(placement.mainColor, placement.arrowColor);
    assert.equal(placement.menuReceivesPointer, true, `${theme}/${width}: publication menu is covered`);

    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#publicationMenu').isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'publicationMenuButton');
  }
  // Simulate an available PWA update without activating a service worker.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'graphite';
    const spacer = document.createElement('div');
    spacer.id = 'publicationScrollFixture'; spacer.style.height = '1000px';
    spacer.setAttribute('aria-hidden', 'true'); document.body.append(spacer);
    document.querySelector('#updateAppContainer').hidden = false;
    window.scrollTo(0, 0);
  });
  const popoverHit = await page.evaluate(() => {
    const button = document.querySelector('#publishButton').getBoundingClientRect();
    const hint = document.querySelector('#updateAppHint');
    // Align the real popover over the action to cover overlap at any layout width.
    // No stacking styles are changed by the fixture.
    Object.assign(hint.style, { position: 'fixed', left: `${button.left}px`, right: 'auto', top: `${button.top - 24}px` });
    document.querySelector('#updateAppButton').focus({ preventScroll: true });
    return !!document.elementFromPoint(button.left + button.width / 2, button.top + button.height / 2)?.closest('#updateAppHint');
  });
  assert.equal(popoverHit, true, 'Publication action must stay behind the update popover');
  if (screenshots) await page.screenshot({ animations: 'disabled', path: path.join(screenshots, `${corporate ? 'corporate' : 'public'}-update-popover.png`) });
  await page.evaluate(() => {
    document.activeElement.blur();
    document.querySelector('#updateAppHint').removeAttribute('style');
    document.querySelector('#updateAppContainer').hidden = true;
    const button = document.querySelector('#publishButton').getBoundingClientRect();
    const topbar = document.querySelector('.topbar').getBoundingClientRect();
    window.scrollTo(0, window.scrollY + button.top + button.height / 2 - topbar.height / 2);
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const scrolled = await page.evaluate(() => {
    const button = document.querySelector('#publishButton').getBoundingClientRect();
    const topbar = document.querySelector('.topbar').getBoundingClientRect();
    const hit = document.elementFromPoint(button.left + button.width / 2, button.top + button.height / 2);
    return { overlaps: button.top < topbar.bottom && button.bottom > topbar.top, topbarReceivesPointer: !!hit?.closest('.topbar') };
  });
  assert.equal(scrolled.overlaps, true, 'Scroll fixture must overlap publication action and sticky header');
  assert.equal(scrolled.topbarReceivesPointer, true, 'Publication action must stay behind the sticky header');
  if (screenshots) await page.screenshot({ animations: 'disabled', path: path.join(screenshots, `${corporate ? 'corporate' : 'public'}-scrolled-header.png`) });
  await page.evaluate(() => { document.querySelector('#publicationScrollFixture').remove(); window.scrollTo(0, 0); });
  // The current binding survives access and temporary failures.
  const beforeMissing = await page.evaluate(async () => {
    cloudHistoryEnabled = true;
    await saveDraft({ collect: false });
    await Promise.all([...(pendingHistoryServerSaves.get(draft.reportId) || [])]);
    return { link: structuredClone(draft.jiraPublication), record: await getReportRecord(draft.reportId) };
  });
  for (const status of [403, 502]) {
    failureStatus = status;
    await page.click('#publishButton'); await page.click('#acceptPublishScopeButton');
    await page.waitForFunction(() => !publishInProgress);
    assert.deepEqual(await page.evaluate(() => draft.jiraPublication), beforeMissing.link);
    assert.equal(await page.locator('#publishButton').innerText(), 'Обновить отчёт');
    await page.click('#publishCancelButton');
    await page.evaluate(() => closeJiraSettings());
  }
  failureStatus = 0;
  await page.locator('.cell-editor').first().fill('Правка перед удалением комментария');
  await page.waitForFunction(() => undoStack.length > 0 && historyCurrent === serializeDraft());
  const oldCreates = creates, oldUpdates = updates;
  comments.delete(beforeMissing.link.parts[0].commentId);
  const detectedAfter = Date.now();
  await page.click('#publishButton'); await page.click('#acceptPublishScopeButton');
  await page.waitForFunction(() => !publishInProgress);
  assert.equal(await page.evaluate(() => draft.jiraPublication), null);
  assert.equal(await page.locator('#publishButton').innerText(), 'Опубликовать отчёт');
  assert.equal(await page.locator('#publishExportButton').innerText(), 'Опубликовать отчёт');
  assert.equal(await page.locator('#publicationInfo').isVisible(), false);
  assert.match(await page.locator('#publishErrorText').innerText(), /Связь и даты публикации удалены/);
  assert.equal(creates, oldCreates); assert.equal(updates, oldUpdates);
  await page.click('#publishCancelButton');
  const missingRecord = await page.evaluate(() => getReportRecord(draft.reportId));
  assert.equal(missingRecord.document.jiraPublication, null);
  assert.equal(missingRecord.createdAt, beforeMissing.record.createdAt);
  assert.ok(Date.parse(missingRecord.updatedAt) >= detectedAfter);
  await page.waitForFunction(async () => (await reportApi('/api/reports/' + draft.reportId)).report.document.jiraPublication === null);
  const serverMissing = await page.evaluate(async () => (await reportApi('/api/reports')).reports.find(r => r.id === draft.reportId));
  assert.equal(serverMissing.jiraPublication, null);
  await page.evaluate(() => openHistory());
  assert.equal(await page.locator('.history-publication-info').count(), 0);
  await page.evaluate(() => closeHistory());
  await page.evaluate(() => undo());
  assert.equal(await page.evaluate(() => draft.jiraPublication), null);
  await page.evaluate(() => redo());
  assert.equal(await page.evaluate(() => draft.jiraPublication), null);
  await page.reload(); await page.waitForSelector('.cell-editor'); await prepare();
  assert.equal(await page.locator('#publishButton').innerText(), 'Опубликовать отчёт');
  assert.equal(await page.locator('#publicationInfo').isVisible(), false);
  // Publishing again is an explicit click and starts fresh publication dates.
  await page.click('#publishButton'); await page.click('#acceptPublishScopeButton');
  await page.waitForFunction(() => !publishInProgress);
  const replacement = await page.evaluate(() => structuredClone(draft.jiraPublication));
  assert.equal(creates, oldCreates + 1);
  assert.notEqual(replacement.parts[0].commentId, beforeMissing.link.parts[0].commentId);
  assert.equal(replacement.firstPublishedAt, replacement.lastPublishedAt);
  assert.notEqual(replacement.firstPublishedAt, beforeMissing.link.firstPublishedAt);
  assert.doesNotMatch(await page.locator('#publicationInfo').innerText(), /Обновлён/);
  assert.equal(await page.evaluate(previous => writeJiraPublication(previous, null, previous), beforeMissing.link), false);
  assert.equal(await page.evaluate(() => draft.jiraPublication.parts[0].commentId), replacement.parts[0].commentId);
  await page.click('#publishCancelButton');
  await page.evaluate(() => openHistory());
  await page.getByRole('button', { name: 'Копия', exact: true }).first().click();
  await page.waitForFunction(() => draft.jiraPublication === null);
  assert.equal(await page.locator('#publishButton').innerText(), 'Опубликовать отчёт');
  assert.deepEqual(errors, []);
  console.log(`${corporate ? 'Corporate' : 'Public'} publication UI: create, update, new comment, persistence, history, copy, responsive layout, missing-comment reset and explicit replacement OK`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close(); child?.kill();
  if (child) await new Promise(resolve => child.once('exit', resolve));
  fs.rmSync(temp, { recursive: true, force: true });
});
