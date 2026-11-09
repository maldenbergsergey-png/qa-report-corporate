const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const path = require("node:path");

async function connectMcp(env, protocolVersion = "2025-11-25", script = "qa-report-mcp.cjs", launch) {
  const child = spawn(launch?.command || process.execPath, launch?.args || [path.resolve(__dirname, "../../scripts", script)], {
    env: { ...process.env, QA_REPORT_PROJECT_URL: "", QA_REPORT_PROJECT_TOKEN: "", QA_REPORT_IMPORT_URL: "", QA_REPORT_IMPORT_TOKEN: "", QA_REPORT_SHARE_URL: "", QA_REPORT_SHARE_ORIGIN: "", QA_REPORT_FILE_ROOT: "", QA_REPORT_MCP_READ_ONLY: "", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let nextId = 0, stderr = "";
  const pending = new Map(), messages = [];
  child.stderr.on("data", bytes => { stderr += bytes; });
  const lines = createInterface({ input: child.stdout });
  function fail(error) { for (const entry of pending.values()) entry.reject(error); pending.clear(); }
  lines.on("line", line => {
    try {
      const message = JSON.parse(line);
      messages.push(message);
      const entry = pending.get(message.id);
      if (entry) { pending.delete(message.id); entry.resolve(message); }
    } catch (error) { fail(error); }
  });
  child.on("error", fail);
  child.on("exit", () => fail(new Error("MCP process exited: " + stderr)));
  const send = value => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
  function request(method, params) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("MCP request timed out: " + method)); }, launch?.timeoutMs || 10000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      send({ id, method, params });
    });
  }
  const close = async () => {
    if (child.exitCode !== null || child.signalCode) return;
    await new Promise(resolve => { child.once("exit", resolve); child.kill(); });
    lines.close();
  };
  try {
    const initialized = await request("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "qa-report-test", version: "1.0.0" } });
    if (initialized.error) throw new Error(JSON.stringify(initialized.error));
    send({ method: "notifications/initialized" });
    return { request, call: (name, args = {}) => request("tools/call", { name, arguments: args }), close, messages, initialized,
      get stderr() { return stderr; } };
  } catch (error) { await close(); throw error; }
}
module.exports = { connectMcp };
