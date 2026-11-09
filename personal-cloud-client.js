(function (root) {
  'use strict';
  const API = '/api/cloud-reports';
  const KEY = 'qa-report-personal-cloud-v1';
  const fingerprint = value => root.QaReportHistory.contentFingerprint(root.QaReportFile.documentFields(value));
  const base64 = bytes => {
    const parts = [];
    for (let offset = 0; offset < bytes.length; offset += 32768) parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
    return btoa(parts.join(''));
  };

  const cloudPath = id => `/cloud-report/${id}`;
  const routeId = () => /^\/cloud-report\/([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/.exec(location.pathname)?.[1] || '';
  let binding;
  // Hide cached local content before the editor renders on a cloud navigation.
  if (routeId()) document.documentElement.dataset.cloudAccess = 'locked';
  function keepRoute(localId) {
    if (!routeId()) return false;
    if (document.documentElement.dataset.cloudAccess !== 'granted' || binding?.localId === localId) return true;
    binding = undefined;
    return false;
  }
  const currentPath = (localId, publicId) => binding?.localId === localId ? cloudPath(binding.id) : `/report/${publicId}`;

  function create({ headers, capture, records, restore, loadAttachment, notify, blocked, operation, signIn, onStatus = () => {}, requestTimeout = 60_000 }) {
    const $ = id => document.getElementById(id);
    const dialog = $('personalCloudDialog');
    let state, ownerId = '', generation = 0, busy = false, entries = [];
    let currentWork, pendingStatus = false, listLoaded = false, listLoading = false, routeTicket = 0;
    const requests = new Set();
    const titleOf = value => [value.issueUrl || value.sections[0]?.title || 'Чек-лист', value.environment].filter(Boolean).join(' — ').slice(0, 500);
    function access(locked, text = '', pending = false, needsSignIn = false) {
      const protectedRoute = Boolean(routeId());
      if (protectedRoute) document.documentElement.dataset.cloudAccess = locked ? 'locked' : 'granted';
      else delete document.documentElement.dataset.cloudAccess;
      $('cloudReportAccess').hidden = !protectedRoute || !locked;
      $('cloudReportAccessStatus').textContent = text;
      $('cloudReportAccess').setAttribute('aria-busy', String(pending));
      $('cloudReportSignIn').hidden = !needsSignIn || !signIn;
      $('cloudReportRetry').disabled = pending || busy;
      $('cloudReportLocal').href = `/report/${capture(false).publicId}`;
      for (const element of document.querySelectorAll('.header-report-actions, .header-dropdown')) element.inert = protectedRoute && locked;
    }
    function navigateCloud(id, localId) {
      binding = { id, localId, ownerId };
      if (location.pathname !== cloudPath(id)) history.pushState({}, '', cloudPath(id));
      access(false);
      root.dispatchEvent(new Event('qa-report-cloud-route'));
    }
    function canceled() { return Object.assign(new Error('Открытие отменено.'), { cloudCanceled: true }); }
    function checkRoute(id, ticket) { if (routeId() !== id || ticket !== routeTicket) throw canceled(); }
    function errorText(error) {
      if (error.name === 'TimeoutError') return 'Сервер не ответил вовремя. Проверьте подключение и повторите действие.';
      if (error instanceof TypeError) return 'Не удалось подключиться к облаку. Проверьте сеть и повторите действие.';
      return error.message || 'Не удалось завершить действие. Повторите ещё раз.';
    }
    function abortable(promise, signal) {
      return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) return abort();
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      });
    }
    function readLinks() {
      try {
        const value = JSON.parse(localStorage.getItem(KEY) || '{}');
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      } catch { return {}; }
    }
    function links() { return readLinks()[ownerId] || {}; }
    function updateLink(localId, value, owner = ownerId) {
      const all = readLinks();
      const saved = all[owner] && typeof all[owner] === 'object' ? all[owner] : {};
      if (value) saved[localId] = value; else delete saved[localId];
      all[owner] = saved;
      // If this cannot persist, autosave must not silently claim to be enabled.
      localStorage.setItem(KEY, JSON.stringify(all));
    }
    function message(text, error = false, pending = false) {
      pendingStatus = pending;
      $('personalCloudStatus').textContent = text;
      $('personalCloudStatus').classList.toggle('cloud-error', error);
      $('personalCloudStatus').dataset.state = pending ? 'busy' : error ? 'error' : 'idle';
      if (routeId() && document.documentElement.dataset.cloudAccess !== 'granted') {
        access(true, text, pending, state?.signedIn === false);
      }
    }
    function assertCurrent(expectedOwner, version) {
      if (ownerId !== expectedOwner || generation !== version) throw Object.assign(new Error('Аккаунт изменился. Повторите действие в нужном профиле.'), { cloudCanceled: true });
    }
    async function request(route, { method = 'GET', body, binary = false, owner = ownerId, version = generation } = {}) {
      const controller = new AbortController();
      requests.add(controller);
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(requestTimeout)]);
      try {
        const auth = await abortable(headers(method), signal);
        assertCurrent(owner, version);
        const response = await fetch(API + route, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
          headers: { ...auth, 'X-QA-Cloud': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        assertCurrent(owner, version);
        if (binary && response.ok) {
          const bytes = new Uint8Array(await response.arrayBuffer());
          assertCurrent(owner, version);
          return bytes;
        }
        const data = await response.json().catch(() => ({}));
        if (signal.aborted) throw signal.reason;
        assertCurrent(owner, version);
        if (!response.ok) throw Object.assign(new Error(data.error || 'Облако временно недоступно.'), { status: response.status });
        return data;
      } finally { requests.delete(controller); }
    }

    async function availability() {
      const version = generation, expected = ownerId;
      const result = await request('/availability');
      if (version !== generation || expected !== ownerId) throw new Error('Аккаунт изменился.');
      state = result;
      if (ownerId !== result.ownerId) { ownerId = result.ownerId; generation++; entries = []; listLoaded = false; }
      if (routeId() && document.documentElement.dataset.cloudAccess === 'granted' &&
          (!result.signedIn || binding?.ownerId !== result.ownerId)) {
        access(true, 'Проверяем доступ к облачному отчёту…', true);
        queueMicrotask(() => { void openRoute(); });
      }
      $('personalCloudAccount').textContent = result.signedIn ? 'Доступно только вашему аккаунту' : 'Войдите в профиль, чтобы открыть свои облачные отчёты.';
      return result;
    }
    function render() {
      const current = capture(false);
      const link = links()[current.reportId];
      $('personalCloudReportTitle').textContent = titleOf(current);
      dialog.setAttribute('aria-busy', String(busy));
      $('personalCloudList').setAttribute('aria-busy', String(listLoading));
      $('personalCloudSave').disabled = busy || !state?.canSave;
      $('personalCloudSave').textContent = link ? 'Сохранить сейчас' : 'Сохранить текущий отчёт';
      $('personalCloudCopy').hidden = !link;
      $('personalCloudCopy').disabled = busy || !state?.canSave;
      $('personalCloudRefresh').disabled = busy;
      $('personalCloudAuto').disabled = busy || !link || !state?.canSave;
      $('personalCloudAuto').checked = Boolean(link?.auto);
      $('personalCloudCurrent').textContent = link?.conflict ? 'Автосохранение остановлено: облачная версия изменена на другом устройстве.'
        : link?.savedAt ? `Последняя облачная копия: ${new Date(link.savedAt).toLocaleString('ru-RU')}` : 'Текущий отчёт пока хранится только в этом браузере.';
      const list = $('personalCloudList'); list.replaceChildren();
      for (const entry of entries) {
        const article = document.createElement('article'); article.className = 'cloud-report';
        const info = document.createElement('div');
        const title = document.createElement('strong'); title.textContent = entry.title || 'Чек-лист без названия';
        const date = document.createElement('small'); date.textContent = `Сохранён ${new Date(entry.updatedAt).toLocaleString('ru-RU')}`;
        info.append(title, date);
        const actions = document.createElement('div'); actions.className = 'cloud-actions';
        const open = document.createElement('button'); open.type = 'button'; open.className = 'button button-secondary'; open.textContent = 'Открыть'; open.disabled = busy;
        open.addEventListener('click', () => run(() => openReport(entry)));
        const copyLink = document.createElement('button'); copyLink.type = 'button'; copyLink.className = 'button button-ghost'; copyLink.textContent = 'Копировать ссылку'; copyLink.disabled = busy;
        copyLink.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(new URL(cloudPath(entry.id), location.origin).href);
            message('Ссылка скопирована. Открыть отчёт сможет только его владелец.');
          } catch { message('Не удалось скопировать ссылку. Разрешите доступ к буферу обмена и повторите.', true); }
        });
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button button-ghost'; remove.textContent = 'Удалить'; remove.disabled = busy;
        remove.setAttribute('aria-label', `Удалить из облака: ${entry.title || 'чек-лист'}`);
        remove.addEventListener('click', () => run(async () => {
          if (!confirm('Удалить отчёт из облака? Локальные копии в браузерах сохранятся.')) return;
          await request('/' + entry.id, { method: 'DELETE', body: {} });
          for (const [id, link] of Object.entries(links())) if (link.id === entry.id) updateLink(id, null);
          await refresh(); message('Отчёт удалён из облака. Локальные копии сохранены.');
        }, { label: 'Удаляем отчёт из облака…' }));
        actions.append(open, copyLink, remove); article.append(info, actions); list.append(article);
      }
      if (!entries.length) {
        const empty = document.createElement('p'); empty.className = 'cloud-empty';
        empty.textContent = listLoading ? 'Загружаем список отчётов…' : !listLoaded && state?.signedIn ? 'Список отчётов пока не загружен.'
          : state?.signedIn ? 'Сохранённых облачных отчётов пока нет.' : 'Ваши отчёты появятся здесь после входа.';
        list.append(empty);
      }
      onStatus();
    }
    function historyStatus(source) {
      if (!source) return { state: 'unknown', label: 'Проверить облачную копию' };
      const link = state?.signedIn ? links()[source.reportId] : null;
      if (!state) return { state: 'unknown', label: 'Проверить облачную копию' };
      if (!link?.savedAt) return { state: 'local', label: 'Сохранить отчёт в личное облако' };
      const saved = new Date(link.savedAt).toLocaleString('ru-RU');
      if (link.conflict) return { state: 'conflict', label: `В облаке есть другая версия. Последнее сохранение ${saved}` };
      const current = link.content === fingerprint(source);
      return { state: current ? 'saved' : 'dirty', label: `${current ? 'Личная облачная копия сохранена' : 'Есть правки для сохранения в облако'} · ${saved}` };
    }

    async function refresh() {
      listLoading = true; render();
      try {
        await availability();
        entries = state.signedIn ? (await request('')).reports : [];
        listLoaded = true;
        if (!state.configured) message('Облачное хранилище пока не подключено администратором.');
        else if (!state.signedIn) message('Войдите в профиль, чтобы открыть свои облачные отчёты.');
        else if (!state.canSave) message('Администратор отключил сохранение в облако. Ранее сохранённые отчёты можно открывать и удалять.');
        else message('');
      } finally { listLoading = false; render(); }
    }
    async function run(action, { label = 'Загружаем отчёт…', wait = false } = {}) {
      if (busy) {
        if (!wait) return false;
        await currentWork;
        if (busy) return false;
      }
      if (blocked()) { message('Дождитесь завершения текущей операции с отчётом.', true); return false; }
      busy = true; operation(1); message(label, false, true); render();
      const work = (async () => {
        try {
          await action();
          if (pendingStatus) message('');
          return true;
        } catch (error) {
          if (error.status === 401) { state = { ...state, signedIn: false, canSave: false }; entries = []; listLoaded = false; }
          if (!error.cloudCanceled) { message(errorText(error), true); if (!dialog.open && !routeId()) notify(errorText(error)); }
          return false;
        } finally {
          busy = false; operation(-1); render();
          if (routeId() && document.documentElement.dataset.cloudAccess !== 'granted') $('cloudReportRetry').disabled = false;
        }
      })();
      currentWork = work;
      try { return await work; } finally { if (currentWork === work) currentWork = undefined; }
    }
    async function save(value, { copy = false, silent = false } = {}) {
      const owner = ownerId, version = generation;
      if (!state?.canSave || !owner) throw new Error('Сохранение в облако недоступно.');
      const localId = value.reportId, content = fingerprint(value);
      let link = links()[localId];
      if (silent && (!link?.auto || link.conflict || link.content === content)) return;
      if (link?.conflict && !copy) throw new Error('Откройте свежий отчёт из облака или сохраните текущий отдельной копией.');
      if (!link || copy) {
        const { report } = await request('', { method: 'POST', body: {} });
        link = { id: report.id, revision: report.revision, auto: true };
        updateLink(localId, link);
      }
      try {
        const payload = await root.QaReportFile.pack(value, { cloud: true, load: loadAttachment(),
          onProgress: ({ completed, total }) => { if (!silent && total) message(`Подготовка вложений: ${completed} из ${total}`, false, true); } });
        assertCurrent(owner, version);
        for (const bytes of payload.assets.values()) if (bytes.length > state.fileBytes) throw new Error('Одно облачное вложение должно быть не больше 50 МиБ.');
        const files = [...payload.assets].map(([hash, bytes]) => ({ hash, size: bytes.length }));
        const { missing } = await request('/' + link.id + '/files', { method: 'POST', body: { files } });
        for (const hash of missing) {
          const bytes = payload.assets.get(hash);
          let offset = 0;
          do {
            const part = bytes.subarray(offset, offset + state.chunkBytes);
            if (!silent) message(`Загрузка вложений: ${Math.round((offset + part.length) / Math.max(1, bytes.length) * 100)}%`, false, true);
            const result = await request(`/${link.id}/files/${hash}`, { method: 'POST', body: { size: bytes.length, offset, data: base64(part) } });
            if (result.complete) break;
            offset += part.length;
          } while (offset < bytes.length);
        }
        if (!silent) message('Сохраняем текст отчёта…', false, true);
        const title = titleOf(value);
        const { report } = await request('/' + link.id, { method: 'PUT', body: { title, document: payload.document, revision: link.revision } });
        assertCurrent(owner, version);
        updateLink(localId, { ...link, revision: report.revision, content, savedAt: report.updatedAt, conflict: false });
        entries = [report, ...entries.filter(entry => entry.id !== report.id)]; listLoaded = true;
        if (!silent) {
          binding = { id: report.id, ownerId: owner, localId };
          if (capture(false).reportId === localId && location.pathname !== '/profile') navigateCloud(report.id, localId);
          message('Отчёт сохранён в личном облаке.');
        }
      } catch (error) {
        if (error.status === 409 && owner === ownerId && generation === version) updateLink(localId, { ...link, conflict: true });
        throw error;
      }
    }
    async function openReport(entry, validate = () => {}) {
      const owner = ownerId, version = generation;
      const before = capture();
      const beforeContent = fingerprint(before);
      const { report } = await request('/' + entry.id);
      const assets = new Map();
      for (const file of report.files) {
        message(`Открываем вложения: ${assets.size + 1} из ${report.files.length}`, false, true);
        const bytes = await request(`/${entry.id}/files/${file.hash}`, { binary: true });
        if (bytes.length !== file.size || await root.QaReportFile.hash(bytes) !== file.hash) throw new Error('Вложение повреждено. Текущий локальный отчёт сохранён.');
        assets.set(file.hash, bytes);
      }
      const imported = root.QaReportFile.restoreCloud(report.document, assets);
      assertCurrent(owner, version);
      const current = capture();
      if (current.reportId !== before.reportId || fingerprint(current) !== beforeContent) throw new Error('За время загрузки текущий отчёт изменился. Повторите открытие.');
      validate();
      const value = await restore(imported.document);
      validate();
      assertCurrent(owner, version);
      // Only the explicitly opened local copy backs up to this cloud record.
      for (const [id, link] of Object.entries(links())) if (link.id === entry.id) updateLink(id, null);
      updateLink(value.reportId, { id: entry.id, revision: report.revision, auto: true, content: fingerprint(value), savedAt: report.updatedAt });
      navigateCloud(entry.id, value.reportId);
      message('Отчёт открыт в браузере.');
      dialog.close();
      notify('Отчёт открыт в браузере. Изменения сохраняются в облако раз в минуту.');
    }
    async function open() {
      if (!dialog.open) dialog.showModal();
      await run(refresh, { label: 'Загружаем список отчётов…', wait: true });
    }
    $('personalCloudClose').addEventListener('click', () => dialog.close());
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
    $('personalCloudRefresh').addEventListener('click', () => run(refresh, { label: 'Обновляем список отчётов…' }));
    $('personalCloudSave').addEventListener('click', () => run(() => save(capture()), { label: 'Готовим текущий отчёт к сохранению…' }));
    $('personalCloudCopy').addEventListener('click', () => run(() => save(capture(), { copy: true }), { label: 'Готовим отдельную копию…' }));
    $('personalCloudAuto').addEventListener('change', () => {
      try {
        const id = capture(false).reportId, link = links()[id];
        if (link) updateLink(id, { ...link, auto: $('personalCloudAuto').checked });
      } catch (error) { message(error.message, true); }
      render();
    });
    for (const button of document.querySelectorAll('[data-personal-cloud]')) button.addEventListener('click', open);
    function reset() {
      generation++; ownerId = ''; state = undefined; entries = []; listLoaded = false;
      for (const controller of requests) controller.abort(canceled());
      message(''); render();
      if (routeId()) { access(true, 'Проверяем доступ к облачному отчёту…', true); void openRoute(); }
    }
    root.addEventListener('qa-report-account-change', reset);
    async function tick() {
      if (busy || blocked() || !navigator.onLine || document.visibilityState === 'hidden') return;
      if (routeId() && document.documentElement.dataset.cloudAccess !== 'granted') return;
      if (!Object.values(readLinks()).some(group => Object.values(group || {}).some(link => link?.auto && !link.conflict))) return;
      await run(async () => {
        await availability();
        if (!state.canSave) return;
        const saved = await records();
        const current = capture();
        const byId = new Map(saved.map(record => [record.id, record.document])); byId.set(current.reportId, current);
        for (const [id, link] of Object.entries(links())) {
          if (link.auto && !link.conflict && byId.has(id)) await save(byId.get(id), { silent: true });
        }
      }, { label: 'Проверяем сохранение изменений…' });
    }
    async function openRoute() {
      const id = routeId(), ticket = ++routeTicket;
      if (!id) { if (location.pathname !== '/profile') binding = undefined; access(false); return; }
      access(true, 'Проверяем доступ к облачному отчёту…', true);
      await currentWork;
      if (routeId() !== id || ticket !== routeTicket) return;
      await run(async () => {
        checkRoute(id, ticket);
        await availability();
        checkRoute(id, ticket);
        if (!state.signedIn) { access(true, 'Войдите в профиль, чтобы открыть этот облачный отчёт.', false, true); message('Войдите в профиль, чтобы открыть этот облачный отчёт.'); return; }
        if (binding?.id === id && binding.ownerId === ownerId && binding.localId === capture(false).reportId) {
          await request(`/${id}/access`);
          checkRoute(id, ticket);
          access(false);
        } else await openReport({ id }, () => checkRoute(id, ticket));
      }, { label: 'Проверяем доступ к облачному отчёту…', wait: true });
    }
    $('cloudReportRetry').addEventListener('click', () => { void openRoute(); });
    $('cloudReportSignIn').addEventListener('click', async () => {
      const button = $('cloudReportSignIn'); button.disabled = true;
      try { await signIn?.(); await openRoute(); }
      catch (error) { message(errorText(error), true); }
      finally { button.disabled = false; }
    });
    root.addEventListener('popstate', () => { void openRoute(); });
    root.addEventListener('qa-report-navigation', () => { void openRoute(); });
    const lockRoute = () => { if (routeId()) access(true, 'Проверяем доступ к облачному отчёту…', true); };
    root.addEventListener('pagehide', lockRoute);
    root.addEventListener('pageshow', event => { if (event.persisted && routeId()) void openRoute(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') lockRoute();
      else if (routeId()) void openRoute();
    });
    root.addEventListener('focus', () => { if (routeId()) void openRoute(); });
    if (routeId()) queueMicrotask(() => { void openRoute(); });
    const interval = setInterval(tick, 60_000);
    root.addEventListener('online', () => { if (routeId()) void openRoute().then(tick); else void tick(); });
    return { open, reset, tick, openRoute, historyStatus, refreshHistory: () => run(availability, { wait: true, label: 'Проверяем облачные копии…' }), close: () => clearInterval(interval) };
  }
  root.QaReportCloud = { create, routeId, keepRoute, currentPath };
})(window);
