// Text and attachments retain their source order in each supported report format.
const { chromium } = require(process.env.QA_REPORT_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-attachment-order-'));
let server, browser;

function contentOrder(root) {
  const result = [];
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      result.push(...(node.textContent.match(/Текст \d/g) || []));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || node.matches('[data-editor-ui], figcaption')) return;
    if (node.matches('.cell-file, .report-attachment, .file')) {
      result.push(node.dataset.fileName || node.querySelector('[aria-label^="Открыть "]')?.getAttribute('aria-label').slice(8)
        || node.querySelector('.file-name')?.textContent || node.textContent);
      return;
    }
    if (node.matches('img')) { result.push(node.alt); return; }
    for (const child of node.childNodes) walk(child);
  }
  walk(root);
  return result;
}

async function main() {
  const listener = http.createServer().listen(0, '127.0.0.1');
  await new Promise(resolve => listener.once('listening', resolve));
  const origin = `http://127.0.0.1:${listener.address().port}`;
  await new Promise(resolve => listener.close(resolve));
  const secret = crypto.randomBytes(32).toString('hex');
  server = spawn(process.execPath, ['server.js'], { cwd: root, env: {
    ...process.env, HOST: '127.0.0.1', PORT: new URL(origin).port, NODE_ENV: 'development',
    AUTH_SECRET: secret, AUTH_SECRET_FILE: '', DEV_LOGIN_EMAIL: 'qa@example.com',
    DEV_LOGIN_PASSWORD: crypto.randomBytes(24).toString('hex'), REPORTS_DB_PATH: path.join(temp, 'reports.sqlite'),
    QA_REPORT_PUBLIC_URL: origin, QA_STORAGE_ACCESS_KEY: '', QA_STORAGE_SECRET_KEY: '',
    QA_STORAGE_ACCESS_KEY_FILE: '', QA_STORAGE_SECRET_KEY_FILE: '',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', data => { if (data.toString().includes('QA Report:')) resolve(); });
    server.stderr.on('data', data => fs.appendFileSync(path.join(temp, 'server.log'), data));
    server.once('exit', code => reject(Error(`Server exited: ${code}`)));
    setTimeout(() => reject(Error('Server startup timeout')), 10000).unref();
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 1000 } });
  if (fs.existsSync(path.join(root, 'auth.js'))) {
    const { createSessionToken } = require(path.join(root, 'auth'));
    await context.addCookies([{ name: 'query-port-session', value: createSessionToken('qa@example.com', { env: { AUTH_SECRET: secret } }),
      url: origin, httpOnly: true, sameSite: 'Lax' }]);
  }
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.goto(origin);
  await page.waitForSelector('#settingsButton');
  const expected = ['Текст 1', 'shot.png', 'Текст 2', 'log.txt', 'Текст 3', 'shot.png', 'Текст 4'];
  await page.evaluate(() => {
    cloudHistoryEnabled = false;
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA5sAAAAASUVORK5CYII=';
    const html = `<p>Текст 1</p><figure class="cell-image"><img src="${image}" alt="shot.png" data-file-name="shot.png"></figure>`
      + '<p>Текст 2</p><figure class="cell-file" data-file-name="log.txt" data-mime-type="text/plain" data-data-url="data:text/plain;base64,bG9n">log.txt</figure>'
      + `<p>Текст 3</p><a href="https://example.test/image"><img src="${image}" alt="shot.png" data-file-name="shot.png"></a>`
      + '<p>Текст 4 <code>requestId</code> <a href="https://example.test/docs?mode=full#details">Документация</a></p>'
      + '<pre class="cell-code-block" data-language="js"><code>  return true;\n</code></pre>';
    applyDraftLocally({ ...draft, draftId: crypto.randomUUID(), reportId: crypto.randomUUID(), issueUrl: '', intro: html, sections: [{
      id: 'section', title: 'Порядок вложений', columns: [{ id: 'actual', title: 'Фактический результат' }],
      rows: [{ id: 'row', status: 'OK', cells: { actual: html } }],
    }] });
    collectDocumentFields();
  });
  await page.click('#previewButton');
  assert.deepEqual(await page.locator('#previewModal td.report-cell').evaluate(contentOrder), expected);
  await page.keyboard.press('Escape');
  const formats = await page.evaluate(async () => {
    const html = document.createElement('div'); html.innerHTML = generatePortableHtml();
    const packed = await window.QaReportFile.pack(draft);
    const restored = await window.QaReportFile.unpack(packed.blob);
    const cell = document.createElement('div'); cell.innerHTML = restored.document.sections[0].rows[0].cells.actual;
    return { html: html.querySelector('tbody tr td:nth-child(2)').innerHTML, restored: cell.innerHTML, wiki: generateMarkup() };
  });
  for (const html of [formats.html, formats.restored]) {
    const handle = await page.evaluateHandle(html => {
      const cell = document.createElement('div'); cell.innerHTML = html; return cell;
    }, html);
    assert.deepEqual(await handle.evaluate(contentOrder), expected);
    await handle.dispose();
  }
  assert.match(formats.wiki, /Текст 1[\s\S]*!shot\.png[\s\S]*Текст 2[\s\S]*log\.txt[\s\S]*Текст 3[\s\S]*!shot\.png[\s\S]*Текст 4/);

  if (await page.evaluate(() => Boolean(window.QaReportFile.prepareSharedSnapshot))) {
    const prepared = await page.evaluate(async () => {
      const options = { ...sharedSnapshotOptions(draft, { includeImages: true, includeFiles: true }),
        attachmentFingerprint: value => value };
      const before = window.QaReportFile.inspectSharedSnapshot(draft, options);
      const prepared = await window.QaReportFile.prepareSharedSnapshot(draft, options);
      const excluded = await window.QaReportFile.prepareSharedSnapshot(draft, { ...options, includeImages: false });
      const source = structuredClone(draft);
      const cell = document.createElement('div'); cell.innerHTML = source.sections[0].rows[0].cells.actual;
      cell.append(cell.querySelector('figure.cell-image'));
      source.sections[0].rows[0].cells.actual = cell.innerHTML;
      const moved = window.QaReportFile.inspectSharedSnapshot(source, options);
      return { snapshot: prepared.snapshot, files: prepared.files.map(({ bytes, ...file }) => ({ ...file, data: Array.from(bytes) })),
        excluded, changed: JSON.stringify(before) !== JSON.stringify(moved) };
    });
    assert.equal(prepared.files.length, 2, 'Repeated images share stored bytes');
    assert.equal(prepared.changed, true, 'Moving an image changes the publication snapshot');
    const content = prepared.snapshot.sections[0].rows[0].cells.actual;
    const names = new Map(prepared.files.map(file => [file.id, file.name]));
    assert.deepEqual(content.fragments.filter(f => f.type === 'attachment').map(f => names.get(f.id)), ['shot.png', 'log.txt', 'shot.png']);
    assert.equal(content.fragments.find(f => f.type === 'code').text, '  return true;');
    assert.equal(content.fragments.find(f => f.type === 'link').href, 'https://example.test/docs?mode=full#details');
    const excludedCell = prepared.excluded.snapshot.sections[0].rows[0].cells.actual;
    assert.equal(excludedCell.fragments.filter(f => f.type === 'attachment').length, 1);
    assert.match(excludedCell.text, /Текст 1[\s\S]*\[Изображение не включено\][\s\S]*Текст 2/);
    const id = 'a'.repeat(32);
    let legacy = false, pending = true;
    await context.route(`**/api/shared-reports/${id}/files/*`, route => {
      const file = prepared.files.find(file => route.request().url().endsWith('/' + file.id));
      return route.fulfill({ contentType: file.type, body: Buffer.from(file.data) });
    });
    await context.route(`**/api/shared-reports/${id}/attachment-status`, route => {
      pending = false;
      return route.fulfill({ json: { pending: [] } });
    });
    await context.route(`**/api/shared-reports/${id}`, route => {
      const report = structuredClone(prepared.snapshot);
      if (legacy) for (const part of [report.intro, report.sections[0].rows[0].cells.actual]) {
        part.fragments = part.fragments.filter(f => f.type !== 'attachment');
      }
      return route.fulfill({ json: { report: { ...report, canReply: false,
        files: prepared.files.map(({ data, ...file }) => ({ ...file, pending: pending && file.type === 'image/png' })) } } });
    });
    const shared = await context.newPage();
    shared.on('pageerror', error => errors.push(error.message));
    await shared.goto(`${origin}/shared-report/${id}#${'A'.repeat(43)}`);
    await shared.locator('#report').waitFor();
    const publishedCell = shared.locator('td.report-cell').first();
    assert.deepEqual(await publishedCell.evaluate(contentOrder), expected, 'Pending cards keep their positions');
    await shared.waitForFunction(() => !document.querySelector('.file-pending'));
    assert.deepEqual(await publishedCell.evaluate(contentOrder), expected, 'Upload completion keeps both copies in place');
    assert.deepEqual(await shared.locator('#report-overview .intro-content').evaluate(contentOrder), expected);
    await publishedCell.getByRole('button', { name: 'Открыть log.txt', exact: true }).click();
    await shared.waitForFunction(() => document.querySelector('#shared-viewer-text').textContent === 'log');
    assert.equal(await shared.locator('#shared-viewer-text').textContent(), 'log');
    await shared.keyboard.press('Escape');
    if (process.env.QA_REPORT_SCREENSHOTS) {
      fs.mkdirSync(process.env.QA_REPORT_SCREENSHOTS, { recursive: true });
      await shared.screenshot({ path: path.join(process.env.QA_REPORT_SCREENSHOTS, 'attachment-order.png'), fullPage: true });
    }
    legacy = true;
    await shared.reload();
    await shared.locator('#report').waitFor();
    assert.equal(await publishedCell.locator('.files .file').count(), 2, 'Old publications keep all files');
  }
  assert.deepEqual(errors, []);
  console.log('Attachment order passed: preview, HTML, Jira markup, .report and supported shared reports');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close(); server?.kill(); fs.rmSync(temp, { recursive: true, force: true });
});
