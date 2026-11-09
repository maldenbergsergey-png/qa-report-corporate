const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { MessageChannel } = require('node:worker_threads');

function target(properties = {}) {
  const listeners = new Map();
  return Object.assign(properties, {
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
    },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
    emit(name) { return Promise.all([...listeners.get(name) || []].map(callback => callback())); },
  });
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function harness() {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, target({ hidden: true, disabled: false, textContent: '', click() { return this.emit('click'); } }));
    return nodes.get(id);
  };
  const shell = { inert: false };
  const calls = [];
  const reg = target({ waiting: null, installing: null, active: null, update: async () => { calls.push('check'); } });
  const serviceWorker = target({ controller: {}, ready: Promise.resolve(reg), register: async () => reg });
  const window = { isSecureContext: true, addEventListener() {},
    preparePwaUpdate: async () => { calls.push('save'); },
    location: { reload() { calls.push('reload'); } }, showToast() {},
  };
  const worker = (name, state = 'installed') => target({ state,
    postMessage() {
      calls.push(`activate:${name}`);
      reg.waiting = null; reg.active = this;
      serviceWorker.controller = this;
      serviceWorker.emit('controllerchange');
      this.state = 'activated'; this.emit('statechange');
    },
  });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pwa.js'), 'utf8'), {
    document: { getElementById: node, querySelector: () => shell, visibilityState: 'visible', addEventListener() {} },
    window, navigator: { serviceWorker }, MessageChannel, setTimeout, clearTimeout, setInterval() {}, console,
  });
  return { nodes, node, reg, serviceWorker, worker, shell, window, calls, click: () => node('updateAppButton').click() };
}

test('update button appears when the waiting reference settles after statechange', async () => {
  const h = harness();
  h.reg.installing = h.worker('pending', 'installing');
  await tick();
  h.reg.installing.state = 'installed';
  await h.reg.installing.emit('statechange');
  assert.equal(h.node('updateAppContainer').hidden, true);
  h.reg.waiting = h.reg.installing;
  await tick();
  assert.equal(h.node('updateAppContainer').hidden, false);
  assert.equal(h.node('updateAppButton').hidden, false);
});

test('one click saves and waits for the latest build instead of activating an older waiting build', async () => {
  const h = harness();
  h.reg.waiting = h.worker('older');
  const latest = h.worker('latest', 'installing');
  h.reg.update = async () => { h.calls.push('check'); h.reg.installing = latest; };
  await tick();
  const click = h.click();
  await tick();
  assert.deepEqual(h.calls, ['save', 'check']);
  assert.equal(h.shell.inert, true);
  assert.equal(h.node('updateAppButton').disabled, true);
  await h.click(); // A second click cannot launch another update.
  h.reg.installing = null; h.reg.waiting = latest;
  latest.state = 'installed'; await latest.emit('statechange');
  await click;
  assert.deepEqual(h.calls, ['save', 'check', 'activate:latest', 'reload']);
});

test('failed local save prevents checking, activation and reload', async () => {
  const h = harness();
  h.reg.waiting = h.worker('waiting');
  h.window.preparePwaUpdate = async () => { throw new Error('Не удалось сохранить чек-лист'); };
  await tick(); await h.click();
  assert.deepEqual(h.calls, []);
  assert.equal(h.node('updateAppAnnouncement').textContent, 'Не удалось сохранить чек-лист');
  assert.equal(h.shell.inert, false);
  assert.equal(h.node('updateAppButton').disabled, false);
});

for (const failure of ['network', 'installation']) test(`${failure} failure keeps the editor open without applying an outdated build; retry succeeds`, async () => {
  const h = harness();
  h.reg.waiting = h.worker('outdated');
  const latest = h.worker('latest', 'installing');
  h.reg.update = async () => {
    h.calls.push('check');
    if (failure === 'network') throw new Error('offline');
    h.reg.installing = latest;
  };
  await tick();
  const click = h.click(); await tick();
  if (failure === 'installation') {
    h.reg.installing = null; latest.state = 'redundant'; await latest.emit('statechange');
  }
  await click;
  assert.deepEqual(h.calls, ['save', 'check']);
  assert.match(h.node('updateAppAnnouncement').textContent, /Проверьте подключение/);
  assert.equal(h.shell.inert, false);
  assert.equal(h.node('updateAppButton').disabled, false);
  h.reg.update = async () => { h.reg.waiting = h.worker('latest'); };
  await h.click();
  assert.deepEqual(h.calls, ['save', 'check', 'save', 'activate:latest', 'reload']);
});

test('a build already activated by another tab can be loaded without another update click', async () => {
  const h = harness();
  const latest = h.worker('latest', 'activated');
  h.reg.waiting = h.worker('older');
  h.reg.update = async () => {
    h.reg.waiting = null; h.reg.active = latest; h.serviceWorker.controller = latest;
  };
  await tick(); await h.click();
  assert.deepEqual(h.calls, ['save', 'reload']);
});

test('an unrelated controllerchange cannot reload the page before the selected build activates', async () => {
  const h = harness();
  const latest = h.worker('latest');
  latest.postMessage = () => {
    h.calls.push('activation-requested');
    h.serviceWorker.controller = h.worker('other', 'activated');
    h.serviceWorker.emit('controllerchange');
  };
  h.reg.waiting = latest;
  await tick();
  const click = h.click();
  await tick(); await tick();
  assert.deepEqual(h.calls, ['save', 'check', 'activation-requested']);
  h.serviceWorker.controller = latest;
  await h.serviceWorker.emit('controllerchange');
  assert.equal(h.calls.includes('reload'), false);
  latest.state = 'activated'; await latest.emit('statechange');
  await click;
  assert.equal(h.calls.at(-1), 'reload');
});
