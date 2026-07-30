const test = require("node:test");
const assert = require("node:assert/strict");
const { parseJiraMarkup } = require("../jira-markup-import");

function onlyRow(markup, attachments = []) {
  const imported = parseJiraMarkup(markup, attachments);
  assert.equal(imported.sections.length, 1);
  assert.equal(imported.sections[0].rows.length, 1);
  return {
    section: imported.sections[0],
    row: imported.sections[0].rows[0],
  };
}

test("Jira image options do not split an imported table row", () => {
  const { section, row } = onlyRow(
    [
      "h2. Регистрация",
      "||№||Проверка||Ожидаемый результат||Фактический результат||Комментарий||Статус||",
      "|18|Проверить форму|Открывается окно|!screenshot-15.png|thumbnail!|Окно закрывается корректно|*НЕ ОК*|",
    ].join("\n"),
    [
      {
        id: "70015",
        filename: "screenshot-15.png",
        content: "https://jira.example.com/secure/attachment/70015/screenshot-15.png",
        thumbnail: "https://jira.example.com/secure/thumbnail/70015/screenshot-15.png",
      },
    ],
  );

  assert.equal(section.columns.length, 4);
  assert.equal(row.status, "НЕ ОК");
  assert.match(row.cells[section.columns[2].id], /class="cell-image"/);
  assert.match(row.cells[section.columns[2].id], /data-jira-name="screenshot-15\.png"/);
  assert.match(row.cells[section.columns[2].id], /data-jira-options/);
  assert.equal(row.cells[section.columns[3].id], "Окно закрывается корректно");
});

test("an unavailable Jira image remains in its source cell as a round-trip placeholder", () => {
  const { section, row } = onlyRow(
    [
      "||№||Проверка||Факт||Комментарий||Статус||",
      "|1|Проверить форму|Макет: !missing image.png|thumbnail,width=320!|Без замечаний|OK|",
    ].join("\n"),
  );

  assert.equal(row.status, "OK");
  assert.match(row.cells[section.columns[1].id], /class="jira-image-placeholder"/);
  assert.match(row.cells[section.columns[1].id], /data-jira-name="missing image\.png"/);
  assert.match(row.cells[section.columns[1].id], /data-jira-options="thumbnail,width=320"/);
  assert.doesNotMatch(row.cells[section.columns[1].id], /\[Изображение:/);
  assert.match(row.cells[section.columns[1].id], />missing image\.png<\/span>/);
  assert.equal(row.cells[section.columns[2].id], "Без замечаний");
});

test("Jira rich text formatting is preserved in imported cells", () => {
  const { section, row } = onlyRow(
    [
      "||№||Проверка||Результат||Статус||",
      "|1|*Жирный*, _курсив_, +подчёркнутый+ и -зачёркнутый-|{{код}}, ^верхний^, ~нижний~, {color:#de350b}красный{color} и [ссылка|https://example.com/docs]|OK|",
    ].join("\n"),
  );

  const check = row.cells[section.columns[0].id];
  const result = row.cells[section.columns[1].id];
  assert.match(check, /<strong>Жирный<\/strong>/);
  assert.match(check, /<em>курсив<\/em>/);
  assert.match(check, /<u>подчёркнутый<\/u>/);
  assert.match(check, /<s>зачёркнутый<\/s>/);
  assert.match(result, /<code>код<\/code>/);
  assert.match(result, /<sup>верхний<\/sup>/);
  assert.match(result, /<sub>нижний<\/sub>/);
  assert.match(result, /<span style="color:#de350b">красный<\/span>/);
  assert.match(result, /<a href="https:\/\/example\.com\/docs"/);
});
