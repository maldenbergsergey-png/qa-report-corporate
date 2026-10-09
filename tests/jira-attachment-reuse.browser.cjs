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
  const inventories = new Map(), comments = new Map();
  let uploads = 0, commentWrites = 0;
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { externalRequests.push(url.href); return route.abort(); }
    const action = url.pathname.match(/^\/api\/(?:agent\/)?jira\/(attachment-manifest|attachments|comment|update-comment)$/)?.[1];
    if (!action) return route.continue();
    const body = route.request().postDataJSON();
    const target = publication.target(body.issueUrl).issueUrl;
    if (!inventories.has(target)) inventories.set(target, []);
    const inventory = inventories.get(target);
    if (action === 'attachment-manifest') return route.fulfill({ json: {
      attachmentReuse: true, issueUrl: target, attachments: inventory,
    } });
    if (action === 'attachments') {
      const attachments = body.files.map(file => {
        uploads++;
        const remote = { id: String(uploads), filename: file.name, mimeType: file.type,
          content: `https://jira.example/secure/attachment/${uploads}/${encodeURIComponent(file.name)}` };
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
  await page.fill('#environment', 'STAGE2');
  await page.waitForFunction(() => !hasUnsavedLocalChanges && historyCurrent === serializeDraft() && undoStack.length > 0);
  const publish = async () => {
    await page.click('#publishButton'); await page.click('#acceptPublishScopeButton');
    await page.waitForFunction(() => !publishInProgress);
    assert.equal(await page.locator('#publishErrorText').isVisible(), false, await page.locator('#publishErrorText').textContent());
    await page.click('#publishCancelButton');
  };
  const sources = async () => page.evaluate(() => QaReportJiraReuse.collect(draft).map(asset => ({
    attachmentId:asset.attachmentId, id:asset.source.id, issueUrl:asset.source.issueUrl, hash:asset.source.hash,
  })));
  await publish();
  assert.equal(uploads, 2, 'Shared image and file each upload once');
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
  assert.equal(commentWrites, 5);

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
  assert.deepEqual(externalRequests, []); assert.deepEqual(errors, []);
  console.log('PASS: publish/update, shared occurrences, undo/redo/reload, changed bytes, deleted attachments and task changes keep correct bindings without duplicate uploads.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (child) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
  fs.rmSync(temp, { recursive: true, force: true });
});
