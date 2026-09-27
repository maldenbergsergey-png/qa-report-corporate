const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
function harness() {
  const counts = { collections: 0, cleanups: 0, summaries: 0, history: 0 };
  const timers = new Map();
  let timerId = 0;
  const ctx = vm.createContext({
    draft: { sections: [{ id: 'section', columns: [{ id: 'text' }, { id: 'attachment' }], rows: [
      { id: 'row', status: 'НЕ ПРОВЕРЕНО', cells: { text: 'Before', attachment: '' } },
      { id: 'other', status: 'OK', cells: { text: 'Keep', attachment: '<img src="data:image/png;base64,AAAA">' } },
    ] }] },
    hasUnsavedLocalChanges: false, saveTimer: 0,
    flushDraftFromDom: () => counts.collections++,
    cleanEditorHtml: editor => { counts.cleanups++; return editor.html; },
    htmlToText: html => html.replace(/<[^>]*>/g, '').trim(),
    renderSummary: () => counts.summaries++,
    setSaveStatus() {}, saveDraft() {}, scheduleHistoryCommit: () => counts.history++,
    clearTimeout: id => timers.delete(id),
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
  });
  for (const name of ['scheduleSave', 'hasRowContent', 'updateCellFromEditor']) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0);
    vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), ctx);
  }
  const input = html => ctx.updateCellFromEditor('section', 'row', 'text', { html });
  return { ctx, counts, timers, input };
}
test('typing only collects the edited cell, debounces saving and keeps history enabled', () => {
  const { ctx, counts, timers, input } = harness();
  const untouched = JSON.stringify(ctx.draft.sections[0].rows[1]);
  for (let i = 0; i < 20; i++) input(`Text ${i}`);
  assert.equal(ctx.draft.sections[0].rows[0].cells.text, 'Text 19');
  assert.equal(JSON.stringify(ctx.draft.sections[0].rows[1]), untouched);
  assert.deepEqual(counts, { collections: 0, cleanups: 20, summaries: 0, history: 20 });
  assert.equal(ctx.hasUnsavedLocalChanges, true);
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].delay, 400);
  ctx.scheduleSave();
  assert.equal(counts.collections, 1, 'other operations retain the full collection');
});
test('typing after autosave updates the current row rather than a replaced object', () => {
  const { ctx, input } = harness();
  const oldRow = ctx.draft.sections[0].rows[0];
  ctx.draft = structuredClone(ctx.draft);
  input('After autosave');
  assert.equal(oldRow.cells.text, 'Before');
  assert.equal(ctx.draft.sections[0].rows[0].cells.text, 'After autosave');
});
test('summary changes only when row inclusion changes, including image-only and status-only rows', () => {
  const { ctx, counts, input } = harness();
  input('<br>'); assert.equal(counts.summaries, 1);
  input('New'); assert.equal(counts.summaries, 2);
  input('More'); assert.equal(counts.summaries, 2);
  const row = ctx.draft.sections[0].rows[0];
  row.cells.attachment = '<img src="data:image/png;base64,AAAA">';
  input(''); assert.equal(counts.summaries, 2);
  row.cells.attachment = ''; row.status = 'OK';
  input('Text'); input(''); assert.equal(counts.summaries, 2);
});
test('events from a removed row, column or section cannot mutate another report', () => {
  for (const remove of [
    ctx => { ctx.draft.sections = []; },
    ctx => { ctx.draft.sections[0].rows.shift(); },
    ctx => { ctx.draft.sections[0].columns.shift(); },
  ]) {
    const { ctx, counts, input } = harness();
    remove(ctx); const before = JSON.stringify(ctx.draft);
    input('Detached');
    assert.equal(JSON.stringify(ctx.draft), before);
    assert.equal(counts.cleanups, 0);
    assert.equal(counts.history, 0);
  }
});
