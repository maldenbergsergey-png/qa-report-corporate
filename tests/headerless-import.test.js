const test = require('node:test');
const assert = require('node:assert/strict');
const { parseJiraMarkup, configureHeaderlessSection } = require('../jira-markup-import');
const O = require('../import-options');
const parseRows = text => parseJiraMarkup(text, [], { allowHeaderlessRows: true });
const fragment = '|3.|Порядок записей|Сверить {{items}}|По возрастанию|Не проверено напрямую: нет доступа|Источник — документация|{color:#6b778c}*НЕ ПРОВЕРЕНО*{color}|';

test('cell text about environment or status is never interpreted as report metadata', () => {
  const doc = parseJiraMarkup('Окружение: PROD\nТЕСТ — НЕ ОК\n||Проверка||Окружение: DEV||Статус||\n'
    + '|Не проверено напрямую|Проверено на STAGE; Статус: OK|НЕ ПРОВЕРЕНО|\n|ТЕСТ — OK|Окружение: DEV|OK|');
  assert.equal(doc.environment, 'PROD');
  assert.equal(doc.overallStatus, 'НЕ ОК');
  assert.equal(doc.sections[0].rows.length, 2);
  assert.match(Object.values(doc.sections[0].rows[0].cells).join(''), /Не проверено напрямую/);
});

test('a numbered fragment with a colored status retains all five data cells', () => {
  const section = parseRows(fragment).sections[0];
  assert.deepEqual(section.headerless, { numberColumn: true, statusColumn: true });
  assert.equal(section.columns.length, 5);
  assert.equal(section.rows[0].manualNumber, '3.');
  assert.equal(section.rows[0].status, 'НЕ ПРОВЕРЕНО');
  assert.match(section.rows[0].cells[section.columns[1].id], /<code>items<\/code>/);
  assert.match(section.rows[0].cells[section.columns[3].id], /Не проверено напрямую/);
  assert.throws(() => parseJiraMarkup(fragment), /не найдена таблица/, 'automatic full-checklist APIs still require headers');
});

test('role choices are reversible and numeric or status-like content is never lost', () => {
  const section = parseRows('|42|Text|OK|').sections[0], before = JSON.stringify(section);
  const all = configureHeaderlessSection(section, { numberColumn: false, statusColumn: false });
  assert.equal(all.columns.length, 3);
  assert.equal(all.rows[0].manualNumber, undefined);
  assert.equal(all.rows[0].sourceStatus, '');
  assert.deepEqual(Object.values(all.rows[0].cells), ['42', 'Text', 'OK']);
  const restored = configureHeaderlessSection(all, { numberColumn: true, statusColumn: true });
  assert.deepEqual(restored, section);
  assert.equal(JSON.stringify(section), before);
});

test('rows with no numbers or statuses retain content and inconsistent widths lose no cells', () => {
  const section = parseRows('|Check|Result|\n|Other|Value|Extra|').sections[0];
  assert.deepEqual(section.headerless, { numberColumn: false, statusColumn: false });
  assert.equal(section.columns.length, 3);
  assert.deepEqual(section.rows.map(row => Object.values(row.cells)), [['Check', 'Result', ''], ['Other', 'Value', 'Extra']]);
});

test('headerless fragments retain wrapped cells, escaped delimiters, links and attachments', () => {
  const section = parseRows('|8.|Text [docs|https://example.test] !shot.png|thumbnail!|Line one\nLine two [^log.txt] a\\|b|{color:gray}*НЕ ПРОВЕРЕНО*\n{color}|').sections[0];
  assert.equal(section.columns.length, 2);
  assert.equal(section.rows[0].status, 'НЕ ПРОВЕРЕНО');
  const values = Object.values(section.rows[0].cells);
  assert.match(values[0], /href="https:\/\/example.test\/"/);
  assert.match(values[0], /jira-image-placeholder/);
  assert.match(values[1], /Line one<br>Line two/);
  assert.match(values[1], /jira-file-placeholder/);
  assert.match(values[1], /a\|b/);
});

test('explicit and headerless tables can coexist without losing sections', () => {
  const doc = parseRows('h2. First\n|1|A|OK|\nh2. Second\n||Проверка||Статус||\n|B|OK|');
  assert.equal(doc.sections.length, 2);
  assert.ok(doc.sections[0].headerless);
  assert.equal(doc.sections[1].headerless, undefined);
  assert.deepEqual(doc.sections.map(s => s.rows.length), [1, 1]);
});

test('an unknown last-column status can be explicitly recognized and mapped', () => {
  const doc = parseRows('|1|Check|Blocked|');
  assert.equal(doc.sections[0].headerless.statusColumn, false);
  doc.sections[0] = configureHeaderlessSection(doc.sections[0], { numberColumn: true, statusColumn: true });
  const state = O.create(doc);
  assert.equal(O.summary(doc, state).unresolved, 1);
  state.mapping.set('Blocked', 'ТРЕБУЕТ УТОЧНЕНИЯ');
  const result = O.build(doc, state);
  assert.equal(result.sections[0].rows[0].status, 'ТРЕБУЕТ УТОЧНЕНИЯ');
  assert.equal(result.sections[0].headerlessRows, undefined, 'raw source is not persisted');
});

test('appending headerless rows maps positions, retains existing data and respects explicit choices', () => {
  const current = parseJiraMarkup('Окружение: PROD\n||Проверка||ФР||Комментарий||Статус||\n|Existing|Result|Note|НЕ ОК|');
  current.reportId = 'report'; current.numberingMode = 'manual';
  const before = JSON.stringify(current), target = current.sections[0];
  const source = parseRows('|3|Added|New result|New note|OK|'), state = O.create(source);
  const selected = O.build(source, state), incoming = selected.sections[0];
  const placement = { mode: 'rows', targetId: target.id, preserveNumbers: true };
  const plan = O.planAddition(current, selected, placement);
  assert.equal(plan.newColumns.length, 0);
  assert.equal(plan.document.environment, 'PROD');
  assert.equal(plan.document.reportId, 'report');
  assert.equal(plan.document.sections[0].rows[1].manualNumber, '3');
  assert.deepEqual(Object.values(plan.document.sections[0].rows[1].cells), ['Added', 'New result', 'New note']);
  assert.deepEqual(plan.document.sections[0].rows[0], target.rows[0]);
  const columns = new Map([[O.key(incoming.id, incoming.columns[1].id), target.columns[2].id],
    [O.key(incoming.id, incoming.columns[2].id), target.columns[1].id]]);
  const custom = O.planAddition(current, selected, { ...placement, columns });
  assert.deepEqual(Object.values(custom.document.sections[0].rows[1].cells), ['Added', 'New note', 'New result']);
  state.columns.set(O.key(incoming.id, incoming.columns[1].id), 'omit');
  const filtered = O.planAddition(current, O.build(source, state), placement);
  assert.deepEqual(Object.values(filtered.document.sections[0].rows[1].cells), ['Added', '', 'New note']);
  assert.equal(JSON.stringify(current), before);
});
