const test = require('node:test');
const assert = require('node:assert/strict');
const { selectByStatus, moveRows, copyRows, deleteRows } = require('../checklist-selection');
let nextId = 0;
const id = () => `generated-${++nextId}`;
const blank = (columns) => ({ id: id(), status: 'НЕ ПРОВЕРЕНО', cells: Object.fromEntries(columns.map((c) => [c.id, ''])) });
const columns = [{ id: 'check', title: 'Проверка' }];
const row = (id, status = 'НЕ ОК', cells = { check: id }) => ({ id, status, cells });
const section = (id, rows, cols = columns) => ({ id, title: id, columns: structuredClone(cols), rows });
const defaultSection = () => section(id(), [blank(columns), blank(columns)]);

test('status selection spans collapsed sections, includes empty rows, and supports no statuses', () => {
  const sections = [section('a', [row('1', 'OK'), row('2')]), { ...section('b', [row('3', 'НЕ ПРОВЕРЕНО'), row('4', 'ПОЧТИ ОК')]), collapsed: true }];
  assert.deepEqual([...selectByStatus(sections, new Set(['НЕ ОК', 'НЕ ПРОВЕРЕНО']))], ['2', '3']);
  assert.equal(selectByStatus(sections, new Set()).size, 0);
});

test('moving keeps visual source order, stable IDs/statuses, and leaves target selections in place', () => {
  const sections = [section('a', [row('1'), row('2')]), section('b', [row('3')]), section('target', [row('4', 'OK')])];
  const count = moveRows(sections, new Set(['3', '4', '1']), 'target', id, blank);
  assert.equal(count, 2);
  assert.deepEqual(sections[2].rows.map((r) => r.id), ['4', '1', '3']);
  assert.equal(sections[2].rows[0].status, 'OK');
  assert.deepEqual(sections[0].rows.map((r) => r.id), ['2']);
  assert.equal(sections[1].rows.length, 1);
  assert.equal(sections[1].rows[0].cells.check, '');
});

test('different schemas preserve HTML, attachments, extra columns and duplicate titles', () => {
  const rich = '<a href="https://example.com">Link</a><img src="data:image/png;base64,abc">';
  const sections = [
    section('a', [row('1', 'НЕ ОК', { check: 'A', steps: rich, extra: 'first', another: 'second' })],
      [...columns, { id: 'steps', title: 'Шаги' }, { id: 'extra', title: 'Детали' }, { id: 'another', title: 'Детали' }]),
    section('b', [row('2', 'OK', { own: 'B', stepsB: 'step B' })], [{ id: 'own', title: ' проверка ' }, { id: 'stepsB', title: 'Шаги' }]),
    section('target', [row('3', 'OK', { other: 'C' })], [{ id: 'other', title: 'ПРОВЕРКА' }]),
  ];
  moveRows(sections, new Set(['1', '2']), 'target', id, blank);
  const target = sections[2];
  assert.equal(target.columns.length, 4);
  assert.deepEqual(target.rows[1].cells, { other: 'A', steps: rich, extra: 'first', another: 'second' });
  assert.deepEqual(target.rows[2].cells, { other: 'B', steps: 'step B', extra: '', another: '' });
  assert.deepEqual(target.rows[0].cells, { other: 'C', steps: '', extra: '', another: '' });
});

test('columns introduced by later sources also exist in earlier moved rows', () => {
  const sections = [section('a', [row('1')]), section('b', [row('2', 'OK', { check: 'B', extra: 'X' })], [...columns, { id: 'extra', title: 'Extra' }]), section('target', [])];
  moveRows(sections, new Set(['1', '2']), 'target', id, blank);
  assert.deepEqual(sections[2].rows.map((r) => r.cells), [{ check: '1', extra: '' }, { check: 'B', extra: 'X' }]);
});

test('missing destination and selections already in target are no-ops', () => {
  const sections = [section('a', [row('1')])];
  const before = structuredClone(sections);
  assert.equal(moveRows(sections, new Set(['1']), 'missing', id, blank), 0);
  assert.equal(moveRows(sections, new Set(['1']), 'a', id, blank), 0);
  assert.deepEqual(sections, before);
});

test('delete uses stable IDs after sorting and preserves other rows', () => {
  const sections = [section('b', [row('3'), row('2')]), section('a', [row('1')])];
  const result = deleteRows(sections, new Set(['1', '3']), blank, defaultSection);
  assert.equal(result.count, 2);
  assert.deepEqual(result.sections[0].rows.map((r) => r.id), ['2']);
  assert.equal(result.sections[1].rows.length, 1);
  assert.equal(result.sections[1].rows[0].cells.check, '');
});

