"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Bugs = require("./bug-report");
const fail = (message, status = 422, fields = {}) => Object.assign(new Error(message), { status, fieldErrors: fields });
const key = value => {
  const text = String(value || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*$/.test(text)) throw fail("Укажите ключ проекта");
  return text;
};
const typeId = value => {
  const text = String(value || ""); if (!/^\d{1,20}$/.test(text)) throw fail("Выберите тип задачи"); return text;
};
function parentKey(connection, value) {
  let text = String(value || "").trim();
  if (/^https?:/i.test(text)) {
    const url = new URL(text), base = new URL(connection.baseUrl);
    if (url.origin !== base.origin || url.username || url.password || !url.pathname.startsWith(base.pathname.replace(/\/$/, "") + "/browse/")) throw fail("Родительская задача относится к другому подключению");
    text = url.pathname.match(/\/browse\/([A-Z][A-Z0-9_]*-\d+)\/?$/i)?.[1] || "";
  }
  if (!/^[A-Z][A-Z0-9_]*-\d+$/i.test(text)) throw fail("Укажите ключ или ссылку родительской задачи");
  return text.toUpperCase();
}
function createService({ configuredJira, jiraFetch, directory }) {
  const version = c => c.type === "cloud" ? "3" : "2";
  async function pages(c, route, property) {
    const list = [];
    for (let startAt = 0, page = 0; page < 100; page++) {
      const data = await jiraFetch(c, `${route}${route.includes("?") ? "&" : "?"}startAt=${startAt}&maxResults=100`);
      const values = data[property] || data.values;
      if (!Array.isArray(values)) throw fail("Сервер не вернул список для формы создания", 502);
      list.push(...values); startAt += values.length;
      if (!values.length || data.isLast === true || (Number.isFinite(data.total) && startAt >= data.total) || (!Number.isFinite(data.total) && data.isLast === undefined)) return list;
    }
    throw fail("В проекте слишком много полей или типов задач. Уточните проект.", 502);
  }
  async function metadata(c, project, id) {
    const route = `/rest/api/${version(c)}/issue/createmeta/${encodeURIComponent(project)}/issuetypes${id ? `/${encodeURIComponent(id)}` : ""}`;
    try { return await pages(c, route, id ? "fields" : "issueTypes"); }
    catch (error) {
      // Older Data Center releases expose the same create screen through expanded metadata.
      if (![404, 405].includes(error.status) || c.type === "cloud") throw error;
      const data = await jiraFetch(c, `/rest/api/2/issue/createmeta?projectKeys=${encodeURIComponent(project)}${id ? `&issuetypeIds=${id}&expand=projects.issuetypes.fields` : ""}`);
      const types = data.projects?.find(item => item.key === project || String(item.id) === project)?.issuetypes;
      if (!Array.isArray(types)) throw fail("Нет доступа к созданию задач в этом проекте", 403);
      return id ? Object.entries(types.find(item => String(item.id) === id)?.fields || {}).map(([fieldId, field]) => ({ ...field, fieldId })) : types;
    }
  }
  async function context(c, payload) {
    let parent = null, projectKey;
    if (payload.mode === "subtask") {
      const issue = await jiraFetch(c, `/rest/api/${version(c)}/issue/${encodeURIComponent(parentKey(c, payload.parent))}?fields=project,summary,issuetype`);
      if (issue.fields?.issuetype?.subtask) throw fail("Подзадача не может быть родительской задачей");
      projectKey = key(issue.fields?.project?.key);
      parent = { key: issue.key, summary: String(issue.fields?.summary || ""), projectKey };
    } else {
      if (payload.mode !== "standalone") throw fail("Выберите самостоятельную задачу или подзадачу");
      projectKey = key(payload.projectKey);
    }
    const types = (await metadata(c, projectKey)).filter(item => Boolean(item.subtask) === (payload.mode === "subtask"))
      .map(item => ({ id: String(item.id), name: String(item.name), subtask: Boolean(item.subtask) }));
    if (!types.length) throw fail(payload.mode === "subtask" ? "В проекте нет доступных типов подзадач" : "В проекте нет доступных типов задач", 403);
    return { ok: true, projectKey, parent, types, cloud: c.type === "cloud" };
  }
  async function fields(c, payload) {
    const ctx = await context(c, payload), id = typeId(payload.issueTypeId);
    if (!ctx.types.some(item => item.id === id)) throw fail("Этот тип задачи недоступен для выбранного режима");
    const fields = (await metadata(c, ctx.projectKey, id)).map(Bugs.normalizeField).filter(Boolean);
    if (!fields.some(field => field.id === "summary")) throw fail("Сервер не вернул поле заголовка для создания задачи", 502);
    return { ...ctx, issueTypeId: id, fields: fields.filter(field => field.kind !== "context") };
  }
  async function options(c, payload) {
    const meta = await fields(c, payload), field = meta.fields.find(item => item.id === payload.fieldId);
    if (!field || !(["user", "users"].includes(field.kind) || Bugs.isLabelField(field))) throw fail("Поиск доступен только для пользователей и меток");
    const query = String(payload.query || "").trim().slice(0, 100);
    if (Bugs.isLabelField(field)) {
      if (!query || /\s/.test(query)) return { ok: true, options: [] };
      const customId = field.id.match(/^customfield_(\d+)$/)?.[1];
      const route = c.type === "cloud"
        ? `/rest/api/3/jql/autocompletedata/suggestions?fieldName=${encodeURIComponent(customId ? `cf[${customId}]` : "labels")}&fieldValue=${encodeURIComponent(query)}`
        : `/rest/api/1.0/labels/suggest?query=${encodeURIComponent(query)}${customId ? `&customFieldId=${customId}` : ""}`;
      const result = await jiraFetch(c, route), raw = c.type === "cloud" ? result.results : result.suggestions;
      if (!Array.isArray(raw)) throw fail("Сервер не вернул подсказки меток", 502);
      // Display plain label values, never the highlighted HTML supplied by Jira.
      const labels = raw.map(item => c.type === "cloud" ? item.value : item.label)
        .filter(value => typeof value === "string" && value.length <= 255 && !/\s/.test(value) && value.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
      return { ok: true, options: [...new Set(labels)].slice(0, 50).map(value => ({ value, label: value })) };
    }
    if (query.length < 2) return { ok: true, options: [] };
    const assignable = field.id === "assignee";
    const route = assignable ? "user/assignable/search" : "user/search";
    const result = await jiraFetch(c, `/rest/api/${version(c)}/${route}?${c.type === "cloud" ? "query" : "username"}=${encodeURIComponent(query)}&maxResults=50${assignable ? `&project=${encodeURIComponent(meta.projectKey)}` : ""}`);
    if (!Array.isArray(result)) throw fail("Сервер не вернул список пользователей", 502);
    return { ok: true, options: result.filter(user => user.active !== false).map(user => ({ value: String(c.type === "cloud" ? user.accountId : user.name), label: String(user.displayName || user.name || user.accountId) })) };
  }
  function recordPath(c, operationId) {
    if (!/^[a-f0-9-]{36}$/i.test(operationId || "")) throw fail("Не удалось определить операцию создания. Откройте форму снова.");
    const name = crypto.createHash("sha256").update(`${c.baseUrl}\n${c.user || ""}\n${operationId}`).digest("hex");
    return path.join(directory, "issue-operations", `${name}.json`);
  }
  function writeRecord(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" }); fs.renameSync(temporary, file); }
    finally { fs.rmSync(temporary, { force: true }); }
  }
  async function create(c, payload) {
    const file = recordPath(c, payload.operationId);
    let previous;
    try { previous = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw fail("Не удалось проверить предыдущую операцию создания", 500); }
    const digest = crypto.createHash("sha256").update(JSON.stringify({ mode: payload.mode, projectKey: payload.projectKey, parent: payload.parent, issueTypeId: payload.issueTypeId, fields: payload.fields })).digest("hex");
    if (previous) {
      if (previous.digest !== digest) throw fail("Поля предыдущей операции изменились. Проверьте результат в задаче перед новым созданием", 409);
      if (previous.result) return previous.result;
      throw fail("Результат предыдущего создания не подтверждён. Проверьте результат: повторная отправка может создать дубликат.", 409);
    }
    const meta = await fields(c, payload), values = payload.fields;
    if (!values || typeof values !== "object" || Array.isArray(values)) throw fail("Заполните поля баг-репорта");
    const permitted = new Map(meta.fields.map(field => [field.id, field]));
    const errors = {}, resultFields = { project: { key: meta.projectKey }, issuetype: { id: meta.issueTypeId }, ...(meta.parent ? { parent: { key: meta.parent.key } } : {}) };
    for (const id of Object.keys(values)) {
      const field = permitted.get(id);
      if (!field || field.kind === "unsupported") throw fail("В форме есть недоступное поле. Загрузите поля снова.");
      if (Bugs.empty(values[id])) continue;
      if (["text", "textarea"].includes(field.kind) && (typeof values[id] !== "string" || values[id].length > 32768)) errors[id] = "Слишком длинный или неподдерживаемый текст";
      else {
        try { resultFields[id] = Bugs.toJiraValue(field, values[id], meta.cloud); }
        catch (error) { errors[id] = error.message; }
      }
    }
    for (const field of meta.fields) if (field.required && !field.hasDefaultValue && Bugs.empty(values[field.id])) errors[field.id] = `Заполните «${field.name}»`;
    if (typeof resultFields.summary !== "string" || !resultFields.summary.trim() || resultFields.summary.length > 255) errors.summary = "Укажите заголовок до 255 символов";
    if (Object.keys(errors).length) throw fail("Проверьте обязательные поля", 422, errors);
    writeRecord(file, { digest, status: "sending", createdAt: new Date().toISOString() });
    let issue;
    try { issue = await jiraFetch(c, `/rest/api/${version(c)}/issue`, { method: "POST", body: JSON.stringify({ fields: resultFields }) }); }
    catch (error) {
      // Explicit client errors prove no issue was created. A network/5xx outcome stays uncertain.
      if (error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) fs.rmSync(file, { force: true });
      else throw fail("Результат создания не подтверждён. Проверьте результат перед повторной отправкой, чтобы не создать дубликат.", 409);
      throw error;
    }
    if (!/^[A-Z][A-Z0-9_]*-\d+$/i.test(issue?.key || "")) throw fail("Сервер не вернул ключ созданной задачи. Проверьте результат в задаче.", 409);
    const result = { ok: true, key: issue.key, issueUrl: `${c.baseUrl}/browse/${encodeURIComponent(issue.key)}`, operationId: payload.operationId };
    writeRecord(file, { digest, result });
    return result;
  }
  async function evidence(c, payload) {
    const file = recordPath(c, payload.operationId);
    let record;
    try { record = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw fail("Не удалось подтвердить создание этого бага. Добавьте ссылки вручную в задаче.", 403); }
    if (!record.result || record.result.key !== payload.issueKey) throw fail("Можно добавить материалы только в подтверждённый баг этой операции", 403);
    if (!/^[a-z][a-z0-9_]*$/i.test(payload.fieldId || "") || ["constructor", "prototype", "__proto__", "summary"].includes(payload.fieldId)) throw fail("Выберите текстовое поле для ссылок");
    const ids = [...new Set(Array.isArray(payload.attachmentIds) ? payload.attachmentIds.map(String) : [])];
    if (!ids.length || ids.length > 100 || ids.some(id => !/^\d+$/.test(id))) throw fail("Не удалось определить загруженные вложения");
    let placements;
    try { placements = Bugs.attachmentPlacements(payload.placements, ids); } catch (error) { throw fail(error.message); }
    if (placements.length && payload.fieldId !== "description") throw fail("Вложение можно вставить только в описание");
    const route = `/rest/api/${version(c)}/issue/${encodeURIComponent(record.result.key)}`;
    const edit = await jiraFetch(c, `${route}/editmeta`);
    const raw = edit.fields?.[payload.fieldId], field = raw && Bugs.normalizeField({ ...raw, fieldId: payload.fieldId });
    if (!field || field.kind !== "textarea") throw fail("В выбранной системе нельзя изменить поле для ссылок. Добавьте их вручную в описание.", 403);
    const issue = await jiraFetch(c, `${route}?fields=attachment,${encodeURIComponent(field.id)}`);
    const attachments = issue.fields?.attachment;
    if (!Array.isArray(attachments) || ids.some(id => !attachments.some(a => String(a.id) === id))) throw fail("Сервер ещё не подтвердил все загруженные вложения", 404);
    const base = new URL(c.baseUrl), current = issue.fields[field.id];
    const links = ids.map(id => {
      const attachment = attachments.find(a => String(a.id) === id);
      let url;
      try { if (attachment.content) url = new URL(attachment.content, `${c.baseUrl}/`); } catch {}
      if (!url || url.origin !== base.origin || url.username || url.password || !["http:", "https:"].includes(url.protocol)) {
        url = new URL(c.type === "cloud" ? `${c.baseUrl}/rest/api/3/attachment/content/${id}?redirect=false` : `${c.baseUrl}/secure/attachment/${id}/${encodeURIComponent(attachment.filename || "file")}`);
      }
      const name = String(attachment.filename || "file"), mime = String(attachment.mimeType || "").split(";")[0].trim().toLowerCase();
      const image = mime.startsWith("image/") || ((!mime || mime === "application/octet-stream") && /\.(png|jpe?g|gif|bmp|webp|tiff?)$/i.test(name));
      return { id, name, url: url.href, image };
    });
    let value, missing, changed;
    if (c.type === "cloud") {
      const doc = current == null || typeof current === "string" ? Bugs.textDocument(current || "") : current;
      if (doc.type !== "doc" || !Array.isArray(doc.content)) throw fail("Не удалось сохранить текущий текст. Добавьте ссылки вручную.");
      const before = JSON.stringify(doc);
      const replace = node => {
        if (node.type === "text" && placements.length) {
          let parts = [node];
          for (const placement of placements) parts = parts.flatMap(part => {
            if (part.type !== "text" || !part.text.includes(placement.placeholder)) return [part];
            const link = links.find(item => item.id === placement.attachmentId), pieces = part.text.split(placement.placeholder), result = [];
            pieces.forEach((piece, i) => { if (i) result.push({ type: "text", text: link.name, marks: [...(part.marks || []).filter(mark => mark.type !== "link"), { type: "link", attrs: { href: link.url } }] }); if (piece) result.push({ ...part, text: piece }); });
            return result;
          });
          return parts;
        }
        return [{ ...node, ...(Array.isArray(node.content) ? { content: node.content.flatMap(replace) } : {}) }];
      };
      const placed = replace(doc)[0], serialized = JSON.stringify(placed);
      missing = links.filter(link => !serialized.includes(JSON.stringify(link.url)));
      value = { ...placed, content: [...placed.content, ...(missing.length ? [{ type: "paragraph", content: [{ type: "text", text: "Материалы" }] }, ...missing.map(link => ({ type: "paragraph", content: [{ type: "text", text: link.name, marks: [{ type: "link", attrs: { href: link.url } }] }] }))] : [])] };
      changed = JSON.stringify(value) !== before;
    } else {
      if (current != null && typeof current !== "string") throw fail("Не удалось прочитать текст поля");
      const wikiUrl = link => link.url.replace(/\|/g, "%7C").replace(/\[/g, "%5B").replace(/\]/g, "%5D");
      const legacy = link => `[${link.name.replace(/[\r\n\[\]|!]/g, " ")}|${wikiUrl(link)}]`;
      const reference = link => {
        // A filename reference must resolve to exactly this uploaded attachment.
        const unique = attachments.filter(attachment => String(attachment.filename) === link.name).length === 1;
        if (!unique || link.name.trim() !== link.name || /[\x00-\x1f\\\[\]|!^{}:]/.test(link.name)) return legacy(link);
        return link.image ? `!${link.name}|thumbnail!` : `[^${link.name}]`;
      };
      const references = links.map(link => ({ ...link, wiki: reference(link) }));
      const replacements = new Map(references.map(link => [legacy(link), link.wiki]));
      let materials = false;
      // Upgrade only complete generated link lines; preserve the user's other text.
      value = String(current || "").split("\n").map(line => {
        if (line === "Материалы") materials = true;
        return materials ? replacements.get(line) ?? line : line;
      }).join("\n");
      for (const placement of placements) value = value.split(placement.placeholder).join(references.find(link => link.id === placement.attachmentId).wiki);
      missing = references.filter(link => !value.includes(link.wiki));
      if (missing.length) value += `\n\nМатериалы\n${missing.map(link => link.wiki).join("\n")}`;
      if (value.length > 32768) throw fail("Поле слишком длинное для добавления ссылок. Добавьте их вручную в задаче.");
      changed = value !== String(current || "");
    }
    if (changed) await jiraFetch(c, route, { method: "PUT", body: JSON.stringify({ fields: { [field.id]: value } }) });
    return { ok: true, linked: links.length };
  }
  return async function execute(config, action, payload) {
    const c = configuredJira(config, { baseUrl: payload.baseUrl });
    if (action === "issue-projects") {
      const raw = c.type === "cloud" ? await pages(c, "/rest/api/3/project/search", "values") : await jiraFetch(c, "/rest/api/2/project");
      return { ok: true, projects: (Array.isArray(raw) ? raw : []).map(item => ({ key: String(item.key), name: String(item.name) })) };
    }
    if (action === "issue-context") return context(c, payload);
    if (action === "issue-fields") return fields(c, payload);
    if (action === "issue-options") return options(c, payload);
    if (action === "create-issue") return create(c, payload);
    if (action === "issue-evidence") return evidence(c, payload);
    throw fail("Неизвестная команда создания задачи");
  };
}
module.exports = { createService, parentKey };
