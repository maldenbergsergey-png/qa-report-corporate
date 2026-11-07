const test = require('node:test');
const assert = require('node:assert/strict');
const { plan, scrollOffset, scrollState } = require('../shared-table-layout');

const layout = (overrides = {}) => plan({ viewportWidth: 1200, pointWidth: 42, dataMinWidth: 190,
  pinnedWidths: [125, 180, 280], pinColumns: true,
  sections: [{ columnCount: 8 }, { columnCount: 2 }, { columnCount: 0 }], ...overrides });

test('mixed column counts share a right edge while narrow sections retain their visible data', () => {
  const { canvasWidth, sections } = layout();
  assert.equal(canvasWidth, 2147);
  assert.ok(sections.every(section => section.width === canvasWidth));
  assert.equal(sections[0].overflow, 947);
  assert.equal(sections[1].overflow, 0);
  for (const scroll of [0, 250, 946.5, 947]) {
    const narrow = sections[1];
    assert.equal(narrow.dataWidth - scroll + scrollOffset(narrow, scroll), 615);
    assert.equal(scrollOffset(sections[0], scroll), 0);
  }
});

test('each section stops scrolling at its own last column rather than following a wider section', () => {
  const { sections } = layout({ sections: [{ columnCount: 12 }, { columnCount: 5 }] });
  const shorter = sections[1];
  const scroll = shorter.overflow + 300;
  assert.equal(scrollOffset(shorter, scroll), 300);
  assert.equal(shorter.dataWidth - scroll + scrollOffset(shorter, scroll), 615);
});

test('hidden wide sections no longer impose their width and empty filter results remain finite', () => {
  const result = layout({ sections: [{ columnCount: 20, hidden: true }, { columnCount: 2 }] });
  assert.equal(result.canvasWidth, 1200);
  assert.equal(result.sections[1].spacerWidth, 0);
  assert.equal(layout({ sections: [] }).canvasWidth, 1200);
  assert.equal(layout({ sections: [{ columnCount: 20, hidden: true }] }).canvasWidth, 1200);
});

test('column widths fit their table, preserve a readable minimum and handle zero columns', () => {
  for (const viewportWidth of [700, 1200, 1920]) {
    const result = layout({ viewportWidth, sections: Array.from({ length: 33 }, (_, columnCount) => ({ columnCount })) });
    for (const section of result.sections) {
      assert.ok(Math.abs(section.dataWidth + section.spacerWidth + 585 - section.width) < 0.001);
      assert.ok(section.spacerWidth >= 0);
      if (section.columnCount) assert.ok(section.columnWidth >= 190);
      assert.equal(scrollOffset(section, -1), 0);
    }
  }
});

test('side view reserves only the QA status and mobile tables stop at their own right edge', () => {
  const side = layout({ pinnedWidths: [125] });
  assert.equal(side.canvasWidth, 1687);
  assert.equal(side.sections[1].dataWidth, 1075);
  const mobile = layout({ viewportWidth: 366, pinnedWidths: [125, 160, 220], pinColumns: false });
  assert.ok(mobile.sections[0].width > mobile.sections[1].width);
  const scroll = mobile.canvasWidth - 366;
  for (const section of mobile.sections) {
    assert.ok(Math.abs(section.width - scroll + scrollOffset(section, scroll) - 366) < 0.001);
  }
});


test('shadows describe hidden columns of each section, including scroll boundaries', () => {
  const { sections } = layout();
  const [wide, narrow, empty] = sections;
  assert.deepEqual(scrollState(wide, 0), { offset: 0, hiddenLeft: false, hiddenRight: true });
  assert.deepEqual(scrollState(wide, 400), { offset: 0, hiddenLeft: true, hiddenRight: true });
  assert.deepEqual(scrollState(wide, wide.overflow), { offset: 0, hiddenLeft: true, hiddenRight: false });
  for (const section of [narrow, empty]) {
    for (const scroll of [0, 400, wide.overflow]) {
      const state = scrollState(section, scroll);
      assert.equal(state.hiddenLeft, false); assert.equal(state.hiddenRight, false);
    }
  }
  assert.equal(scrollState(wide, 0.5).hiddenLeft, false);
  assert.equal(scrollState(wide, wide.overflow - 0.5).hiddenRight, false);
});
