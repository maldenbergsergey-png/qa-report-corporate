#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline/promises');
const { Writable } = require('node:stream');
const { passwordHash, loadConfig } = require('../admin/server');

async function main() {
  if (!process.stdin.isTTY) throw new Error('Запустите настройку в интерактивном терминале. Пароли не принимаются через аргументы или переменные окружения.');
  const args = process.argv.slice(2); const rotate = args.includes('--rotate-password');
  const fileIndex = args.indexOf('--file');
  if (fileIndex >= 0 && (!args[fileIndex + 1] || args[fileIndex + 1].startsWith('--'))) throw new Error('После --file укажите путь');
  if (args.some((arg, index) => !['--rotate-password', '--file'].includes(arg) && !(fileIndex >= 0 && index === fileIndex + 1))) throw new Error('Доступны только --file <путь> и --rotate-password');
  const file = path.resolve(fileIndex >= 0 ? args[fileIndex + 1] : process.env.QA_ADMIN_CONFIG_FILE || path.join(__dirname, '..', 'secrets', 'admin', 'admin.json'));
  const previous = loadConfig(file);
  if (previous && !rotate) throw new Error('Администратор уже настроен. Для смены пароля используйте --rotate-password.');
  if (!previous && rotate) throw new Error('Сначала создайте администратора без --rotate-password.');
  let muted = false;
  const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk, encoding); callback(); } });
  const prompt = readline.createInterface({ input: process.stdin, output, terminal: true });
  prompt.on('SIGINT', () => { prompt.close(); process.exit(130); });
  let username; let password; let confirmation;
  try {
    username = previous?.username || (await prompt.question('Логин администратора: ')).trim();
    if (!/^[\w.@-]{1,80}$/.test(username)) throw new Error('Логин: 1–80 латинских букв, цифр или символов . @ _ -');
    process.stdout.write('Пароль (не менее 16 символов, ввод скрыт): '); muted = true;
    password = await prompt.question(''); muted = false; process.stdout.write('\n');
    if (password.length < 16 || password.length > 256) throw new Error('Длина пароля должна быть от 16 до 256 символов.');
    process.stdout.write('Повторите пароль: '); muted = true;
    confirmation = await prompt.question(''); muted = false; process.stdout.write('\n');
    if (confirmation !== password) throw new Error('Пароли не совпадают');
  } finally { muted = false; prompt.close(); }
  const salt = crypto.randomBytes(16).toString('hex');
  const config = { version: 1, path: previous?.path || `/_manage_${crypto.randomBytes(16).toString('hex')}`, username,
    passwordSalt: salt, passwordHash: await passwordHash(password, salt), visitorSecret: previous?.visitorSecret || crypto.randomBytes(32).toString('hex') };
  password = ''; confirmation = '';
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    if (rotate) fs.renameSync(temporary, file);
    else { fs.linkSync(temporary, file); fs.unlinkSync(temporary); }
  } finally { try { fs.unlinkSync(temporary); } catch {} }
  console.log(`Конфигурация сохранена: ${file}\nАдрес админки: ${config.path}/\nПерезапустите сервер после подключения файла конфигурации. Пароль нигде не сохранён в открытом виде.`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
