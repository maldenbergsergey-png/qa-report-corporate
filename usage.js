// Best-effort online usage signal. It never reads reports, URLs, account data or tokens.
(() => {
  'use strict';
  let pending = false; let lastSent = 0;
  async function visit() {
    if (pending || document.visibilityState !== 'visible' || navigator.onLine === false || Date.now() - lastSent < 60000) return;
    pending = true; lastSent = Date.now();
    try {
      await fetch('/api/usage/visit', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true ? 'pwa' : 'browser' }),
      });
    } catch { /* Offline statistics are deliberately not queued. */ }
    finally { pending = false; }
  }
  visit();
  document.addEventListener('visibilitychange', visit);
  window.addEventListener('pageshow', visit);
  window.addEventListener('online', () => { lastSent = 0; visit(); });
  setInterval(visit, 5 * 60000);
})();
