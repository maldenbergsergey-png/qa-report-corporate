(() => {
  const button = document.getElementById("installAppButton");
  let installPrompt;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    button.hidden = false;
  });
  button.addEventListener("click", async () => {
    if (!installPrompt) return;
    const prompt = installPrompt;
    installPrompt = null;
    button.hidden = true;
    try {
      await prompt.prompt();
      await prompt.userChoice;
    } catch (error) {
      console.warn("Не удалось открыть установку QA Report", error);
    }
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    button.hidden = true;
  });
  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch((error) => {
      console.warn("Не удалось подготовить QA Report к автономной работе", error);
    });
  }
})();

(() => {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  const button = document.getElementById('updateAppButton');
  const label = document.getElementById('updateAppLabel');
  const announcement = document.getElementById('updateAppAnnouncement');
  let registration;
  let applying = false;
  let lastCheck = 0;
  const reveal = () => {
    if (!registration?.waiting || !navigator.serviceWorker.controller) return;
    if (button.hidden) announcement.textContent = 'Доступна новая версия QA Report. Нажмите «Обновить», когда будет удобно.';
    button.hidden = false;
  };
  const check = () => {
    if (!registration || document.visibilityState !== 'visible' || Date.now() - lastCheck < 60000) return;
    lastCheck = Date.now();
    registration.update().then(reveal).catch(() => {});
  };
  navigator.serviceWorker.ready.then(reg => {
    registration = reg;
    reveal();
    const observe = () => {
      const installing = reg.installing;
      installing?.addEventListener('statechange', () => {
        if (installing.state === 'installed') {
          reveal();
          // The registration's waiting reference can settle after statechange.
          setTimeout(reveal, 0);
        }
      });
    };
    reg.addEventListener('updatefound', observe);
    observe();
    // register() already checks at startup; avoid overlapping update jobs.
    lastCheck = Date.now();
  });
  window.addEventListener('online', check);
  document.addEventListener('visibilitychange', check);
  setInterval(check, 15 * 60 * 1000);

  button.addEventListener('click', async () => {
    if (applying || !registration?.waiting) return;
    applying = true;
    button.disabled = true;
    label.textContent = 'Обновляем…';
    const shell = document.querySelector('.app-shell');
    const wasInert = shell.inert;
    shell.inert = true;
    let changed;
    let timer;
    try {
      if (!window.preparePwaUpdate) throw new Error('Редактор ещё загружается. Попробуйте снова.');
      await window.preparePwaUpdate();
      await new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        const cleanup = () => {
          clearTimeout(timer);
          channel.port1.close();
          navigator.serviceWorker.removeEventListener('controllerchange', changed);
        };
        changed = () => { cleanup(); resolve(); };
        navigator.serviceWorker.addEventListener('controllerchange', changed);
        timer = setTimeout(() => { cleanup(); reject(new Error('Не удалось завершить обновление. Попробуйте снова.')); }, 15000);
        channel.port1.onmessage = ({ data }) => {
          if (!data.ok) { cleanup(); reject(new Error(data.message)); }
        };
        registration.waiting.postMessage({ type: 'APPLY_UPDATE' }, [channel.port2]);
      });
      window.location.reload();
    } catch (error) {
      announcement.textContent = error.message;
      window.showToast?.(error.message, 8000);
      label.textContent = 'Обновить';
      button.disabled = false;
      applying = false;
    } finally {
      shell.inert = wasInert;
    }
  });
})();
