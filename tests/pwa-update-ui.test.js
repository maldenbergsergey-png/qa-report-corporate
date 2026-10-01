const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness() {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: true, textContent: '', addEventListener() {} });
    return nodes.get(id);
  };
  node('updateAppContainer');
  const states = {}, regEvents = {}, timers = [];
  const installing = { state: 'installing', addEventListener: (name, fn) => { states[name] = fn; } };
  const reg = { waiting: null, installing, update: async () => {}, addEventListener: (name, fn) => { regEvents[name] = fn; } };
  const ctx = { document: { getElementById: node, visibilityState: 'visible', addEventListener() {} },
    window: { isSecureContext: true, addEventListener() {} },
    navigator: { serviceWorker: { controller: {}, ready: Promise.resolve(reg), register: async () => reg } },
    setTimeout: fn => { timers.push(fn); }, setInterval() {}, console,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pwa.js'), 'utf8'), ctx);
  return { nodes, reg, installing, states, timers };
}

test('update button appears when the waiting worker reference settles after statechange', async () => {
  const h = harness();
  await Promise.resolve();
  h.installing.state = 'installed';
  h.states.statechange();
  assert.equal(h.nodes.get('updateAppContainer').hidden, true);
  h.reg.waiting = {};
  for (const callback of h.timers) callback();
  assert.equal(h.nodes.get('updateAppContainer').hidden, false);
  assert.equal(h.nodes.get('updateAppButton').hidden, false);
});
