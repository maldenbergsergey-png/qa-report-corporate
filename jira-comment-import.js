"use strict";

// Comment links identify the source Jira, independently of the report that
// published them. Preserve the full context path when matching a connection.
function location(value) {
  let url;
  try { url = new URL(String(value || "")); }
  catch { throw new Error("Некорректная ссылка на комментарий Jira"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Укажите HTTP(S)-ссылку Jira без логина и пароля");
  }
  const browse = url.pathname.match(/^(.*?)\/browse\/([A-Z][A-Z0-9_]*-\d+)\/?$/i);
  const edit = url.pathname.match(/^(.*?)\/secure\/EditComment(?:!default)?\.jspa$/i);
  return { url, baseUrl: browse || edit ? url.origin + (browse || edit)[1] : "",
    issueRef: browse ? browse[2].toUpperCase() : edit ? url.searchParams.get("id") || "" : "",
    numeric: Boolean(edit) };
}

function baseUrl(value) { return location(value).baseUrl; }

function reference(connection, value) {
  const source = location(value);
  if (!source.baseUrl) throw new Error("В ссылке не найдена задача Jira");
  const target = new URL(connection.baseUrl);
  if (source.baseUrl !== target.origin + target.pathname.replace(/\/+$/, "")) {
    throw new Error("Ссылка комментария относится к другому подключению Jira");
  }
  if (source.numeric && !/^[1-9]\d*$/.test(source.issueRef)) {
    throw new Error("В ссылке не найден идентификатор задачи Jira");
  }
  const candidates = [source.url.searchParams.get("focusedCommentId"), source.url.searchParams.get("commentId"),
    source.url.searchParams.get("selectedItem")?.match(/^comment-(\d+)$/i)?.[1],
    source.url.hash.match(/^#comment-(\d+)$/i)?.[1]];
  const commentId = candidates.find(value => /^\d+$/.test(value || "")) || "";
  return { ...source, commentId };
}

async function load(connection, value, jiraFetch) {
  const source = reference(connection, value);
  if (!source.commentId) throw new Error("В ссылке не найден идентификатор комментария Jira");
  const version = connection.type === "cloud" ? "3" : "2";
  let issueKey = source.issueRef;
  if (source.numeric) {
    const issue = await jiraFetch(connection, `/rest/api/${version}/issue/${source.issueRef}?fields=key`);
    issueKey = String(issue.key || "").toUpperCase();
    if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(issueKey)) throw new Error("Jira не вернула ключ задачи для комментария");
  }
  const comment = await jiraFetch(connection, `/rest/api/${version}/issue/${encodeURIComponent(issueKey)}/comment/${source.commentId}`);
  let attachments = [];
  try {
    const issue = await jiraFetch(connection, `/rest/api/${version}/issue/${encodeURIComponent(issueKey)}?fields=attachment`);
    attachments = (issue.fields?.attachment || []).map(item => ({ id: String(item.id), filename: item.filename,
      content: item.content, thumbnail: item.thumbnail, mimeType: item.mimeType }));
  } catch { /* Text remains importable when Jira denies access to the attachment list. */ }
  return { ok: true, format: version === "3" ? "adf" : "wiki", body: comment.body,
    issueUrl: `${source.baseUrl}/browse/${encodeURIComponent(issueKey)}`, commentId: source.commentId, attachments };
}

module.exports = { baseUrl, reference, load };
