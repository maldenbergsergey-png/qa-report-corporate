const test = require('node:test');
const assert = require('node:assert/strict');
const report = require('../report-file');
const encode = value => new TextEncoder().encode(value);
const fixture = () => ({ schemaVersion: 3, issueUrl: 'https://jira.example/browse/QA-1', environment: 'STAGE', overallStatus: 'НЕ ОК', intro: '<p>Описание</p>', numberingMode: 'manual', token: 'secret', reportId: 'original', sections: [{ id: 'section-1', title: 'Раздел', columns: [{ id: 'check', title: 'Проверка', width: 345 }], rows: [{ id: 'row-1', manualNumber: '4.2', status: 'OK', cells: { check: 'Результат' } }] }] });
async function archive(document, change = value => value) {
  const bytes = encode(JSON.stringify(document));
  const manifest = change({ format: 'qa-report', version: 1, documentHash: await report.hash(bytes), attachments: [] });
  return report.zip(new Map([['manifest.json', encode(JSON.stringify(manifest))], ['report.json', bytes]]));
}
test('ZIP roundtrip preserves Unicode document and arbitrary binary including an empty file', async () => {
  const files = new Map([['manifest.json', encode('{}')], ['report.json', encode('Русский текст')], [`attachments/${'a'.repeat(64)}`, new Uint8Array([0, 255, 3, 128])], [`attachments/${'b'.repeat(64)}`, new Uint8Array()]]);
  const restored = report.unzip(new Uint8Array(await report.zip(files).arrayBuffer()));
  assert.deepEqual(restored, files);
});
test('corruption, truncation, trailing bytes and path traversal are rejected', async () => {
  const bytes = new Uint8Array(await (await archive(fixture())).arrayBuffer());
  const corrupt = bytes.slice(); corrupt[43] ^= 1;
  for (const value of [corrupt, bytes.slice(0, -1), new Uint8Array([...bytes, 0]), new Uint8Array(0)]) assert.throws(() => report.unzip(value));
  const unsafe = report.zip(new Map([['manifest.json', encode('{}')], ['../report.json', encode('{}')]]));
  await assert.rejects(async () => report.unzip(new Uint8Array(await unsafe.arrayBuffer())));
});
test('unsupported format and document hash fail before any DOM processing', async () => {
  await assert.rejects(report.unpack(await archive(fixture(), m => ({ ...m, version: 2 }))), /не поддерживается/);
  await assert.rejects(report.unpack(await archive(fixture(), m => ({ ...m, documentHash: '0'.repeat(64) }))), /повреждён/);
  await assert.rejects(report.unpack({ size: report.MAX_BYTES + 1 }), /250/);
});
test('document projection preserves report content and excludes credentials and source identity', () => {
  const actual = report.documentFields(fixture());
  assert.equal(actual.token, undefined); assert.equal(actual.reportId, undefined);
  assert.equal(actual.sections[0].rows[0].manualNumber, '4.2');
  assert.equal(actual.sections[0].columns[0].width, 345);
  assert.equal(actual.overallStatus, 'НЕ ОК');
});
test('invalid, duplicate and prototype-related IDs and unknown schemas are rejected', () => {
  for (const mutate of [d => d.sections[0].columns[0].id = '__proto__', d => d.sections.push(d.sections[0]), d => d.schemaVersion = 4, d => d.sections[0].rows[0].status = '<img onerror=alert(1)>', d => d.sections[0].rows[0].cells = {}]) {
    const value = fixture(); mutate(value); assert.throws(() => report.documentFields(value), /структура/);
  }
});


test('unfinished reports preserve empty metadata; invalid outcomes and empty row statuses remain rejected', () => {
  const value = fixture(); value.environment = ''; value.overallStatus = '';
  const actual = report.documentFields(value);
  assert.equal(actual.environment, ''); assert.equal(actual.overallStatus, '');
  for (const invalid of [undefined, null, 'UNKNOWN', '<img onerror=alert(1)>']) {
    assert.throws(() => report.documentFields({ ...value, overallStatus: invalid }), /структура/);
  }
  value.sections[0].rows[0].status = '';
  assert.throws(() => report.documentFields(value), /структура/);
});
