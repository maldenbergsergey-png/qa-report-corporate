// Corporate navigation ALWAYS reaches the server's existing session gate.
// No editor HTML, user data, login responses or API results are cached.
const CACHE_NAME = 'qa-report-corporate-assets-v24';
const SHELL = [
  "/jira-attachment-reuse.js?v=1",
  "/attachment-import.js?v=4", "/local-import-client.js?v=1",
  "/checklist-table.js?v=2",
  "/icons/icon-192.png?v=2", "/icons/icon-512.png?v=2",
  "/icons/brand-light.png?v=2", "/icons/brand-dark.png",
  '/styles.css?v=92', '/app.js?v=95', '/pwa.js?v=3',
  '/jira-markup-import.js?v=4', '/checklist-selection.js?v=2',
  '/checklist-numbering.js?v=2', '/release-notes.js?v=7',
  '/favicon.svg?v=2', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png',
];
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    // Reject redirects to login: they must never become cached JavaScript.
    const responses = await Promise.all(SHELL.map(async url => {
      const response = await fetch(new Request(url, { cache: 'reload', credentials: 'same-origin', redirect: 'error' }));
      if (!response.ok) throw new Error('Incomplete application update');
      return [url, response];
    }));
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(responses.map(([url, response]) => cache.put(url, response)));
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('qa-report-corporate-assets-') && name !== CACHE_NAME) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => new Response(
      '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>QA Report — требуется подключение</title><body><h1>Не удалось подключиться к серверу</h1><p>Для открытия корпоративного редактора необходимо проверить вход. Локальные данные не удалены.</p><p>Восстановите подключение и обновите страницу.</p><a href="/">Попробовать снова</a></body></html>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'" } }
    )));
    return;
  }
  // Even cached code is served only after the original server authorizes it.
  const key = url.pathname + url.search;
  if (!SHELL.includes(key)) return;
  event.respondWith((async () => {
    const response = await fetch(event.request);
    if (!response.ok || response.redirected) return response;
    const cache = await caches.open(CACHE_NAME);
    return await cache.match(key) || response;
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type !== 'APPLY_UPDATE' || !event.ports[0]) return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (windows.some(client => client.url.startsWith(self.registration.scope) && client.id !== event.source?.id)) {
      event.ports[0].postMessage({ ok: false, message: 'Закройте другие окна и вкладки QA Report, затем нажмите «Обновить» снова.' });
      return;
    }
    event.ports[0].postMessage({ ok: true });
    await self.skipWaiting();
  })());
});
