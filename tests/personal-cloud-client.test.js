const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { documentFields } = require('../report-file');
const { contentFingerprint } = require('../history-content');
const fixture = () => ({ reportId: 'local', publicId: 'abc12345', schemaVersion: 3, issueUrl: '', environment: '', overallStatus: '', intro: '', numberingMode: 'section', sections: [{ id: 's', title: 'Текущий чек-лист', columns: [{ id: 'check', title: 'Проверка' }], rows: [{ id: 'r', status: 'OK', cells: { check: 'Локальные данные' } }] }] });
function harness({ hang = false, failList = false } = {}) {
  const elements = new Map(), stored = new Map();
  function element() {
    return { textContent: '', dataset: {}, hidden: false, children: [], open: false, disabled: false, attributes: {}, events: {},
      classList: { toggle() {} }, setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, callback) { this.events[name] = callback; },
      append(...values) { this.children.push(...values); }, replaceChildren(...values) { this.children = values; },
      showModal() { this.open = true; }, close() { this.open = false; } };
  }
  const document = { documentElement: { dataset: {} }, visibilityState: 'visible', createElement: element,
    getElementById: id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    querySelectorAll: () => [], addEventListener() {} };
  const root = { addEventListener() {}, dispatchEvent() {}, QaReportFile: { documentFields }, QaReportHistory: { contentFingerprint } };
  const context = { window: root, document, location: new URL('https://qa.example/report/abc12345'), history: {},
    localStorage: { getItem: key => stored.get(key) || null, setItem: (key, value) => stored.set(key, value) },
    navigator: { onLine: true }, URL, AbortSignal, AbortController, setInterval: () => 1, clearInterval() {},
    fetch: async url => {
      if (url.endsWith('/availability')) return Response.json({ signedIn: true, ownerId: 'owner', configured: true, canSave: true, chunkBytes: 393216, fileBytes: 52428800 });
      if (failList) return Response.json({ error: 'Не удалось получить список.' }, { status: 503 });
      return Response.json({ reports: [] });
    } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../personal-cloud-client'), 'utf8'), context);
  let operations = 0;
  const client = root.QaReportCloud.create({ requestTimeout: hang ? 20 : 500, headers: () => hang ? new Promise(() => {}) : {},
    capture: fixture, records: async () => [], restore() {}, loadAttachment() {}, notify() {}, blocked: () => false, operation: delta => operations += delta });
  return { client, elements, stored, operations: () => operations, ready: () => { hang = false; failList = false; } };
}

test('an empty successful cloud list finishes loading and leaves save enabled', async () => {
  const h = harness(); await h.client.open();
  assert.equal(h.elements.get('personalCloudDialog').attributes['aria-busy'], 'false');
  assert.equal(h.elements.get('personalCloudStatus').textContent, '');
  assert.equal(h.elements.get('personalCloudStatus').dataset.state, 'idle');
  assert.equal(h.elements.get('personalCloudSave').disabled, false);
  assert.match(h.elements.get('personalCloudReportTitle').textContent, /Текущий чек-лист/);
  assert.equal(h.operations(), 0);
});

test('a stalled account provider times out, clears busy state and permits a successful retry', async () => {
  const h = harness({ hang: true });
  await Promise.all([h.client.open(), new Promise(resolve => setTimeout(resolve, 50))]);
  assert.match(h.elements.get('personalCloudStatus').textContent, /Сервер не ответил вовремя/);
  assert.equal(h.elements.get('personalCloudDialog').attributes['aria-busy'], 'false');
  assert.equal(h.elements.get('personalCloudRefresh').disabled, false);
  assert.equal(h.operations(), 0);
  h.ready(); await h.client.open();
  assert.equal(h.elements.get('personalCloudStatus').textContent, '');
  assert.equal(h.elements.get('personalCloudSave').disabled, false);
});

test('a failed list reports an error rather than a loading indicator and can be refreshed again', async () => {
  const h = harness({ failList: true }); await h.client.open();
  assert.equal(h.elements.get('personalCloudStatus').dataset.state, 'error');
  assert.equal(h.elements.get('personalCloudStatus').textContent, 'Не удалось получить список.');
  assert.equal(h.elements.get('personalCloudRefresh').disabled, false);
  h.ready(); await h.client.open();
  assert.equal(h.elements.get('personalCloudStatus').textContent, '');
  assert.equal(h.operations(), 0);
});

test('sign-out cancels a pending account request and does not leave the next opening blocked', async () => {
  const h = harness({ hang: true });
  const opening = h.client.open();
  h.client.reset(); await opening;
  assert.equal(h.elements.get('personalCloudDialog').attributes['aria-busy'], 'false');
  assert.equal(h.operations(), 0);
  h.ready(); await h.client.open();
  assert.equal(h.elements.get('personalCloudSave').disabled, false);
  assert.equal(h.elements.get('personalCloudStatus').textContent, '');
});


test('history cloud state uses the verified owner and the selected report content', async () => {
  const h = harness(), source = fixture();
  const content = contentFingerprint(documentFields(source));
  const savedAt = '2026-11-09T09:00:00.000Z';
  h.stored.set('qa-report-personal-cloud-v1', JSON.stringify({
    other: { local: { id: 'other-copy', savedAt, content } },
    owner: { local: { id: 'own-copy', savedAt, content } },
  }));
  assert.equal(h.client.historyStatus(source).state, 'unknown');
  await h.client.refreshHistory();
  assert.equal(h.client.historyStatus(source).state, 'saved');
  const changed = structuredClone(source);
  changed.sections[0].rows[0].cells.check = 'Изменённая проверка';
  assert.equal(h.client.historyStatus(changed).state, 'dirty');
  assert.equal(h.client.historyStatus({ ...source, reportId: 'another-local' }).state, 'local');
  h.client.reset();
  assert.equal(h.client.historyStatus(source).state, 'unknown');
});

test('history never takes a cloud badge from another account', async () => {
  const h = harness(), source = fixture();
  h.stored.set('qa-report-personal-cloud-v1', JSON.stringify({ other: {
    local: { savedAt: '2026-11-09T09:00:00Z', content: contentFingerprint(documentFields(source)) },
  } }));
  await h.client.refreshHistory();
  assert.equal(h.client.historyStatus(source).state, 'local');
});
