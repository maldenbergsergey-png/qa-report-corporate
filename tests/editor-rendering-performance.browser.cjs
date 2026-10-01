// Rendering isolation experiment: synthetic data, autosave disabled, 4x CPU throttle.
// Removing most DOM rows here demonstrates virtualization; it is not a production implementation.
// Uses an isolated database and synthetic attachments.
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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-rendering-'));
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
  page.setDefaultTimeout(45000);
  await page.goto(origin);
  await page.waitForSelector('#settingsButton');


  const instrument = () => page.evaluate(() => {
    const stack = [];
    window.perfMetrics = {};
    for (const name of ['updateCellFromEditor', 'cleanEditorHtml', 'hasRowContent', 'htmlToText',
      'collectDocumentFields', 'collectSectionsFromDom', 'serializeDraft', 'clone', 'normalizeDraft',
      'normalizeSections', 'persistLocalDraft', 'saveReportSnapshot', 'saveDraft', 'renderSummary',
      'objectAtEditorCaret', 'setSaveStatus']) {
      const original = window[name];
      if (!original) continue;
      window[name] = function (...args) {
        const frame = { children: 0 }, start = performance.now(); stack.push(frame);
        try { return original.apply(this, args); }
        finally {
          const elapsed = performance.now() - start; stack.pop();
          if (stack.length) stack.at(-1).children += elapsed;
          const record = window.perfMetrics[name] ||= { calls: 0, totalMs: 0, selfMs: 0, maxMs: 0 };
          record.calls++; record.totalMs += elapsed; record.selfMs += elapsed - frame.children;
          record.maxMs = Math.max(record.maxMs, elapsed);
        }
      };
    }
    window.longTasks = []; window.inputEvents = [];
    new PerformanceObserver(list => window.longTasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration })))).observe({ type: 'longtask', buffered: false });
    new PerformanceObserver(list => window.inputEvents.push(...list.getEntries().filter(e => e.name === 'keydown').map(e => ({ duration: e.duration,
      inputDelay: e.processingStart - e.startTime, processing: e.processingEnd - e.processingStart })))).observe({ type: 'event', durationThreshold: 16 });
  });
  await page.evaluate(async () => {
    cloudHistoryEnabled = false;
    const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
    const ctx = canvas.getContext('2d'), pixels = ctx.createImageData(1280, 720);
    let seed = 937;
    for (let i = 0; i < pixels.data.length; i += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      pixels.data[i] = seed & 255; pixels.data[i + 1] = seed >>> 8 & 255; pixels.data[i + 2] = seed >>> 16 & 255; pixels.data[i + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
    const source = canvas.toDataURL('image/png');
    const image = id => `<figure class="cell-image" contenteditable="false" data-align="left"><img src="${source}" alt="" data-attachment-id="${id}" data-file-name="fixture.png" data-mime-type="image/png"></figure>`;
    const columns = ['text', 'attachment', 'expected', 'actual'].map(id => ({ id, title: id }));
    const rows = Array.from({ length: 1500 }, (_, i) => ({ id: `row-${i}`, status: 'НЕ ПРОВЕРЕНО',
      cells: { text: `<p>Check ${i}</p>`, attachment: '', expected: '', actual: '' } }));
    for (let i = 0; i < 8; i++) rows[i * 60].cells.attachment = image(`image-${i}`);
    rows[1].cells.text = image('active-image') + '<p>Edit this text</p>';
    rows[2].cells.text = '';
    rows[2].cells.attachment = image('neighbor-image');
    applyDraftLocally({ ...draft, intro: '<p>Diagnostic</p>', sections: [{ id: 'diagnostic-section', title: 'Diagnostic', columns, rows }] });
    await saveDraft();
    await Promise.all([...document.images].map(image => image.decode().catch(() => {})));
    historyCurrent = serializeDraft(); undoStack = []; redoStack = [];
    window.diagnosticFixture = { rows: rows.length, images: 10, imageBytes: new Blob([source]).size,
      documentBytes: new Blob([serializeDraft()]).size };
  });
  await instrument();
  await page.evaluate(() => { clearTimeout(saveTimer); clearTimeout(historyTimer); scheduleSave = () => { hasUnsavedLocalChanges = true; }; });
  const scenarios = [
    { name: 'full-table-type', row: 3, delay: 55 },
    { name: 'full-table-backspace', row: 3, delay: 55, delete: true },
    { name: 'small-dom-type', row: 3, delay: 55, reduce: true },
    { name: 'small-dom-backspace', row: 3, delay: 55, delete: true },
  ];
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const results = [];
  for (const scenario of scenarios) {
    if (scenario.reduce) await page.evaluate(() => { [...document.querySelectorAll('tr[data-row-id]')].slice(40).forEach(row => row.remove()); });
    const selector = `tr[data-row-id="row-${scenario.row}"] .cell-editor[data-column-id="text"]`;
    await page.locator(selector).evaluate(editor => {
      editor.focus(); const range = document.createRange();
      const paragraph = editor.querySelector('p:last-child');
      range.selectNodeContents(paragraph || editor); range.collapse(false);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    await page.evaluate(() => { window.perfMetrics = {}; window.longTasks = []; window.inputEvents = []; });
    const browserBefore = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]));
    const start = Date.now();
    if (scenario.delete) {
      for (let i = 0; i < 13; i++) { await page.keyboard.press('Backspace'); await page.waitForTimeout(scenario.delay); }
    } else await page.locator(selector).pressSequentially(' typed sample', { delay: scenario.delay });
    await page.waitForTimeout(250);
    const browserAfter = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]));
    const browserMs = Object.fromEntries(['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'].map(name => [name, 1000 * (browserAfter[name] - browserBefore[name])]));
    results.push(await page.evaluate(({ name, wallMs, browserMs }) => ({ name, wallMs, browserMs,
      functions: Object.fromEntries(Object.entries(window.perfMetrics).sort((a, b) => b[1].selfMs - a[1].selfMs)),
      longTasks: window.longTasks.map(e => Math.round(e.duration)),
      keyEvents: { count: window.inputEvents.length, maxDuration: Math.max(0, ...window.inputEvents.map(e => e.duration)), maxInputDelay: Math.max(0, ...window.inputEvents.map(e => e.inputDelay)) }, dirty: hasUnsavedLocalChanges,
    }), { name: scenario.name, wallMs: Date.now() - start, browserMs }));
  }
  const report = { version: path.basename(root), fixture: await page.evaluate(() => window.diagnosticFixture),
    conditions: { cpuThrottle: 4, autosaveEnabled: false, eventDurationThresholdMs: 16 }, results };
  console.log(JSON.stringify(report, null, 2));
  if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  // This is a runtime isolation experiment, never a persisted UI change.
  assert.equal(await page.evaluate(() => draft.sections[0].rows.length), 1500);
  assert.equal(await page.locator('tr[data-row-id]').count(), 40);
  assert.equal(await page.evaluate(() => htmlToText(draft.sections[0].rows[3].cells.text)), 'Check 3');
  assert.deepEqual(errors, []);

}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
});
