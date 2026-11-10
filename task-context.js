(function (root, factory) {
  const links = typeof module === "object" && module.exports ? require("./tracker-links") : root.QaReportTrackerLinks;
  const api = factory(links);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.QaReportTaskContext = api;
})(typeof self !== "undefined" ? self : globalThis, function (links) {
  "use strict";
  const text = (value, max = 500) => typeof value === "string" ? value.trim().slice(0, max) : "";
  function task(value) {
    if (!value || typeof value !== "object") return null;
    const parsed = links.parse(value.issueUrl);
    if (!parsed) return null;
    return { issueUrl: parsed.issueUrl, key: parsed.key, summary: text(value.summary),
      typeName: text(value.typeName, 120), projectKey: text(value.projectKey, 120) || links.projectKey(parsed.key) };
  }
  function normalize(value, issueUrl) {
    const result = task(value), current = links.parse(issueUrl);
    if (!result || !current || result.issueUrl !== current.issueUrl) return null;
    const related = item => {
      const result = task(item), parsed = result && links.parse(result.issueUrl);
      return parsed && parsed.baseUrl === current.baseUrl && parsed.provider === current.provider
        && result.issueUrl !== current.issueUrl ? result : null;
    };
    const parent = related(value.parent), seen = new Set([current.issueUrl, parent?.issueUrl]);
    const ancestors = (Array.isArray(value.ancestors) ? value.ancestors : []).slice(0, 8).flatMap(item => {
      const next = related(item);
      if (!next || seen.has(next.issueUrl)) return [];
      seen.add(next.issueUrl); return [next];
    });
    return { ...result, parent, ancestors, ...(value.parentSource === "manual" ? { parentSource: "manual" } : {}) };
  }
  function forReport(report) {
    const source = report?.document || report || {};
    const info = Object.hasOwn(source, "taskInfo") ? source.taskInfo : report?.taskInfo;
    return normalize(info, source.issueUrl ?? report?.issueUrl);
  }
  function label(value) { return value ? [value.key, value.summary].filter(Boolean).join(" · ") : ""; }
  return { task, normalize, forReport, label };
});
