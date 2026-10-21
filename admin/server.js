const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');

const scrypt = promisify(crypto.scrypt);
const SCRYPT_OPTIONS = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const DAY = 86400000;
const SESSION_TTL = 8 * 3600000;
const VISIT_GAP = 30 * 60000;
const equal = (a, b) => {
  const left = Buffer.from(String(a)); const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

async function passwordHash(password, salt) {
  return (await scrypt(password, salt, 64, SCRYPT_OPTIONS)).toString('hex');
}

function loadConfig(file) {
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Не удалось прочитать конфигурацию администратора'); }
  if (config.version !== 1 || !/^\/_manage_[a-f0-9]{32}$/.test(config.path) ||
      typeof config.username !== 'string' || !/^[\w.@-]{1,80}$/.test(config.username) ||
      !/^[a-f0-9]{32}$/.test(config.passwordSalt) || !/^[a-f0-9]{128}$/.test(config.passwordHash) ||
      !/^[a-f0-9]{64}$/.test(config.visitorSecret)) throw new Error('Некорректная конфигурация администратора');
  return config;
}

function cookieValue(request, name) {
  return String(request.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))?.slice(name.length + 1) || '';
}

function deviceInfo(ua) {
  const browserMatch = ua.match(/(Edg|OPR|Firefox|CriOS|Chrome|Version)\/([\d.]+)/);
  const names = { Edg: 'Edge', OPR: 'Opera', Firefox: 'Firefox', CriOS: 'Chrome', Chrome: 'Chrome', Version: 'Safari' };
  // Chromium-based browsers include Chrome before their own product token.
  const special = ua.match(/(Edg|OPR)\/([\d.]+)/);
  const match = special || browserMatch;
  const browser = match ? `${names[match[1]]} ${match[2].split('.')[0]}` : 'Другой браузер';
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iPod/i.test(ua) ? 'iOS' : /Windows/i.test(ua) ? 'Windows' : /Macintosh|Mac OS/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : 'Другая ОС';
  const device = /iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua)) ? 'Планшет' : /Mobile|iPhone|iPod/i.test(ua) ? 'Телефон' : 'Компьютер';
  return { browser, os, device };
}

