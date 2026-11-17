const test = require('node:test');
const assert = require('node:assert/strict');
const { PAGE_SIZE, key, selectedSet, indexRows, matchingRows, pageRows, setRows } = require('../share-exclusions');
const fixture = () => indexRows([
  { id: 'ios', title: '1. iOS', rows: [
    { rowId: 'api', number: 'BE-7', title: 'Создание заказа', content: 'Комментарий: серверная ошибка', tags: ['Backend'] },
    { rowId: 'ui', number: '2', title: 'Поле получателя', content: 'Ожидаемый результат: расчёт доставки', tags: ['Frontend'] },
  ] },
  { id: 'android', title: '2. Android', rows: [{ rowId: 'api', number: '1', title: 'Создание заказа', content: 'Фактический результат: долгий ответ', tags: [] }] },
]);
test('search covers section, source number, every field and tags with normalized Russian spelling', () => {
  const rows = fixture(), selected = new Set();
  for (const [query, ids] of [
    ['ios', ['api', 'ui']], ['be-7', ['api']], ['СЕРВЕРНАЯ', ['api']], ['backend', ['api']],
    ['расчет доставки', ['ui']], ['заказа android', ['api']], ['unknown', []],
  ]) assert.deepEqual(matchingRows(rows, selected, { query }).map(row => row.rowId), ids);
});
test('section and selected-only filters compose without confusing equal row IDs', () => {
  const rows = fixture(), selected = selectedSet([{ sectionId: 'ios', rowId: 'api' }]);
  assert.deepEqual(matchingRows(rows, selected, { excludedOnly: true }).map(key), [key(rows[0])]);
  assert.deepEqual(matchingRows(rows, selected, { sectionId: 'android', excludedOnly: true }), []);
  assert.equal(matchingRows(rows, selected, { sectionId: 'android', query: 'заказа' }).length, 1);
});
test('large lists render bounded pages, retain canonical order, and clamp the page after narrowing', () => {
  const rows = Array.from({ length: 20000 }, (_, rowId) => ({ sectionId: 'large', rowId: String(rowId) }));
  const first = pageRows(rows), last = pageRows(rows, 10000);
  assert.equal(first.rows.length, PAGE_SIZE); assert.equal(first.total, 20000); assert.equal(first.start, 1); assert.equal(first.end, 30);
  assert.equal(last.rows.at(-1).rowId, '19999'); assert.ok(last.rows.length <= PAGE_SIZE);
  assert.equal(pageRows(rows.slice(0, 2), 100).page, 0);
  assert.deepEqual(pageRows([], 20), { rows: [], page: 0, pages: 1, start: 0, end: 0, total: 0 });
});
test('bulk actions affect all matching pages and preserve hidden selections and the saved set', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ sectionId: i < 70 ? 'one' : 'two', rowId: String(i) }));
  const saved = new Set([key(rows[99])]), matches = rows.slice(0, 70);
  const staged = setRows(saved, matches, true);
  assert.equal(staged.size, 71); assert.equal(saved.size, 1);
  const restored = setRows(staged, matches, false);
  assert.deepEqual([...restored], [...saved]);
});
test('malformed saved exclusions are ignored and IDs remain exact strings', () => {
  const selected = selectedSet([null, {}, { sectionId: 'one', rowId: 7 }, { sectionId: 'one', rowId: '7' }, { sectionId: 'one', rowId: '7' }]);
  assert.deepEqual([...selected], ['["one","7"]']);
});
