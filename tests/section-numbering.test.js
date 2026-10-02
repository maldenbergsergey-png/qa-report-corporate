const test = require('node:test');
const assert = require('node:assert/strict');
const N = require('../checklist-numbering');
const S = require('../checklist-selection');
const O = require('../import-options');
const J = require('../jira-markup-import');
const F = require('../report-file');
let serial = 0;
const id = () => `new-${++serial}`;
const fixture = () => ({ schemaVersion: 3, issueUrl: '', environment: 'STAGE', overallStatus: 'OK', intro: '', numberingMode: 'hierarchical', sections: [
  { id: 'a', title: 'First', columns: [{ id: 'check', title: 'Check' }], rows: [{ id: 'a1', status: 'OK', cells: { check: 'A' } }] },
  { id: 'b', title: 'Second', columns: [{ id: 'check', title: 'Check' }, { id: 'detail', title: 'Details' }], rows: [
    { id: 'b1', status: 'НЕ ОК', cells: { check: 'B', detail: '<img src="data:image/png;base64,abc">' } },
    { id: 'b2', status: 'OK', cells: { check: 'C', detail: '' } },
  ] },
] });
const manual = () => { const doc = fixture(); N.setSectionMode(doc, 'manual'); doc.sections[0].manualNumber = '4'; doc.sections[1].manualNumber = '8'; return doc; };

test('old documents use positional sections; manual sections stay stable after reordering, deletion and JSON reload', () => {
  const doc = fixture();
  assert.deepEqual([...N.sectionNumbers(doc).values()], ['1', '2']);
  N.setSectionMode(doc, 'manual');
  assert.deepEqual(doc.sections.map(s => s.manualNumber), ['1', '2']);
  doc.sections.reverse();
  assert.deepEqual([...N.sectionNumbers(doc).values()], ['2', '1']);
  doc.sections.shift();
  doc.sections.push({ ...structuredClone(doc.sections[0]), id: 'fresh', manualNumber: '' });
  assert.deepEqual([...N.sectionNumbers(JSON.parse(JSON.stringify(doc))).values()], ['1', '']);
  N.setSectionMode(doc, 'automatic');
  assert.deepEqual([...N.sectionNumbers(doc).values()], ['1', '2']);
  N.setSectionMode(doc, 'manual');
  assert.deepEqual(doc.sections.map(s => s.manualNumber), ['1', '2']);
});

test('hierarchical points use actual section labels while row and section manual modes stay independent', () => {
  const doc = manual();
  assert.deepEqual([...N.rowNumbers(doc).values()], ['4.1', '8.1', '8.2']);
  N.setMode(doc, 'manual');
  doc.sections[1].manualNumber = '12';
  assert.equal(N.sectionTitle(doc, doc.sections[1]), '12. Second');
  assert.deepEqual([...N.rowNumbers(doc).values()], ['4.1', '8.1', '8.2']);
  N.setMode(doc, 'hierarchical');
  assert.deepEqual([...N.rowNumbers(doc).values()], ['4.1', '12.1', '12.2']);
  doc.sections[1].manualNumber = '';
  assert.equal(N.sectionTitle(doc, doc.sections[1]), 'Second');
  assert.deepEqual([...N.rowNumbers(doc).values()], ['4.1', '1', '2']);
});

for (const preserveRows of [false, true]) for (const preserveSections of [false, true]) {
  test(`copy independently preserves rows=${preserveRows} and sections=${preserveSections} before IDs change`, () => {
    const doc = manual(), before = structuredClone(doc), selected = new Set(['b2']);
    const next = { ...doc, sections: S.copySelection(doc.sections, selected, id, {
      grouping: 'sections', rowNumbers: preserveRows ? N.rowNumbers(doc) : null,
      sectionNumbers: preserveSections ? N.sectionNumbers(doc) : null,
    }) };
    N.configureImport(next, preserveRows, doc.numberingMode, preserveSections);
    assert.equal(next.sectionNumberingMode, preserveSections ? 'manual' : 'automatic');
    assert.equal(N.sectionTitle(next, next.sections[0]), `${preserveSections ? '8' : '1'}. Second`);
    assert.deepEqual([...N.rowNumbers(next).values()], [preserveRows ? '8.2' : preserveSections ? '8.1' : '1.1']);
    assert.notEqual(next.sections[0].id, doc.sections[1].id);
    assert.notEqual(next.sections[0].rows[0].id, 'b2');
    assert.deepEqual(doc, before);
  });
}

