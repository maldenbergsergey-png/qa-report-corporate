const { randomBytes, randomUUID } = require('node:crypto');
const { corporateStorageConfig } = require('../corporate-storage');
const { createReportStorage } = require('../report-storage');

async function checkStorage({ env = process.env, roundtrip = false, makeStorage = createReportStorage } = {}) {
  const config = corporateStorageConfig(env), bucket = config.buckets.corporate;
  const storage = makeStorage(config);
  const result = { endpoint: bucket.endpoint, bucket: bucket.name, region: bucket.region, roundtrip: false };
  if (!roundtrip) return result;
  const key = `healthchecks/${randomUUID()}`, bytes = randomBytes(32);
  const reference = { bucketId: 'corporate', key };
  let error;
  try {
    await storage.put(key, bytes);
    const received = Buffer.from(await (await storage.get(reference)).arrayBuffer());
    if (!received.equals(bytes)) throw new Error('S3 вернул другое содержимое проверочного файла.');
    result.roundtrip = true;
  } catch (failure) { error = failure; }
  finally {
    try { await storage.remove(reference); }
    catch { error = new Error(`${error ? error.message + ' ' : ''}Не удалось удалить проверочный объект ${key}. Удалите только этот объект из бакета.`); }
  }
  if (error) throw error;
  return result;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--roundtrip')) { console.error('Использование: npm run storage:check -- [--roundtrip]'); process.exitCode = 1; }
  else checkStorage({ roundtrip: args.includes('--roundtrip') }).then(result => {
    console.log(`S3: ${result.endpoint}; бакет: ${result.bucket}; регион: ${result.region}.`);
    console.log(result.roundtrip ? 'Запись, чтение, сверка содержимого и удаление проверочного объекта выполнены.' : 'Формат настроек проверен. Проверка сети и прав: npm run storage:check -- --roundtrip');
  }).catch(error => {
    // Never print credentials, signed URLs, headers or raw S3 responses.
    const message = error.code === 'ENOENT' || error.code === 'EACCES' ? 'Не удалось прочитать файл ключа S3. Проверьте путь и права пользователя контейнера.' : error.message;
    console.error(message); process.exitCode = 1;
  });
}
module.exports = { checkStorage };
