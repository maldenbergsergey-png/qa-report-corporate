(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const dialog = $('corporateProfileDialog'), trigger = $('corporateProfileButton');
  const fields = [$('corporateFirstName'), $('corporateLastName')];
  let user, busy = false, generation = 0;
  function message(text = '') { $('corporateProfileMessage').textContent = text; }
  function render() {
    $('corporateProfileEmail').textContent = user?.email || 'Проверяем профиль…';
    for (const button of dialog.querySelectorAll('[data-profile-edit], #corporateProfileSave')) button.disabled = busy || !user;
    fields.forEach(field => { field.disabled = busy || !user; });
    $('corporateProfileRemoveAvatar').hidden = !user?.avatar;
    for (const image of document.querySelectorAll('[data-corporate-avatar]')) {
      image.hidden = !user?.avatar;
      if (user?.avatar) image.src = user.avatar; else image.removeAttribute('src');
    }
    trigger.querySelector('svg').toggleAttribute('hidden', Boolean(user?.avatar));
    $('corporateProfileAvatarFallback').hidden = Boolean(user?.avatar);
  }
  function setUser(value) {
    user = value; fields[0].value = user.firstName; fields[1].value = user.lastName; render();
  }
  async function load() {
    const current = ++generation;
    busy = true; render(); message(); $('corporateProfileAdmin').hidden = true;
    try {
      const profile = await reportApi('/api/profile');
      if (current !== generation) return;
      setUser(profile.user);
      if (profile.adminPath && /^\/[a-z_][a-z0-9_-]*\/$/.test(profile.adminPath)) {
        $('corporateProfileAdmin').href = profile.adminPath; $('corporateProfileAdmin').hidden = false;
      }
    } catch { if (current === generation) message('Не удалось загрузить профиль. Нажмите «Обновить».'); }
    finally { if (current === generation) { busy = false; render(); } }
  }
  async function save(body, success) {
    if (busy || !user) return;
    const current = generation;
    busy = true; render(); message('Сохраняем…');
    try {
      const result = await reportApi('/api/profile', { method: 'POST', headers: { 'X-QA-CSRF-Token': await authCsrfToken() }, body: JSON.stringify(body) });
      if (current !== generation) return;
      setUser(result.user); message(success);
    } catch (error) { if (current === generation) message(error.message || 'Не удалось сохранить профиль. Повторите ещё раз.'); }
    finally { if (current === generation) { busy = false; render(); } }
  }
  trigger.addEventListener('click', () => { closeHeaderDropdowns(); dialog.showModal(); load(); });
  $('corporateProfileClose').addEventListener('click', () => dialog.close());
  dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
  dialog.querySelector('[data-personal-cloud]').addEventListener('click', () => dialog.close());
  $('corporateProfileSettings').addEventListener('click', () => { dialog.close(); openJiraSettings(); });
  $('corporateProfileRefresh').addEventListener('click', () => { if (!busy) load(); });
  $('corporateProfileNameForm').addEventListener('submit', event => {
    event.preventDefault(); save({ firstName: fields[0].value.trim(), lastName: fields[1].value.trim() }, 'Имя и фамилия сохранены.');
  });
  $('corporateProfileUploadAvatar').addEventListener('click', () => $('corporateProfileAvatarFile').click());
  $('corporateProfileRemoveAvatar').addEventListener('click', () => save({ avatar: null }, 'Аватар убран.'));
  $('corporateProfileAvatarFile').addEventListener('change', async event => {
    const file = event.target.files[0]; event.target.value = '';
    if (!file || busy || !user) return;
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      message('Выберите PNG, JPEG, WebP или GIF до 5 МиБ.'); return;
    }
    const current = generation;
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      if (current === generation) await save({ avatar: canvas.toDataURL('image/png') }, 'Аватар обновлён.');
    } catch { message('Не удалось прочитать изображение. Выберите другой файл.'); }
    finally { bitmap?.close(); }
  });
  $('corporateProfileSignOut').addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true;
    try {
      await reportApi('/api/auth/logout', { method: 'POST', body: JSON.stringify({ csrfToken: await authCsrfToken() }) });
      ++generation; user = null; render(); personalCloud.reset(); location.assign('/login');
    } catch { showToast('Не удалось выйти. Повторите ещё раз.'); button.disabled = false; }
  });
  window.addEventListener('pagehide', () => { ++generation; $('corporateProfileAdmin').hidden = true; });
  window.addEventListener('pageshow', event => { if (event.persisted) load(); });
  load();
})();
