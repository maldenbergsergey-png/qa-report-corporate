const test = require('node:test');
const assert = require('node:assert/strict');
const tags = require('../checklist-tags');
const imports = require('../import-options');
const jira = require('../jira-markup-import');
const selection = require('../checklist-selection');
const files = require('../report-file');
const fixture = () => ({ schemaVersion: 3, numberingMode: "section", issueUrl: '', environment: '', overallStatus: '', intro: '', sections: [{
  id: 's', title: 'Проверки', columns: [{ id: 'check', title: 'Проверка' }, { id: 'tags', title: 'Команда', type: 'tags' }],
  rows: [
    { id: 'backend', status: 'НЕ ОК', cells: { check: 'API', tags: tags.html(['Backend']) } },
    { id: 'front', status: 'OK', cells: { check: 'Экран', tags: tags.html(['Frontend']) } },
    { id: 'mixed', status: 'НЕ ОК', cells: { check: 'Интеграция', tags: tags.html(['Backend', 'Frontend']) } },
    { id: 'plain', status: 'OK', cells: { check: 'Без меток', tags: '' } },
  ],
}] });

test('free names retain punctuation and Unicode while HTML stays inert', () => {
  const names = ['Backend', 'Нужна аналитика', 'API | [v2]; x,y', '<img src=x onerror=alert(1)>', '" & &#39; {code} * _', 'Форма 🧪'];
  const html = tags.html(names);
  assert.deepEqual(tags.read(html), names);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.deepEqual(tags.unique([' Backend ', 'backend', 'Нужна  аналитика', 'Нужна аналитика']), ['Backend', 'Нужна аналитика']);
  assert.deepEqual(tags.read('<p>Backend</p><p>Нужна аналитика</p>'), ['Backend', 'Нужна аналитика']);
});
test('inclusion uses any matching tag, exclusion wins, and untagged rows are explicit', () => {
  const rows = fixture().sections[0].rows;
  const ids = scope => rows.filter(row => tags.matches(row, scope)).map(row => row.id);
  assert.deepEqual(ids({}), ['backend', 'front', 'mixed', 'plain']);
  assert.deepEqual(ids({ include: ['Frontend'], exclude: ['BACKEND'], untagged: false }), ['front']);
  assert.deepEqual(ids({ include: ['Frontend'], exclude: ['Backend'], untagged: true }), ['front', 'plain']);
  assert.deepEqual(ids({ exclude: ['Backend'] }), ['front', 'plain']);
  assert.deepEqual(ids({ include: ['Backend', 'Frontend'], untagged: false }), ['backend', 'front', 'mixed']);
});
test('hiding a column and filtering never mutate the source or erase tag data', () => {
  const source = fixture(), before = JSON.stringify(source);
  const result = tags.filter(source.sections, { exclude: ['Backend'], showTags: false });
  assert.deepEqual(result[0].columns.map(column => column.id), ['check']);
  assert.deepEqual(result[0].rows.map(row => row.id), ['front', 'plain']);
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual(tags.read(result[0].rows[0].cells.tags), ['Frontend']);
});
test('import filters original tags before resetting statuses and omitting the tag column', () => {
  const source = fixture(), before = JSON.stringify(source), state = imports.create(source);
  state.tagFilter = { include: ['Frontend'], exclude: ['Backend'], untagged: false };
  state.resetStatuses = true; state.columns.set(imports.key('s', 'tags'), 'omit');
  const result = imports.build(source, state);
  assert.deepEqual(result.sections[0].rows.map(row => row.id), ['front']);
  assert.equal(result.sections[0].rows[0].status, 'НЕ ПРОВЕРЕНО');
  assert.deepEqual(Object.keys(result.sections[0].rows[0].cells), ['check']);
  assert.equal(JSON.stringify(source), before);
});
test('markup import recognizes a tag column and keeps distinct names at line boundaries', () => {
  const source = jira.parseJiraMarkup('||Номер||Проверка||Метки||Статус||\n|1|API|{color:#505f79}Backend{color}\\\\Нужна аналитика|НЕ ОК|');
  const section = source.sections[0], column = section.columns.find(tags.isColumn);
  assert.ok(column);
  assert.deepEqual(tags.read(section.rows[0].cells[column.id]), ['Backend', 'Нужна аналитика']);
});
test('portable documents keep column type and exact tag names', () => {
  const source = fixture(), restored = files.documentFields(source);
  assert.equal(restored.sections[0].columns[1].type, 'tags');
  assert.deepEqual(tags.rowNames(restored.sections[0].rows[2]), ['Backend', 'Frontend']);
});
test('copying rows matches renamed tag columns without turning ordinary text into tags', () => {
  const source = fixture().sections[0];
  const target = { id: 'target', title: 'Назначение', columns: [{ id: 'text', title: 'Команда' }, { id: 'labels', title: 'Область', type: 'tags' }], rows: [] };
  let serial = 0;
  selection.copyRows([source, target], new Set(['mixed']), target.id, () => 'new-' + ++serial);
  assert.equal(target.columns.filter(tags.isColumn).length, 1);
  assert.deepEqual(tags.read(target.rows[0].cells.labels), ['Backend', 'Frontend']);
  assert.equal(target.rows[0].cells.text, '');
  assert.deepEqual(tags.rowNames(source.rows[2]), ['Backend', 'Frontend']);
});

test('wiki formatting characters remain literal in tag names', () => {
  const names = ['API | [v2]; x,y', 'a \\ b', '{code} x {code}', 'Подсказка *x* _y_ +z+ !image! <x> & \"'];
  const markup = '||Проверка||Метки||Статус||\n|API|' + names.map(value => '{color:#505f79}' + tags.wiki(value) + '{color}').join('\\\\ ') + '|OK|';
  const imported = jira.parseJiraMarkup(markup).sections[0];
  const column = imported.columns.find(tags.isColumn);
  assert.deepEqual(tags.read(imported.rows[0].cells[column.id]), names);
});

test('tag names survive the existing corporate and portable HTML sanitizer', () => {
  const names = ['Backend', 'Нужна аналитика', '<x> & \"'];
  const safeHtml = tags.html(names).replace(/ data-(?:qa-tag|tone)="[^"]*"/g, '');
  assert.deepEqual(tags.rowNames({ cells: { labels: safeHtml } }), names);
});
