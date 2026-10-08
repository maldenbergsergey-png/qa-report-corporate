(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.QaReportJiraPublication = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function target(value) {
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
      const match = url.pathname.match(/^(.*?)\/browse\/([A-Z][A-Z0-9_]*-\d+)\/?$/i);
      if (!match) return null;
      const baseUrl = url.origin + match[1].replace(/\/$/, "");
      const issueKey = match[2].toUpperCase();
      return { baseUrl, issueKey, issueUrl: `${baseUrl}/browse/${issueKey}` };
    } catch { return null; }
  }

  function commentUrl(issueUrl, id) {
    return `${issueUrl}?focusedCommentId=${encodeURIComponent(id)}#comment-${encodeURIComponent(id)}`;
  }

  function date(value) {
    const time = Date.parse(value || "");
    return Number.isFinite(time) ? new Date(time).toISOString() : "";
  }

  // Persist only publication metadata, never credentials or a caller-supplied URL.
  function normalize(value, reportId) {
    if (!value || value.reportId !== reportId || !Array.isArray(value.parts) || value.parts.length > 1000) return null;
    const issue = target(value.issueUrl);
    if (!issue || !["wiki", "adf"].includes(value.format)) return null;
    const parts = value.parts.map(part => part && /^\d+$/.test(String(part.commentId || "")) ? {
      commentId: String(part.commentId),
      bodyHash: /^[a-f0-9]{64}$/.test(part.bodyHash || "") ? part.bodyHash : "",
      publishedAt: date(part.publishedAt),
    } : null);
    if (!parts.some(Boolean)) return null;
    return { reportId, ...issue, format: value.format, split: Boolean(value.split), parts, updateIncomplete: Boolean(value.updateIncomplete),
      sectionIds: Array.isArray(value.sectionIds) ? value.sectionIds.filter(id => typeof id === "string") : [],
      statuses: Array.isArray(value.statuses) ? value.statuses.filter(status => typeof status === "string") : [],
      firstPublishedAt: date(value.firstPublishedAt), lastPublishedAt: date(value.lastPublishedAt) };
  }

  function matching(value, reportId, issueUrl) {
    const link = normalize(value, reportId), issue = target(issueUrl);
    return link && issue && link.issueUrl === issue.issueUrl ? link : null;
  }

  function sameComments(value, expected) {
    const current = normalize(value, expected?.reportId), previous = normalize(expected, expected?.reportId);
    return Boolean(current && previous && current.issueUrl === previous.issueUrl
      && current.format === previous.format && current.parts.length === previous.parts.length
      && previous.parts.every((part, index) => !part || part.commentId === current.parts[index]?.commentId));
  }

  function missingComment(error) {
    // Existing Connect releases send this dedicated message without an error code.
    // A generic HTTP 404 can also mean a missing route, task or connection.
    return error?.status === 404 && error.message === "Связанный комментарий удалён или недоступен. Можно опубликовать отчёт заново.";
  }

  function canonical(value) {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
  }

  function fingerprint(body) {
    const normalized = typeof body === "string" ? body.replace(/\r\n/g, "\n").trim() : canonical(body);
    return require("node:crypto").createHash("sha256")
      .update(typeof normalized === "string" ? normalized : JSON.stringify(normalized ?? null)).digest("hex");
  }

  async function updateComment(connection, issue, payload, jiraFetch) {
    const id = String(payload.commentId || "");
    if (!/^\d+$/.test(id) || !/^[a-f0-9]{64}$/.test(payload.expectedBodyHash || "")) {
      throw Object.assign(new Error("Не удалось проверить связь с комментарием. Обновите QA Report Connect или опубликуйте отчёт заново."), { status: 422 });
    }
    const version = connection.type === "cloud" ? "3" : "2";
    const path = `/rest/api/${version}/issue/${encodeURIComponent(issue.issueKey)}/comment/${encodeURIComponent(id)}`;
    let before;
    try { before = await jiraFetch(connection, path); }
    catch (error) {
      if (error.status === 404) error.message = "Связанный комментарий удалён или недоступен. Можно опубликовать отчёт заново.";
      throw error;
    }
    if (String(before?.id || "") !== id) throw Object.assign(new Error("Jira не подтвердила связанный комментарий"), { status: 502 });
    const user = await jiraFetch(connection, `/rest/api/${version}/myself`);
    const identity = value => String(value?.accountId || value?.key || value?.name || "");
    if (!identity(before.author) || identity(before.author) !== identity(user)) {
      throw Object.assign(new Error("Обновить можно только свой комментарий Jira. Опубликуйте отчёт заново от своего имени."), { status: 403 });
    }
    const nextHash = fingerprint(payload.comment.body), currentHash = fingerprint(before.body);
    if (currentHash !== nextHash && currentHash !== payload.expectedBodyHash) {
      throw Object.assign(new Error("Комментарий изменён непосредственно в Jira. Чтобы сохранить эти правки, опубликуйте отчёт заново."), { status: 409 });
    }
    if (payload.checkOnly === true) return { ok: true, verified: true, commentId: id };
    // A retry after an ambiguous PUT is safe when Jira already has this body.
    if (currentHash !== nextHash) {
      await jiraFetch(connection, path, { method: "PUT", body: JSON.stringify({
        body: payload.comment.body, ...(before.visibility ? { visibility: before.visibility } : {}),
      }) });
    }
    const verified = await jiraFetch(connection, path);
    if (String(verified?.id || "") !== id || fingerprint(verified.body) !== nextHash) {
      throw Object.assign(new Error("Jira не подтвердила обновление отчёта. Повторите обновление; новый комментарий не создаётся."), { status: 502 });
    }
    return { ok: true, verified: true, commentId: id, bodyHash: nextHash,
      publishedAt: new Date().toISOString(), issueUrl: String(issue.issueUrl),
      commentUrl: commentUrl(String(issue.issueUrl), id) };
  }

  return { target, commentUrl, normalize, matching, sameComments, missingComment, fingerprint, updateComment };
});
