const test = require('node:test');
const assert = require('node:assert/strict');
const { selectByStatus, moveRows, deleteRows } = require('../checklist-selection');
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
