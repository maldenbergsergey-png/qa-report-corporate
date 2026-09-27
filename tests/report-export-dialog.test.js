const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const code = source.slice(source.indexOf('let reportFileBusy = false;'), source.indexOf('function reportAttachmentLoader()'));
function setup(stored, storageFails = false) {
  const nodes = new Map();
  let focused;
  function node(id) {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, { hidden: false, checked: false, disabled: false, textContent: '',
        classList: { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name) },
        focus() { focused = id; }, removeAttribute() {} });
    }
    return nodes.get(id);
  }
  const storage = new Map(stored ? [['qa-report-hide-export-success-v1', 'true']] : []);
  const context = vm.createContext({ document: { getElementById: node },
    localStorage: { getItem: key => { if (storageFails) throw Error('blocked'); return storage.get(key); },
      setItem: (key, value) => { if (storageFails) throw Error('blocked'); storage.set(key, value); } },
    pwaPendingOperations: 0, publishInProgress: false, importBusy: false,
    showToast() {}, closeHeaderDropdowns() {}, syncBodyModalOverflow() {}, elements: { copyMenuButton: node('export') },
  });
  vm.runInContext(code, context);
  return { context, node, storage, focus: () => focused, run: action => context.runReportFileOperation('Сохранить копию', action) };
}
test('successful export shows concise result, preference and close controls', async () => {
  const ui = setup(); await ui.run(async () => 'Ready');
  assert.equal(ui.node('reportFileTitle').textContent, 'Копия отчёта скачана');
  assert.equal(ui.node('reportFileModal').hidden, false);
  assert.equal(ui.node('reportFileProgress').hidden, true);
  assert.equal(ui.node('reportFileDismissOption').hidden, false);
  assert.equal(ui.node('closeReportFileIcon').hidden, false);
  assert.equal(ui.focus(), 'closeReportFileButton');
});
test('dismissal persists and suppresses success in a fresh app session', async () => {
  const ui = setup(); await ui.run(async () => 'Ready');
  ui.node('reportFileDismissCheckbox').checked = true; ui.context.closeReportFileDialog();
  assert.equal(ui.storage.get('qa-report-hide-export-success-v1'), 'true');
  const reloaded = setup(true); let called = false;
  await reloaded.run(async () => { called = true; return 'Ready'; });
  assert.equal(called, true); assert.equal(reloaded.node('reportFileModal').hidden, true);
  assert.equal(reloaded.focus(), 'export');
});
test('export errors remain visible when success messages are disabled', async () => {
  const ui = setup(true); await ui.run(async () => { throw Error('Missing attachment'); });
  assert.equal(ui.node('reportFileModal').hidden, false);
  assert.equal(ui.node('reportFileError').textContent, 'Missing attachment');
  assert.equal(ui.node('reportFileDismissOption').hidden, true);
  assert.equal(ui.node('closeReportFileButton').disabled, false);
  ui.context.closeReportFileDialog();
  assert.equal(ui.storage.get('qa-report-hide-export-success-v1'), 'true');
});
test('progress is protected from closing and duplicate exports', async () => {
  const ui = setup(); let finish; const pending = ui.run(() => new Promise(resolve => { finish = resolve; }));
  ui.context.closeReportFileDialog(); assert.equal(ui.node('reportFileModal').hidden, false);
  assert.equal(ui.node('closeReportFileButton').disabled, true);
  let duplicate = false; await ui.run(async () => { duplicate = true; }); assert.equal(duplicate, false);
  finish('Ready'); await pending; assert.equal(ui.context.pwaPendingOperations, 0);
});
test('blocked preference storage does not break download completion or close', async () => {
  const ui = setup(false, true); await ui.run(async () => 'Ready');
  ui.node('reportFileDismissCheckbox').checked = true; ui.context.closeReportFileDialog();
  assert.equal(ui.node('reportFileModal').hidden, true);
  await ui.run(async () => 'Ready'); assert.equal(ui.node('reportFileModal').hidden, true);
});
test('a new attempt clears success and previous errors', async () => {
  const ui = setup(); await ui.run(async () => 'Ready'); ui.context.closeReportFileDialog();
  await ui.run(async () => { throw Error('Failed'); });
  assert.equal(ui.node('reportFileModal').classList.contains('is-success'), false);
  assert.equal(ui.node('reportFileSuccessIcon').hidden, true);
  await ui.run(async () => 'Ready'); assert.equal(ui.node('reportFileError').hidden, true);
});
