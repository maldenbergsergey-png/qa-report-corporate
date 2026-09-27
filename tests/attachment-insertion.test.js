const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const limits = require('../attachment-limits');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const health = [], jira = [], inserted = [], shown = [], messages = [], reads = [];
  const ctx = vm.createContext({
    window: { QaReportAttachmentLimits: limits }, URL,
    Date: { now: () => 100000 }, AbortSignal: { timeout: n => n },
    crypto: { randomUUID: () => 'attachment' },
    draft: { reportId: 'report-a' }, elements: { issueUrl: { value: 'https://jira-a.test/browse/QA-1' } },
    jiraSettings: { transport: 'agent' }, jiraSecret: '', pwaPendingOperations: 0,
    activeEditor: { matches: () => true, isConnected: true },
    fetch: () => { const d = deferred(); health.push(d); return d.promise; },
    jiraRequest: (path, body) => { const d = deferred(); jira.push({ ...d, body }); return d.promise; },
    showAttachmentLimits: value => shown.push({ ...value }),
    showToast: message => messages.push(message), escapeHtml: text => text,
    readFileAsDataUrl: async file => { reads.push(file.name); return 'data:'+file.type+';base64,YQ=='; },
    insertHtmlAtCursor: html => inserted.push(html),
    enhanceImageControls() {}, enhanceFileControls() {},
    attachmentLimits: { publicationSentinel: true },
  });
  vm.runInContext('let localAttachmentLimitCache = null; let localAppAttachmentLimits = {...window.QaReportAttachmentLimits.defaults};', ctx);
  for (const name of ['attachmentLimitContext','getLocalAttachmentLimits','refreshAttachmentLimits','parseIssueUrl',
    'insertImages','insertImagesForPwa','insertFiles','insertFilesForPwa','insertAttachments',
    'isImageLikeFile','createFileCardHtml','getFileExtension','formatFileSize']) {
    const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
    assert.ok(start >= 0, name);
    vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2),ctx);
  }
  return { ctx, health, jira, inserted, shown, messages, reads };
}
const image = { name: 'shot.png', type: 'image/png', size: 1 };
const file = { name: 'log.txt', type: 'text/plain', size: 1 };
function resolveHealth(request, extra = {}) {
  request.resolve({ ok: true, json: async () => ({ attachmentLimits: { ...limits.defaults, ...extra } }) });
}
test('mixed clipboard files appear while both network requests remain unresolved; requests are deduplicated', async () => {
  const h = harness();
  await h.ctx.insertAttachments([image,file]);
  assert.equal(h.inserted.length, 2);
  assert.deepEqual(h.reads, ['shot.png','log.txt']);
  assert.equal(h.health.length, 1); assert.equal(h.jira.length, 1);
  assert.equal(h.ctx.pwaPendingOperations, 0);
  await h.ctx.insertAttachments([image]);
  assert.equal(h.health.length, 1); assert.equal(h.jira.length, 1);
});
test('known local limits are enforced even while Jira metadata is still pending', async () => {
  const h = harness(); h.ctx.getLocalAttachmentLimits();
  resolveHealth(h.health[0], { appMaxFileBytes: 10 }); await settle();
  await h.ctx.insertAttachments([{ ...image, size: 11 }]);
  assert.equal(h.reads.length, 0);
  assert.match(h.messages[0], /лимит QA Report/);
});
test('known Jira restrictions are enforced and publication limits are not changed by background metadata', async () => {
  const h = harness(); h.ctx.getLocalAttachmentLimits();
  resolveHealth(h.health[0]); h.jira[0].resolve({ attachmentLimits: { jiraEnabled: false } });
  await settle();
  await h.ctx.insertAttachments([image]);
  assert.equal(h.reads.length, 0); assert.match(h.messages[0], /отключены/);
  assert.deepEqual(h.ctx.attachmentLimits, { publicationSentinel: true });
  h.ctx.Date.now = () => 160001;
  h.ctx.getLocalAttachmentLimits(); h.ctx.getLocalAttachmentLimits();
  assert.equal(h.jira.length, 2, 'one background refresh after expiry');
});
test('Jira and report switches clear advisory Jira limits; late responses do not change the active target', async () => {
  for (const change of [h => { h.ctx.elements.issueUrl.value = 'https://jira-b.test/browse/QA-2'; },
    h => { h.ctx.draft.reportId = 'report-b'; }]) {
    const h = harness(); h.ctx.getLocalAttachmentLimits();
    change(h); assert.equal(h.ctx.getLocalAttachmentLimits().jiraEnabled, null);
    resolveHealth(h.health[1]); h.jira[1].resolve({ attachmentLimits: { jiraEnabled: true, jiraUploadLimit: 100 } });
    await settle(); const shown = h.shown.length;
    resolveHealth(h.health[0]); h.jira[0].resolve({ attachmentLimits: { jiraEnabled: false, jiraUploadLimit: 0 } });
    await settle();
    assert.equal(h.shown.length, shown);
    assert.equal(h.ctx.getLocalAttachmentLimits().jiraUploadLimit, 100);
    assert.equal(h.ctx.getLocalAttachmentLimits().jiraEnabled, true);
  }
});
test('completed limits from one Jira never block insertion into another', async () => {
  const h = harness(); h.ctx.getLocalAttachmentLimits();
  resolveHealth(h.health[0], { appMaxFileBytes: 10 }); h.jira[0].resolve({ attachmentLimits: { jiraEnabled: false } });
  await settle(); h.ctx.elements.issueUrl.value = 'https://jira-b.test/browse/QA-2';
  assert.equal(h.ctx.getLocalAttachmentLimits().jiraEnabled, null);
  assert.equal(h.ctx.getLocalAttachmentLimits().appMaxFileBytes, 10);
  await h.ctx.insertAttachments([image]); assert.equal(h.inserted.length, 1);
});
test('offline insertion works; invalid Jira URLs do not make Jira requests', async () => {
  const h = harness(); h.ctx.getLocalAttachmentLimits();
  h.health[0].reject(new Error('offline')); h.jira[0].reject(new Error('offline')); await settle();
  await h.ctx.insertAttachments([file]); assert.equal(h.inserted.length, 1);
  h.ctx.elements.issueUrl.value = '';
  await h.ctx.insertAttachments([image]); assert.equal(h.inserted.length, 2);
  assert.equal(h.jira.length, 1);
});
test('changing or detaching the editor during file reading cancels the remaining batch', async () => {
  for (const first of [image,file]) for (const detach of [false,true]) {
    const h = harness(), reading = deferred();
    h.ctx.readFileAsDataUrl = () => reading.promise;
    const pending = h.ctx.insertAttachments([first,file]);
    if (detach) h.ctx.activeEditor.isConnected = false;
    else h.ctx.activeEditor = { matches: () => true, isConnected: true };
    reading.resolve('data:text/plain;base64,YQ=='); await pending;
    assert.equal(h.inserted.length, 0); assert.equal(h.ctx.pwaPendingOperations, 0);
    assert.match(h.messages[0], /ячейка изменилась/);
  }
});
