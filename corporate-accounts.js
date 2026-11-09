const { normalizeEmail } = require('./auth');

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const AVATAR_BYTES = 256 * 1024;

function avatarValue(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > Math.ceil(AVATAR_BYTES / 3) * 4 + 22 ||
      !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) fail(400, 'Выберите изображение PNG до 256 КиБ.');
  const encoded = value.slice(22), bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > AVATAR_BYTES || bytes.toString('base64') !== encoded || bytes.length < 33 ||
      bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(8) !== 13 ||
      bytes.subarray(12, 16).toString() !== 'IHDR' || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20) ||
      bytes.readUInt32BE(16) > 512 || bytes.readUInt32BE(20) > 512) fail(400, 'Аватар должен быть PNG размером до 512 × 512.');
  return value;
}

// Local display preferences never change AD identity, credentials or Jira ownership.
function createCorporateAccounts({ getDb, clock = Date.now }) {
  let initialized;
  function db() {
    const connection = getDb();
    if (initialized !== connection) {
      connection.function('corporate_lower', { deterministic: true }, value => String(value || '').toLowerCase());
      connection.exec(`CREATE TABLE IF NOT EXISTS corporate_accounts (
        email TEXT PRIMARY KEY, first_name TEXT NOT NULL DEFAULT '', last_name TEXT NOT NULL DEFAULT '',
        avatar TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, last_login INTEGER
      )`);
      initialized = connection;
    }
    return connection;
  }
  function observe(email, login = false) {
    const id = normalizeEmail(email);
    if (!id) fail(401, 'Войдите в QA Report.');
    const now = clock();
    db().prepare(`INSERT INTO corporate_accounts (email,first_seen,last_seen,last_login) VALUES (?,?,?,?)
      ON CONFLICT(email) DO UPDATE SET last_seen=excluded.last_seen,
        last_login=COALESCE(excluded.last_login,corporate_accounts.last_login)
      WHERE corporate_accounts.last_seen < ? OR excluded.last_login IS NOT NULL`)
      .run(id, now, now, login ? now : null, now - 60_000);
    return id;
  }
  const view = row => ({ id: row.email, email: row.email, firstName: row.first_name, lastName: row.last_name,
    name: [row.first_name, row.last_name].filter(Boolean).join(' '), avatar: row.avatar });
  function get(email) {
    const id = observe(email);
    return view(db().prepare('SELECT * FROM corporate_accounts WHERE email=?').get(id));
  }
  function update(email, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length ||
        Object.keys(body).some(key => !['firstName', 'lastName', 'avatar'].includes(key))) fail(400, 'Проверьте поля профиля.');
    const previous = get(email);
    for (const field of ['firstName', 'lastName']) if (Object.hasOwn(body, field) &&
        (typeof body[field] !== 'string' || body[field].trim().length > 100 || /[\u0000-\u001f\u007f]/.test(body[field]))) {
      fail(400, 'Имя и фамилия должны содержать не больше 100 символов.');
    }
    const avatar = Object.hasOwn(body, 'avatar') ? avatarValue(body.avatar) : previous.avatar;
    db().prepare('UPDATE corporate_accounts SET first_name=?,last_name=?,avatar=? WHERE email=?')
      .run(body.firstName?.trim() ?? previous.firstName, body.lastName?.trim() ?? previous.lastName, avatar, previous.email);
    return get(previous.email);
  }
  function has(email) { return Boolean(db().prepare('SELECT 1 FROM corporate_accounts WHERE email=?').get(email)); }
  function list(page = 1, search = '') {
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || typeof search !== 'string' || search.length > 100) fail(400, 'Проверьте поиск и номер страницы.');
    const query = search.toLowerCase();
    const filter = "instr(corporate_lower(email),?)>0 OR instr(corporate_lower(first_name || ' ' || last_name),?)>0";
    const rows = db().prepare(`SELECT * FROM corporate_accounts WHERE ${filter} ORDER BY last_seen DESC,email LIMIT 51 OFFSET ?`)
      .all(query, query, (page - 1) * 50);
    return { page, hasNext: rows.length > 50, users: rows.slice(0, 50).map(row => {
      const { avatar, ...user } = view(row);
      return { ...user, role: 'Сотрудник', lastSeen: row.last_seen, lastLogin: row.last_login };
    }) };
  }
  return { observe, get, update, has, list };
}

module.exports = { createCorporateAccounts, avatarValue };
