"use strict";
const { readBytes, fileType, cleanName, problem } = require("./local-import-server");

// The download URL must come from Jira's authorized issue attachment list.
// Never forward credentials to a redirect or a URL supplied by the importer.
async function downloadJiraAttachment({ connection, issueKey, attachmentId, jiraFetch, fetchFile, maxBytes }) {
  const version = connection.type === "cloud" ? "3" : "2";
  const issue = await jiraFetch(connection, `/rest/api/${version}/issue/${encodeURIComponent(issueKey)}?fields=attachment`);
  const attachment = (issue.fields?.attachment || []).find(item => String(item.id) === String(attachmentId));
  if (!attachment) throw problem(404, "Вложение не найдено или недоступно в этой задаче");
  if (Number(attachment.size) > maxBytes) throw problem(413, "Вложение превышает допустимый размер");
  const base = new URL(connection.baseUrl);
  const target = connection.type === "cloud"
    ? new URL(`${connection.baseUrl}/rest/api/3/attachment/content/${encodeURIComponent(attachment.id)}?redirect=false`)
    : new URL(attachment.content, `${connection.baseUrl}/`);
  if (target.origin !== base.origin || target.username || target.password || !["http:", "https:"].includes(target.protocol)) throw problem(403, "Jira вернула адрес вложения вне разрешённого подключения");
  const response = await fetchFile(target.toString());
  if (!response.ok) { await response.body?.cancel(); throw problem(response.status >= 400 ? response.status : 502, `Jira не отдала файл (HTTP ${response.status}). Проверьте подключение Jira`); }
  const type = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type === "text/html" && attachment.mimeType !== "text/html") { await response.body?.cancel(); throw problem(502, "Jira вернула страницу входа вместо файла"); }
  if (Number(response.headers.get("content-length")) > maxBytes) { await response.body?.cancel(); throw problem(413, "Вложение превышает допустимый размер"); }
  const bytes = await readBytes(response.body, maxBytes);
  return { bytes, name: cleanName(attachment.filename), type: fileType(bytes, attachment.mimeType || type) };
}
async function listJiraAttachments({ connection, issueKey, jiraFetch }) {
  const version = connection.type === "cloud" ? "3" : "2";
  const issue = await jiraFetch(connection, `/rest/api/${version}/issue/${encodeURIComponent(issueKey)}?fields=attachment`);
  if (!Array.isArray(issue.fields?.attachment)) throw new Error("Jira не вернула список вложений. Публикация остановлена, чтобы не создать дубликаты");
  const safeUrl = value => {
    if (!value) return "";
    const url = new URL(value, `${connection.baseUrl}/`);
    return url.origin === new URL(connection.baseUrl).origin && !url.username && !url.password ? url.href : "";
  };
  return issue.fields.attachment.map(item => ({
    id: String(item.id), filename: item.filename, mimeType: item.mimeType, size: item.size,
    content: safeUrl(item.content), thumbnail: safeUrl(item.thumbnail),
  }));
}
module.exports = { downloadJiraAttachment, listJiraAttachments };
