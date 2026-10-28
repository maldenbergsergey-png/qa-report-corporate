"use strict";
const crypto = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const dc = require("node:diagnostics_channel");
const context = new AsyncLocalStorage();
const requests = new WeakMap();
const sessions = new Map();
const locks = new Map();
const round = n => Math.round(n * 10) / 10;
const now = () => performance.now();
function log(event, details = {}) {
  const current = context.getStore();
  if (current) console.log(JSON.stringify({ event: "jira_upload", request_id: current.id, phase: event, elapsed_ms: round(now() - current.start), ...details }));
}
function stage(value) { const current = context.getStore(); if (current) { current.phase = value; current.onStage?.(value); log(value); } }
function run(id, operation, onStage) { return context.run({ id, start: now(), phase: "prepare", onStage }, operation); }
dc.subscribe("undici:request:create", ({ request }) => { const current = context.getStore(); if (current) requests.set(request, { current, start: now() }); });
dc.subscribe("undici:request:bodySent", ({ request }) => { const span = requests.get(request); if (span) context.run(span.current, () => log("body_sent", { upstream_ms: round(now() - span.start) })); });
dc.subscribe("undici:client:beforeConnect", () => log("connect_start"));
dc.subscribe("undici:client:connected", () => log("connected"));
dc.subscribe("undici:client:connectError", () => log("connect_error"));
function scope(connection) {
  // The digest partitions caches by credentials without persisting or logging them.
  return crypto.createHash("sha256").update(JSON.stringify(connection)).digest("hex");
}
function uploadActive() { return ["limits", "inventory", "upload"].includes(context.getStore()?.phase); }
function createSession(connection, issueKey, limits, files) {
  if (sessions.size >= 128) sessions.delete(sessions.keys().next().value);
  const id = crypto.randomUUID(); sessions.set(id, { scope: scope(connection), issueKey, limits, files: [...files], until: Date.now() + 60_000 }); return id;
}
function session(connection, issueKey, id) {
  const item = sessions.get(id);
  return item && item.until > Date.now() && item.scope === scope(connection) && item.issueKey === issueKey ? item : null;
}
async function locked(connection, issueKey, execute) {
  const key = scope(connection) + issueKey, previous = locks.get(key);
  const task = (async () => { await previous?.catch(() => {}); return execute(); })(); locks.set(key, task);
  try { return await task; } finally { if (locks.get(key) === task) locks.delete(key); }
}
function networkError(error) {
  const phase = context.getStore()?.phase || "request";
  const label = { limits: "проверка ограничений Jira", inventory: "проверка вложений задачи", upload: "отправка файла и подтверждение Jira", request: "обращение к Jira" }[phase] || "обращение к Jira";
  const timeout = error?.name === "TimeoutError" || /TIMEOUT/.test(error?.cause?.code || error?.code || "");
  const failure = new Error(timeout ? `Превышено время ожидания: ${label}. Результат загрузки может быть не подтверждён; повторная отправка файла не начата.` : `Соединение прервано: ${label}. Проверьте сеть между отправителем и Jira.`);
  return Object.assign(failure, { status: 502, code: timeout ? "JIRA_TRANSPORT_TIMEOUT" : "JIRA_NETWORK_ERROR", phase, cause: error });
}
async function request(transport, target, options) {
  const started = now(), pathname = new URL(target).pathname;
  const kind = pathname.endsWith("/attachment/meta") ? "limits" : pathname.endsWith("/attachments") ? "upload" : "jira_read";
  log("upstream_start", { method: options.method || "GET", kind, transport: transport.transportKind || "node" });
  try {
    const response = await transport(target, { ...options, signal: options.signal || AbortSignal.timeout(300_000) });
    const upstreamId = response.headers.get("x-arequestid") || response.headers.get("x-request-id") || "";
    log("upstream_headers", { status: response.status, upstream_ms: round(now() - started), kind, ...(/^[a-z0-9,._:-]{1,128}$/i.test(upstreamId) ? { upstream_request_id: upstreamId } : {}) });
    const read = response.text.bind(response);
    response.text = async () => { try { const value = await read(); log("upstream_complete", { status: response.status, upstream_ms: round(now() - started) }); return value; } catch (error) { log("upstream_body_error", { upstream_ms: round(now() - started) }); throw networkError(error); } };
    return response;
  } catch (error) { log("upstream_network_error", { upstream_ms: round(now() - started) }); throw networkError(error); }
}
function httpError(response, pathname) {
  if (response.status < 500) return null;
  return Object.assign(new Error(`Jira или шлюз перед ней вернули HTTP ${response.status}. Загрузка не подтверждена.`), { status: response.status, code: "JIRA_UPSTREAM_ERROR", upstreamStatus: response.status, pathname, phase: context.getStore()?.phase || "request" });
}
module.exports = { run, stage, log, request, httpError, createSession, session, locked, uploadActive };
