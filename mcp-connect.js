(function () {
  "use strict";
  const form = document.getElementById("approve"), button = form.querySelector("button");
  const state = document.getElementById("state");
  let account;
  const options = { credentials: "same-origin", cache: "no-store", redirect: "error" };
  async function get(path) {
    const response = await fetch(path, options);
    if (!response.ok) throw new Error("Для подключения войдите снова в корпоративную учётную запись.");
    return response.json();
  }
  get("/api/auth/session").then(({ user }) => {
    account = user.email;
    document.getElementById("identity").textContent = "Учётная запись · " + user.email;
    button.disabled = false;
  }).catch(error => { state.textContent = error.message; });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (button.disabled) return;
    button.disabled = true;
    const code = form.elements.code.value.replace(/[\s-]/g, "").toUpperCase();
    try {
      const { csrfToken } = await get("/api/auth/csrf");
      const response = await fetch("/api/mcp/developer/approve", { ...options, method: "POST",
        headers: { "Content-Type": "application/json", "X-QA-CSRF-Token": csrfToken }, body: JSON.stringify({ code, account }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Не удалось привязать устройство.");
      form.reset(); form.hidden = true;
      state.textContent = "Ассистент подключён. Вернитесь в чат и повторите запрос.";
    } catch (error) { state.textContent = error.message; button.disabled = false; }
  });
})();
