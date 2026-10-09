"use strict";
const { createService } = require("./jira-issues");
// Jira continues to use the signed-in user's configured OAuth connection.
// Connect credentials are limited to speech and AI, never corporate Jira.
function createBugReportService({ readJson, sendJson, requireUser, verifyCsrf, jiraConnection, jiraFetch, directory, audit }) {
  const execute = createService({ configuredJira: connection => connection, jiraFetch, directory });
  const pending = new Map();
  return async function handle(request, response) {
    const route = new URL(request.url, "http://localhost").pathname.match(/^\/api\/jira\/(issue-projects|issue-context|issue-fields|issue-options|create-issue|issue-evidence)$/);
    if (request.method !== "POST" || !route) return false;
    const user = requireUser(request), body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw Object.assign(new Error("Заполните форму баг-репорта"), { status: 422 });
    if (!verifyCsrf(request, body.csrfToken)) throw Object.assign(new Error("Недействительный защитный токен"), { status: 403 });
    const connection = { ...jiraConnection(request, body), user };
    const keys = ["mode", "projectKey", "parent", "issueTypeId", "fieldId", "query", "fields", "operationId", "issueKey", "attachmentIds", "placements"];
    const payload = Object.fromEntries(keys.filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]]));
    if (JSON.stringify(payload).length > 200000) throw Object.assign(new Error("Форма баг-репорта слишком большая"), { status: 413 });
    const action = route[1], key = JSON.stringify([user, connection.id, payload.operationId]);
    // Serialize identical operations before the metadata fetch to prevent duplicate creates.
    const previous = action === "create-issue" ? pending.get(key) : null;
    const operation = (async () => {
      if (previous) await previous.catch(() => {});
      return execute(connection, action, payload);
    })();
    if (action === "create-issue") pending.set(key, operation);
    try {
      const result = await operation;
      audit(request, response, `jira_${action.replaceAll("-", "_")}`);
      sendJson(response, 200, result);
    } finally { if (pending.get(key) === operation) pending.delete(key); }
    return true;
  };
}
module.exports = { createBugReportService };
