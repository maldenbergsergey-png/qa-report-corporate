(function (root) {
  "use strict";

  const outcomes = ["OK", "НЕ ОК", "ПОЧТИ ОК", "ТРЕБУЕТ УТОЧНЕНИЯ", "ЗАБЛОКИРОВАНО", "ЧАСТИЧНО ПРОВЕРЕНО", "НЕ ПРОВЕРЕНО"];
  const replies = { fixed: "Исправлено", not_fixed: "Не исправлено", needs_clarification: "Требует уточнения",
    clarified: "Уточнено", no_changes_needed: "Изменения не требуются", deferred: "Отложено", unreviewed: "Не рассмотрено" };
  const key = (sectionId, rowId) => JSON.stringify([sectionId, rowId]);

  function requiredPoints(sections, answers, files, handoff = {}) {
    const earlier = new Map((handoff.points || []).map(item => [key(item.sectionId, item.rowId), item.status]));
    const responded = new Set(files.map(file => key(file.sectionId, file.rowId)));
    for (const ids of handoff.pending || []) responded.add(key(...ids));
    for (const answer of answers) {
      if (answer.status !== "unreviewed" || answer.comment?.trim() || answer.commentDocument?.length) responded.add(key(answer.sectionId, answer.rowId));
    }
    return sections.flatMap(section => section.rows.filter(row =>
      !["OK", "ОК", "НЕ ПРОВЕРЕНО"].includes((earlier.get(key(section.id, row.id)) || row.status).trim().toUpperCase()) || responded.has(key(section.id, row.id)))
      .map(row => [section.id, row.id]));
  }

  function review(workflow) {
    const results = new Map(workflow.results.map(item => [key(item.sectionId, item.rowId), item.status]));
    const points = new Set([...workflow.required.map(ids => key(...ids)), ...results.keys()]);
    const pending = [], issues = [];
    let passed = 0, minor = 0;
    for (const point of points) {
      const status = results.get(point);
      if (!status || status === "НЕ ПРОВЕРЕНО") pending.push(JSON.parse(point));
      else if (status === "OK") passed++;
      else {
        issues.push(JSON.parse(point));
        if (status === "ПОЧТИ ОК") minor++;
      }
    }
    const qualified = !pending.length && minor > 0 && minor === issues.length;
    return { pending, issues, passed, qualified, canFinish: qualified || !issues.length && !pending.length };
  }

  function serviceColumn(column) {
    return /^(?:retest|reply|reply-text)-[0-9a-f]{32}(?:-\d+)?$/.test(column.id);
  }

  function withoutServiceColumns(draft) {
    const sections = draft.sections.map(section => {
      const removed = new Set(section.columns.filter(serviceColumn).map(column => column.id));
      if (!removed.size) return section;
      return {
        ...section, columns: section.columns.filter(column => !removed.has(column.id)),
        rows: section.rows.map(row => ({
          ...row, cells: Object.fromEntries(Object.entries(row.cells).filter(([id]) => !removed.has(id))),
        })),
      };
    });
    return { ...draft, sections };
  }

  function effectiveResults(workflow, answers) {
    const results = new Map((workflow.handoff?.points || []).map(result => [key(result.sectionId, result.rowId), result]));
    for (const result of workflow.results) {
      const id = key(result.sectionId, result.rowId);
      results.set(id, { ...result, answer: results.get(id)?.answer });
    }
    for (const answer of answers) {
      const id = key(answer.sectionId, answer.rowId), result = results.get(id);
      if (result && (answer.status !== "unreviewed" || answer.comment)) results.set(id, { ...result,
        answer: { status: answer.status, comment: answer.comment, updatedAt: answer.updatedAt } });
    }
    return [...results.values()];
  }

  function roundId(report) {
    return report.workflow.round > 1 ? report.id + "-" + report.workflow.round : report.id;
  }

  function planMerge(draft, report, fingerprint) {
    const plan = { changes: [], skipped: [], applied: 0 };
    const sections = new Map(draft.sections.map(section => [section.id, section]));
    const rows = new Map(draft.sections.flatMap(section => section.rows.map(row => [key(section.id, row.id), row])));
    const originals = new Map(report.sections.flatMap(section => section.rows.map(row => [key(section.id, row.id), { section, row }])));
    for (const result of effectiveResults(report.workflow, report.answers)) {
      const id = key(result.sectionId, result.rowId), section = sections.get(result.sectionId), row = rows.get(id);
      const original = originals.get(id);
      const label = original?.row.number || result.rowId;
      if (!row || !original) { plan.skipped.push(label + " — пункт удалён или перемещён"); continue; }
      if (row.cells["retest-" + roundId(report)]) { plan.applied++; continue; }
      if ((row.status !== original.row.status && row.status !== result.status) || (original.row.sourceHash &&
          fingerprint(row, original.section.columns) !== original.row.sourceHash)) {
        plan.skipped.push(label + " — пункт изменился после публикации"); continue;
      }
      plan.changes.push({ section, row, result, answer: result.answer });
    }
    return plan;
  }

  function applyMerge(plan, report, html, date) {
    const suffix = " · " + date(report.workflow.finishedAt);
    for (const { section, row, result, answer } of plan.changes) {
      const put = (id, title, value) => {
        if (!section.columns.some(column => column.id === id)) section.columns.push({ id, title });
        row.cells[id] = html(value);
      };
      row.status = result.status;
      put("retest-" + roundId(report), "Ретест" + suffix, result.status + " · " + date(result.updatedAt));
      if (answer && (answer.status !== "unreviewed" || answer.comment)) {
        put("reply-" + roundId(report), "Статус ответа" + suffix, (replies[answer.status] || answer.status) + " · " + date(answer.updatedAt));
        if (answer.comment) put("reply-text-" + roundId(report), "Комментарий к ответу" + suffix, answer.comment);
      }
      if (result.comment) {
        const column = section.columns.find(column => column.type !== "tags" && (column.id === "comment" || /^комментарий( ретеста)?$/i.test(column.title)));
        const id = column?.id || "retest-comment";
        if (!column && !section.columns.some(item => item.id === id)) section.columns.push({ id, title: "Комментарий ретеста" });
        const previous = row.cells[id] || "";
        row.cells[id] = previous + (previous ? "<br>" : "") + html("Ретест · " + date(result.updatedAt) + " — " + result.comment);
      }
    }
  }
  const api = { outcomes, replies, key, requiredPoints, review, serviceColumn, withoutServiceColumns, effectiveResults, planMerge, applyMerge };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.QaReportRetest = api;
})(typeof window === "object" ? window : globalThis);
