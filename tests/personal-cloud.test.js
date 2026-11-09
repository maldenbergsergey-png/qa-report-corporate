const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
const { Writable } = require('node:stream');
const { createCloudSettings, createPersonalCloud } = require('../personal-cloud');
const bytesHash = bytes => createHash('sha256').update(bytes).digest('hex');
const document = () => ({ schemaVersion: 3, issueUrl: 'https://tasks.example/browse/QA-1', environment: 'STAGE', overallStatus: '', intro: '<p>Личный отчёт</p>', numberingMode: 'manual', sections: [{ id: 's', title: 'Раздел', columns: [{ id: 'check', title: 'Проверка' }], rows: [{ id: 'r', manualNumber: '4.2', status: 'OK', cells: { check: 'Результат' } }] }] });
function setup(t) {
  const db = new DatabaseSync(':memory:');
  let configured = true, uploadsEnabled = true;
  const settings = createCloudSettings({ getDb: () => db, configured: () => configured });
  const objects = new Map();
  const storage = { activeBucketId: 'private',
    async put(key, bytes) { objects.set(key, Buffer.from(bytes)); return { key, bucketId: 'private' }; },
    async get({ key }) { assert.ok(objects.has(key)); return new Response(objects.get(key)); },
    async remove({ key }) { objects.delete(key); } };
  let cloud;
  const restart = async () => {
    await cloud?.close();
    cloud = createPersonalCloud({ getDb: () => db, settings, storage: () => storage, uploadsAllowed: () => uploadsEnabled,
      authenticate: request => request.session,
      validateWrite: request => { if (request.headers.origin !== 'https://qa.example' || request.headers.csrf !== 'valid') throw Object.assign(Error('CSRF'), { status: 403 }); },
      readJson: async (request, max = Infinity) => { if (Buffer.byteLength(JSON.stringify(request.body)) > max) throw Object.assign(Error('size'), { status: 413 }); return request.body; },
      sendJson: (response, status, body) => { response.status = status; response.json = body; },
    });
  };
  t.after(async () => { await cloud?.close(); db.close(); });
  async function call(route = '', method = 'GET', body = {}, session = 'owner-a', headers = {}) {
    const chunks = [];
    const response = new Writable({ write(chunk, _, done) { chunks.push(Buffer.from(chunk)); done(); } });
    response.writeHead = (status, headers) => { response.status = status; response.headers = headers; };
    try {
      const handled = await cloud.handle({ method, body, session, headers: { origin: 'https://qa.example', csrf: 'valid', ...headers } }, response, '/api/cloud-reports' + route);
      assert.equal(handled, true);
    } catch (error) { response.status = error.status || 400; response.json = { error: error.message }; }
    response.bytes = Buffer.concat(chunks);
    return response;
  }
  const create = async () => { settings.set(true); const result = await call('', 'POST'); assert.equal(result.status, 201); return result.json.report.id; };
  const save = (id, doc = document(), revision = 0, session) => call('/' + id, 'PUT', { document: doc, revision, title: 'Личный отчёт', owner_id: 'forged' }, session);
  const upload = async (id, bytes) => {
    const hash = bytesHash(bytes);
    for (let offset = 0; offset < Math.max(1, bytes.length); offset += 384 * 1024) {
      const result = await call(`/${id}/files/${hash}`, 'POST', { size: bytes.length, offset, data: bytes.subarray(offset, offset + 384 * 1024).toString('base64') });
      assert.equal(result.status, 200, result.json?.error);
    }
    return hash;
  };
  return { db, settings, objects, storage, call, create, save, upload, restart,
    configured(value) { configured = value; }, uploads(value) { uploadsEnabled = value; } };
}

test('cloud is opt-in; anonymous access, CSRF and user overrides cannot bypass policy', async t => {
  const h = setup(t); await h.restart();
  assert.equal((await h.call('/availability')).json.canSave, false);
  assert.equal((await h.call('', 'POST')).status, 403);
  assert.equal((await h.call('', 'GET', {}, null)).status, 401);
  h.settings.set(true);
  assert.equal((await h.call('', 'POST', {}, 'owner-a', { csrf: 'forged' })).status, 403);
  assert.equal((await h.call('', 'POST', {}, 'owner-a', { origin: 'https://attacker.example' })).status, 403);
  h.settings.setUser('owner-a', false);
  assert.equal((await h.call('', 'POST')).status, 403);
  h.settings.setUser('owner-a', true);
  assert.equal((await h.call('', 'POST')).status, 201);
  h.configured(false);
  assert.equal((await h.call('/availability')).json.canSave, false);
});

test('account ownership isolates list, document, mutation, deletion and direct attachment links', async t => {
  const h = setup(t); await h.restart(); const id = await h.create();
  const bytes = Buffer.from('private binary\0\xff'), hash = await h.upload(id, bytes);
  const doc = document(); doc.intro = `<figure class="cell-file" data-mime-type="text/plain" data-data-url="report-asset:${hash}">private.txt</figure>`;
  assert.equal((await h.save(id, doc)).status, 200);
  assert.equal((await h.call('', 'GET', {}, 'owner-b')).json.reports.length, 0);
  for (const [route, method, body] of [[`/${id}`, 'GET', {}], [`/${id}`, 'PUT', { document: doc, revision: 1, title: 'hijack' }], [`/${id}`, 'DELETE', {}], [`/${id}/files/${hash}`, 'GET', {}], [`/${id}/files/${hash}`, 'POST', { offset: 0, size: 1, data: 'YQ==' }], [`/${id}/files`, 'POST', { files: [] }]]) {
    assert.equal((await h.call(route, method, body, 'owner-b')).status, 403, `${method} ${route}`);
  }
  const downloaded = await h.call(`/${id}/files/${hash}`);
  assert.equal(downloaded.status, 200); assert.deepEqual(downloaded.bytes, bytes);
  assert.equal(downloaded.headers['Cache-Control'], 'no-store');
  assert.equal(downloaded.headers['Content-Type'], 'application/octet-stream');
  assert.match([...h.objects.keys()][0], new RegExp(`^cloud-reports/[a-f0-9]{64}/${id}/${hash}$`));
  assert.doesNotMatch([...h.objects.keys()][0], /owner-a|private.txt/);
  await h.restart();
  assert.equal((await h.call('/' + id)).json.report.document.sections[0].rows[0].manualNumber, '4.2');
});

