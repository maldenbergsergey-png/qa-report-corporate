const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture() {
  const requests = []; const listeners = new Map();
  const document = { visibilityState: 'visible', addEventListener(name, callback) { listeners.set(name, callback); } };
  const window = { addEventListener(name, callback) { listeners.set(name, callback); } };
  const navigator = { onLine: true };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'usage.js'), 'utf8'), {
    window, document, navigator, Date, AbortSignal, matchMedia: () => ({ matches: false }), setInterval() {},
    fetch(url, options) { const done = deferred(); requests.push({ url, options, done }); return done.promise; },
  });
  return { requests, document, navigator, listeners, account: window.QaReportUsage.setAccount };
}

test('session restoration queues identification behind the initial signal without putting identity in the body', async () => {
  const f = fixture();
  assert.equal(f.requests.length, 1);
  f.account('user_alice', async () => 'signed-alice');
  assert.equal(f.requests.length, 1);
  f.requests[0].done.resolve(); await flush();
  assert.equal(f.requests.length, 2);
  const request = f.requests[1];
  assert.equal(request.url, '/api/usage/visit');
  assert.equal(request.options.headers['X-QA-Report-Session'], 'signed-alice');
  assert.deepEqual(JSON.parse(request.options.body), { mode: 'browser' });
  assert.equal(request.options.redirect, 'error');
  request.done.resolve(); await flush();
  f.account('user_alice', async () => 'same-account');
  assert.equal(f.requests.length, 2);
  f.account('', async () => 'must-never-be-sent'); await flush();
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests[2].options.headers['X-QA-Report-Session'], undefined);
  f.requests[2].done.resolve(); await flush();
});

test('changing accounts during token retrieval discards the previous token and hidden/offline pages wait', async () => {
  const f = fixture(); f.requests[0].done.resolve(); await flush();
  const stale = deferred();
  f.account('user_alice', () => stale.promise);
  f.account('user_bob', async () => 'signed-bob');
  stale.resolve('signed-alice'); await flush();
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].options.headers['X-QA-Report-Session'], 'signed-bob');
  f.requests[1].done.resolve(); await flush();
  f.document.visibilityState = 'hidden';
  f.account('user_carol', async () => 'signed-carol'); await flush();
  assert.equal(f.requests.length, 2);
  f.document.visibilityState = 'visible'; f.navigator.onLine = false;
  f.listeners.get('visibilitychange')(); await flush();
  assert.equal(f.requests.length, 2);
  f.navigator.onLine = true; f.listeners.get('online')(); await flush();
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests[2].options.headers['X-QA-Report-Session'], 'signed-carol');
  f.requests[2].done.resolve(); await flush();
});
