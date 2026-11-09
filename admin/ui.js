(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let csrf = ''; let page = 1; let timezone = 'Europe/Moscow'; let loading = false;
  let authVersion = 0, usersPage = 1, usersLoading = false, generalAccess;
  function message(text = '') { $('message').textContent = text; }
  function showLogin() {
    authVersion++; loading = usersLoading = false; generalAccess = undefined;
    $('login-panel').hidden = false; $('dashboard').hidden = true; $('logout').hidden = true; csrf = '';
    for (const id of ['users', 'users-status', 'users-page', 'summary', 'visitors', 'daily']) $(id).replaceChildren();
    for (const id of ['publish-enabled', 'storage-enabled', 'cloud-enabled']) { $(id).checked = false; $(id).disabled = true; }
    $('cloud-settings-status').textContent = '';
  }
  function showDashboard() { $('login-panel').hidden = true; $('dashboard').hidden = false; $('logout').hidden = false; }
  async function api(route, body) {
    const response = await fetch(new URL(route, location.href), {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
      redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'X-QA-Admin': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    if (!response.ok) { if (response.status === 401) showLogin(); throw new Error(data.error || 'Не удалось загрузить данные'); }
    return data;
  }
  function cell(row, text, tag = 'td') { const element = document.createElement(tag); element.textContent = text; row.append(element); return element; }
  const number = value => Number(value).toLocaleString('ru-RU');
  function date(value) { return new Date(value).toLocaleString('ru-RU', { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' }); }
  function render(data) {
    timezone = data.timezone;
    for (const id of ['from', 'to']) { $(id).min = data.earliest; $(id).max = data.today; $(id).value = data[id]; }
    $('period-note').textContent = `Период: ${data.from} — ${data.to}. Часовой пояс: ${data.timezone}. Доступны последние ${data.retentionDays} дней. Поиск фильтрует список посетителей.`;
    $('summary').replaceChildren();
    for (const [label, value] of [['Уникальные посетители', data.summary.visitors], ['Визиты', data.summary.visits], ['Использовали PWA', data.summary.pwa], ['Использовали браузер', data.summary.browser]]) {
      const card = document.createElement('div'); card.className = 'card';
      const caption = document.createElement('span'); caption.className = 'muted'; caption.textContent = label;
      const total = document.createElement('strong'); total.textContent = number(value); card.append(caption, total); $('summary').append(card);
    }
    $('daily').replaceChildren();
    // Include zero days so missing traffic is visible.
    const rows = new Map(data.daily.map(row => [row.day, row]));
    for (let day = Date.parse(data.to); day >= Date.parse(data.from); day -= 86400000) {
      const key = new Date(day).toISOString().slice(0, 10); const item = rows.get(key);
      const row = document.createElement('tr'); cell(row, key.split('-').reverse().join('.')); cell(row, number(item?.visitors || 0)); cell(row, number(item?.visits || 0)); $('daily').append(row);
    }
    $('daily-empty').hidden = data.daily.length > 0;
    $('visitors').replaceChildren();
    for (const visitor of data.visitors) {
      const row = document.createElement('tr'); const id = cell(row, ''); const code = document.createElement('code'); code.textContent = visitor.id; id.append(code);
      const accounts = cell(row, ''); accounts.className = 'visitor-accounts';
      if (!visitor.accounts?.length) accounts.textContent = 'Не определён';
      for (const account of visitor.accounts || []) {
        const entry = document.createElement('div'); entry.className = 'account';
        const name = document.createElement('div'); name.textContent = account.name || account.email || account.id;
        entry.append(name);
        if (account.name && account.email) { const email = document.createElement('div'); email.className = 'muted'; email.textContent = account.email; entry.append(email); }
        entry.title = `Аккаунт подтверждён: ${date(account.lastSeen)}`;
        accounts.append(entry);
      }
      cell(row, number(visitor.visits)); cell(row, `${date(visitor.firstSeen)} / ${date(visitor.lastSeen)}`);
      const devices = cell(row, '');
      for (const item of visitor.devices) {
        const entry = document.createElement('div'); entry.className = 'device';
        const label = document.createElement('div'); label.textContent = `${item.device} · ${item.os} · ${item.browser}`;
        const mode = document.createElement('span'); mode.className = 'badge'; mode.textContent = `${item.mode === 'pwa' ? 'PWA' : 'Браузер'} · `;
        const ip = document.createElement('code'); ip.textContent = item.ip;
        entry.append(label, mode, ip); devices.append(entry);
      }
      $('visitors').append(row);
    }
    $('visitors-empty').hidden = data.visitors.length > 0;
    $('page-info').textContent = `Страница ${data.page} · Посетителей: ${number(data.total)}`;
    $('previous').disabled = page <= 1; $('next').disabled = page * data.pageSize >= data.total;
  }
  async function load() {
    if (loading) return;
    const version = authVersion;
    loading = true; message('Загрузка…'); $('refresh').disabled = true;
    const query = new URLSearchParams({ page, search: $('search').value.trim() });
    if ($('from').value) query.set('from', $('from').value);
    if ($('to').value) query.set('to', $('to').value);
    try {
      const data = await api(`stats?${query}`);
      if (version !== authVersion) return;
      render(data); showDashboard(); message();
      await Promise.all([loadCloudSettings(), loadUsers()]);
    }
    catch (error) { if (version === authVersion) message(error.message); }
    finally { if (version === authVersion) { loading = false; $('refresh').disabled = false; } }
  }
  async function loadCloudSettings(update) {
    const version = authVersion, status = $('cloud-settings-status');
    const controls = ['publish-enabled', 'storage-enabled', 'cloud-enabled'].map($);
    controls.forEach(control => { control.disabled = true; });
    status.textContent = update ? 'Сохраняем…' : 'Проверяем настройки…';
    try {
      const state = await api('storage', update);
      if (version !== authVersion) return;
      generalAccess = state;
      status.textContent = !state.configured ? 'Хранилище S3 не настроено.' :
        `Публикация по ссылке: ${state.publishEnabled ? 'разрешена' : 'приостановлена'}. Загрузка вложений: ${state.enabled ? 'разрешена' : 'приостановлена'}. Личное облако: ${state.cloudEnabled ? 'разрешено' : 'приостановлено'}.`;
    } catch (error) { if (version === authVersion) status.textContent = error.message; }
    finally {
      if (version === authVersion) {
        const keys = ['publishEnabled', 'enabled', 'cloudEnabled'];
        controls.forEach((control, index) => { control.checked = Boolean(generalAccess?.[keys[index]]); control.disabled = !generalAccess?.configured; });
      }
    }
  }
  async function loadUsers(target = usersPage) {
    if (usersLoading || $('dashboard').hidden) return;
    const version = authVersion, controls = ['users-previous', 'users-next', 'users-refresh'].map($);
    const disabled = controls.map(control => control.disabled);
    usersLoading = true; controls.forEach(control => { control.disabled = true; }); $('users-status').textContent = 'Загрузка списка…';
    try {
      const query = new URLSearchParams({ page: target, search: $('users-search').value.trim() });
      const data = await api(`users?${query}`);
      if (version !== authVersion) return;
      usersPage = data.page; $('users').replaceChildren();
      for (const user of data.users) {
        const row = document.createElement('tr');
        cell(row, user.name || '—'); cell(row, user.email); cell(row, user.role); cell(row, date(user.lastSeen));
        appendUserAccess(row, user); $('users').append(row);
      }
      $('users-status').textContent = data.users.length ? '' : 'Пользователи не найдены.';
      $('users-page').textContent = `Страница ${usersPage}`;
      controls[0].disabled = usersPage <= 1; controls[1].disabled = !data.hasNext;
    } catch (error) {
      if (version === authVersion) { $('users-status').textContent = error.message; controls.forEach((control, index) => { control.disabled = disabled[index]; }); }
    } finally { if (version === authVersion) { usersLoading = false; controls[2].disabled = false; } }
  }
  function appendUserAccess(row, user) {
    let saved = user.access;
    const publish = document.createElement('select'), uploads = document.createElement('select'), cloud = document.createElement('select');
    const status = document.createElement('span'); status.className = 'user-access-status muted'; status.setAttribute('role', 'status');
    publish.setAttribute('aria-label', `Публикация по ссылке: ${user.email}`);
    uploads.setAttribute('aria-label', `Новые вложения в S3: ${user.email}`); cloud.setAttribute('aria-label', `Личное облако: ${user.email}`);
    publish.append(new Option('По общим настройкам', 'role'), new Option('Разрешить', 'allow'), new Option('Запретить', 'deny'));
    for (const select of [uploads, cloud]) select.append(new Option('По общим настройкам', 'true'), new Option('Запретить', 'false'));
    cell(row, '').append(publish, status); cell(row, '').append(uploads); cell(row, '').append(cloud);
    const render = () => { publish.value = saved.publish; uploads.value = String(saved.uploadsEnabled); cloud.value = String(saved.cloudEnabled); };
    async function save() {
      const version = authVersion; publish.disabled = uploads.disabled = cloud.disabled = true; status.textContent = 'Сохраняем…';
      try {
        const result = await api('user-access', { userId: user.id, publish: publish.value, uploadsEnabled: uploads.value === 'true', cloudEnabled: cloud.value === 'true' });
        if (version === authVersion) { saved = result; status.textContent = 'Сохранено'; }
      } catch (error) { if (version === authVersion) status.textContent = error.message; }
      finally { if (version === authVersion) { render(); publish.disabled = uploads.disabled = cloud.disabled = false; } }
    }
    render(); for (const control of [publish, uploads, cloud]) control.addEventListener('change', save);
  }
  $('cloud-enabled').addEventListener('change', event => loadCloudSettings({ cloudEnabled: event.target.checked }));
  $('publish-enabled').addEventListener('change', event => loadCloudSettings({ publishEnabled: event.target.checked }));
  $('storage-enabled').addEventListener('change', event => loadCloudSettings({ enabled: event.target.checked }));
  $('users-refresh').addEventListener('click', () => loadUsers());
  $('users-previous').addEventListener('click', () => loadUsers(usersPage - 1));
  $('users-next').addEventListener('click', () => loadUsers(usersPage + 1));
  $('users-search-form').addEventListener('submit', event => { event.preventDefault(); loadUsers(1); });
  $('login-form').addEventListener('submit', async event => {
    event.preventDefault(); $('login-submit').disabled = true; message('Проверка входа…');
    try { const data = await api('login', { username: $('username').value, password: $('password').value }); csrf = data.csrf; $('password').value = ''; page = 1; await load(); }
    catch (error) { $('password').value = ''; message(error.message); }
    finally { $('login-submit').disabled = false; }
  });
  $('logout').addEventListener('click', async () => {
    try { await api('logout', {}); showLogin(); $('summary').replaceChildren(); $('visitors').replaceChildren(); $('daily').replaceChildren(); message(); }
    catch (error) { message(error.message); }
  });
  for (const id of ['filters', 'search-form']) $(id).addEventListener('submit', event => { event.preventDefault(); page = 1; load(); });
  $('refresh').addEventListener('click', load);
  $('previous').addEventListener('click', () => { if (!loading && page > 1) { page--; load(); } });
  $('next').addEventListener('click', () => { if (!loading) { page++; load(); } });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  api('session').then(data => { csrf = data.csrf; return load(); }).catch(() => { showLogin(); message(); });
})();
