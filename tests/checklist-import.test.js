const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSessionToken } = require("../auth");

const SESSION_SECRET = "checklist-import-session-secret-at-least-32-bytes";
const { freePort, waitForStartup } = require("./server-fixture");
let PORT;
let ORIGIN;

function sessionCookie() {
  const token = createSessionToken("user@example.com", {
    env: { AUTH_SECRET: SESSION_SECRET },
  });
  return `query-port-session=${encodeURIComponent(token)}`;
}


test("QA Assistant creates a public import and the user opens it under an AD session", async () => {
  PORT = await freePort();
  ORIGIN = `http://127.0.0.1:${PORT}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-checklist-import-"));
  const app = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(PORT),
      AUTH_SECRET: SESSION_SECRET, AUTH_SECRET_FILE: "",
      QA_REPORT_PUBLIC_URL: "https://qa-report.example.com",
      REPORTS_DB_PATH: path.join(dir, "reports.sqlite"),
      QA_STORAGE_ACCESS_KEY: "",
      QA_STORAGE_SECRET_KEY: "",
      QA_STORAGE_ACCESS_KEY_FILE: "",
      QA_STORAGE_SECRET_KEY_FILE: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const body = JSON.stringify({
    source: "qa-assistant",
    format: "jira",
    title: "Экспорт транзакций",
    issueKey: "https://jira.example.com/browse/QA-123",
    content: "||Номер||Проверка||Статус||\n|1.|Кнопка Export отображается| |",
  });

  try {
    await waitForStartup(app, ORIGIN);

    const created = await fetch(`${ORIGIN}/api/checklists/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
    const createdPayload = await created.json();
    assert.equal(createdPayload.ok, true);
    assert.deepEqual(createdPayload.parsed, { sections: 1, rows: 1 });
    assert.match(
      createdPayload.url,
      /^https:\/\/qa-report\.example\.com\/report\/[a-f0-9]{8}\?importToken=[0-9a-f-]{36}$/,
    );

    const anonymousRedemption = await fetch(
      `${ORIGIN}/api/checklists/import/${createdPayload.checklistId}`,
    );
    assert.equal(anonymousRedemption.status, 401);

    const redeemed = await fetch(
      `${ORIGIN}/api/checklists/import/${createdPayload.checklistId}`,
      { headers: { Cookie: sessionCookie() } },
    );
    assert.equal(redeemed.status, 200);
    const redeemedPayload = await redeemed.json();
    assert.equal(redeemedPayload.content, JSON.parse(body).content);
    assert.equal(redeemedPayload.issueKey, "https://jira.example.com/browse/QA-123");
  } finally {
    if (app.exitCode === null && app.signalCode === null) {
      const exited = new Promise((resolve) => app.once("exit", resolve));
      app.kill("SIGTERM");
      await exited;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
