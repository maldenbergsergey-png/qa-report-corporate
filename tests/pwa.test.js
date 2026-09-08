const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../sw.js'), 'utf8');
function worker(fetcher, windows = []) {
  const handlers = {}, stored = new Map(); let activated = false;
  class Request { constructor(url, options) { this.url = url; this.options = options; } }
  const cache = { async put(url, response) { stored.set(url, response); }, async match(url) { return stored.get(url); } };
  vm.runInNewContext(source, {
    URL, Request, Response, fetch: fetcher,
    caches: { async open() { return cache; }, async keys() { return []; } },
    self: { location: { origin: 'https://qa.test' }, registration: { scope: 'https://qa.test/' },
      clients: { async claim() {}, async matchAll() { return windows; } },
      async skipWaiting() { activated = true; }, addEventListener: (name, handler) => handlers[name] = handler },
  });
  return { handlers, stored, activated: () => activated };
}
function dispatch(w, name, event) {
  let result;
  w.handlers[name]({ ...event, waitUntil: promise => result = promise, respondWith: promise => result = promise });
  return result;
}
test('corporate cache never contains editor HTML, API or login responses', async () => {
  const w = worker(async () => new Response('asset'));
  await dispatch(w, 'install', {});
  assert.ok(w.stored.size > 5);
  for (const url of w.stored.keys()) {
    assert.ok(!url.includes('/api/') && !url.includes('login') && url !== '/' && !url.endsWith('.html'));
    assert.ok(fs.existsSync(path.join(__dirname, '..', url.split('?')[0])));
  }
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  for (const [, url] of html.matchAll(/(?:src|href)="(\/[^"#]+\.(?:js|css)(?:\?[^"#]*)?)"/g)) assert.ok(w.stored.has(url), url);
});
test('Docker image includes every script referenced by the editor', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  for (const match of html.matchAll(/<script[^>]+src="\/([^"?]+\.js)(?:\?[^"#]*)?"/g)) {
    assert.match(dockerfile, new RegExp(`(?:^|\\s)${match[1].replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}(?:\\s|$)`, 'm'), match[1]);
  }
});
test('navigation preserves server authorization redirect even with a cached editor', async () => {
  const response = new Response(null, { status: 302, headers: { Location: '/login' } });
  const w = worker(async () => response); w.stored.set('/', new Response('PRIVATE EDITOR'));
  const result = await dispatch(w, 'fetch', { request: { url: 'https://qa.test/report/abcd1234', method: 'GET', mode: 'navigate' } });
  assert.equal(result, response);
});
test('offline navigation is a connection message, never the editor', async () => {
  const w = worker(async () => { throw new Error('offline'); });
  const result = await dispatch(w, 'fetch', { request: { url: 'https://qa.test/', method: 'GET', mode: 'navigate' } });
  assert.equal(result.status, 503);
  const html = await result.text();
  assert.match(html, /проверить вход/); assert.doesNotMatch(html, /app\.js|contenteditable|localStorage|indexedDB/);
});
test('cached script does not override server denial', async () => {
  const response = new Response(null, { status: 401 });
  const asset = source.match(/['"](\/app\.js\?v=\d+)['"]/)[1];
  const w = worker(async () => response); w.stored.set(asset, new Response('cached script'));
  assert.equal(await dispatch(w, 'fetch', { request: { url: `https://qa.test${asset}`, method: 'GET', mode: 'cors' } }), response);
});
test('failed download prevents installation', async () => {
  const w = worker(async () => new Response(null, { status: 403 }));
  await assert.rejects(dispatch(w, 'install', {})); assert.equal(w.stored.size, 0);
});
for (const other of [false, true]) test(`update ${other ? 'blocks multiple windows' : 'allows sole window'}`, async () => {
  const windows = [{ id: 'a', url: 'https://qa.test/' }];
  if (other) windows.push({ id: 'b', url: 'https://qa.test/report/abcd1234' });
  const w = worker(async () => new Response(''), windows); let reply;
  await dispatch(w, 'message', { data: { type: 'APPLY_UPDATE' }, source: { id: 'a' }, ports: [{ postMessage: data => reply = data }] });
  assert.equal(reply.ok, !other); assert.equal(w.activated(), !other);
});