test('deleting all rows restores exactly one section and two fresh blank rows', () => {
  const result = deleteRows([section('a', [row('1')]), section('b', [row('2')])], new Set(['1', '2']), blank, defaultSection);
  assert.equal(result.count, 2);
  assert.equal(result.sections.length, 1);
  assert.equal(result.sections[0].rows.length, 2);
  assert.ok(result.sections[0].rows.every((r) => r.status === 'НЕ ПРОВЕРЕНО' && r.cells.check === '' && !['1', '2'].includes(r.id)));
});

test('stale or empty selections cannot reset or delete a report', () => {
  const sections = [section('a', [row('1')])];
  const result = deleteRows(sections, new Set(['missing']), blank, defaultSection);
  assert.equal(result.count, 0);
  assert.equal(result.sections, sections);
});

test('different column titles sharing an ID are preserved as separate fields', () => {
  const sections = [
    section('a', [row('1', 'OK', { check: 'A', shared: 'How to test' })], [...columns, { id: 'shared', title: 'Шаги' }]),
    section('b', [row('2', 'НЕ ОК', { check: 'B', shared: 'Actual value' })], [...columns, { id: 'shared', title: 'Факт' }]),
    section('target', [row('3', 'OK', { check: 'C' })]),
  ];
  moveRows(sections, new Set(['1', '2']), 'target', id, blank);
  const target = sections[2];
  const steps = target.columns.find((c) => c.title === 'Шаги').id;
  const actual = target.columns.find((c) => c.title === 'Факт').id;
  assert.notEqual(steps, actual);
  assert.deepEqual(target.rows.map((r) => [r.cells[steps], r.cells[actual]]), [
    ['', ''], ['How to test', ''], ['', 'Actual value'],
  ]);
  assert.equal(new Set(target.columns.map((c) => c.id)).size, target.columns.length);
});

test('copying selected sections preserves schemas, rich content, manual numbers and sort without mutating source', () => {
  const { copySections } = require('../checklist-selection');
  const rich = '<img src="data:image/png;base64,YQ=="><a href="https://example.test">File</a>';
  const sections = [
    { ...section('a', [{ ...row('1', 'OK', { check: rich }), manualNumber: '4.2' }, row('2')]), collapsed: true, statusSort: true },
    section('b', [row('3', 'НЕ ОК', { custom: 'B' }), row('4', 'OK', { custom: '' })], [{ id: 'custom', title: 'Details', width: 310 }]),
    section('ignored', [row('5')]),
  ];
  const before = structuredClone(sections);
  const copy = copySections(sections, new Set(['4', '3', '1', 'stale']), id);
  assert.deepEqual(sections, before);
  assert.deepEqual(copy.map(s => s.title), ['a', 'b']);
  assert.deepEqual(copy.map(s => s.rows.length), [1, 2]);
  assert.equal(copy[0].collapsed, false);
  assert.equal(copy[0].statusSort, true);
  assert.equal(copy[0].rows[0].manualNumber, '4.2');
  assert.equal(copy[0].rows[0].cells.check, rich);
  assert.equal(copy[0].rows[0].status, 'OK');
  assert.equal(copy[1].columns[0].width, 310);
  assert.deepEqual(copy[1].rows.map(r => r.cells.custom), ['B', '']);
  const oldIds = new Set(sections.flatMap(s => [s.id, ...s.rows.map(r => r.id)]));
  assert.ok(copy.flatMap(s => [s.id, ...s.rows.map(r => r.id)]).every(value => !oldIds.has(value)));
  copy[0].columns[0].title = 'Changed';
  copy[0].rows[0].cells.check = 'Changed';
  assert.deepEqual(sections, before);
  assert.deepEqual(copySections(sections, new Set(), id), []);
  assert.deepEqual(copySections(sections, new Set(['stale']), id), []);
});

for (const mode of ['section', 'continuous', 'hierarchical', 'manual']) {
  test(`selection copy can preserve original ${mode} numbers before IDs and positions change`, () => {
    const numbering = require('../checklist-numbering');
    const { copySections } = require('../checklist-selection');
    const document = { numberingMode: mode, sections: [
      section('omitted', [row('empty'), row('ignored')]),
      section('kept', [row('skip'), { ...row('chosen'), manualNumber: '7.2' }]),
      section('last', [{ ...row('last-row'), manualNumber: '' }]),
    ] };
    const before = structuredClone(document);
    const selected = new Set(['chosen', 'last-row']);
    const numbers = numbering.rowNumbers(document);
    const copy = { numberingMode: mode, sections: copySections(document.sections, selected, id, numbers) };
    numbering.configureImport(copy, true, mode);
    assert.equal(copy.numberingMode, 'manual');
    assert.deepEqual([...numbering.rowNumbers(copy).values()], [numbers.get('chosen'), numbers.get('last-row')]);
    assert.deepEqual(document, before);
    numbering.configureImport(copy, false, mode);
    assert.equal(copy.numberingMode, mode === 'manual' ? 'section' : mode);
    assert.ok(copy.sections.every(s => s.rows.every(r => !Object.hasOwn(r, 'manualNumber'))));
    assert.deepEqual([...numbering.rowNumbers(copy).values()], {
      section: ['1.', '1.'], continuous: ['1.', '2.'], hierarchical: ['1.1', '2.1'], manual: ['1.', '1.'],
    }[mode]);
  });
}

