const http = require("node:http");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseJiraMarkup } = require("../jira-markup-import");

async function main() {
  const xssImport = parseJiraMarkup(
    "||Проверка||Статус||\n|[Открыть\\|https://jira.example/\\\" onmouseover=\\\"alert(1)]|ОК|",
  );
  const xssHtml = JSON.stringify(xssImport);
  assert.equal(xssHtml.includes("<a "), false);
  assert.equal(xssHtml.includes("javascript:"), false);

  const received = [];
  let fallbackCommentCreated = false;
  let wafPostAttempted = false;
  const mock = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks);
    const body = request.headers["content-type"]?.includes("application/json")
      ? JSON.parse(rawBody.toString("utf8") || "{}")
      : rawBody;
    received.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
      body,
    });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/rest/api/2/issue/QA-999/comment?maxResults=100") {
      response.setHeader("Content-Type", "text/html; charset=UTF-8");
      response.end(
        '<!DOCTYPE html><html><head><noscript><meta http-equiv="refresh" content="0; url=/exhkqyad"></noscript></head></html>',
      );
      return;
    }
    if (request.url === "/rest/api/2/issue/QA-999/comment" && request.method === "POST") {
      wafPostAttempted = true;
      response.statusCode = 201;
      response.end(JSON.stringify({ id: "should-not-exist" }));
      return;
    }
    if (request.url === "/rest/api/2/issue/QA-456/comment" && request.method === "POST") {
      fallbackCommentCreated = true;
      response.statusCode = 201;
      response.end(JSON.stringify({}));
      return;
    }
    if (request.url === "/rest/api/2/issue/QA-456/comment?maxResults=100") {
      response.end(
        JSON.stringify({
          total: fallbackCommentCreated ? 1 : 0,
          comments: fallbackCommentCreated ? [{ id: "20002", body: "Fallback comment" }] : [],
        }),
      );
      return;
    }
    if (request.url === "/rest/api/2/issue/QA-456/comment/20002") {
      response.end(JSON.stringify({ id: "20002", body: "Fallback comment" }));
      return;
    }
    if (request.url === "/rest/api/2/issue/QA-789/comment" && request.method === "POST") {
      response.statusCode = 201;
      response.end(JSON.stringify({}));
      return;
    }
    if (request.url === "/rest/api/2/issue/QA-789/comment?maxResults=100") {
      response.end(JSON.stringify({ total: 0, comments: [] }));
      return;
    }
    if (request.url.endsWith("/myself")) {
      response.end(JSON.stringify({ displayName: "QA Tester", name: "qa" }));
      return;
    }
    if (request.url.includes("/comment/777")) {
      response.end(
        JSON.stringify({
          body: {
            type: "doc",
            version: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: "Комментарий" }] }],
          },
        }),
      );
      return;
    }
    if (request.url.includes("?fields=attachment")) {
      response.end(JSON.stringify({ fields: { attachment: [] } }));
      return;
    }
    if (request.url.endsWith("/attachments")) {
      response.statusCode = 200;
      response.end(JSON.stringify([{ id: "900", filename: "shot.png", content: "http://jira/shot.png" }]));
      return;
    }
    response.statusCode = 201;
    response.end(JSON.stringify({ id: "10001" }));
  });
  await new Promise((resolve) => mock.listen(4199, "127.0.0.1", resolve));

  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-report-test-"));
  const app = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: "4174", REPORTS_DB_PATH: path.join(testDir, "reports.sqlite") },
    stdio: "ignore",
  });
  await new Promise((resolve) => setTimeout(resolve, 250));

  try {
    const healthResponse = await fetch("http://127.0.0.1:4174/api/health");
    assert.equal(healthResponse.status, 200);
    assert.match(healthResponse.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
    assert.equal(healthResponse.headers.get("x-content-type-options"), "nosniff");
    assert.equal(healthResponse.headers.get("x-frame-options"), "DENY");

    const crossSiteResponse = await fetch("http://127.0.0.1:4174/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: "{}",
    });
    assert.equal(crossSiteResponse.status, 403);

    const removedStorageResponse = await fetch("http://127.0.0.1:4174/api/storage/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(removedStorageResponse.status, 400);

    const testResponse = await fetch("http://127.0.0.1:4174/api/jira/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "data-center",
        baseUrl: "http://127.0.0.1:4199",
        token: "secret-pat",
      }),
    });
    assert.equal(testResponse.status, 200);
    assert.equal((await testResponse.json()).displayName, "QA Tester");

    const commentResponse = await fetch("http://127.0.0.1:4174/api/jira/comment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "cloud",
        baseUrl: "http://127.0.0.1:4199",
        user: "qa@example.com",
        token: "cloud-token",
        issueUrl: "http://127.0.0.1:4199/browse/QA-123",
        comment: {
          format: "adf",
          body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [] }] },
        },
      }),
    });
    assert.equal(commentResponse.status, 201);
    const commentResult = await commentResponse.json();
    assert.equal(commentResult.verified, true);
    assert.equal(commentResult.commentId, "10001");
    assert.equal(commentResult.apiRevision, 5);
    const patTestRequest = received.find((item) => item.url === "/rest/api/2/myself");
    assert.equal(patTestRequest.authorization, "Bearer secret-pat");
    const cloudCommentRequest = received.find(
      (item) => item.url === "/rest/api/3/issue/QA-123/comment" && item.method === "POST",
    );
    assert.match(cloudCommentRequest.authorization, /^Basic /);
    assert.equal(cloudCommentRequest.body.body.type, "doc");

    const basicResponse = await fetch("http://127.0.0.1:4174/api/jira/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "data-center",
        authMethod: "basic",
        baseUrl: "http://127.0.0.1:4199",
        user: "legacy-user",
        token: "legacy-password",
      }),
    });
    assert.equal(basicResponse.status, 200);
    const basicTestRequest = received
      .filter((item) => item.url === "/rest/api/2/myself")
      .find((item) => item.authorization?.startsWith("Basic "));
    assert.equal(
      basicTestRequest.authorization,
      `Basic ${Buffer.from("legacy-user:legacy-password").toString("base64")}`,
    );

    const cookieResponse = await fetch("http://127.0.0.1:4174/api/jira/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "data-center",
        authMethod: "cookie",
        baseUrl: "http://127.0.0.1:4199",
        token: "JSESSIONID=session-from-curl; atlassian.xsrf.token=xsrf",
      }),
    });
    assert.equal(cookieResponse.status, 200);
    const cookieTestRequest = received
      .filter((item) => item.url === "/rest/api/2/myself")
      .find((item) => item.cookie?.includes("JSESSIONID=session-from-curl"));
    assert.equal(cookieTestRequest.authorization, undefined);
    assert.equal(cookieTestRequest.cookie, "JSESSIONID=session-from-curl; atlassian.xsrf.token=xsrf");

    const fallbackResponse = await fetch("http://127.0.0.1:4174/api/jira/comment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "data-center",
        baseUrl: "http://127.0.0.1:4199",
        token: "secret-pat",
        issueUrl: "http://127.0.0.1:4199/browse/QA-456",
        comment: { format: "wiki", body: "Fallback comment" },
      }),
    });
    assert.equal(fallbackResponse.status, 201);
    const fallbackResult = await fallbackResponse.json();
    assert.equal(fallbackResult.verified, true);
    assert.equal(fallbackResult.commentId, "20002");
    assert.equal(fallbackResult.verificationSource, "comments-body-match");

    const diagnosticResponse = await fetch("http://127.0.0.1:4174/api/jira/comment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "data-center",
        baseUrl: "http://127.0.0.1:4199",
        token: "secret-pat",
        issueUrl: "http://127.0.0.1:4199/browse/QA-789",
        comment: { format: "wiki", body: "Missing comment" },
      }),
    });
    assert.equal(diagnosticResponse.status, 400);
    const diagnosticResult = await diagnosticResponse.json();
    assert.match(diagnosticResult.error, /HTTP 201/);
    assert.match(diagnosticResult.error, /комментариев до: 0/);
    assert.match(diagnosticResult.error, /после: 0/);

    const wafResponse = await fetch("http://127.0.0.1:4174/api/jira/comment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "data-center",
        baseUrl: "http://127.0.0.1:4199",
        token: "secret-pat",
        issueUrl: "http://127.0.0.1:4199/browse/QA-999",
        comment: { format: "wiki", body: "Must not be sent" },
      }),
    });
    assert.equal(wafResponse.status, 502);
    const wafResult = await wafResponse.json();
    assert.equal(wafResult.errorCode, "JIRA_SECURITY_CHALLENGE");
    assert.match(wafResult.error, /\/rest\/api\/\*/);
    assert.equal(wafPostAttempted, false);

    const importResponse = await fetch("http://127.0.0.1:4174/api/jira/import-comment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "cloud",
        baseUrl: "http://127.0.0.1:4199",
        user: "qa@example.com",
        token: "cloud-token",
        commentUrl: "http://127.0.0.1:4199/browse/QA-123?focusedCommentId=777",
      }),
    });
    assert.equal(importResponse.status, 200);
    assert.equal((await importResponse.json()).format, "adf");

    const tinyPng = Buffer.from("iVBORw0KGgo=", "base64").toString("base64");
    const attachmentResponse = await fetch("http://127.0.0.1:4174/api/jira/attachments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "cloud",
        baseUrl: "http://127.0.0.1:4199",
        user: "qa@example.com",
        token: "cloud-token",
        issueUrl: "http://127.0.0.1:4199/browse/QA-123",
        files: [
          {
            attachmentId: "local-1",
            name: "shot.png",
            type: "image/png",
            dataBase64: tinyPng,
          },
        ],
      }),
    });
    assert.equal(attachmentResponse.status, 200);
    assert.equal((await attachmentResponse.json()).attachments[0].attachmentId, "local-1");

    const reportDocument = {
      reportId: "server-report-1",
      draftId: "server-draft-1",
      schemaVersion: 3,
      issueUrl: "https://company.atlassian.net/browse/QA-321",
      environment: "STAGE",
      overallStatus: "OK",
      intro: "",
      sections: [{ id: "s1", title: "Раздел", columns: [], rows: [] }],
    };
    const saveReportResponse = await fetch("http://127.0.0.1:4174/api/reports", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-QA-Report-Client-Id": "browser-a",
      },
      body: JSON.stringify({ document: reportDocument, reason: "test" }),
    });
    assert.equal(saveReportResponse.status, 200);
    const saveReportResult = await saveReportResponse.json();
    assert.equal(saveReportResult.report.ownerSource, "browser");
    assert.equal(saveReportResult.report.issueKey, "QA-321");

    const ownReportsResponse = await fetch("http://127.0.0.1:4174/api/reports", {
      headers: { "X-QA-Report-Client-Id": "browser-a" },
    });
    assert.equal(ownReportsResponse.status, 200);
    assert.equal((await ownReportsResponse.json()).reports.length, 1);

    const otherReportsResponse = await fetch("http://127.0.0.1:4174/api/reports", {
      headers: { "X-QA-Report-Client-Id": "browser-b" },
    });
    assert.equal(otherReportsResponse.status, 200);
    assert.equal((await otherReportsResponse.json()).reports.length, 0);

    const sharedReportResponse = await fetch("http://127.0.0.1:4174/api/reports", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-QA-Report-Client-Id": "browser-a",
        "X-QA-Report-Workspace-Key": "qa-team",
      },
      body: JSON.stringify({
        document: { ...reportDocument, reportId: "server-report-shared" },
        title: "Shared report",
      }),
    });
    assert.equal(sharedReportResponse.status, 200);
    assert.equal((await sharedReportResponse.json()).report.ownerSource, "workspace-key");

    const sharedReportsResponse = await fetch("http://127.0.0.1:4174/api/reports", {
      headers: {
        "X-QA-Report-Client-Id": "browser-c",
        "X-QA-Report-Workspace-Key": "qa-team",
      },
    });
    assert.equal(sharedReportsResponse.status, 200);
    const sharedReports = await sharedReportsResponse.json();
    assert.equal(sharedReports.reports.length, 1);
    assert.equal(sharedReports.reports[0].title, "Shared report");

    const fullReportResponse = await fetch("http://127.0.0.1:4174/api/reports/server-report-shared", {
      headers: {
        "X-QA-Report-Client-Id": "browser-c",
        "X-QA-Report-Workspace-Key": "qa-team",
      },
    });
    assert.equal(fullReportResponse.status, 200);
    const fullReport = await fullReportResponse.json();
    assert.equal(fullReport.report.document.reportId, "server-report-shared");
    assert.ok(fullReport.report.contentHash);

    const updatedSharedResponse = await fetch("http://127.0.0.1:4174/api/reports", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-QA-Report-Client-Id": "browser-c",
        "X-QA-Report-Workspace-Key": "qa-team",
      },
      body: JSON.stringify({
        document: {
          ...reportDocument,
          reportId: "server-report-shared",
          environment: "PROD",
        },
        title: "Shared report updated",
        baseContentHash: fullReport.report.contentHash,
      }),
    });
    assert.equal(updatedSharedResponse.status, 200);
    const updatedShared = await updatedSharedResponse.json();
    assert.notEqual(updatedShared.report.contentHash, fullReport.report.contentHash);

    const staleSharedResponse = await fetch("http://127.0.0.1:4174/api/reports", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-QA-Report-Client-Id": "browser-a",
        "X-QA-Report-Workspace-Key": "qa-team",
      },
      body: JSON.stringify({
        document: {
          ...reportDocument,
          reportId: "server-report-shared",
          environment: "DEV",
        },
        title: "Stale overwrite",
        baseContentHash: fullReport.report.contentHash,
      }),
    });
    assert.equal(staleSharedResponse.status, 409);
    const staleConflict = await staleSharedResponse.json();
    assert.equal(staleConflict.conflict, true);
    assert.equal(staleConflict.report.title, "Shared report updated");

    const forcedSharedResponse = await fetch("http://127.0.0.1:4174/api/reports", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-QA-Report-Client-Id": "browser-a",
        "X-QA-Report-Workspace-Key": "qa-team",
      },
      body: JSON.stringify({
        document: {
          ...reportDocument,
          reportId: "server-report-shared",
          environment: "DEV",
        },
        title: "Forced local version",
        baseContentHash: fullReport.report.contentHash,
        force: true,
      }),
    });
    assert.equal(forcedSharedResponse.status, 200);
    assert.equal((await forcedSharedResponse.json()).report.title, "Forced local version");

    const checklistImportResponse = await fetch("http://127.0.0.1:4174/api/checklists/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "qa-assistant",
        format: "jira",
        title: "Экспорт транзакций в Excel",
        issueKey: "https://company.atlassian.net/browse/ADVINTAUT2-117",
        content:
          "||Номер||Проверка||Как проверить||Ожидаемый результат||Фактический результат||Статус||Комментарий||\n" +
          "|1.|Отображение кнопки Export|Авторизоваться как Admin|Кнопка Export видна и доступна для нажатия||||",
      }),
    });
    assert.equal(checklistImportResponse.status, 201);
    const checklistImportResult = await checklistImportResponse.json();
    assert.equal(checklistImportResult.ok, true);
    assert.match(checklistImportResult.checklistId, /^[0-9a-f-]{36}$/);
    assert.match(checklistImportResult.url, /^http:\/\/127\.0\.0\.1:4174\/report\/[a-f0-9]{8}\?/);
    assert.match(checklistImportResult.url, /\?importToken=/);
    assert.equal(checklistImportResult.parsed.rows, 1);

    const proxiedChecklistImportResponse = await fetch("http://127.0.0.1:4174/api/checklists/import", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "qa-report.company.ru",
      },
      body: JSON.stringify({
        source: "qa-assistant",
        format: "jira",
        title: "Proxy URL check",
        content: "||Номер||Проверка||Статус||\n|1.|Проверить публичный URL||",
      }),
    });
    assert.equal(proxiedChecklistImportResponse.status, 201);
    const proxiedChecklistImportResult = await proxiedChecklistImportResponse.json();
    assert.match(
      proxiedChecklistImportResult.url,
      /^https:\/\/qa-report\.company\.ru\/report\/[a-f0-9]{8}\?importToken=/,
    );

    const checklistPayloadResponse = await fetch(
      `http://127.0.0.1:4174/api/checklists/import/${checklistImportResult.checklistId}`,
    );
    assert.equal(checklistPayloadResponse.status, 200);
    const checklistPayload = await checklistPayloadResponse.json();
    assert.equal(checklistPayload.format, "jira");
    assert.equal(checklistPayload.title, "Экспорт транзакций в Excel");
    assert.equal(checklistPayload.issueKey, "https://company.atlassian.net/browse/ADVINTAUT2-117");
    assert.equal(checklistPayload.content.includes("Отображение кнопки Export"), true);

    const heavyReportResponse = await fetch("http://127.0.0.1:4174/api/reports", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-QA-Report-Client-Id": "browser-heavy",
      },
      body: JSON.stringify({
        document: {
          ...reportDocument,
          reportId: "server-report-heavy",
          publicId: "aabbccdd",
          intro:
            '<p onclick="alert(1)">Текст до</p><script>alert(1)</script><figure class="cell-image"><img src="data:image/png;base64,AAAA" /></figure><p>Текст после</p>',
          sections: [
            {
              ...reportDocument.sections[0],
              rows: [
                {
                  ...reportDocument.sections[0].rows[0],
                  cells: {
                    check:
                      'Проверка <figure class="cell-file" data-file-name="dump.log">dump.log</figure><img src="data:image/png;base64,BBBB">',
                  },
                },
              ],
            },
          ],
        },
        title: "Heavy report",
      }),
    });
    assert.equal(heavyReportResponse.status, 200);
    const heavyReportGetResponse = await fetch("http://127.0.0.1:4174/api/reports/server-report-heavy", {
      headers: { "X-QA-Report-Client-Id": "browser-heavy" },
    });
    assert.equal(heavyReportGetResponse.status, 200);
    const heavyReport = await heavyReportGetResponse.json();
    assert.equal(JSON.stringify(heavyReport.report.document).includes("data:image"), false);
    assert.equal(JSON.stringify(heavyReport.report.document).includes("data-data-url=\"data:"), false);
    assert.equal(JSON.stringify(heavyReport.report.document).includes("onclick"), false);
    assert.equal(JSON.stringify(heavyReport.report.document).includes("<script"), false);
    assert.equal(heavyReport.report.document.intro.includes("Текст до"), true);

    const unsupportedFormatResponse = await fetch("http://127.0.0.1:4174/api/checklists/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "markdown", content: "| nope |" }),
    });
    assert.equal(unsupportedFormatResponse.status, 400);

    const emptyContentResponse = await fetch("http://127.0.0.1:4174/api/checklists/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "jira", content: "" }),
    });
    assert.equal(emptyContentResponse.status, 400);

    const unparseableResponse = await fetch("http://127.0.0.1:4174/api/checklists/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "jira", content: "Просто текст без таблицы" }),
    });
    assert.equal(unparseableResponse.status, 422);

    console.log("Jira integration test passed");
  } finally {
    app.kill("SIGTERM");
    await new Promise((resolve) => mock.close(resolve));
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
