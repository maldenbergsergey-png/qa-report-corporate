const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
const copy = value => JSON.parse(JSON.stringify(value));
function harness() {
  const section = {
    id: 'first', title: 'First', statusSort: true,
    columns: [{ id: 'check', title: 'Same', width: 250 }, { id: 'status', title: 'Same' }],
    rows: [
      { id: 'one', manualNumber: '7', status: 'OK', cells: { check: '<p>Text</p><img src="data:image/png;base64,AA==">', status: 'Keep' } },
      { id: 'two', manualNumber: '9', status: 'НЕ ОК', cells: { check: '<a class="cell-file">File</a><pre>code</pre>', status: 'Keep too' } },
    ],
  };
  const ctx = vm.createContext({
    draft: { numberingMode: 'manual', intro: 'Intro', sections: [section, { ...copy(section), id: 'second' }] },
    undoStack: [], redoStack: [], historyTimer: 0, clearTimeout() {},
    flushDraftFromDom() {}, collectDocumentFields() {}, closeFloatingMenu() {},
    renderSections() {}, renderSummary() {}, updateHistoryButtons() {},
    saves: 0, saveLocalMutationNow() { ctx.saves++; },
    serializeDraft() { return JSON.stringify(ctx.draft); },
    restoreSerializedDraft(serialized) { ctx.draft = JSON.parse(serialized); ctx.historyCurrent = serialized; },
  });
  ctx.historyCurrent = ctx.serializeDraft();
  for (const name of ['clearSectionColumn', 'commitSelectionMutation', 'undo', 'redo']) {
    vm.runInContext(functionSource(name), ctx);
  }
  return ctx;
}

test('clear only the requested column in its section, including attachments; undo and redo atomically', () => {
  const ctx = harness();
  const before = copy(ctx.draft);
  const expected = copy(before);
  expected.sections[0].rows.forEach(row => { row.cells.check = ''; });
  ctx.clearSectionColumn('first', 'check');
  assert.deepEqual(copy(ctx.draft), expected);
  assert.equal(ctx.saves, 1);
  assert.equal(ctx.undoStack.length, 1);
  ctx.undo();
  assert.deepEqual(copy(ctx.draft), before);
  ctx.redo();
  assert.deepEqual(copy(ctx.draft), expected);
});

test('status clearing resets every row only in its section and is undoable', () => {
  const ctx = harness();
  const before = copy(ctx.draft);
  const expected = copy(before);
  expected.sections[0].rows.forEach(row => { row.status = 'НЕ ПРОВЕРЕНО'; });
  ctx.clearSectionColumn('first');
  assert.deepEqual(copy(ctx.draft), expected);
  ctx.undo();
  assert.deepEqual(copy(ctx.draft), before);
  ctx.redo();
  assert.deepEqual(copy(ctx.draft), expected);
});

test('a content column with status as its ID does not reset row statuses', () => {
  const ctx = harness();
  const expected = copy(ctx.draft);
  expected.sections[0].rows.forEach(row => { row.cells.status = ''; });
  ctx.clearSectionColumn('first', 'status');
  assert.deepEqual(copy(ctx.draft), expected);
});

test('pending edits survive a single undo of clearing and form a separate history step', () => {
  const ctx = harness();
  const original = copy(ctx.draft);
  ctx.flushDraftFromDom = () => { ctx.draft.sections[0].rows[0].cells.check = 'Just typed'; };
  const expected = copy(original);
  expected.sections[0].rows[0].cells.check = 'Just typed';
  ctx.clearSectionColumn('first', 'check');
  assert.equal(ctx.undoStack.length, 2);
  ctx.undo();
  assert.deepEqual(copy(ctx.draft), expected);
  ctx.undo();
  assert.deepEqual(copy(ctx.draft), original);
});

test('missing targets, empty sections and already cleared columns do not create undo or save operations', () => {
  const ctx = harness();
  const before = copy(ctx.draft);
  ctx.clearSectionColumn('missing', 'check');
  ctx.clearSectionColumn('first', 'missing');
  assert.deepEqual(copy(ctx.draft), before);
  assert.equal(ctx.saves, 0);
  ctx.clearSectionColumn('first', 'check');
  ctx.clearSectionColumn('first', 'check');
  ctx.clearSectionColumn('first');
  ctx.clearSectionColumn('first');
  assert.equal(ctx.saves, 2);
  assert.equal(ctx.undoStack.length, 2);
  ctx.draft.sections[0].rows = [];
  ctx.clearSectionColumn('first', 'check');
  ctx.clearSectionColumn('first');
  assert.equal(ctx.saves, 2);
});
