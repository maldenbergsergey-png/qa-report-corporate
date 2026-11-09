"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { gzipSync } = require("node:zlib");
const { createHash } = require("node:crypto");

// Only these public source files enter the npm archive. Never pack the repository.
async function buildMcpPackage(root = __dirname) {
  const app = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const manifest = { name: "@qa-report/mcp", version: app.version, description: "QA Report MCP server",
    bin: { "qa-report-mcp": "scripts/qa-report-mcp.cjs" }, engines: { node: ">=22" },
    dependencies: Object.fromEntries(["@modelcontextprotocol/server", "zod"].map(name => [name, app.dependencies[name]])) };
  const files = new Map([["package.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n")]]);
  for (const file of ["scripts/qa-report-mcp.cjs", "scripts/shared-report-mcp.cjs"]) {
    files.set(file, await fs.readFile(path.join(root, file)));
  }
  const parts = [];
  for (const [name, bytes] of files) {
    const header = Buffer.alloc(512);
    header.write("package/" + name, 0, 100, "ascii");
    const octal = (offset, size, number) => header.write(number.toString(8).padStart(size - 1, "0") + "\0", offset, size, "ascii");
    octal(100, 8, name.endsWith(".cjs") ? 0o755 : 0o644); octal(108, 8, 0); octal(116, 8, 0);
    octal(124, 12, bytes.length); octal(136, 12, 0);
    header.fill(32, 148, 156); header[156] = 48;
    header.write("ustar\0", 257, 6, "ascii"); header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    parts.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  parts.push(Buffer.alloc(1024));
  const bytes = gzipSync(Buffer.concat(parts));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { bytes, version: app.version, sha256, packageUrl: `/downloads/qa-report-mcp.tgz?v=${sha256}` };
}

function createMcpDownload(root = __dirname) {
  let cached;
  return async (request, response, pathname) => {
    if (!["/api/mcp/package", "/downloads/qa-report-mcp.tgz"].includes(pathname)) return false;
    if (!["GET", "HEAD"].includes(request.method)) {
      response.writeHead(405, { Allow: "GET, HEAD" }); response.end(); return true;
    }
    cached ??= buildMcpPackage(root).catch(error => { cached = undefined; throw error; });
    const bundle = await cached;
    if (pathname === "/api/mcp/package") {
      const payload = JSON.stringify({ version: bundle.version, sha256: bundle.sha256, packageUrl: bundle.packageUrl, node: ">=22" });
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(request.method === "HEAD" ? undefined : payload); return true;
    }
    const expected = new URL(request.url, "http://localhost").searchParams.get("v");
    if (expected && expected !== bundle.sha256) {
      response.writeHead(409, { "Cache-Control": "no-store" }); response.end("Откройте «Подключить ИИ» и скопируйте обновлённую конфигурацию."); return true;
    }
    response.writeHead(200, { "Content-Type": "application/gzip", "Content-Length": bundle.bytes.length,
      "Content-Disposition": `attachment; filename="qa-report-mcp-${bundle.version}.tgz"`, "X-Content-Type-Options": "nosniff",
      "Cache-Control": expected ? "public, max-age=31536000, immutable" : "no-cache", ETag: `"${bundle.sha256}"` });
    response.end(request.method === "HEAD" ? undefined : bundle.bytes); return true;
  };
}
module.exports = { buildMcpPackage, createMcpDownload };
