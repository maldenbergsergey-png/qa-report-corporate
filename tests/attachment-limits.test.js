const test = require("node:test");
const assert = require("node:assert/strict");
const limits = require("../attachment-limits");

test("base64 accounting uses raw bytes for Jira and UTF-8 JSON bytes for transport", () => {
  for (const size of [1, 2, 3, 4, 1204756]) {
    const dataBase64 = Buffer.alloc(size, 0x82).toString("base64");
    assert.equal(dataBase64.length, 4 * Math.ceil(size / 3));
    assert.equal(limits.base64Bytes(dataBase64), size);
    assert.equal(limits.fileError({ name: "видео.mp4", dataBase64 }, { ...limits.defaults, jiraUploadLimit: size }), "");
    assert.match(limits.fileError({ name: "видео.mp4", dataBase64 }, { ...limits.defaults, jiraUploadLimit: size - 1 }), /лимит Jira/);
    const json = JSON.stringify({ token: "fixture", files: [{ name: "видео.mp4", dataBase64 }] });
    const requestBytes = Buffer.byteLength(json, "utf8");
    assert.equal(limits.requestError(json, { requestMaxBytes: requestBytes }), "");
    assert.match(limits.requestError(json, { requestMaxBytes: requestBytes - 1 }), /лимит QA Report/);
  }
});
test("unknown, disabled, zero, local and transport limits stay distinct", () => {
  assert.equal(limits.fileError({ name: "clip.mp4", size: 1204756 }), "");
  assert.match(limits.describe(limits.defaults), /неизвестен/);
  assert.match(limits.fileError({ name: "clip.mp4", size: 1 }, { ...limits.defaults, jiraEnabled: false }), /отключены/);
  assert.match(limits.fileError({ name: "clip.mp4", size: 1 }, { ...limits.defaults, jiraUploadLimit: 0 }), /лимит Jira/);
  assert.match(limits.fileError({ name: "clip.mp4", size: 51 * 1024 * 1024 }), /лимит QA Report/);
  assert.equal(limits.fileError({ name: "clip.mp4", size: 51 * 1024 * 1024 }, { ...limits.defaults, appMaxFileBytes: 60 * 1024 * 1024 }), "");
  assert.match(limits.fileError({ name: "clip.mp4", size: 1204756 }, { ...limits.defaults, requestMaxBytes: 1024 * 1024 }), /при передаче/);
});
test("Jira metadata respects Cloud/DC paths and degrades to unknown for unsupported metadata", async () => {
  for (const [type, version] of [["cloud", "3"], ["data-center", "2"]]) {
    const value = await limits.fromJira({ type }, async (_, path) => {
      assert.equal(path, `/rest/api/${version}/attachment/meta`);
      return { enabled: true, uploadLimit: 1204756 };
    });
    assert.deepEqual(value, { jiraEnabled: true, jiraUploadLimit: 1204756 });
  }
  for (const value of [{}, { enabled: "false", uploadLimit: -1 }, { uploadLimit: "100" }]) {
    assert.deepEqual(await limits.fromJira({}, async () => value), { jiraEnabled: null, jiraUploadLimit: null });
  }
  assert.deepEqual(await limits.fromJira({}, async () => { throw new Error("HTTP 404"); }), { jiraEnabled: null, jiraUploadLimit: null });
});

test("allowing other Jira image formats does not loosen storage image validation", () => {
  const fs = require("node:fs"), vm = require("node:vm");
  const source = fs.readFileSync(require.resolve("../server"), "utf8");
  const context = vm.createContext({ Buffer, MAX_ATTACHMENT_FILE: limits.defaults.appMaxFileBytes });
  for (const name of ["detectImageMime", "decodeImageFile", "decodeAttachmentFile"]) {
    const start = source.indexOf(`function ${name}(`), end = source.indexOf("\n}", start) + 2;
    vm.runInContext(source.slice(start, end), context);
  }
  assert.throws(() => context.decodeAttachmentFile({ name: "diagram.svg", type: "image/svg+xml", dataBase64: Buffer.from("<svg/>").toString("base64") }, 0), /не распознан/);
});
