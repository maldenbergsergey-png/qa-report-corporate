const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');

function load(context, names) {
  const ctx = vm.createContext(context);
  for (const name of names) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, name);
    vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), ctx);
  }
  return ctx;
}

test('history serialization preserves content and attachments while ignoring only top-level transient fields', () => {
  const attachment = 'data:application/octet-stream;base64,' + 'YWFh'.repeat(32 * 1024);
  const content = { reportId: 'report', draftId: 'draft', publicId: 'abc12345',
    intro: '<p>Introduction</p>', sections: [{ id: 'section', revision: 12,
      columns: [{ id: 'text', title: 'Text' }], rows: [{ id: 'row', status: 'OK',
        cells: { text: `<figure data-data-url="${attachment}">File</figure>` } }] }] };
  const transient = { revision: 7, updatedAt: 'old', lastSavedBy: 'tab', lastSavedClientId: 'client',
    tabId: 'tab', clientId: 'client', browserId: 'browser', selectedCell: 'cell', focus: 'cell',
    scroll: 120, syncTimestamps: { saved: 'old' } };
  const expected = JSON.stringify(content);
  const ctx = load({ draft: { ...content, ...transient } },
    ['clone', 'draftContentFields', 'draftContentSnapshot', 'serializeDraft']);
  const before = JSON.stringify(ctx.draft);
  assert.equal(ctx.serializeDraft(), expected);
  assert.equal(JSON.stringify(ctx.draft), before);
  ctx.draft.revision++;
  ctx.draft.updatedAt = 'new';
  assert.equal(ctx.serializeDraft(), expected);
  ctx.draft.sections[0].rows[0].cells.text += '<p>Edited</p>';
  assert.notEqual(ctx.serializeDraft(), expected);
});

test('content snapshots remain independent deep copies', () => {
  const draft = { reportId: 'report', revision: 2, sections: [{ id: 'section',
    columns: [{ id: 'text' }], rows: [{ id: 'row', cells: { text: 'Original' } }] }] };
  const ctx = load({ draft }, ['clone', 'draftContentFields', 'draftContentSnapshot']);
  const snapshot = ctx.draftContentSnapshot();
  snapshot.sections[0].rows[0].cells.text = 'Changed snapshot';
  snapshot.sections[0].columns[0].id = 'changed';
  assert.equal(draft.sections[0].rows[0].cells.text, 'Original');
  assert.equal(draft.sections[0].columns[0].id, 'text');
  assert.equal(snapshot.revision, undefined);
});

test('table collection updates current rows by identity, including manual numbers and attachments', () => {
  const fileHtml = '<figure data-data-url="data:text/plain;base64,YWFh">File</figure>';
  const row = (id, text, status, number) => ({ dataset: { rowId: id },
    querySelectorAll: () => [{ dataset: { columnId: 'text' }, html: text }],
    querySelector: selector => ({ value: selector === '.status-select' ? status : number }) });
  const sectionElement = { dataset: { sectionId: 'section' }, classList: { contains: () => true },
    querySelector: () => ({ value: 'Updated section' }),
    querySelectorAll: selector => selector.startsWith('th')
      ? [{ dataset: { columnId: 'text' }, querySelector: () => ({ value: 'Updated column' }) }]
      : [row('second', fileHtml, 'OK', '7.2'), row('removed', 'Ignore', 'OK', '9'), row('first', 'Edited', 'НЕ ОК', '7.1')] };
  const draft = { numberingMode: 'manual', sections: [{ id: 'section', columns: [{ id: 'text' }],
    rows: [{ id: 'first', cells: { text: 'Before' } }, { id: 'second', cells: { text: '' } }] }] };
  const ctx = load({ draft, cleanEditorHtml: editor => editor.html,
    ChecklistNumbering: require('../checklist-numbering'),
    elements: { sections: { querySelectorAll: () => [sectionElement, { dataset: { sectionId: 'removed' } }] } } },
    ['collectSectionsFromDom']);
  const oldRow = draft.sections[0].rows[0];
  ctx.draft = structuredClone(draft);
  ctx.collectSectionsFromDom();
  assert.equal(oldRow.cells.text, 'Before');
  const section = ctx.draft.sections[0];
  assert.equal(section.title, 'Updated section');
  assert.equal(section.collapsed, true);
  assert.equal(section.columns[0].title, 'Updated column');
  assert.deepEqual(section.rows.map(item => item.cells.text), ['Edited', fileHtml]);
  assert.deepEqual(section.rows.map(item => item.status), ['НЕ ОК', 'OK']);
  assert.deepEqual(section.rows.map(item => item.manualNumber), ['7.1', '7.2']);
});

test('save copies preserve legacy JSON fields and attachments without sharing mutable containers', () => {
  const value = { schemaVersion: 2, reportId: 'legacy', publicId: 'abc12345', extra: { custom: [1, null] },
    intro: '<p>Introduction</p>', sections: [{ id: 'section', collapsed: true,
      columns: [{ id: 'text', name: 'Legacy title', width: 333, required: true }],
      rows: [{ id: 'row', manualNumber: '7.2', status: 'НЕ ОК', custom: { old: true },
        cells: { text: '<figure><img src="data:image/png;base64,AAAA"></figure>' } }] }],
    optional: undefined, nonfinite: NaN, values: [undefined, Infinity] };
  const ctx = load({}, ['copyDraftValue']);
  const copy = ctx.copyDraftValue(value);
  assert.equal(JSON.stringify(copy), JSON.stringify(value));
  copy.sections[0].rows[0].cells.text = 'Changed';
  copy.sections[0].columns[0].width = 200;
  copy.extra.custom.push(2);
  assert.equal(value.sections[0].rows[0].cells.text.includes('data:image/png'), true);
  assert.equal(value.sections[0].columns[0].width, 333);
  assert.equal(value.extra.custom.length, 2);
});

