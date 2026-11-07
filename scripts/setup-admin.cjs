#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline/promises');
const { Writable } = require('node:stream');
const { passwordHash, loadConfig, validAdminPath } = require('../admin/server');

function options(args) {
  const result = {};
  const values = new Set(['--file', '--path', '--username', '--access-file']);
  const flags = new Set(['--rotate-password', '--generate']);
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (Object.hasOwn(result, name)) throw new Error(`Параметр ${name} указан повторно`);
    if (flags.has(name)) result[name] = true;
    else if (values.has(name) && args[i + 1] && !args[i + 1].startsWith('--')) result[name] = args[++i];
    else throw new Error('Параметры: --file <файл>, --path /owner, --rotate-password; для автоматической настройки — --generate --access-file <закрытый файл> [--username <логин>].');
  }
  if (result['--generate'] && !result['--access-file']) throw new Error('Для сгенерированного пароля укажите --access-file: пароль будет записан только в этот файл с правами 0600.');
  if (!result['--generate'] && (result['--access-file'] || result['--username'])) throw new Error('--access-file и --username используются вместе с --generate');
  return result;
}

function saveConfig(file, config, replace) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    if (replace) fs.renameSync(temporary, file);
    else { fs.linkSync(temporary, file); fs.unlinkSync(temporary); }
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}

async function askCredentials(previous) {
  if (!process.stdin.isTTY) throw new Error('Для ввода пароля запустите настройку в интерактивном терминале. Для автоматической настройки используйте --generate --access-file <закрытый файл>.');
  let muted = false;
  const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk, encoding); callback(); } });
  const prompt = readline.createInterface({ input: process.stdin, output, terminal: true });
  prompt.on('SIGINT', () => { prompt.close(); process.exit(130); });
  try {
    const username = previous?.username || (await prompt.question('Логин администратора: ')).trim();
    if (!/^[\w.@-]{1,80}$/.test(username)) throw new Error('Логин: 1–80 латинских букв, цифр или символов . @ _ -');
    process.stdout.write('Пароль (не менее 16 символов, ввод скрыт): '); muted = true;
    const password = await prompt.question(''); muted = false; process.stdout.write('\n');
    if (password.length < 16 || password.length > 256) throw new Error('Длина пароля должна быть от 16 до 256 символов.');
    process.stdout.write('Повторите пароль: '); muted = true;
    const confirmation = await prompt.question(''); muted = false; process.stdout.write('\n');
    if (confirmation !== password) throw new Error('Пароли не совпадают');
    return { username, password };
  } finally { muted = false; prompt.close(); }
}

async function main() {
  const opts = options(process.argv.slice(2));
  const file = path.resolve(opts['--file'] || process.env.QA_ADMIN_CONFIG_FILE || path.join(__dirname, '..', 'secrets', 'admin', 'admin.json'));
  const previous = loadConfig(file);
  const adminPath = opts['--path']?.replace(/\/$/, '') || previous?.path || '/owner';
  if (!validAdminPath(adminPath)) throw new Error('Адрес должен быть отдельным путём, например /owner или /control-room; системные пути запрещены.');
  const rotate = Boolean(opts['--rotate-password']);
  if (!previous && rotate) throw new Error('Сначала создайте администратора без --rotate-password.');
  if (previous && !rotate) {
    if (!opts['--path'] && !opts['--generate']) throw new Error('Администратор уже настроен. Для смены пароля используйте --rotate-password, для смены адреса — --path /owner.');
    if (adminPath !== previous.path) saveConfig(file, { ...previous, path: adminPath }, true);
    console.log(`Администратор уже настроен. Логин, пароль и ключ посетителей сохранены.\nАдрес админки: ${adminPath}/\nПосле изменения адреса перезапустите приложение.`);
    return;
  }
  let credentials;
  let accessFile;
  if (opts['--generate']) {
    accessFile = path.resolve(opts['--access-file']);
    if (accessFile === file) throw new Error('Файл для выдачи пароля должен отличаться от конфигурации сервера.');
    if (fs.existsSync(accessFile)) throw new Error('Файл выдачи уже существует. Укажите новый закрытый файл, чтобы сохранить прежние данные для входа.');
    credentials = { username: previous?.username || opts['--username'] || 'owner', password: crypto.randomBytes(32).toString('base64url') };
    if (!/^[\w.@-]{1,80}$/.test(credentials.username)) throw new Error('Некорректный логин администратора');
  } else credentials = await askCredentials(previous);
  const salt = crypto.randomBytes(16).toString('hex');
  const config = { version: 1, path: adminPath, username: credentials.username,
    passwordSalt: salt, passwordHash: await passwordHash(credentials.password, salt), visitorSecret: previous?.visitorSecret || crypto.randomBytes(32).toString('hex') };
  let accessCreated = false;
  try {
    if (accessFile) {
      fs.mkdirSync(path.dirname(accessFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(accessFile, JSON.stringify({ path: adminPath + '/', username: credentials.username, password: credentials.password }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      accessCreated = true;
    }
    saveConfig(file, config, Boolean(previous));
  } catch (error) { if (accessCreated) fs.unlinkSync(accessFile); throw error; }
  credentials.password = '';
  console.log(`Конфигурация сохранена: ${file}\nАдрес админки: ${adminPath}/\n${accessFile ? `Данные для входа записаны в закрытый файл: ${accessFile}\n` : ''}Перезапустите приложение. При обновлениях существующие настройки сохраняются.`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
