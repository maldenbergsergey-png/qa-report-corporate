// Best-effort usage signal. Account identity is verified by the server; reports and URLs are never read.
(() => {
  'use strict';
  let pending = false; let lastSent = 0; let revision = 0; let accountId = ''; let getToken;
  window.QaReportUsage = {
    setAccount(id, token) {
      if (id === accountId) return;
      accountId = id; getToken = id ? token : undefined; revision++; lastSent = 0;
      visit();
    },
  };
  async function visit() {
    if (pending || document.visibilityState !== 'visible' || navigator.onLine === false || Date.now() - lastSent < 60000) return;
    pending = true; lastSent = Date.now();
    const current = revision;
    try {
      const token = getToken ? await getToken() : '';
      if (current !== revision) return;
      await fetch('/api/usage/visit', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-QA-Report-Session': token } : {}) },
        redirect: 'error', signal: AbortSignal.timeout(8000),
        body: JSON.stringify({ mode: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true ? 'pwa' : 'browser' }),
      });
    } catch { /* Offline statistics are deliberately not queued. */ }
    finally { pending = false; if (current !== revision) { lastSent = 0; visit(); } }
  }
  visit();
  document.addEventListener('visibilitychange', visit);
  window.addEventListener('pageshow', visit);
  window.addEventListener('online', () => { lastSent = 0; visit(); });
  setInterval(visit, 5 * 60000);
})();