test('copying into a section preserves every source and merges schemas without sharing row objects', () => {
  const rich = '<img src="data:image/png;base64,YQ=="><a href="https://example.test">File</a>';
  const sections = [
    { ...section('a', [{ ...row('one', 'OK', { check: rich, shared: 'Steps', duplicate: 'Extra' }), manualNumber: '7.2', metadata: { value: 'original' } }],
      [...columns, { id: 'shared', title: 'Details' }, { id: 'duplicate', title: 'Details' }]), collapsed: true, statusSort: true },
    section('b', [row('two', 'НЕ ОК', { own: 'B', shared: 'Actual' })], [{ id: 'own', title: ' проверка ' }, { id: 'shared', title: 'Actual' }]),
    { ...section('target', [row('existing', 'OK', { text: 'Original' })], [{ id: 'text', title: 'ПРОВЕРКА' }]), collapsed: true },
  ];
  const before = structuredClone(sections);
  assert.equal(copyRows(sections, new Set(['two', 'one']), 'target', id), 2);
  assert.deepEqual(sections.slice(0, 2), before.slice(0, 2));
  const target = sections[2];
  assert.equal(target.collapsed, false);
  assert.equal(target.columns.length, 4);
  assert.deepEqual(target.rows.map(r => r.cells.text), ['Original', rich, 'B']);
  const details = target.columns.filter(c => c.title === 'Details').map(c => c.id);
  const actual = target.columns.find(c => c.title === 'Actual').id;
  assert.deepEqual(target.rows.map(r => [r.cells[details[0]], r.cells[details[1]], r.cells[actual]]), [
    ['', '', ''], ['Steps', 'Extra', ''], ['', '', 'Actual'],
  ]);
  assert.equal(new Set(target.columns.map(c => c.id)).size, 4);
  assert.deepEqual(target.rows.map(r => r.status), ['OK', 'OK', 'НЕ ОК']);
  assert.equal(target.rows[1].manualNumber, '7.2');
  assert.ok(target.rows.slice(1).every(r => !['one', 'two', 'existing'].includes(r.id)));
  target.rows[1].cells.text = 'Changed';
  target.rows[1].metadata.value = 'Changed';
  assert.deepEqual(sections.slice(0, 2), before.slice(0, 2));
});

test('copying to the source itself appends each selected row once with fresh IDs', () => {
  const sections = [section('a', [row('one'), row('two', 'OK')])];
  const before = structuredClone(sections[0].rows);
  assert.equal(copyRows(sections, new Set(['two', 'one']), 'a', id), 2);
  assert.deepEqual(sections[0].rows.slice(0, 2), before);
  assert.deepEqual(sections[0].rows.map(r => r.cells.check), ['one', 'two', 'one', 'two']);
  assert.equal(new Set(sections[0].rows.map(r => r.id)).size, 4);
});

test('copying includes selected target rows once after fields from other sections are merged', () => {
  const sections = [section('source', [row('one', 'OK', { extra: 'Extra' })], [{ id: 'extra', title: 'Extra' }]),
    section('target', [row('two')])];
  const before = structuredClone(sections[0]);
  assert.equal(copyRows(sections, new Set(['one', 'two']), 'target', id), 2);
  assert.deepEqual(sections[0], before);
  assert.deepEqual(sections[1].rows.map(r => r.cells), [
    { check: 'two', extra: '' }, { check: '', extra: 'Extra' }, { check: 'two', extra: '' },
  ]);
});

test('copying to a fresh empty section keeps source rows; missing destinations and stale selections are no-ops', () => {
  const sections = [section('a', [row('one')]), section('new', [], [])];
  const before = structuredClone(sections);
  for (const [selection, target] of [[new Set(['one']), 'missing'], [new Set(['stale']), 'new'], [new Set(), 'new']]) {
    assert.equal(copyRows(sections, selection, target, id), 0);
    assert.deepEqual(sections, before);
  }
  assert.equal(copyRows(sections, new Set(['one']), 'new', id), 1);
  assert.deepEqual(sections[0], before[0]);
  assert.deepEqual(sections[1].columns, columns);
  assert.equal(sections[1].rows[0].cells.check, 'one');
});
