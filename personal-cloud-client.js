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

  function create({ headers, capture, records, restore, loadAttachment, notify, blocked, operation }) {
    const $ = id => document.getElementById(id);
    const dialog = $('personalCloudDialog');
    let state, ownerId = '', generation = 0, busy = false, entries = [];
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
    function message(text, error = false) {
      $('personalCloudStatus').textContent = text;
      $('personalCloudStatus').classList.toggle('cloud-error', error);
    }
    function assertCurrent(expectedOwner, version) {
      if (ownerId !== expectedOwner || generation !== version) throw Object.assign(new Error('Аккаунт изменился. Повторите действие в нужном профиле.'), { cloudCanceled: true });
    }
    async function request(route, { method = 'GET', body, binary = false, owner = ownerId, version = generation } = {}) {
      const auth = await headers(method);
      assertCurrent(owner, version);
      const response = await fetch(API + route, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        signal: AbortSignal.timeout(60_000), headers: { ...auth, 'X-QA-Cloud': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      assertCurrent(owner, version);
      if (binary && response.ok) return new Uint8Array(await response.arrayBuffer());
      const data = await response.json().catch(() => ({}));
      assertCurrent(owner, version);
      if (!response.ok) throw Object.assign(new Error(data.error || 'Облако временно недоступно.'), { status: response.status });
      return data;
    }
    async function availability() {
      const version = generation, expected = ownerId;
      const result = await request('/availability');
      if (version !== generation || expected !== ownerId) throw new Error('Аккаунт изменился.');
      state = result;
      if (ownerId !== result.ownerId) { ownerId = result.ownerId; generation++; }
      $('personalCloudAccount').textContent = result.signedIn ? 'Доступно только вашему аккаунту' : 'Войдите в профиль, чтобы открыть свои облачные отчёты.';
      return result;
    }
    function render() {
      const current = capture(false);
      const link = links()[current.reportId];
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
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button button-ghost'; remove.textContent = 'Удалить'; remove.disabled = busy;
        remove.setAttribute('aria-label', `Удалить из облака: ${entry.title || 'чек-лист'}`);
        remove.addEventListener('click', () => run(async () => {
          if (!confirm('Удалить отчёт из облака? Локальные копии в браузерах сохранятся.')) return;
          await request('/' + entry.id, { method: 'DELETE', body: {} });
          for (const [id, link] of Object.entries(links())) if (link.id === entry.id) updateLink(id, null);
          await refresh(); message('Отчёт удалён из облака. Локальные копии сохранены.');
        }));
        actions.append(open, remove); article.append(info, actions); list.append(article);
      }
      if (!entries.length) {
        const empty = document.createElement('p'); empty.className = 'cloud-empty';
        empty.textContent = state?.signedIn ? 'Сохранённых облачных отчётов пока нет.' : 'Ваши отчёты появятся здесь после входа.';
        list.append(empty);
      }
    }
    async function refresh() {
      await availability();
      entries = state.signedIn ? (await request('')).reports : [];
      if (!state.configured) message('Облачное хранилище пока не подключено администратором.');
      else if (state.signedIn && !state.canSave) message('Администратор отключил сохранение в облако. Ранее сохранённые отчёты можно открывать и удалять.');
      render();
    }
    async function run(action) {
      if (busy) return;
      if (blocked()) { notify('Дождитесь завершения текущей операции с отчётом.'); return; }
      busy = true; operation(1); message('Подождите…'); render();
      try { await action(); }
      catch (error) {
        if (!error.cloudCanceled) { message(error.message, true); if (!dialog.open) notify(error.message); }
      } finally { busy = false; operation(-1); render(); }
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
          onProgress: ({ completed, total }) => { if (!silent && total) message(`Подготовка вложений: ${completed} из ${total}`); } });
        assertCurrent(owner, version);
        for (const bytes of payload.assets.values()) if (bytes.length > state.fileBytes) throw new Error('Одно облачное вложение должно быть не больше 50 МиБ.');
        const files = [...payload.assets].map(([hash, bytes]) => ({ hash, size: bytes.length }));
        const { missing } = await request('/' + link.id + '/files', { method: 'POST', body: { files } });
        for (const hash of missing) {
          const bytes = payload.assets.get(hash);
          let offset = 0;
          do {
            const part = bytes.subarray(offset, offset + state.chunkBytes);
            if (!silent) message(`Загрузка вложений: ${Math.round((offset + part.length) / Math.max(1, bytes.length) * 100)}%`);
            const result = await request(`/${link.id}/files/${hash}`, { method: 'POST', body: { size: bytes.length, offset, data: base64(part) } });
            if (result.complete) break;
            offset += part.length;
          } while (offset < bytes.length);
        }
        const title = [value.issueUrl || value.sections[0]?.title || 'Чек-лист', value.environment].filter(Boolean).join(' — ').slice(0, 500);
        const { report } = await request('/' + link.id, { method: 'PUT', body: { title, document: payload.document, revision: link.revision } });
        assertCurrent(owner, version);
        updateLink(localId, { ...link, revision: report.revision, content, savedAt: report.updatedAt, conflict: false });
        if (!silent) { await refresh(); message('Отчёт сохранён в личном облаке.'); }
      } catch (error) {
        if (error.status === 409 && owner === ownerId && generation === version) updateLink(localId, { ...link, conflict: true });
        throw error;
      }
    }
    async function openReport(entry) {
      const owner = ownerId, version = generation;
      const before = capture();
      const beforeContent = fingerprint(before);
      const { report } = await request('/' + entry.id);
      const assets = new Map();
      for (const file of report.files) {
        message(`Открываем вложения: ${assets.size + 1} из ${report.files.length}`);
        const bytes = await request(`/${entry.id}/files/${file.hash}`, { binary: true });
        if (bytes.length !== file.size || await root.QaReportFile.hash(bytes) !== file.hash) throw new Error('Вложение повреждено. Текущий локальный отчёт сохранён.');
        assets.set(file.hash, bytes);
      }
      const imported = root.QaReportFile.restoreCloud(report.document, assets);
      assertCurrent(owner, version);
      const current = capture();
      if (current.reportId !== before.reportId || fingerprint(current) !== beforeContent) throw new Error('За время загрузки текущий отчёт изменился. Повторите открытие.');
      const value = await restore(imported.document);
      assertCurrent(owner, version);
      // Only the explicitly opened local copy backs up to this cloud record.
      for (const [id, link] of Object.entries(links())) if (link.id === entry.id) updateLink(id, null);
      updateLink(value.reportId, { id: entry.id, revision: report.revision, auto: true, content: fingerprint(value), savedAt: report.updatedAt });
      dialog.close();
      notify('Отчёт открыт в браузере. Изменения сохраняются в облако раз в минуту.');
    }
    async function open() {
      if (!dialog.open) dialog.showModal();
      message('Загружаем ваши отчёты…');
      await run(refresh);
    }
    $('personalCloudClose').addEventListener('click', () => dialog.close());
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
    $('personalCloudRefresh').addEventListener('click', () => run(refresh));
    $('personalCloudSave').addEventListener('click', () => run(() => save(capture())));
    $('personalCloudCopy').addEventListener('click', () => run(() => save(capture(), { copy: true })));
    $('personalCloudAuto').addEventListener('change', () => {
      try {
        const id = capture(false).reportId, link = links()[id];
        if (link) updateLink(id, { ...link, auto: $('personalCloudAuto').checked });
      } catch (error) { message(error.message, true); }
      render();
    });
    for (const button of document.querySelectorAll('[data-personal-cloud]')) button.addEventListener('click', open);
    function reset() {
      generation++; ownerId = ''; state = undefined; entries = [];
      message(''); render();
    }
    root.addEventListener('qa-report-account-change', reset);
    async function tick() {
      if (busy || blocked() || !navigator.onLine || document.visibilityState === 'hidden') return;
      // Do not contact the account service until this browser has cloud copies.
      if (!Object.values(readLinks()).some(group => Object.values(group || {}).some(link => link?.auto && !link.conflict))) return;
      busy = true; operation(1);
      try {
        await availability();
        if (!state.canSave) return;
        const saved = await records();
        const current = capture();
        const byId = new Map(saved.map(record => [record.id, record.document])); byId.set(current.reportId, current);
        for (const [id, link] of Object.entries(links())) {
          if (link.auto && !link.conflict && byId.has(id)) await save(byId.get(id), { silent: true });
        }
      } catch (error) {
        if (error.cloudCanceled) return;
        message(error.message, true);
        if (error.status === 409) notify(error.message);
      } finally { busy = false; operation(-1); render(); }
    }
    const interval = setInterval(tick, 60_000);
    root.addEventListener('online', tick);
    return { open, reset, tick, close: () => clearInterval(interval) };
  }
  root.QaReportCloud = { create };
})(window);