function createAdminService({ root, reportsPath, env = process.env, clock = Date.now }) {
  const configFile = path.resolve(env.QA_ADMIN_CONFIG_FILE || path.join(root, 'secrets', 'admin', 'admin.json'));
  const dataDirectory = path.resolve(path.dirname(reportsPath), 'admin');
  const databaseFile = path.join(dataDirectory, 'usage.sqlite');
  const config = loadConfig(configFile);
  const timezone = env.QA_ADMIN_TIMEZONE || 'Europe/Moscow';
  const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dayOf = time => {
    const parts = Object.fromEntries(dayFormat.formatToParts(new Date(time)).map(p => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const secure = env.NODE_ENV !== 'development';
  let publicOrigin = '';
  const configuredOrigin = env.QA_REPORT_PUBLIC_URL || env.APP_PUBLIC_URL || env.PUBLIC_URL;
  if (configuredOrigin) publicOrigin = new URL(configuredOrigin).origin;
  if (config && secure && !publicOrigin.startsWith('https://')) throw new Error('Для админки требуется QA_REPORT_PUBLIC_URL с HTTPS');
  if (config && !secure && !['127.0.0.1', '::1', 'localhost'].includes(env.HOST || '127.0.0.1')) throw new Error('HTTP-вход администратора разрешён только на loopback в development');
  const sessions = new Map(); const limits = new Map();
  let db; let lastCleanup = 0; let verifying = false;

  function database() {
    if (db) return db;
    fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    db = new DatabaseSync(databaseFile);
    fs.chmodSync(databaseFile, 0o600);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS visitors (id TEXT PRIMARY KEY, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS activity (visitor_id TEXT REFERENCES visitors(id) ON DELETE CASCADE, mode TEXT, last_seen INTEGER NOT NULL, PRIMARY KEY(visitor_id, mode));
      CREATE TABLE IF NOT EXISTS usage_daily (day TEXT, visitor_id TEXT REFERENCES visitors(id) ON DELETE CASCADE, mode TEXT, ip TEXT, browser TEXT, os TEXT, device TEXT, visits INTEGER NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, PRIMARY KEY(day, visitor_id, mode, ip, browser, os, device));
      CREATE INDEX IF NOT EXISTS usage_visitor_day ON usage_daily(visitor_id, day);`);
    return db;
  }

  function cleanup() {
    const now = clock();
    for (const [key, item] of sessions) if (item.expires <= now) sessions.delete(key);
    for (const [key, item] of limits) if (item.until <= now) limits.delete(key);
    if (!config || (lastCleanup && now - lastCleanup < 3600000)) return;
    const store = database();
    store.prepare('DELETE FROM usage_daily WHERE day < ?').run(dayOf(now - 89 * DAY));
    store.exec('DELETE FROM visitors WHERE NOT EXISTS (SELECT 1 FROM usage_daily WHERE visitor_id = visitors.id)');
    lastCleanup = now;
  }
  // Purge expired personal data even if nobody opens the application.
  const timer = config ? setInterval(() => { try { cleanup(); } catch { console.error('Не удалось очистить статистику посещений'); } }, 3600000) : null;
  timer?.unref();

  function ipOf(request) {
    const value = env.QA_REPORT_TRUST_PROXY === 'true' ? String(request.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
    return net.isIP(value) ? value : request.socket.remoteAddress || 'unknown';
  }

  function rate(key, max, window) {
    const now = clock();
    let bucket = limits.get(key);
    if (!bucket || bucket.until <= now) {
      if (limits.size >= 10000) return false;
      limits.set(key, bucket = { count: 0, until: now + window });
    }
    return ++bucket.count <= max;
  }

  function send(response, status, payload, type = 'application/json; charset=utf-8') {
    response.writeHead(status, {
      'Content-Type': type, 'Cache-Control': 'no-store, private', 'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      ...(secure ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
    });
    response.end(type.startsWith('application/json') ? JSON.stringify(payload) : payload);
  }

  function sameOrigin(request) {
    const expected = publicOrigin || `http://${request.headers.host}`;
    return request.headers.origin === expected && !['cross-site', 'same-site'].includes(request.headers['sec-fetch-site']);
  }

  async function bodyOf(request) {
    if (!String(request.headers['content-type'] || '').startsWith('application/json')) throw Object.assign(new Error(), { status: 415 });
    const chunks = []; let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 2048) throw Object.assign(new Error(), { status: 413 });
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
    return body;
  }

  function setCookie(response, name, value, scope, maxAge) {
    response.setHeader('Set-Cookie', `${name}=${value}; Path=${scope}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
  }

  function visitorId(request, response) {
    const raw = cookieValue(request, 'qa-usage-id');
    const [id, signature] = raw.split('.');
    const sign = id => crypto.createHmac('sha256', config.visitorSecret).update(id).digest('hex');
    if (/^[a-f0-9]{32}$/.test(id || '') && equal(signature || '', sign(id))) return id;
    const next = crypto.randomBytes(16).toString('hex');
    setCookie(response, 'qa-usage-id', `${next}.${sign(next)}`, '/', 365 * 86400);
    return next;
  }

  async function collect(request, response) {
    if (!config) { response.writeHead(204, { 'Cache-Control': 'no-store' }); response.end(); return; }
    if (request.method !== 'POST') { send(response, 405, { error: 'Метод не поддерживается' }); return; }
    if (!sameOrigin(request)) { send(response, 403, { error: 'Источник запроса не разрешён' }); return; }
    cleanup();
    if (!rate(`usage:${ipOf(request)}`, 600, 5 * 60000)) { send(response, 429, { error: 'Повторите позже' }); return; }
    const body = await bodyOf(request);
    if (!['browser', 'pwa'].includes(body.mode)) { send(response, 400, { error: 'Неизвестный режим' }); return; }
    const id = visitorId(request, response); const now = clock(); const day = dayOf(now);
    const { browser, os, device } = deviceInfo(String(request.headers['user-agent'] || '').slice(0, 1000));
    const store = database();
    store.exec('BEGIN IMMEDIATE');
    try {
      const previous = store.prepare('SELECT last_seen FROM activity WHERE visitor_id = ? AND mode = ?').get(id, body.mode);
      const visits = !previous || now - previous.last_seen >= VISIT_GAP || dayOf(previous.last_seen) !== day ? 1 : 0;
      store.prepare('INSERT INTO visitors VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen').run(id, now, now);
      store.prepare('INSERT INTO activity VALUES (?, ?, ?) ON CONFLICT(visitor_id, mode) DO UPDATE SET last_seen = excluded.last_seen').run(id, body.mode, now);
      store.prepare(`INSERT INTO usage_daily VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(day, visitor_id, mode, ip, browser, os, device) DO UPDATE SET visits = visits + excluded.visits, last_seen = excluded.last_seen`)
        .run(day, id, body.mode, ipOf(request), browser, os, device, visits, now, now);
      store.exec('COMMIT');
    } catch (error) { store.exec('ROLLBACK'); throw error; }
    send(response, 200, { ok: true });
  }

  function statistics(url) {
    cleanup();
    const today = dayOf(clock()); const earliest = dayOf(clock() - 89 * DAY);
    const validDay = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    const from = url.searchParams.get('from') || dayOf(clock() - 6 * DAY);
    const to = url.searchParams.get('to') || today;
    if (!validDay(from) || !validDay(to) || from > to || from < earliest || to > today) throw Object.assign(new Error(), { status: 400 });
    const page = Math.max(1, Math.min(100000, Number.parseInt(url.searchParams.get('page'), 10) || 1));
    const search = (url.searchParams.get('search') || '').slice(0, 100);
    const store = database();
    const summary = store.prepare(`SELECT COUNT(DISTINCT visitor_id) AS visitors, COALESCE(SUM(visits), 0) AS visits,
      COUNT(DISTINCT CASE WHEN mode = 'pwa' THEN visitor_id END) AS pwa, COUNT(DISTINCT CASE WHEN mode = 'browser' THEN visitor_id END) AS browser
      FROM usage_daily WHERE day BETWEEN ? AND ?`).get(from, to);
    const daily = store.prepare('SELECT day, COUNT(DISTINCT visitor_id) AS visitors, SUM(visits) AS visits FROM usage_daily WHERE day BETWEEN ? AND ? GROUP BY day ORDER BY day DESC').all(from, to);
    const filter = `day BETWEEN ? AND ? AND (instr(visitor_id, ?) > 0 OR instr(ip, ?) > 0)`;
    const args = [from, to, search, search];
    const total = store.prepare(`SELECT COUNT(DISTINCT visitor_id) AS count FROM usage_daily WHERE ${filter}`).get(...args).count;
    const visitors = store.prepare(`SELECT visitor_id AS id, SUM(visits) AS visits, MIN(first_seen) AS firstSeen, MAX(last_seen) AS lastSeen FROM usage_daily WHERE ${filter} GROUP BY visitor_id ORDER BY lastSeen DESC, visitor_id LIMIT 50 OFFSET ?`).all(...args, (page - 1) * 50);
    for (const visitor of visitors) {
      visitor.devices = store.prepare(`SELECT mode, ip, browser, os, device, SUM(visits) AS visits FROM usage_daily WHERE visitor_id = ? AND day BETWEEN ? AND ? GROUP BY mode, ip, browser, os, device ORDER BY MAX(last_seen) DESC`).all(visitor.id, from, to);
    }
    return { from, to, today, earliest, timezone, retentionDays: 90, summary, daily, visitors, total, page, pageSize: 50 };
  }

  async function handle(request, response) {
    const url = new URL(request.url, 'http://localhost');
    if (!config || !(url.pathname === config.path || url.pathname.startsWith(config.path + '/'))) return false;
    try {
      if (secure && !request.socket.encrypted && !(env.QA_REPORT_TRUST_PROXY === 'true' && request.headers['x-forwarded-proto'] === 'https')) {
        send(response, 403, { error: 'Требуется HTTPS' }); return true;
      }
      cleanup();
      const suffix = url.pathname.slice(config.path.length);
      if (suffix === '' && request.method === 'GET') { response.writeHead(303, { Location: config.path + '/', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' }); response.end(); return true; }
      const assets = { '/': ['page.html', 'text/html; charset=utf-8'], '/ui.js': ['ui.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
      if (request.method === 'GET' && Object.hasOwn(assets, suffix)) {
        const [file, type] = assets[suffix]; send(response, 200, fs.readFileSync(path.join(__dirname, file)), type); return true;
      }
      if (request.headers['x-qa-admin'] !== '1' || (request.method !== 'GET' && !sameOrigin(request))) { send(response, 403, { error: 'Запрос отклонён' }); return true; }
      if (request.method === 'POST' && suffix === '/login') {
        if (!rate(`login:${ipOf(request)}`, 10, 15 * 60000) || !rate('login:all', 100, 15 * 60000) || verifying) { response.setHeader('Retry-After', '900'); send(response, 429, { error: 'Слишком много попыток. Повторите позже.' }); return true; }
        const body = await bodyOf(request);
        if (typeof body.password !== 'string' || body.password.length > 256 || typeof body.username !== 'string' || body.username.length > 80) { send(response, 401, { error: 'Неверный логин или пароль' }); return true; }
        verifying = true;
        let hash;
        try { hash = await passwordHash(body.password, config.passwordSalt); } finally { verifying = false; }
        const valid = equal(hash, config.passwordHash) && equal(body.username, config.username);
        if (!valid) { send(response, 401, { error: 'Неверный логин или пароль' }); return true; }
        const old = cookieValue(request, 'qa-admin-session'); if (old) sessions.delete(digest(old));
        if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
        const token = crypto.randomBytes(32).toString('hex'); const csrf = crypto.randomBytes(32).toString('hex');
        sessions.set(digest(token), { expires: clock() + SESSION_TTL, csrf });
        setCookie(response, 'qa-admin-session', token, config.path + '/', SESSION_TTL / 1000);
        send(response, 200, { ok: true, csrf }); return true;
      }
      const token = cookieValue(request, 'qa-admin-session');
      const session = token && sessions.get(digest(token));
      if (!session || session.expires <= clock()) { send(response, 401, { error: 'Войдите в админку' }); return true; }
      if (request.method === 'GET' && suffix === '/session') { send(response, 200, { csrf: session.csrf }); return true; }
      if (request.method === 'GET' && suffix === '/stats') { send(response, 200, statistics(url)); return true; }
      if (request.method === 'POST' && suffix === '/logout') {
        if (!equal(request.headers['x-csrf-token'] || '', session.csrf)) { send(response, 403, { error: 'Обновите страницу' }); return true; }
        sessions.delete(digest(token)); setCookie(response, 'qa-admin-session', '', config.path + '/', 0);
        send(response, 200, { ok: true }); return true;
      }
      send(response, 404, { error: 'Не найдено' });
    } catch (error) { send(response, error.status || 400, { error: error.status === 400 ? 'Проверьте период' : 'Не удалось обработать запрос' }); }
    return true;
  }

  function isPrivateFile(file) {
    const inside = (candidate, directory) => candidate === directory || candidate.startsWith(directory + path.sep);
    const reportsDirectory = path.resolve(path.dirname(reportsPath));
    const reportsFile = path.resolve(reportsPath);
    const blocked = candidate => path.relative(root, candidate).split(path.sep).some(part => part.startsWith('.')) ||
      [path.join(root, 'admin'), path.join(root, 'admin-config'), path.join(root, 'secrets'), path.join(root, 'reports-data'), dataDirectory, path.join(root, 'feedback-data')].some(dir => inside(candidate, dir)) ||
      (!inside(root, reportsDirectory) && inside(candidate, reportsDirectory)) || candidate === reportsFile || candidate.startsWith(reportsFile + '-') ||
      candidate === configFile || candidate.startsWith(configFile + '.') || candidate === path.join(root, 'scripts', 'setup-admin.cjs');
    if (blocked(file)) return true;
    try { return blocked(fs.realpathSync(file)); } catch { return false; }
  }

  return { handle, collect: async (request, response) => {
    try { await collect(request, response); }
    catch (error) { send(response, error.status || 400, { error: 'Не удалось записать посещение' }); }
  }, isPrivateFile, close() { if (timer) clearInterval(timer); db?.close(); } };
}

module.exports = { createAdminService, passwordHash, deviceInfo, loadConfig };
