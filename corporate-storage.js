const { readFileSync } = require('node:fs');
const { createReportStorage } = require('./report-storage');

function corporateStorageConfig(env = process.env) {
  const secret = name => env[name + '_FILE'] ? readFileSync(env[name + '_FILE'], 'utf8').trim() : String(env[name] || '').trim();
  return { activeBucket: 'corporate', buckets: { corporate: {
    endpoint: String(env.QA_STORAGE_ENDPOINT || 'https://minio-buckets.adv.ru').replace(/\/+$/, ''),
    name: String(env.QA_STORAGE_BUCKET || 'qa-tools').trim(),
    region: String(env.QA_STORAGE_REGION || 'us-east-1').trim(),
    accessKeyId: secret('QA_STORAGE_ACCESS_KEY'), secretAccessKey: secret('QA_STORAGE_SECRET_KEY'),
  } } };
}

function createCorporateStorage(env = process.env) { return createReportStorage(corporateStorageConfig(env)); }
module.exports = { corporateStorageConfig, createCorporateStorage };
