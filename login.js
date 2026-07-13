const form = document.querySelector("#loginForm");
const email = document.querySelector("#loginEmail");
const password = document.querySelector("#loginPassword");
const submit = document.querySelector("#loginSubmit");
const errorBox = document.querySelector("#loginError");
const toggle = document.querySelector("#togglePassword");

function callbackUrl() {
  const value = new URLSearchParams(location.search).get("callbackUrl") || "/";
  return value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

toggle.addEventListener("click", () => {
  const visible = password.type === "text";
  password.type = visible ? "password" : "text";
  toggle.setAttribute("aria-label", visible ? "Показать пароль" : "Скрыть пароль");
  toggle.setAttribute("title", visible ? "Показать пароль" : "Скрыть пароль");
  toggle.classList.toggle("is-active", !visible);
});

email.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); password.focus(); }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  if (!email.value.trim() || !password.value) { errorBox.textContent = "Введите email и пароль"; errorBox.hidden = false; return; }
  submit.disabled = true;
  submit.classList.add("is-loading");
  submit.setAttribute("aria-label", "Выполняется вход");
  try {
    const csrfResponse = await fetch("/api/auth/csrf", { credentials: "same-origin", cache: "no-store" });
    const { csrfToken } = await csrfResponse.json();
    const response = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.value, password: password.value, csrfToken, callbackUrl: callbackUrl() }),
    });
    const result = await response.json().catch(() => ({}));
    password.value = "";
    if (!response.ok) throw new Error(result.error || "Неверный email или пароль");
    location.assign(result.callbackUrl || "/");
  } catch (error) {
    password.value = "";
    errorBox.textContent = error.message || "Не удалось выполнить вход";
    errorBox.hidden = false;
    password.focus();
  } finally {
    submit.disabled = false;
    submit.classList.remove("is-loading");
    submit.setAttribute("aria-label", "Войти");
  }
});

addEventListener("pagehide", () => { password.value = ""; });
