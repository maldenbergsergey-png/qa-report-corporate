(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let csrf = ''; let page = 1; let timezone = 'Europe/Moscow'; let loading = false;
  function message(text = '') { $('message').textContent = text; }
  function showLogin() { $('login-panel').hidden = false; $('dashboard').hidden = true; $('logout').hidden = true; csrf = ''; }
  function showDashboard() { $('login-panel').hidden = true; $('dashboard').hidden = false; $('logout').hidden = false; }
  async function api(route, body) {
    const response = await fetch(new URL(route, location.href), {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
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
    loading = true; message('Загрузка…'); $('refresh').disabled = true;
    const query = new URLSearchParams({ page, search: $('search').value.trim() });
    if ($('from').value) query.set('from', $('from').value);
    if ($('to').value) query.set('to', $('to').value);
    try { const data = await api(`stats?${query}`); render(data); showDashboard(); message(); }
    catch (error) { message(error.message); }
    finally { loading = false; $('refresh').disabled = false; }
  }
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
