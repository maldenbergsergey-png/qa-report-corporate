const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const jira = require('../jira-markup-import');
const imports = require('../import-options');
const table = require('../checklist-table');
const report = require('../report-file');
const ChecklistNumbering = require('../checklist-numbering');
const blocked = 'ЗАБЛОКИРОВАНО';
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');

test('blocked imports retain their status in metadata, ordinary tables and headerless fragments', () => {
  for (const label of [blocked, 'Заблокировано', 'Blocked', '{color:#505f79}*ЗАБЛОКИРОВАНО*{color}']) {
    assert.deepEqual(jira.matchStatus(label), { status: blocked, certain: true });
    const parsed = jira.parseJiraMarkup(`ТЕСТ — ${label}\n||Проверка||Статус||\n|Dependent check|${label}|`);
    assert.equal(parsed.overallStatus, blocked);
    assert.equal(parsed.sections[0].rows[0].status, blocked);
    const state = imports.create(parsed);
    assert.equal(imports.summary(parsed, state).unresolved, 0);
    assert.equal(imports.build(parsed, state).sections[0].rows[0].status, blocked);
    const fragment = jira.parseJiraMarkup(`|1.1|Dependent check|${label}|`, [], { allowHeaderlessRows: true });
    assert.equal(fragment.sections[0].headerless.statusColumn, true);
    assert.equal(fragment.sections[0].rows[0].status, blocked);
  }
});

test('blocked checks sort immediately after failures without changing their original order', () => {
  const rows = ['НЕ ПРОВЕРЕНО', blocked, 'OK', 'НЕ ОК', blocked].map((status, id) => ({ id, status }));
  assert.deepEqual(table.visibleRows({ statusSort: true, rows }).map(row => row.id), [3, 1, 4, 2, 0]);
  assert.deepEqual(rows.map(row => row.id), [0, 1, 2, 3, 4]);
});

test('blocked outcomes survive portable report validation and archive roundtrip', async () => {
  const document = { schemaVersion: 3, issueUrl: '', environment: '', overallStatus: blocked,
    intro: '', numberingMode: 'hierarchical', sections: [{ id: 'section', title: 'Dependencies',
      columns: [{ id: 'check', title: 'Check' }], rows: [{ id: 'row', status: blocked, cells: { check: '' } }] }] };
  const projected = report.documentFields(document);
  const bytes = new TextEncoder().encode(JSON.stringify(projected));
  const manifest = { format: 'qa-report', version: 1, documentHash: await report.hash(bytes), attachments: [] };
  const archive = report.zip(new Map([['manifest.json', new TextEncoder().encode(JSON.stringify(manifest))], ['report.json', bytes]]));
  const files = report.unzip(new Uint8Array(await archive.arrayBuffer()));
  assert.equal(await report.hash(files.get('report.json')), manifest.documentHash);
  const restored = report.documentFields(JSON.parse(new TextDecoder().decode(files.get('report.json'))));
  assert.equal(restored.overallStatus, blocked);
  assert.equal(restored.sections[0].rows[0].status, blocked);
});

test('blocked checks, including empty cells, publish and export with their own status and styling', () => {
  const draft = { numberingMode: 'hierarchical', issueUrl: '', environment: '', overallStatus: blocked, intro: '', sections: [
    { id: 'section', title: 'Dependencies', columns: [{ id: 'text', title: 'Check' }], rows: [
      { id: 'row', status: blocked, cells: { text: '' } },
      { id: 'other', status: 'OK', cells: { text: 'Ready' } },
    ] },
  ] };
  const context = vm.createContext({ draft, ChecklistNumbering, collectDocumentFields() {},
    htmlToText: text => text, htmlToWiki: text => text, jiraCell: text => text, htmlToSpreadsheetText: text => text,
    htmlToAdfBlocks: text => [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
  const functions = ['escapeWikiNotEquals', 'sectionsForPublication', 'generateMarkup', 'hasRowContent', 'xlsxEscape', 'columnName', 'escapeHtml',
    'createSharedStringStore', 'xlsxCell', 'xlsxRow', 'estimateXlsxRowHeight', 'getXlsxStatusStyle',
    'buildXlsxWorksheet', 'xlsxStylesXml'];
  if (/^function generateAdfDocument\(/m.test(source)) functions.push('generateAdfDocument', 'adfText', 'adfParagraph');
  const code = ['STATUS_META', 'XLSX_STATUS_STYLES'].map(name => {
    const match = source.match(new RegExp(`^const ${name} = \\{[\\s\\S]*?^\\};`, 'm'));
    assert.ok(match); return match[0];
  }).concat(functions.map(name => {
    const match = source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'));
    assert.ok(match); return match[0];
  })).join('\n');
  vm.runInContext(code, context);
  const markup = context.generateMarkup({ statuses: [blocked] });
  assert.match(markup, /ТЕСТ — ЗАБЛОКИРОВАНО/);
  assert.match(markup, /\|1\.1\|\|\{color:#505f79\}\*ЗАБЛОКИРОВАНО\*/);
  assert.doesNotMatch(markup, /Ready/);
  if (context.generateAdfDocument) {
    const adf = context.generateAdfDocument({ statuses: [blocked] });
    const serialized = JSON.stringify(adf);
    assert.match(serialized, /ЗАБЛОКИРОВАНО/);
    assert.match(serialized, /#505f79/);
    assert.doesNotMatch(serialized, /Ready/);
  }
  const { sheetXml, sharedStringsXml } = context.buildXlsxWorksheet();
  assert.match(sharedStringsXml, /ЗАБЛОКИРОВАНО/);
  const styleId = context.getXlsxStatusStyle(blocked);
  assert.notEqual(styleId, context.getXlsxStatusStyle('НЕ ПРОВЕРЕНО'));
  assert.equal([...sheetXml.matchAll(new RegExp(`s="${styleId}"`, 'g'))].length, 2);
  const styles = context.xlsxStylesXml();
  const cellStyles = styles.match(/<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/);
  const entries = [...cellStyles[2].matchAll(/<xf\b[^>]*>/g)];
  assert.equal(entries.length, Number(cellStyles[1]));
  assert.match(entries[styleId][0], /fillId="13"/);
  assert.match(styles, /FFE9EDF2/);
});
