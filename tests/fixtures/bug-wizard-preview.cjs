"use strict";
const http = require("node:http"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const fields = [
  { id: "summary", name: "Тема", kind: "text", required: true },
  { id: "description", name: "Описание", kind: "textarea", required: true },
  { id: "customfield_steps", name: "Шаги воспроизведения", kind: "textarea", required: true },
  { id: "customfield_expected", name: "Ожидаемый результат", kind: "textarea", required: true },
  { id: "customfield_actual", name: "Фактический результат", kind: "textarea", required: true },
  { id: "priority", name: "Приоритет", kind: "select", required: true, defaultValue: "1", allowedValues: [{ value: "1", label: "Высокий" }, { value: "2", label: "Обычный" }] },
  { id: "components", name: "Компоненты", kind: "multi", allowedValues: [{ value: "1", label: "ИИ-подборщик" }, { value: "2", label: "Форма" }] },
  { id: "labels", name: "Метки", kind: "tags" },
  { id: "environment", name: "Окружение", kind: "textarea" },
  { id: "fixVersions", name: "Исправить в версиях", kind: "multi", allowedValues: [{ value: "1", label: "1.0" }] },
  { id: "assignee", name: "Исполнитель", kind: "user" }, { id: "customfield_specialist", name: "Специалист", kind: "user" },
  ...Array.from({ length: 10 }, (_, i) => ({ id: `customfield_extra${i}`, name: `Дополнительное поле ${i + 1}`, kind: "text" }))
].map(field => ({ schema: {}, allowedValues: [], ...field }));
const draft = { summary: "Из ИИ-подборщика невозможно удалить объект из избранного", preconditions: "Объект добавлен в избранное.", steps: ["Открыть ИИ-подборщик", "Добавить объект в избранное", "Попытаться удалить объект из избранного"], expected: "Объект удаляется из избранного, не отображается в списке.", actual: "Объект остаётся в избранном.", missingInformation: [] };
async function start(root, port = 0, options = {}) {
  const baseUrl = options.provider === "eva" ? "https://eva.example.test/team" : "https://jira.example.test";
  let failedUploads = 0;
  const jobs = new Map(), creates = [], uploads = [], evidence = [], aiRequests = [], requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); };
    if (url.pathname.startsWith("/api/")) {
      let body = ""; for await (const chunk of req) body += chunk;
      let input = {}; try { input = JSON.parse(body || "{}"); } catch {}
      if (url.pathname === "/api/agent/status") return json({ connected: true, devices: options.devices || [{ online: true, version: "0.6.17", lastSeenAt: new Date().toISOString(), ...(options.provider === "eva" ? { evaBaseUrls: [baseUrl], jiraBaseUrls: [] } : { jiraBaseUrls: [baseUrl] }) }] });
      if (url.pathname === "/api/jira/connections") return json({ instances: [{ id: "fixture", baseUrl, name: "Jira", connected: true }] });
      if (url.pathname === "/api/auth/csrf") return json({ csrfToken: "fixture-csrf" });
      if (/^\/api\/agent\/jobs\//.test(url.pathname)) return json({ job: { status: "completed", result: jobs.get(url.pathname.split("/").at(-1)) } });
      const resultJson = value => {
        if (evaRequest) { const jobId = crypto.randomUUID(); jobs.set(jobId, value); return json({ jobId }); }
        return json(value);
      };
      const evaRequest = url.pathname.startsWith("/api/eva/");
      let result;
      url.pathname = url.pathname.replace("/api/agent/jira/", "/api/jira/").replace("/api/eva/", "/api/jira/");
      requests.push({ path: url.pathname, input });
      if (["/api/jira/issue-context", "/api/jira/issue-fields"].includes(url.pathname) && options.metadataDelay) await new Promise(resolve => setTimeout(resolve, options.metadataDelay));
      if (url.pathname === "/api/jira/issue-fields" && options.rejectType === input.issueTypeId) return json({ error: "Этот тип задачи недоступен для выбранного режима" }, 422);
      const types = [{ id: "1", name: "Ошибка" }, { id: "2", name: "Подзадача" }];
      const meta = { projectKey: "APP", issueTypeId: input.issueTypeId || "1", fields: options.fallback ? fields.filter(f => !/customfield_(steps|expected|actual)/.test(f.id)) : fields, types, parent: input.mode === "subtask" ? { key: "APP-123", summary: "Родительская задача" } : null };
      switch (url.pathname) {
        case "/api/jira/issue-projects": result = { projects: [{ key: "APP", name: "Тестовый проект" }] }; break;
        case "/api/jira/issue-context": result = { ...meta, types: [types[input.mode === "subtask" ? 1 : 0]] }; break;
        case "/api/jira/issue-fields": result = meta; break;
        case "/api/ai/profiles": result = { profiles: options.noAi ? [] : [{ id: "fixture-ai", label: "ChatGPT", model: "Тестовая модель" }], speech: { mode: "browser", available: true } }; break;
        case "/api/ai/bug-draft": aiRequests.push(input); if (options.aiDelay) await new Promise(resolve => setTimeout(resolve, options.aiDelay)); if (options.aiFailure) return json({ error: "ИИ не ответил. Повторите генерацию." }, 503); result = { draft }; break;
        case "/api/jira/issue-options": result = { options: [{ value: "fixture-user", label: "Тестовый пользователь" }] }; break;
        case "/api/jira/create-issue": creates.push(input); result = { key: "APP-1234", issueUrl: `${baseUrl}/${options.provider === "eva" ? "desk/Task" : "browse"}/APP-1234`, operationId: input.operationId }; break;
        case "/api/jira/issue-evidence": if (options.evidenceDelay) await new Promise(resolve => setTimeout(resolve, options.evidenceDelay)); evidence.push(input); result = { ok: true }; break;
        case "/api/jira/import-attachment": {
          if (path.basename(root) === "qa-report") return json({ file: { type: "text/plain", dataBase64: Buffer.from("remote fixture log").toString("base64") } });
          res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("remote fixture log");
        }
        case "/api/jira/attachment-manifest": return resultJson({ attachments: uploads, attachmentLimits: { fileBytes: 52428800, totalBytes: 78643200 } });
        case "/api/jira/attachments": { if (options.uploadDelay) await new Promise(resolve => setTimeout(resolve, options.uploadDelay)); if (failedUploads++ < (options.failUploads || 0)) return json({ error: "Тестовая ошибка загрузки" }, 400); const file = { id: String(uploads.length + 1), filename: input.files?.[0]?.name || "fixture.txt", content: `${baseUrl}/attachment/1`, size: 8 }; uploads.push(file); return resultJson({ attachments: [file] }); }
        default: return json({ ok: true, reports: [], projects: [], downloads: [], session: null });
      }
      if (url.pathname.startsWith("/api/ai/") || path.basename(root) === "qa-report") { const jobId = crypto.randomUUID(); jobs.set(jobId, result); return json({ jobId }); }
      return json(result);
    }
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/" || pathname.startsWith("/report/")) pathname = "/index.html";
    const file = path.resolve(root, "." + pathname);
    if (!file.startsWith(root + path.sep)) return json({}, 404);
    try {
      let data = fs.readFileSync(file);
      const types = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".mjs": "application/javascript", ".webmanifest": "application/manifest+json" };
      res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" }); res.end(data);
    } catch { json({}, 404); }
  });
  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
  return { server, creates, uploads, evidence, aiRequests, requests, origin: `http://127.0.0.1:${server.address().port}` };
}
module.exports = { start };
if (require.main === module) start(path.resolve(process.argv[2] || path.join(__dirname, "../..")), Number(process.argv[3] || 4191)).then(value => console.log(value.origin));
