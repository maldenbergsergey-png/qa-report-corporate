const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness() {
  const document = { activeElement: null };
  function node() {
    const listeners = new Map(), attributes = new Map(), classes = new Set();
    return { hidden: false, classList: {
      add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
      toggle: (name, value) => value ? classes.add(name) : classes.delete(name),
    }, addEventListener: (name, fn) => listeners.set(name, fn), emit: (name, event = {}) => listeners.get(name)?.(event),
    setAttribute: (name, value) => attributes.set(name, value), getAttribute: name => attributes.get(name),
    focus() { document.activeElement = this; } };
  }
  const view = node(), overview = node(), toggle = node(), pin = node(), scrollport = node();
  overview.contains = candidate => candidate === pin;
  Object.defineProperty(overview, 'offsetHeight', { get: () => overview.hidden ? 0 : 120 });
  scrollport.scrollTop = 0;
  scrollport.getBoundingClientRect = () => ({ top: overview.hidden ? 60 : 196 });
  const context = vm.createContext({ window: {}, document, URL,
    ResizeObserver: class { observe() {} } });
  vm.runInContext(fs.readFileSync(require.resolve('../report-view.js'), 'utf8'), context);
  const api = context.window.QaReportView;
  const control = api.createOverviewControl({ view, overview, toggle, pin, scrollport, onLayout() {} });
  control.reset(true);
  function scroll(top) { scrollport.scrollTop = top; scrollport.emit('scroll'); }
  return { api, control, view, overview, toggle, pin, scrollport, document, scroll };
}

test('status filter uses All, the selected name or a short count without repeating Status', () => {
  const { api } = harness();
  for (const value of [null, new Set()]) assert.equal(api.statusFilterLabel(value), 'Все');
  assert.equal(api.statusFilterLabel(new Set(['НЕ ОК'])), 'НЕ ОК');
  assert.equal(api.statusFilterLabel(new Set(['OK', 'НЕ ОК', 'НЕ ПРОВЕРЕНО'])), 'Выбрано 3');
});

test('scrolling collapses the overview while keeping a checklist point at the same screen position', () => {
  const h = harness();
  h.scroll(40);
  assert.equal(h.overview.hidden, false, 'Small scrolls do not hide task details');
  h.scrollport.scrollTop = 300;
  const pointBefore = h.scrollport.getBoundingClientRect().top - h.scrollport.scrollTop;
  h.scrollport.emit('scroll');
  assert.equal(h.overview.hidden, true);
  assert.equal(h.toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(h.scrollport.getBoundingClientRect().top - h.scrollport.scrollTop, pointBefore);
  h.scroll(0);
  assert.equal(h.overview.hidden, false, 'Returning to the start restores task details');
});

test('pinning survives scrolls; unpinning restores automatic collapse; reopening resets the pin', () => {
  const h = harness();
  h.pin.emit('click');
  h.scroll(800);
  assert.equal(h.overview.hidden, false);
  assert.equal(h.pin.getAttribute('aria-pressed'), 'true');
  h.pin.emit('click');
  h.scroll(1000);
  assert.equal(h.overview.hidden, true);
  h.toggle.emit('click');
  h.pin.emit('click');
  h.control.reset(true);
  assert.equal(h.overview.hidden, false);
  assert.equal(h.pin.getAttribute('aria-pressed'), 'false');
  h.scroll(1500);
  assert.equal(h.overview.hidden, true);
});

test('manual collapse clears pinning, can be reopened, and keyboard focus is not hidden automatically', () => {
  const h = harness();
  h.pin.emit('click');
  h.toggle.emit('click');
  assert.equal(h.overview.hidden, true);
  assert.equal(h.pin.getAttribute('aria-pressed'), 'false');
  h.toggle.emit('click');
  h.document.activeElement = h.pin;
  h.view.emit('keydown', { key: 'Tab' });
  h.scroll(500);
  assert.equal(h.overview.hidden, false);
  h.view.emit('pointerdown');
  h.scroll(700);
  assert.equal(h.overview.hidden, true);
  assert.equal(h.document.activeElement, h.toggle);
  h.control.reset(false);
  assert.equal(h.toggle.hidden, true, 'A report without task details has no empty disclosure button');
});
