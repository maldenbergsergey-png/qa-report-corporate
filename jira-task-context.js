"use strict";
// Only fixed Jira API routes and validated issue keys are accepted. The caller
// supplies its existing configured connection and authenticated transport.
async function executeTaskContext(c, action, payload, jiraFetch) {
  const input = String(payload.issueKey || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(input)) throw Object.assign(new Error("Укажите ключ задачи"), { status: 422 });
  const version = c.type === "cloud" ? "3" : "2", warnings = [];
  let epicField;
  if (c.type !== "cloud") {
    try {
      const fields = await jiraFetch(c, "/rest/api/2/field");
      epicField = fields.find(f => f.schema?.custom === "com.pyxis.greenhopper.jira:gh-epic-link")?.id;
      if (epicField && !/^customfield_\d+$/.test(epicField)) epicField = undefined;
    } catch { warnings.push("Не удалось проверить связь с эпиком."); }
  }
  const fields = ["summary", "project", "issuetype", "parent", ...(epicField ? [epicField] : [])];
  const read = key => jiraFetch(c, `/rest/api/${version}/issue/${encodeURIComponent(key)}?fields=${fields.join(",")}`);
  function item(raw) {
    if (!/^[A-Z][A-Z0-9_]*-\d+$/i.test(raw?.key || "")) throw Object.assign(new Error("Jira не вернула ключ задачи"), { status: 502 });
    return { issueUrl: `${c.baseUrl}/browse/${encodeURIComponent(raw.key)}`, key: raw.key,
      summary: String(raw.fields?.summary || "").slice(0, 500), typeName: String(raw.fields?.issuetype?.name || "").slice(0, 120),
      projectKey: raw.fields?.project?.key || raw.key.replace(/-\d+$/, "") };
  }
  if (action === "issue-details") {
    let raw = await read(input);
    const task = { ...item(raw), parent: null, ancestors: [] }, seen = new Set([input]);
    for (let depth = 0; depth < 8; depth++) {
      const reference = raw.fields?.parent?.key || (epicField && raw.fields?.[epicField]);
      if (!reference || !/^[A-Z][A-Z0-9_]*-\d+$/i.test(reference) || seen.has(reference)) break;
      seen.add(reference);
      try { raw = await read(reference); }
      catch { warnings.push("Часть родительских задач недоступна. Сохраните связь вручную при необходимости."); break; }
      const next = item(raw);
      if (!task.parent) task.parent = next; else task.ancestors.push(next);
    }
    return { ok: true, task, warnings };
  }
  const parent = item(await read(input)), tasks = [], seen = new Set();
  const jql = `parent = ${input}${epicField ? ` OR cf[${epicField.slice(12)}] = ${input}` : ""} ORDER BY key ASC`;
  let startAt = 0, nextPageToken;
  for (let page = 0; page < 20; page++) {
    const result = c.type === "cloud"
      ? await jiraFetch(c, "/rest/api/3/search/jql", { method: "POST", body: JSON.stringify({ jql, fields, maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) }) })
      : await jiraFetch(c, `/rest/api/2/search?jql=${encodeURIComponent(jql)}&fields=${fields.join(",")}&startAt=${startAt}&maxResults=100`);
    if (!Array.isArray(result.issues)) throw Object.assign(new Error("Jira не вернула список задач"), { status: 502 });
    for (const raw of result.issues) { const value = item(raw); if (!seen.has(value.issueUrl)) { tasks.push(value); seen.add(value.issueUrl); } }
    startAt += result.issues.length;
    if (c.type === "cloud") {
      if (!result.nextPageToken || result.isLast === true) return { ok: true, parent, tasks };
      if (nextPageToken === result.nextPageToken) break;
      nextPageToken = result.nextPageToken;
    } else if (!result.issues.length || startAt >= result.total) return { ok: true, parent, tasks };
  }
  throw Object.assign(new Error("Список слишком большой или неполный. Выберите родительскую задачу уровнем ниже."), { status: 422 });
}
module.exports = { executeTaskContext };
