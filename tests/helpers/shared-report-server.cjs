const assert = require("node:assert/strict");
const http = require("node:http");
const { randomBytes } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createReportSharing } = require("../../report-sharing");
const { createMcpDownload } = require("../../mcp-download");
const { connectMcp } = require("./qa-report-mcp-client.cjs");

async function fixture(t, { legacy = false, intercept } = {}) {
  const db = new DatabaseSync(":memory:"), objects = new Map();
  let origin, concurrentWrite;
  const service = createReportSharing({ getDb: () => db, allowLocal: true, configPath: "synthetic.json", requestOrigin: () => origin,
    readJson: async request => { const chunks = []; for await (const chunk of request) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks)); },
    sendJson: (response, status, body) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); },
    storageLoader: () => ({ activeBucketId: "primary", hasBucket: id => id === "primary", uploadUrl: () => "https://storage.example.test/file",
      put: async (key, bytes) => objects.set(key, bytes), get: async ref => new Response(objects.get(ref.key)), remove: async ref => objects.delete(ref.key) }),
  });
  const root = path.resolve(__dirname, "../..");
  const page = await fs.readFile(path.join(root, "shared-report.html"), "utf8");
  const assets = new Set([...page.matchAll(/(?:src|href)="\/([^"?#]+)(?:\?[^"#]*)?"/g)].map(match => match[1]));
  assets.add("icons/brand-light.png"); assets.add("icons/brand-dark.png");
  const download = createMcpDownload();
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, origin).pathname;
      if (intercept?.(req, res, pathname)) return;
      if (legacy && pathname === "/api/mcp/package") {
        const sha256 = "a".repeat(64);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ version: "0.32.0", sha256, packageUrl: "/downloads/qa-report-mcp.tgz?v=" + sha256, node: ">=22" })); return;
      }
      if (await download(req, res, pathname)) return;
      const file = /^\/shared-report\/[a-f0-9]{32}$/.test(pathname) ? "shared-report.html" : pathname.slice(1);
      if (req.method === "GET" && (file === "shared-report.html" || assets.has(file))) {
        const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
        res.writeHead(200, { "Content-Type": type }); res.end(await fs.readFile(path.join(root, file))); return;
      }
      if (req.method === "POST" && req.url.endsWith("/answers") && concurrentWrite) { const write = concurrentWrite; concurrentWrite = null; write(); }
      if (!await service(req, res, new URL(req.url, origin).pathname)) { res.writeHead(404); res.end(); }
    } catch (error) { res.writeHead(error.status || 500); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); });
  const json = async (suffix, { method = "GET", body, token } = {}) => {
    const response = await fetch(origin + "/api/shared-reports" + suffix, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const { data: { publication } } = await json("", { method: "POST", body: { publishKey: randomBytes(32).toString("base64url"),
    snapshot: { title: "Замечания разработчику", sections: [{ id: "section", title: "Вход", columns: [{ id: "check", label: "Проверка" }],
      rows: [{ id: "row", number: "1.1", status: "NOT_OK", cells: { check: { text: "Форма не открывается" } } }] }] }, files: [] } });
  assert.ok(publication?.id, "Synthetic publication must be created");
  const url = token => `${origin}/shared-report/${publication.id}#${token}`;
  async function connect(overrides = {}, script) {
    const client = await connectMcp({ QA_REPORT_SHARE_URL: url(publication.replyToken), ...overrides }, undefined, script);
    t.after(() => client.close()); return client;
  }
  const read = () => json("/" + publication.id, { token: publication.replyToken });
  return { connect, url, publication, read, json, origin, db, race: fn => { concurrentWrite = fn; } };
}
module.exports = { fixture };