test('row-only copy merges different schemas, rich content and statuses without carrying a source section label', () => {
  const doc = manual(), before = structuredClone(doc);
  const next = { ...doc, sections: S.copySelection(doc.sections, new Set(['a1', 'b1']), id, {
    grouping: 'rows', title: 'Retest', rowNumbers: N.rowNumbers(doc), sectionNumbers: N.sectionNumbers(doc),
  }) };
  N.configureImport(next, true, doc.numberingMode, false);
  assert.equal(next.sections.length, 1);
  assert.equal(N.sectionTitle(next, next.sections[0]), '1. Retest');
  assert.deepEqual(next.sections[0].columns.map(c => c.title), ['Check', 'Details']);
  assert.deepEqual(next.sections[0].rows.map(r => r.status), ['OK', 'НЕ ОК']);
  assert.match(next.sections[0].rows[1].cells.detail, /data:image/);
  assert.deepEqual([...N.rowNumbers(next).values()], ['4.1', '8.1']);
  assert.deepEqual(doc, before);
});

test('numbered Jira headings retain source labels independently from point numbers', () => {
  const source = J.parseJiraMarkup('h2. 4. First\n||Номер||Check||Статус||\n|4.3|A|OK|\nh2. 8. Second\n||Номер||Check||Статус||\n|8.7|B|OK|');
  assert.deepEqual(source.sections.map(s => s.manualNumber), ['4', '8']);
  N.configureImport(source, false, 'hierarchical', true);
  assert.deepEqual([...N.rowNumbers(source).values()], ['4.1', '8.1']);
  const recount = structuredClone(source); N.configureSectionImport(recount, false);
  assert.deepEqual([...N.rowNumbers(recount).values()], ['1.1', '2.1']);
  assert.equal(J.sectionNumberFromTitle('2026. Report'), undefined);
  assert.equal(J.sectionNumberFromTitle('2FA check'), undefined);
});

test('adding numbered sections freezes existing section labels; merging points retains the destination number', () => {
  const current = fixture(), original = structuredClone(current);
  const source = manual();
  const plan = O.planAddition(current, source, { mode: 'sections', afterId: 'start', preserveSectionNumbers: true }, id);
  assert.deepEqual([...N.sectionNumbers(plan.document).values()], ['4', '8', '1', '2']);
  assert.deepEqual(current, original);
  const merged = O.planAddition(manual(), source, { mode: 'rows', targetId: 'b', preserveSectionNumbers: true }, id);
  assert.equal(N.sectionNumbers(merged.document).get('b'), '8');
  assert.equal(N.rowNumbers(merged.document).get(merged.rowIds[0]), '8.3');
  const recounted = O.planAddition(current, source, { mode: 'sections' }, id);
  assert.deepEqual([...N.sectionNumbers(recounted.document).values()], ['1', '2', '3', '4']);
});

test('.report preserves manual section labels and remains compatible with reports without the new fields', async () => {
  const doc = manual(), projected = F.documentFields(doc);
  assert.equal(projected.sectionNumberingMode, 'manual');
  assert.equal(projected.sections[1].manualNumber, '8');
  const bytes = new TextEncoder().encode(JSON.stringify(projected));
  const manifest = { format: 'qa-report', version: 1, documentHash: await F.hash(bytes), attachments: [] };
  const archive = F.zip(new Map([['manifest.json', new TextEncoder().encode(JSON.stringify(manifest))], ['report.json', bytes]]));
  const unpacked = F.unzip(new Uint8Array(await archive.arrayBuffer()));
  const restored = F.documentFields(JSON.parse(new TextDecoder().decode(unpacked.get('report.json'))));
  assert.equal(restored.sections[1].manualNumber, '8');
  assert.equal(F.documentFields(fixture()).sectionNumberingMode, undefined);
  const invalid = manual(); invalid.sectionNumberingMode = 'unsafe'; assert.throws(() => F.documentFields(invalid));
  invalid.sectionNumberingMode = 'manual'; invalid.sections[0].manualNumber = {}; assert.throws(() => F.documentFields(invalid));
});
