(function (root) {
  "use strict";

  function plan({ viewportWidth, pointWidth, dataMinWidth, pinnedWidths, pinColumns, sections }) {
    const pinnedWidth = pinnedWidths.reduce((sum, width) => sum + width, 0);
    const availableDataWidth = Math.max(0, viewportWidth - pointWidth - pinnedWidth);
    const layouts = sections.map(section => {
      const columnWidth = section.columnCount ? Math.max(dataMinWidth, availableDataWidth / section.columnCount) : 0;
      const dataWidth = pointWidth + section.columnCount * columnWidth;
      return { ...section, columnWidth, dataWidth, minimumWidth: dataWidth + pinnedWidth };
    });
    const canvasWidth = Math.ceil(Math.max(viewportWidth, ...layouts.filter(section => !section.hidden).map(section => section.minimumWidth)));
    return {
      canvasWidth,
      sections: layouts.map(section => {
        const width = pinColumns ? Math.max(canvasWidth, section.minimumWidth) : Math.max(viewportWidth, section.minimumWidth);
        return { ...section, width, spacerWidth: width - section.minimumWidth,
          overflow: Math.max(0, section.minimumWidth - viewportWidth), pinColumns };
      }),
    };
  }

  function scrollOffset(section, scrollLeft) {
    return Math.max(0, scrollLeft - section.overflow);
  }

  function scrollState(section, scrollLeft) {
    const scrolled = Math.max(0, scrollLeft);
    return { offset: scrollOffset(section, scrolled),
      hiddenLeft: Math.min(scrolled, section.overflow) > 1.5,
      hiddenRight: section.pinColumns && section.overflow - scrolled > 1.5 };
  }

  // Keep the spacer next to the fixed block, including a mobile QA column
  // after the scrollable answer fields. Widths still account for every column.
  function columns({ pointWidth, columnCount, columnWidth, spacerWidth, qaWidth, answerWidths, qaPinned, pinAnswers }) {
    const order = ["point", "data", ...(qaPinned
      ? answerWidths.length && !pinAnswers ? ["answers", "spacer", "qa"] : ["spacer", "qa", "answers"]
      : ["qa", "spacer", "answers"])];
    const widths = { point: [pointWidth], data: Array(columnCount).fill(columnWidth),
      spacer: [spacerWidth], qa: [qaWidth], answers: answerWidths };
    return { order, widths: order.flatMap(part => widths[part]) };
  }

  const api = { plan, scrollOffset, scrollState, columns };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.QaReportSharedTableLayout = api;
})(typeof window === "object" ? window : globalThis);
