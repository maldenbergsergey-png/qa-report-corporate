// Attachment publication uses synthetic Jira replies and an isolated local database.
const { chromium } = require(process.env.QA_REPORT_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-attachment-reuse-'));
let child, browser;
async function main() {
  const listener = http.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${listener.address().port}`;
  await new Promise(resolve => listener.close(resolve));
  const secret = crypto.randomBytes(32).toString('hex');
  child = spawn(process.execPath, ['server.js'], { cwd: root, env: {
    ...process.env, HOST: '127.0.0.1', PORT: new URL(origin).port, NODE_ENV: 'development',
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
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  if (fs.existsSync(path.join(root, 'auth.js'))) {
    const { createSessionToken } = require(path.join(root, 'auth'));
    await context.addCookies([{ name: 'query-port-session', value: createSessionToken('qa@example.com', { env: { AUTH_SECRET: secret } }), url: origin, httpOnly: true, sameSite: 'Lax' }]);
  }
  const externalRequests = [];
  const publication = require(path.join(root, 'jira-publication'));
  const issueUrl = 'https://jira.example/browse/QA-1';
  const inventories = new Map(), comments = new Map(), remoteBytes = new Map();
  let downloads = 0;
  let uploads = 0, commentWrites = 0, downloadFailure = true, manifestFailure = false, wrongManifest = false;
  let manifests = 0;
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { externalRequests.push(url.href); return route.abort(); }
    const action = url.pathname.match(/^\/api\/(?:agent\/)?jira\/(attachment-manifest|attachments|import-attachment|comment|update-comment)$/)?.[1];
    if (!action) return route.continue();
    const body = route.request().postDataJSON();
    const target = publication.target(body.issueUrl || body.commentUrl).issueUrl;
    if (!inventories.has(target)) inventories.set(target, []);
    const inventory = inventories.get(target);
    if (action === 'attachment-manifest') {
      manifests++;
      if (manifestFailure) return route.fulfill({ status: 403, json: { error: 'HTTP 403: synthetic access denial' } });
      return route.fulfill({ json: {
        attachmentReuse: true, issueUrl: wrongManifest ? 'https://jira.example/browse/QA-99' : target, attachments: inventory,
      } });
    }
    if (action === 'import-attachment') {
      if (downloadFailure) return route.fulfill({ status: 403, json: { error: 'HTTP 403: synthetic access denial' } });
      const file = remoteBytes.get(String(body.attachmentId));
      assert.ok(inventory.some(item => item.id === String(body.attachmentId)));
      assert.ok(file); downloads++;
      return url.pathname.includes('/agent/') ? route.fulfill({ json: { file } })
        : route.fulfill({ body: Buffer.from(file.dataBase64, 'base64'), contentType: file.type });
    }
    if (action === 'attachments') {
      const attachments = body.files.map(file => {
        uploads++;
        const remote = { id: String(uploads), filename: file.name, mimeType: file.type, size: Buffer.from(file.dataBase64, 'base64').length,
          content: `https://jira.example/secure/attachment/${uploads}/${encodeURIComponent(file.name)}` };
        remoteBytes.set(remote.id, { type: file.type, dataBase64: file.dataBase64 });
        inventory.push(remote);
        return { ...remote, attachmentId: file.attachmentId };
      });
      return route.fulfill({ json: { attachments } });
    }
    const id = action === 'comment' ? String(comments.size + 1000) : String(body.commentId);
    if (action === 'update-comment') {
      assert.equal(publication.fingerprint(comments.get(id)), body.expectedBodyHash);
      if (body.checkOnly) return route.fulfill({ json: { verified: true, commentId: id } });
    }
    commentWrites++;
    comments.set(id, body.comment.body);
    return route.fulfill({ json: { apiRevision: 9, verified: true, commentId: id,
      bodyHash: publication.fingerprint(body.comment.body), publishedAt: '2026-10-09T10:00:00.000Z' } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.goto(origin);
  await page.waitForSelector('#imageButton');

  const setup = async () => page.evaluate(() => {
    cloudHistoryEnabled = false;
    isJiraReadyToPublish = async () => true;
    window.open = () => null;
    jiraSettings = { transport: 'agent', type: 'data-center', baseUrl: 'https://jira.example' };
    if (typeof validateJiraSettings === 'function') validateJiraSettings = () => {};
  });
  await setup();
  await page.evaluate(issueUrl => {
    const image = '<figure class="cell-image" contenteditable="false"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cCMsAAAAASUVORK5CYII=" data-attachment-id="image-a" data-file-name="shot.png" data-mime-type="image/png"></figure>';
    const file = createFileCardHtml({ id:'file-a', name:'response.json', type:'application/json', size:2, dataUrl:'data:application/json;base64,e30=' });
    applyDraftLocally({ ...draft, issueUrl, jiraPublication:null, environment:'STAGE', overallStatus:'OK',
      title:'Повторное использование вложений', intro:'<p>Проверка</p>' + image, sections:[{
        id:'reuse-section', title:'Проверка', columns:[{id:'check',title:'Проверка',width:300},{id:'comment',title:'Вложения',width:500}],
        rows:[{id:'reuse-row',status:'OK',cells:{check:'<p>Проверить ответ</p>',comment:file + image}}],
      }] });
    collectDocumentFields();
    historyCurrent = serializeDraft(); undoStack = []; redoStack = [];
  }, issueUrl);
  const conversion = await page.evaluate(() => {
    const html = '<p>Текст <strong>жирный</strong> <a href="https://docs.example.test/help">Справка</a></p>'
      + '<a href="https://jira.example/attachment/linked.png"><img data-file-name="linked.png">Подпись</a>'
      + '<span class="jira-image-placeholder" data-jira-name="missing-image.png">missing-image.png</span>'
      + '<span class="jira-file-placeholder" data-jira-name="missing-file.txt">missing-file.txt</span>'
      + '<figure class="cell-file jira-attachment-reference" data-jira-id="42"><span>remote-file.txt</span></figure>'
      + createFileCardHtml({ id: 'sample-file', name: 'sample.json', type: 'application/json', dataUrl: 'data:application/json;base64,e30=' })
      + '<pre class="cell-code-block"><code>const result = 1;</code></pre>';
    const before = serializeDraft();
    const options = { includeAttachments: false, forPublication: true };
    const result = { wiki: jiraCell(html, options), wikiDefault: jiraCell(html),
      markup: generateMarkup(options), portable: generatePortableHtml(options),
      adf: typeof generateAdfDocument === 'function' ? JSON.stringify(generateAdfDocument(options)) : null,
      adfBlocks: typeof htmlToAdfBlocks === 'function' ? JSON.stringify(htmlToAdfBlocks(html, options)) : null };
    result.unchanged = before === serializeDraft();
    return result;
  });
  assert.equal(conversion.unchanged, true);
  assert.match(conversion.wiki, /\*жирный\*.*Справка.*https:\/\/docs.example.test\/help/);
  assert.match(conversion.wiki, /Подпись/);
  assert.match(conversion.wiki, /const result = 1;/);
  assert.match(conversion.wikiDefault, /linked\.png|missing-image\.png|sample\.json/);
  for (const output of [conversion.wiki, conversion.markup, conversion.portable, conversion.adf, conversion.adfBlocks].filter(Boolean)) {
    assert.doesNotMatch(output, /shot\.png|response\.json|linked\.png|missing-image\.png|missing-file\.txt|remote-file\.txt|sample\.json|<img|cell-file|data:|blob:/);
  }
  const publish = async (expectedError = null, includeAttachments = true) => {
    await page.click('#publishButton');
    assert.equal(await page.locator('#publishIncludeAttachments').isChecked(), false, 'Each publication starts without attachments');
    if (includeAttachments) await page.check('#publishIncludeAttachments');
    await page.click('#acceptPublishScopeButton');
    await page.waitForFunction(() => !publishInProgress);
    const message = await page.locator('#publishErrorText').textContent();
    assert.equal(await page.locator('#publishErrorText').isVisible(), Boolean(expectedError), message);
    if (expectedError) assert.match(message, expectedError);
    await page.click('#publishCancelButton');
    if (await page.locator('#jiraSettingsModal').isVisible()) await page.click('#closeJiraSettingsButton');
  };
  const sources = async () => page.evaluate(() => QaReportJiraReuse.collect(draft).map(asset => ({
    attachmentId:asset.attachmentId, id:asset.source.id, issueUrl:asset.source.issueUrl, hash:asset.source.hash,
  })));
  // The final section and confirmation remain reachable in every theme on a narrow screen.
  const screenshots = process.env.QA_REPORT_SCREENSHOTS;
  if (screenshots) fs.mkdirSync(screenshots, { recursive: true });
  for (const width of [1440, 390]) for (const theme of ['light', 'graphite', 'dark']) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; void askPublishScope(); }, theme);
    const option = page.locator('#publishIncludeAttachments');
    await option.scrollIntoViewIfNeeded();
    assert.equal(await option.isChecked(), false);
    const bounds = await option.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y > 0);
    assert.equal(await page.locator('#acceptPublishScopeButton').isVisible(), true);
    if (screenshots) await page.locator('#publishScopeModal .modal').screenshot({ path: path.join(screenshots, `${theme}-${width}.png`) });
    await page.click('#cancelPublishScopeButton');
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Isolate the content-edit history from the preceding layout and screenshot checks.
  await page.evaluate(() => { collectDocumentFields(); historyCurrent = serializeDraft(); undoStack = []; redoStack = []; });
  await page.fill('#environment', 'STAGE2');
  await page.waitForFunction(() => !hasUnsavedLocalChanges && historyCurrent === serializeDraft() && undoStack.length > 0);
  // Plain text publication must not inspect, download or upload attachments.
  const beforeTextOnly = { manifests, uploads, downloads };
  const localBefore = await sources();
  await publish(null, false);
  assert.deepEqual({ manifests, uploads, downloads }, beforeTextOnly);
  assert.deepEqual(await sources(), localBefore, 'Text-only publication leaves local attachments untouched');
  assert.match(comments.get('1000'), /Проверка|Проверить ответ/);
  assert.doesNotMatch(comments.get('1000'), /shot\.png|response\.json|data:|blob:|\[\^|!.*thumbnail/);
  // Cancellation and the next opening reset an explicitly enabled checkbox.
  await page.click('#publishButton'); await page.check('#publishIncludeAttachments');
  await page.click('#cancelPublishScopeButton'); await page.waitForFunction(() => !publishInProgress);
  await publish();
  assert.equal(uploads, 2, 'Shared image and file each upload once');
  assert.match(comments.get('1000'), /shot\.png/);
  const confirmedSources = await sources();
  const beforeTextUpdate = { manifests, uploads, downloads };
  await publish(null, false);
  assert.deepEqual({ manifests, uploads, downloads }, beforeTextUpdate);
  assert.deepEqual(await sources(), confirmedSources, 'Removing attachments from a comment preserves their local bindings');
  assert.doesNotMatch(comments.get('1000'), /shot\.png|response\.json|\[\^|!.*thumbnail/);
  assert.equal(inventories.get(issueUrl).length, 2, 'Text-only updates do not delete Jira files');
  assert.equal((await sources()).every(asset => asset.id && asset.hash), true);
  await publish();
  assert.equal(uploads, 2, 'Updating without edits must not upload attachments');
  await page.click('#undoButton');
  const afterUndo = await sources();
  const undoEnvironment = await page.locator('#environment').inputValue();
  await publish();
  assert.equal(uploads, 2, 'Updating after undo must reuse every unchanged attachment');
  assert.equal(afterUndo.every(asset => asset.id && asset.hash), true, 'Undo must preserve confirmed attachment bindings');
  assert.equal(undoEnvironment, 'STAGE', 'Undo should revert the user edit directly');
  await page.click('#redoButton');
  assert.equal(await page.locator('#environment').inputValue(), 'STAGE2');
  await publish();
  assert.equal(uploads, 2, 'Updating after redo must reuse attachments');
  await page.reload(); await page.waitForSelector('.cell-file'); await setup();
  await publish();
  assert.equal(uploads, 2, 'Reloaded report must keep attachment bindings');
  assert.equal(commentWrites, 7);

  // Changed bytes must get a new binding; old bytes in undo keep their own one.
  const originalSources = await sources();
  await page.evaluate(() => {
    document.querySelector('.cell-file[data-attachment-id="file-a"]').dataset.dataUrl = 'data:application/json;base64,eyJjaGFuZ2VkIjp0cnVlfQ==';
    scheduleSave();
  });
  await page.waitForFunction(() => !hasUnsavedLocalChanges && historyCurrent === serializeDraft());
  await publish();
  assert.equal(uploads, 3, 'Only the changed file uploads');
  const changedSources = await sources();
  assert.notEqual(changedSources.find(asset => asset.attachmentId === 'file-a').id, originalSources.find(asset => asset.attachmentId === 'file-a').id);
  await page.click('#undoButton');
  assert.deepEqual(await sources(), originalSources, 'Undo must not bind different bytes to the new upload');
  await publish(); assert.equal(uploads, 3, 'Original bytes still reuse the original attachment');
  await page.click('#redoButton');
  assert.deepEqual(await sources(), changedSources, 'Redo must know the confirmed upload of changed bytes');
  await publish(); assert.equal(uploads, 3);
  // A deleted remote attachment is restored once, without uploading its neighbours.
  const missingId = changedSources.find(asset => asset.attachmentId === 'file-a').id;
  inventories.set(issueUrl, inventories.get(issueUrl).filter(file => file.id !== missingId));
  await publish(); assert.equal(uploads, 4);
  await publish(); assert.equal(uploads, 4, 'Restored file should be reused on the next update');
  // Moving to another task must leave bindings in old-target snapshots intact.
  const firstTargetSources = await sources();
  await page.fill('#issueUrl', 'https://jira.example/browse/QA-2');
  await page.waitForFunction(() => !hasUnsavedLocalChanges && historyCurrent === serializeDraft());
  await publish(); assert.equal(uploads, 6, 'A different task needs its own attachments');
  assert.equal((await sources()).every(asset => asset.issueUrl.endsWith('/QA-2')), true);
  await page.click('#undoButton');
  assert.equal(await page.locator('#issueUrl').inputValue(), issueUrl);
  assert.deepEqual(await sources(), firstTargetSources, 'Older snapshots keep bindings to their original task');
  await publish(); assert.equal(uploads, 6, 'Returning to the original task must not duplicate attachments');
  // Legacy reports stored only ID/name/URL, without source issue/hash or a separate index.
  await page.evaluate(() => {
    const files = Array.from({ length: 27 }, (_, index) => createFileCardHtml({
      id: `legacy-${index}`, name: `legacy-${index}.json`, type: 'application/json',
      dataUrl: `data:application/json;base64,${btoa(JSON.stringify({ index, result: 'published earlier' }))}`,
    })).join('');
    applyDraftLocally({ ...draft, intro: '', sections: [{
      id: 'reuse-section', title: 'Старый отчёт', columns: [{ id: 'check', title: 'Проверка', width: 700 }],
      rows: [{ id: 'reuse-row', status: 'OK', cells: { check: '<p>Вложения</p>' + files } }],
    }] });
    collectDocumentFields(); historyCurrent = serializeDraft(); undoStack = []; redoStack = [];
  });
  await publish(); assert.equal(uploads, 33);
  // Old publications can use generated names, so names alone cannot recover them.
  inventories.get(issueUrl).find(file => file.filename === 'legacy-0.json').filename = 'old-generated-name.json';
  await page.evaluate(async () => {
    for (const node of document.querySelectorAll('.cell-file[data-attachment-id]')) {
      node.removeAttribute('data-jira-source-issue'); node.removeAttribute('data-jira-source-hash');
    }
    draft.jiraAttachmentLinks = [];
    collectDocumentFields(); historyCurrent = serializeDraft(); undoStack = []; redoStack = [];
    await saveDraft();
  });
  await page.reload(); await page.waitForSelector('.cell-file'); await setup();
  assert.equal((await sources()).length, 27);
  assert.equal((await sources()).every(asset => asset.id && !asset.hash && !asset.issueUrl), true);
  assert.equal(await page.evaluate(() => Boolean(currentJiraPublication())), true);
  const beforeRecovery = downloads; const beforeManifest = manifests;
  await publish();
  assert.equal(uploads, 33, 'All 27 previously published files must be recovered without new uploads');
  assert.equal((await sources()).every(asset => asset.id && asset.hash), true, 'Recovered links must be saved');
  assert.equal(downloads, beforeRecovery, 'Legacy recovery must not download any Jira files');
  assert.equal(manifests - beforeManifest, 1, '27 files need only one metadata request');
  assert.equal(await page.locator('#publishAttachmentSummary').textContent(), 'Используем повторно: 27 · Загрузим: 0');
  // Removing every HTML source attribute still recovers from the small saved index.
  await page.evaluate(async () => {
    for (const node of document.querySelectorAll('.cell-file[data-attachment-id]')) {
      for (const attribute of [...node.attributes]) if (attribute.name.startsWith('data-jira-')) node.removeAttribute(attribute.name);
    }
    collectDocumentFields(); historyCurrent = serializeDraft(); await saveDraft();
  });
  await page.reload(); await page.waitForSelector('.cell-file'); await setup();
  assert.equal((await sources()).every(asset => !asset.id && !asset.hash), true);
  await publish(); assert.equal(uploads, 33); assert.equal(downloads, beforeRecovery);
  assert.equal((await sources()).every(asset => asset.id && asset.hash), true);
  const afterRecovery = downloads;
  await page.reload(); await page.waitForSelector('.cell-file'); await setup();
  await publish(); assert.equal(uploads, 33); assert.equal(downloads, afterRecovery, 'Confirmed bindings need no repeat downloads');
  // Failures must never fall back to uploading every unrecognised file.
  const writesBeforeFailure = commentWrites;
  wrongManifest = true;
  await publish(/другой задачи/);
  wrongManifest = false;
  assert.equal(uploads, 33); assert.equal(commentWrites, writesBeforeFailure);
  manifestFailure = true;
  await publish(/HTTP 403|недостаточно прав/);
  manifestFailure = false;
  assert.equal(uploads, 33); assert.equal(commentWrites, writesBeforeFailure);
  // With neither source attributes nor a saved record, stop instead of scanning files or duplicating one.
  await page.evaluate(() => {
    window.savedAttachmentLinks = draft.jiraAttachmentLinks;
    draft.jiraAttachmentLinks = draft.jiraAttachmentLinks.filter(link => link.attachmentId !== 'legacy-1');
    const node = document.querySelector('.cell-file[data-attachment-id="legacy-1"]');
    for (const attribute of [...node.attributes]) if (attribute.name.startsWith('data-jira-')) node.removeAttribute(attribute.name);
    collectDocumentFields(); historyCurrent = serializeDraft();
  });
  await publish(/Связь.*утрачена/);
  assert.equal(uploads, 33); assert.equal(commentWrites, writesBeforeFailure);
  assert.equal(downloads, beforeRecovery);
  await page.evaluate(() => { draft.jiraAttachmentLinks = window.savedAttachmentLinks; delete window.savedAttachmentLinks; });
  await publish(); assert.equal(uploads, 33); assert.equal(downloads, beforeRecovery);
  assert.deepEqual(externalRequests, []); assert.deepEqual(errors, []);
  console.log('PASS: text-only publication/update, opt-in attachments, checkbox reset, wiki/ADF/HTML conversion, themes/mobile, undo/redo/reload and attachment reuse without duplicate uploads.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (child) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
  fs.rmSync(temp, { recursive: true, force: true });
});
