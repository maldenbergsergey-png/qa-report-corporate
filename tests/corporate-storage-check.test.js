const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkStorage } = require('../scripts/check-corporate-storage.cjs');
const { corporateStorageConfig } = require('../corporate-storage');
const env = { QA_STORAGE_ENDPOINT: 'https://storage.example.test', QA_STORAGE_BUCKET: 'fixture-bucket', QA_STORAGE_REGION: 'eu-central-1',
  QA_STORAGE_ACCESS_KEY: 'synthetic-access', QA_STORAGE_SECRET_KEY: 'synthetic-secret' };

test('storage diagnosis validates settings without network and secrets files take precedence', async t => {
  const result = await checkStorage({ env });
  assert.deepEqual(result, { endpoint: env.QA_STORAGE_ENDPOINT, bucket: env.QA_STORAGE_BUCKET, region: env.QA_STORAGE_REGION, roundtrip: false });
  assert.ok(!JSON.stringify(result).includes(env.QA_STORAGE_SECRET_KEY));
  await assert.rejects(checkStorage({ env: { ...env, QA_STORAGE_ENDPOINT: 'http://storage.example.test' } }));
  await assert.rejects(checkStorage({ env: { ...env, QA_STORAGE_ENDPOINT: 'https://storage.example.test/console' } }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corporate-storage-check-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'key'); fs.writeFileSync(file, 'file-access\n');
  assert.equal(corporateStorageConfig({ ...env, QA_STORAGE_ACCESS_KEY_FILE: file }).buckets.corporate.accessKeyId, 'file-access');
  assert.throws(() => corporateStorageConfig({ ...env, QA_STORAGE_ACCESS_KEY_FILE: file + '-missing' }), { code: 'ENOENT' });
});

test('roundtrip checks bytes and only cleans its randomly named object, including failed PUT', async () => {
  const operations = [], objects = new Map();
  const makeStorage = () => ({
    async put(key, bytes) { operations.push(['put', key]); objects.set(key, bytes); },
    async get(ref) { operations.push(['get', ref.key]); return new Response(objects.get(ref.key)); },
    async remove(ref) { operations.push(['delete', ref.key]); objects.delete(ref.key); },
  });
  assert.equal((await checkStorage({ env, roundtrip: true, makeStorage })).roundtrip, true);
  assert.deepEqual(operations.map(item => item[0]), ['put', 'get', 'delete']);
  assert.match(operations[0][1], /^healthchecks\/[a-f0-9-]{36}$/);
  assert.ok(operations.every(item => item[1] === operations[0][1])); assert.equal(objects.size, 0);
  let cleaned;
  await assert.rejects(checkStorage({ env, roundtrip: true, makeStorage: () => ({
    async put() { throw new Error('Uncertain PUT'); }, async remove(ref) { cleaned = ref.key; },
  }) }), /Uncertain PUT/);
  assert.match(cleaned, /^healthchecks\//);
  await assert.rejects(checkStorage({ env, roundtrip: true, makeStorage: () => ({
    async put() {}, async get() { return new Response('wrong bytes'); }, async remove() {},
  }) }), /другое содержимое/);
  await assert.rejects(checkStorage({ env, roundtrip: true, makeStorage: () => ({
    async put() { throw new Error('S3 corporate: PUT вернул HTTP 403'); }, async remove() { throw new Error('Delete denied'); },
  }) }), /PUT вернул HTTP 403.*healthchecks\//);
});
