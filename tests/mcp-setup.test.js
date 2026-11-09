const test = require("node:test");
const assert = require("node:assert/strict");
const { gunzipSync } = require("node:zlib");
const { createHash } = require("node:crypto");
const { buildMcpPackage, createMcpDownload } = require("../mcp-download");
const { buildSetup } = require("../shared-mcp-setup");
const shareUrl = "https://reports.example/shared-report/" + "a".repeat(32) + "#" + "b".repeat(43);
const packageUrl = "/downloads/qa-report-mcp.tgz?v=" + "c".repeat(64);

test("downloadable npm package contains only public MCP sources and minimal pinned dependencies", async () => {
  const bundle = await buildMcpPackage(), tar = gunzipSync(bundle.bytes), files = new Map();
  let cursor = 0;
  while (tar[cursor]) {
    const header = tar.subarray(cursor, cursor + 512);
    const name = header.subarray(0, 100).toString().replace(/\0.*$/, "");
    const size = parseInt(header.subarray(124, 136).toString(), 8);
    const checksum = parseInt(header.subarray(148, 156).toString(), 8);
    const check = Buffer.from(header); check.fill(32, 148, 156);
    assert.equal(check.reduce((sum, byte) => sum + byte, 0), checksum);
    files.set(name, tar.subarray(cursor + 512, cursor + 512 + size));
    if (name.endsWith("qa-report-mcp.cjs")) assert.equal(parseInt(header.subarray(100, 108).toString(), 8), 0o755);
    cursor += 512 + Math.ceil(size / 512) * 512;
  }
  assert.deepEqual([...files.keys()], ["package/package.json", "package/scripts/qa-report-mcp.cjs", "package/scripts/shared-report-mcp.cjs"]);
  const manifest = JSON.parse(files.get("package/package.json"));
  assert.equal(manifest.bin["qa-report-mcp"], "scripts/qa-report-mcp.cjs");
  assert.deepEqual(Object.keys(manifest.dependencies), ["@modelcontextprotocol/server", "zod"]);
  assert.ok(Object.values(manifest.dependencies).every(version => /^\d+\.\d+\.\d+$/.test(version)));
  assert.equal(manifest.scripts, undefined);
  assert.ok(files.get("package/scripts/qa-report-mcp.cjs").toString().startsWith("#!/usr/bin/env node\n"));
  assert.equal(createHash("sha256").update(bundle.bytes).digest("hex"), bundle.sha256);
  assert.deepEqual((await buildMcpPackage()).bytes, bundle.bytes);
});

test("package metadata and download are public, bounded to exact routes and support HEAD", async () => {
  const handle = createMcpDownload();
  async function call(url, method = "GET") {
    const response = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
    const matched = await handle({ url, method }, response, new URL(url, "https://reports.example").pathname);
    return { matched, ...response };
  }
  const info = await call("/api/mcp/package"); assert.equal(info.status, 200);
  const metadata = JSON.parse(info.body);
  assert.deepEqual(Object.keys(metadata).sort(), ["node", "packageUrl", "sha256", "version"]);
  const downloaded = await call(metadata.packageUrl); assert.equal(downloaded.status, 200);
  assert.equal(createHash("sha256").update(downloaded.body).digest("hex"), metadata.sha256);
  const head = await call(metadata.packageUrl, "HEAD"); assert.equal(head.status, 200); assert.equal(head.body, undefined);
  assert.equal((await call("/downloads/qa-report-mcp.tgz?v=wrong")).status, 409);
  assert.equal((await call(metadata.packageUrl, "POST")).status, 405);
  assert.equal((await call("/downloads/secret.tgz")).matched, false);
});

test("setup exports correct per-report Codex, Claude Code and JSON configurations on both platforms", () => {
  for (const windows of [false, true]) {
    const json = JSON.parse(buildSetup({ shareUrl, packageUrl, windows, client: "json" }).code);
    const server = json.mcpServers["qa-report-aaaaaaaa"];
    assert.equal(server.env.QA_REPORT_SHARE_URL, shareUrl);
    assert.equal(server.command, windows ? "cmd" : "npx");
    assert.ok(server.args.includes("https://reports.example" + packageUrl));
    const toml = buildSetup({ shareUrl, packageUrl, windows, client: "codex-config" }).code;
    assert.match(toml, /startup_timeout_sec = 120/); assert.match(toml, /\[mcp_servers\.qa-report-aaaaaaaa.env\]/);
    assert.ok(toml.includes(JSON.stringify(server.args)));
    const claude = buildSetup({ shareUrl, packageUrl, windows, client: "claude" }).code;
    assert.match(claude, /^claude mcp add --scope user --transport stdio /);
    assert.ok(claude.includes("QA_REPORT_SHARE_URL=" + shareUrl));
    const codex = buildSetup({ shareUrl, packageUrl, windows }).code;
    assert.match(codex, /^codex mcp add --env /);
    assert.ok(codex.includes("QA_REPORT_SHARE_URL=" + shareUrl));
  }
  const viewer = JSON.parse(buildSetup({ shareUrl, packageUrl, client: "json", readOnly: true }).code);
  assert.equal(viewer.mcpServers["qa-report-aaaaaaaa"].env.QA_REPORT_MCP_READ_ONLY, "1");
  assert.throws(() => buildSetup({ shareUrl, packageUrl: "https://elsewhere.example" + packageUrl }));
  assert.throws(() => buildSetup({ shareUrl: shareUrl.replace("https:", "http:"), packageUrl }));
});

test("QA setup pins its temporary receipt, separates roles and quotes local paths safely", () => {
  const connection = { url: "https://reports.example/api/local-import/agent/qa-session", token: "d".repeat(64) };
  const fileRoot = "/tmp/results 'quoted' $(touch SHOULD_NOT_EXIST)";
  const value = buildSetup({ connection, packageUrl, fileRoot, client: "json" });
  const server = Object.values(JSON.parse(value.code).mcpServers)[0];
  assert.equal(server.env.QA_REPORT_IMPORT_URL, connection.url);
  assert.equal(server.env.QA_REPORT_IMPORT_TOKEN, connection.token);
  assert.equal(server.env.QA_REPORT_FILE_ROOT, fileRoot);
  assert.equal(server.env.QA_REPORT_SHARE_URL, undefined);
  const { spawnSync } = require("node:child_process");
  const command = buildSetup({ connection, packageUrl, fileRoot }).code;
  const result = spawnSync("/bin/sh", ["-c", 'codex() { printf "%s\\n" "$@"; }; ' + command], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.split("\n").includes("QA_REPORT_FILE_ROOT=" + fileRoot));
  const windows = buildSetup({ connection, packageUrl, fileRoot: "C:\\QA's results", windows: true }).code;
  assert.ok(windows.includes("C:\\QA''s results"));
  assert.throws(() => buildSetup({ connection, shareUrl, packageUrl }));
  assert.throws(() => buildSetup({ connection: { ...connection, token: "wrong" }, packageUrl }));
  assert.throws(() => buildSetup({ connection, packageUrl, fileRoot: "relative/path" }));
  assert.throws(() => buildSetup({ connection, packageUrl, accessToken: "e".repeat(64) }));
  const corporate = Object.values(JSON.parse(buildSetup({ shareUrl, packageUrl, accessToken: "e".repeat(64), client: "json" }).code).mcpServers)[0];
  assert.equal(corporate.env.QA_REPORT_MCP_ACCESS_TOKEN, "e".repeat(64));
});
