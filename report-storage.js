const { createHash, createHmac } = require("node:crypto");
const { readFileSync, realpathSync } = require("node:fs");
const path = require("node:path");

const bucketIdPattern = /^[a-z][a-z0-9-]{0,39}$/;
const bucketNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9.-]{1,61}[a-zA-Z0-9]$/;
const objectSegmentPattern = /^[a-zA-ZА-Яа-яЁё0-9_.:-]+$/;
const isObjectSegment = (value) => objectSegmentPattern.test(value) && value !== "." && value !== "..";

function parseBucket(id, bucket) {
  if (!bucketIdPattern.test(id) || !bucket || typeof bucket !== "object") {
    throw new Error("Некорректная запись бакета S3");
  }
  const { endpoint, region, name, accessKeyId, secretAccessKey } = bucket;
  const url = typeof endpoint === "string" && URL.canParse(endpoint) ? new URL(endpoint) : null;
  if (!url || url.protocol !== "https:" || url.href !== `${url.origin}/`) {
    throw new Error(`Для бакета ${id} укажите адрес S3 вида https://s3.example.com`);
  }
  if (
    typeof region !== "string" || !/^[a-z0-9-]{1,64}$/.test(region) ||
    typeof name !== "string" || !bucketNamePattern.test(name) ||
    typeof accessKeyId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(accessKeyId) ||
    typeof secretAccessKey !== "string" || !secretAccessKey || /\s/.test(secretAccessKey)
  ) {
    throw new Error(`Для бакета ${id} проверьте имя, регион и ключи доступа S3`);
  }
  return { url, region, name, accessKeyId, secretAccessKey };
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const hmac = (key, value) => createHmac("sha256", key).update(value).digest();

const encode = (value) => encodeURIComponent(value).replace(/[!'()*]/g,
  (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase());
const queryString = (values) => Object.keys(values).sort().map((name) => encode(name) + "=" + encode(values[name])).join("&");

function signingContext(bucket, date) {
  const timestamp = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = timestamp.slice(0, 8);
  const scope = `${day}/${bucket.region}/s3/aws4_request`;
  const dateKey = hmac(`AWS4${bucket.secretAccessKey}`, day);
  const signingKey = hmac(hmac(hmac(dateKey, bucket.region), "s3"), "aws4_request");
  return {
    timestamp, scope,
    sign(canonicalRequest) {
      return hmac(signingKey, ["AWS4-HMAC-SHA256", timestamp, scope, sha256(canonicalRequest)].join("\n")).toString("hex");
    },
  };
}

function signRequest(method, pathname, bucket, bytes, date, query = "") {
  const { timestamp, scope, sign } = signingContext(bucket, date);
  const headers = {
    host: bucket.url.host,
    "x-amz-content-sha256": sha256(bytes),
    "x-amz-date": timestamp,
  };
  const signedHeaders = Object.keys(headers).join(";");
  const canonicalHeaders = Object.entries(headers).map(([name, value]) => `${name}:${value}\n`).join("");
  const signature = sign([method, pathname, query, canonicalHeaders, signedHeaders, headers["x-amz-content-sha256"]].join("\n"));
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${bucket.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

function createReportStorage(config, { fetchObject = fetch, now = () => new Date() } = {}) {
  if (!config || typeof config.activeBucket !== "string" || !config.buckets ||
      typeof config.buckets !== "object" || Array.isArray(config.buckets)) {
    throw new Error("Укажите activeBucket и настройки buckets для S3");
  }
  const buckets = new Map(Object.entries(config.buckets).map(([id, bucket]) => [id, parseBucket(id, bucket)]));
  const activeBucketId = config.activeBucket;
  if (!buckets.has(activeBucketId)) throw new Error("Активный бакет S3 отсутствует в настройках");

  function resolveObject({ bucketId, key }) {
    const bucket = buckets.get(bucketId);
    if (!bucket) throw new Error("Бакет для этого файла отсутствует в настройках S3");
    if (typeof key !== "string" || Buffer.byteLength(key) > 1024 || !key.split("/").every(isObjectSegment)) {
      throw new Error("Некорректный ключ файла S3");
    }
    return { bucket, pathname: `/${bucket.name}/${key.split("/").map(encode).join("/")}` };
  }

  async function request(method, reference, bytes, query = "", contentType = "application/octet-stream") {
    const { bucketId } = reference;
    const { bucket, pathname } = query === "cors=" && reference.key === ""
      ? { bucket: buckets.get(bucketId), pathname: `/${buckets.get(bucketId).name}` }
      : resolveObject(reference);
    const headers = signRequest(method, pathname, bucket, bytes ?? "", now(), query);
    if (bytes) headers["content-type"] = contentType;
    if (bytes && query === "cors=") headers["content-md5"] = createHash("md5").update(bytes).digest("base64");
    let response;
    try {
      response = await fetchObject(new URL(query ? `${pathname}?${query}` : pathname, bucket.url), {
        method, headers, body: bytes, redirect: "error", signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error(`S3 ${bucketId}: запрос ${method} не выполнен`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(new Error(`S3 ${bucketId}: ${method} вернул HTTP ${response.status}`), { storageStatus: response.status });
    }
    return response;
  }

  return {
    activeBucketId,
    hasBucket: (id) => buckets.has(id),
    uploadUrl(reference, size) {
      const { bucket, pathname } = resolveObject(reference);
      if (!Number.isSafeInteger(size) || size < 0) throw new TypeError("Некорректный размер файла");
      const { timestamp, scope, sign } = signingContext(bucket, now());
      const signedHeaders = "content-length;host";
      const query = queryString({
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": `${bucket.accessKeyId}/${scope}`,
        "X-Amz-Date": timestamp,
        "X-Amz-Expires": "1800",
        "X-Amz-SignedHeaders": signedHeaders,
      });
      const headers = `content-length:${size}\nhost:${bucket.url.host}\n`;
      const signature = sign(["PUT", pathname, query, headers, signedHeaders, "UNSIGNED-PAYLOAD"].join("\n"));
      return new URL(`${pathname}?${query}&X-Amz-Signature=${signature}`, bucket.url).href;
    },
    async allowBrowserUploads(origin, bucketId = activeBucketId) {
      const url = new URL(origin);
      if (url.origin !== origin || url.protocol !== "https:") throw new Error("Укажите HTTPS-адрес QA Report без пути");
      // Bucket-wide CORS is a deployment operation. Preserve other rules.
      const bucket = buckets.get(bucketId);
      if (!bucket) throw new Error("Бакет отсутствует в настройках S3");
      const reference = { bucketId, key: "" };
      let xml;
      try {
        xml = await (await request("GET", reference, undefined, "cors=")).text();
      } catch (error) {
        if (error.storageStatus !== 404) throw error;
        xml = '<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></CORSConfiguration>';
      }
      if (!/<\/CORSConfiguration>\s*$/.test(xml)) throw new Error("S3 вернул неизвестный формат правил CORS");
      if ((xml.match(/<CORSRule>[\s\S]*?<\/CORSRule>/g) || []).some(rule =>
        rule.includes(`<AllowedOrigin>${origin}</AllowedOrigin>`) && rule.includes("<AllowedMethod>PUT</AllowedMethod>"))) return;
      const rule = `<CORSRule><AllowedOrigin>${origin}</AllowedOrigin><AllowedMethod>PUT</AllowedMethod><AllowedHeader>content-type</AllowedHeader><MaxAgeSeconds>600</MaxAgeSeconds></CORSRule>`;
      const body = Buffer.from(xml.replace("</CORSConfiguration>", rule + "</CORSConfiguration>"));
      await (await request("PUT", reference, body, "cors=", "application/xml")).body?.cancel();
    },
    async put(key, bytes, { bucketId = activeBucketId } = {}) {
      if (!Buffer.isBuffer(bytes)) throw new TypeError("Для загрузки S3 ожидается Buffer");
      const reference = { bucketId, key };
      const response = await request("PUT", reference, bytes);
      await response.body?.cancel();
      return reference;
    },
    get: (reference) => request("GET", reference),
    async remove(reference) {
      const response = await request("DELETE", reference);
      await response.body?.cancel();
    },
  };
}

function loadReportStorage(configPath) {
  if (!configPath) throw new Error("Укажите путь к файлу настроек S3");
  const resolved = path.resolve(configPath);
  let real;
  try {
    real = realpathSync(resolved);
  } catch {
    throw new Error("Файл настроек S3 недоступен");
  }
  const appDirectories = [__dirname, realpathSync(__dirname)];
  if ([resolved, real].some((file) => appDirectories.some((dir) => file.startsWith(`${dir}${path.sep}`)))) {
    throw new Error("Храните настройки S3 с ключами вне каталога приложения");
  }
  let config;
  try {
    config = JSON.parse(readFileSync(real, "utf8"));
  } catch {
    throw new Error("Не удалось прочитать JSON с настройками S3");
  }
  return createReportStorage(config);
}

module.exports = { createReportStorage, loadReportStorage };
