(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.QaReportAttachmentLimits = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const defaults = { appMaxFileBytes: 50 * 1024 * 1024, requestMaxBytes: 150 * 1024 * 1024, jiraEnabled: null, jiraUploadLimit: null };
  function format(bytes) {
    return `${Number(bytes).toLocaleString("ru-RU")} Б (${(bytes / 1024 / 1024).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} МБ)`;
  }
  function base64Bytes(value) {
    const data = String(value || "").replace(/^data:[^,]*,/, "").replace(/\s/g, "");
    return Math.floor(data.length * 3 / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  }
  function fileError(file, limits = defaults) {
    const size = file.dataBase64 !== undefined ? base64Bytes(file.dataBase64) : file.size;
    if (limits.jiraEnabled === false) return "В этой Jira отключены вложения. Обратитесь к администратору Jira.";
    if (Number.isSafeInteger(limits.jiraUploadLimit) && limits.jiraUploadLimit >= 0 && size > limits.jiraUploadLimit) {
      return `Файл «${file.name}» (${format(size)}) превышает лимит Jira: ${format(limits.jiraUploadLimit)} на один файл.`;
    }
    if (size > limits.appMaxFileBytes) return `Файл «${file.name}» (${format(size)}) превышает лимит QA Report: ${format(limits.appMaxFileBytes)}. Его может увеличить администратор QA Report.`;
    if (4 * Math.ceil(size / 3) > limits.requestMaxBytes) return `Файл «${file.name}» (${format(size)}) превышает лимит запроса QA Report при передаче. Администратору нужно увеличить лимит запросов: ${format(limits.requestMaxBytes)}.`;
    return "";
  }
  function requestError(json, limits = defaults) {
    const size = new TextEncoder().encode(json).byteLength;
    return size > limits.requestMaxBytes
      ? `Запрос с вложением занимает ${format(size)} и превышает лимит QA Report: ${format(limits.requestMaxBytes)}. Размер при передаче учтён; администратору нужно увеличить лимит запросов.`
      : "";
  }
  function describe(limits = defaults) {
    const jira = limits.jiraEnabled === false ? "вложения отключены"
      : Number.isSafeInteger(limits.jiraUploadLimit) && limits.jiraUploadLimit >= 0 ? `до ${format(limits.jiraUploadLimit)}`
        : "лимит пока неизвестен; он будет проверен при публикации";
    return `Один файл: QA Report — до ${format(limits.appMaxFileBytes)}; Jira — ${jira}. Размер указан для исходного файла.`;
  }
  // Metadata is advisory: older Jira/proxies may not expose this read-only endpoint.
  async function fromJira(connection, jiraFetch) {
    try {
      const version = connection.type === "cloud" ? "3" : "2";
      const meta = await jiraFetch(connection, `/rest/api/${version}/attachment/meta`, { signal: AbortSignal.timeout(8000) });
      return {
        jiraEnabled: typeof meta?.enabled === "boolean" ? meta.enabled : null,
        jiraUploadLimit: Number.isSafeInteger(meta?.uploadLimit) && meta.uploadLimit >= 0 ? meta.uploadLimit : null,
      };
    } catch { return { jiraEnabled: null, jiraUploadLimit: null }; }
  }
  return { defaults, format, base64Bytes, fileError, requestError, describe, fromJira };
});
