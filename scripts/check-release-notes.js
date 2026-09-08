const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fail(message) {
  throw new Error("Release notes check failed: " + message);
}

function loadProject(projectRoot) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const context = { window: {} };
  const releaseFile = path.join(projectRoot, "release-notes.js");
  vm.runInNewContext(fs.readFileSync(releaseFile, "utf8"), context, {
    filename: releaseFile,
    timeout: 1000,
  });
  const releases = context.window.QaReportReleases;
  const projectName = path.basename(projectRoot);
  if (!Array.isArray(releases) || !releases.length) fail(projectName + " has no releases");
  const latest = releases[0];
  if (latest.version !== packageJson.version) {
    fail(projectName + " package " + packageJson.version + " does not match latest release " + latest.version);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(latest.date || "")) fail(projectName + " has an invalid release date");
  if (new Set(releases.map(release => release.date)).size !== releases.length) {
    fail(projectName + " contains more than one release entry for the same date");
  }
  for (const category of ["new", "improvements", "fixes"]) {
    const items = latest.changes?.[category];
    if (!Array.isArray(items)) fail(projectName + " has no " + category + " release category");
    for (const item of items) {
      if (typeof item !== "string" || !item.trim()) fail(projectName + " contains an empty release item");
      if (item.length > 200) fail(projectName + " contains a release item longer than 200 characters");
    }
  }
  return { name: projectName, version: packageJson.version, date: latest.date };
}

const projectRoot = path.resolve(__dirname, "..");
const current = loadProject(projectRoot);
const workspaceRoot = path.dirname(projectRoot);
const peerName = current.name === "qa-report" ? "qa-report-corporate" : "qa-report";
const peerRoot = path.join(workspaceRoot, peerName);
if (fs.existsSync(path.join(peerRoot, "package.json")) && fs.existsSync(path.join(peerRoot, "release-notes.js"))) {
  const peer = loadProject(peerRoot);
  if (current.version !== peer.version || current.date !== peer.date) {
    fail(current.name + " " + current.version + " (" + current.date + ") does not match " +
      peer.name + " " + peer.version + " (" + peer.date + ")");
  }
}

console.log("Release notes are aligned at " + current.version + " (" + current.date + ").");