test('optimistic revisions reject stale device updates and never accept a forced overwrite', async t => {
  const h = setup(t); await h.restart(); const id = await h.create();
  assert.equal((await h.save(id)).json.report.revision, 1);
  const other = document(); other.environment = 'PROD';
  assert.equal((await h.save(id, other, 1)).json.report.revision, 2);
  const stale = await h.call('/' + id, 'PUT', { document: document(), title: 'stale', revision: 1, force: true });
  assert.equal(stale.status, 409);
  assert.equal((await h.call('/' + id)).json.report.document.environment, 'PROD');
});

test('chunked attachments verify full hash, do not enter SQLite, and retain prior report on failure', async t => {
  const h = setup(t); await h.restart(); const id = await h.create();
  await h.save(id);
  const bytes = Buffer.alloc(500 * 1024, 23), hash = bytesHash(bytes);
  assert.equal((await h.call(`/${id}/files/${hash}`, 'POST', { size: bytes.length, offset: 0, data: bytes.subarray(0, 384 * 1024).toString('base64') })).status, 200);
  const doc = document(); doc.intro = `<img src="report-asset:${hash}" data-mime-type="image/png">`;
  assert.equal((await h.save(id, doc, 1)).status, 400);
  assert.equal((await h.call(`/${id}/files/${hash}`)).status, 403);
  assert.equal((await h.call('/' + id)).json.report.revision, 1);
  assert.equal((await h.call(`/${id}/files/${hash}`, 'POST', { size: bytes.length, offset: 1, data: 'YQ==' })).status, 409);
  await h.upload(id, bytes);
  assert.equal((await h.save(id, doc, 1)).status, 200);
  assert.equal(h.db.prepare('SELECT document_json FROM personal_cloud_reports WHERE id=?').get(id).document_json.includes('base64'), false);
  assert.equal((await h.call(`/${id}/files`, 'POST', { files: [{ hash, size: bytes.length }] })).json.missing.length, 0);
  const bad = await h.call(`/${id}/files/${'a'.repeat(64)}`, 'POST', { size: 1, offset: 0, data: 'YQ==' });
  assert.equal(bad.status, 400);
  assert.equal(h.objects.size, 1);
});

test('new upload restrictions preserve existing files and text updates; global cloud pause preserves reads and deletion', async t => {
  const h = setup(t); await h.restart(); const id = await h.create();
  const bytes = Buffer.from('attachment'), hash = await h.upload(id, bytes);
  const doc = document(); doc.intro = `<img src="report-asset:${hash}" data-mime-type="image/png">`;
  await h.save(id, doc);
  h.uploads(false);
  assert.equal((await h.save(id, doc, 1)).status, 200);
  assert.equal((await h.call(`/${id}/files/${bytesHash(Buffer.from('new'))}`, 'POST', { size: 3, offset: 0, data: 'bmV3' })).status, 403);
  h.settings.set(false);
  assert.equal((await h.save(id, doc, 2)).status, 403);
  assert.equal((await h.call('/' + id)).status, 200);
  assert.equal((await h.call(`/${id}/files/${hash}`)).status, 200);
  assert.equal((await h.call('/' + id, 'DELETE')).status, 200);
  assert.equal((await h.call('/' + id)).status, 403);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM personal_cloud_cleanup').get().n, 1);
});

test('invalid and external attachment references cannot be committed; textual source code is preserved', async t => {
  const h = setup(t); await h.restart(); const id = await h.create();
  for (const intro of ['<img src="data:image/png;base64,YQ==">', '<img src=https://attacker.example/x>', '<figure data-data-url="https://attacker.example/x"></figure>', `<img src="report-asset:${'a'.repeat(64)}">`]) {
    const doc = document(); doc.intro = intro; assert.equal((await h.save(id, doc)).status, 400);
  }
  const doc = document(); doc.intro = '<pre>src="https://example.test/script.js"</pre>'; doc.token = 'secret'; doc.ownerId = 'forged';
  assert.equal((await h.save(id, doc)).status, 200);
  const stored = (await h.call('/' + id)).json.report.document;
  assert.equal(stored.token, undefined); assert.equal(stored.ownerId, undefined); assert.equal(stored.intro, doc.intro);
});

test('removing an attachment excludes it from new snapshots and direct downloads', async t => {
  const h = setup(t); await h.restart(); const id = await h.create();
  const hash = await h.upload(id, Buffer.from('removed'));
  const doc = document(); doc.intro = `<img src="report-asset:${hash}" data-mime-type="image/png">`;
  await h.save(id, doc);
  assert.equal((await h.save(id, document(), 1)).status, 200);
  assert.equal((await h.call('/' + id)).json.report.files.length, 0);
  assert.equal((await h.call(`/${id}/files/${hash}`)).status, 403);
});
