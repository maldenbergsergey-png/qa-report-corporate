const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMode, rowNumbers, columnWidth } = require('../checklist-numbering');

function fixture(numberingMode) {
  return { numberingMode, sections: [
    { id: 'a', rows: [{ id: 'a1' }, { id: 'a2' }] },
    { id: 'b', collapsed: true, rows: [{ id: 'b1' }, { id: 'b2' }] },
    { id: 'c', rows: [{ id: 'c1' }] },
  ] };
}

test('old reports and unsupported modes retain numbering from one per section', () => {
  for (const mode of [undefined, null, 'unknown', 'section']) {
    assert.equal(normalizeMode(mode), 'section');
    assert.deepEqual([...rowNumbers(fixture(mode)).values()], ['1.', '2.', '1.', '2.', '1.']);
  }
});

test('continuous numbering includes collapsed sections and blank editable rows', () => {
  assert.deepEqual([...rowNumbers(fixture('continuous')).values()], ['1.', '2.', '3.', '4.', '5.']);
});

test('hierarchical numbering uses section order, independent of titles', () => {
  const doc = fixture('hierarchical');
  doc.sections[0].title = 'Регресс 2026';
  assert.deepEqual([...rowNumbers(doc).values()], ['1.1', '1.2', '2.1', '2.2', '3.1']);
  doc.sections.reverse();
  assert.equal(rowNumbers(doc).get('c1'), '1.1');
  assert.equal(rowNumbers(doc).get('a2'), '3.2');
});

test('moving, deleting and adding rows recalculates labels without changing their IDs', () => {
  const doc = fixture('continuous');
  doc.sections[1].rows.push(doc.sections[0].rows.shift());
  doc.sections[1].rows.splice(0, 1);
  doc.sections[0].rows.push({ id: 'new' });
  assert.deepEqual([...rowNumbers(doc)], [['a2', '1.'], ['new', '2.'], ['b2', '3.'], ['a1', '4.'], ['c1', '5.']]);
});

test('partial publication keeps original numbers; modes survive JSON round trips', () => {
  for (const mode of ['section', 'continuous', 'hierarchical']) {
    const doc = JSON.parse(JSON.stringify(fixture(mode)));
    const numbers = rowNumbers(doc);
    assert.equal(numbers.get('b2'), { section: '2.', continuous: '4.', hierarchical: '2.2' }[mode]);
  }
});

test('number column accommodates long section and row numbers', () => {
  const doc = { numberingMode: 'hierarchical', sections: Array.from({ length: 12 }, (_, section) => ({
    rows: Array.from({ length: 123 }, (_, row) => ({ id: `${section}-${row}` })),
  })) };
  assert.equal(rowNumbers(doc).get('11-122'), '12.123');
  assert.ok(columnWidth(doc) >= '12.123'.length * 8 + 28);
  assert.equal(columnWidth(fixture('section')), 52);
});