test('history commit reuses the saved content and reflects edits made during a pending save', () => {
  let callback, serializations = 0;
  const draft = { intro: 'Saved' };
  const ctx = load({ draft, suppressHistory: false, historyTimer: 0, localEditGeneration: 1,
    savedContentForHistory: { draft, generation: 1, content: JSON.stringify(draft) },
    historyCurrent: '{"intro":"Before"}', undoStack: [], redoStack: ['Redo'],
    clearTimeout() {}, setTimeout: fn => { callback = fn; }, updateHistoryButtons() {},
    collectDocumentFields: () => { throw Error('History scanned the table'); },
    serializeDraft: () => { serializations++; return JSON.stringify(draft); },
  }, ['scheduleHistoryCommit']);
  ctx.scheduleHistoryCommit(); callback();
  assert.equal(serializations, 0);
  assert.equal(ctx.historyCurrent, '{"intro":"Saved"}');
  draft.intro = 'New typing'; ctx.localEditGeneration++;
  ctx.scheduleHistoryCommit(); callback();
  assert.equal(serializations, 1);
  assert.equal(ctx.historyCurrent, '{"intro":"New typing"}');
});

function historyHarness() {
  const ctx = load({ draft: {}, historyCurrent: '', undoStack: [], redoStack: [],
    savedContentForHistory: null, localEditGeneration: 1,
    elements: { undoButton: {}, redoButton: {} },
  }, ['trimHistoryStacks', 'updateHistoryButtons']);
  for (const name of ['HISTORY_MEMORY_LIMIT', 'HISTORY_STEP_LIMIT']) {
    vm.runInContext(source.match(new RegExp(`const ${name} = [^;]+;`))[0], ctx);
  }
  return ctx;
}

test('small reports retain 100 nearest steps across undo and redo', () => {
  const ctx = historyHarness();
  ctx.undoStack = Array.from({ length: 105 }, (_, i) => `undo-${i}`);
  ctx.updateHistoryButtons();
  assert.equal(ctx.undoStack.length, 100);
  assert.equal(ctx.undoStack[0], 'undo-5');
  assert.equal(ctx.elements.undoButton.disabled, false);
  assert.equal(ctx.elements.redoButton.disabled, true);
  ctx.redoStack = Array.from({ length: 20 }, (_, i) => `redo-${i}`);
  ctx.updateHistoryButtons();
  assert.equal(ctx.undoStack.length + ctx.redoStack.length, 100);
  assert.equal(ctx.undoStack.at(-1), 'undo-104');
  assert.equal(ctx.redoStack.at(-1), 'redo-19');
});

test('large snapshots use a memory budget instead of multiplying attachments by 100', () => {
  const ctx = historyHarness();
  const snapshot = 'data:application/octet-stream;base64,' + 'A'.repeat(1024 * 1024);
  ctx.historyCurrent = snapshot;
  ctx.undoStack = Array.from({ length: 100 }, (_, i) => snapshot + i);
  ctx.updateHistoryButtons();
  const bytes = 2 * (ctx.historyCurrent.length + ctx.undoStack.reduce((sum, value) => sum + value.length, 0));
  assert.ok(bytes <= 32 * 1024 * 1024);
  assert.equal(ctx.undoStack.at(-1), snapshot + 99);
});

test('oversized reports always keep their nearest undo and redo snapshots intact', () => {
  const ctx = historyHarness();
  const snapshot = JSON.stringify({ intro: 'A'.repeat(17 * 1024 * 1024) });
  ctx.historyCurrent = snapshot;
  ctx.undoStack = [snapshot + 'old', snapshot + 'previous'];
  ctx.redoStack = [snapshot + 'far', snapshot + 'next'];
  ctx.updateHistoryButtons();
  assert.deepEqual(Array.from(ctx.undoStack), [snapshot + 'previous']);
  assert.deepEqual(Array.from(ctx.redoStack), [snapshot + 'next']);
  assert.equal(ctx.historyCurrent, snapshot);
  assert.equal(ctx.elements.undoButton.disabled, false);
  assert.equal(ctx.elements.redoButton.disabled, false);
});

test('switching reports or editing invalidates the cached full history copy', () => {
  const ctx = historyHarness();
  ctx.savedContentForHistory = { draft: {}, generation: 1, content: 'Old report' };
  ctx.updateHistoryButtons();
  assert.equal(ctx.savedContentForHistory, null);
  ctx.savedContentForHistory = { draft: ctx.draft, generation: 0, content: 'Old edit' };
  ctx.updateHistoryButtons();
  assert.equal(ctx.savedContentForHistory, null);
  const valid = { draft: ctx.draft, generation: 1, content: 'Current edit' };
  ctx.savedContentForHistory = valid;
  ctx.updateHistoryButtons();
  assert.equal(ctx.savedContentForHistory, valid);
});
