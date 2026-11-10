(function (root) {
  "use strict";
  function buildSetup({ shareUrl, connection, project, personal, packageUrl, client = "codex", windows = false, readOnly = false, fileRoot = "", accessToken = "" }) {
    if ([shareUrl, connection, project, personal].filter(Boolean).length !== 1) throw new Error("Выберите одно подключение");
    const target = new URL(shareUrl || connection?.url || project?.url || personal.url), bundle = new URL(packageUrl, target.origin);
    const local = target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
    if ((!local && target.protocol !== "https:") || target.username || target.password || target.search
        || (personal ? target.pathname !== "/api/mcp/personal" || target.hash || !/^[A-Za-z0-9_-]{43}$/.test(personal.token)
          : project ? !/^\/api\/mcp\/projects\/[a-f0-9]{32}\/reports$/.test(target.pathname) || target.hash || !/^[A-Za-z0-9_-]{43}$/.test(project.token)
          : shareUrl ? !/^\/shared-report\/[a-f0-9]{32}$/.test(target.pathname) || !/^#[A-Za-z0-9_-]{43}$/.test(target.hash)
          : !/^\/api\/local-import\/agent\/[A-Za-z0-9_-]{1,80}$/.test(target.pathname) || target.hash || !/^[a-f0-9]{64}$/.test(connection.token))
        || bundle.origin !== target.origin || bundle.pathname !== "/downloads/qa-report-mcp.tgz"
        || !/^\?v=[a-f0-9]{64}$/.test(bundle.search) || bundle.hash) throw new Error("Неполное подключение MCP");
    if (fileRoot && (!(connection || personal) || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(fileRoot) || /[\r\n\0]/.test(fileRoot))) throw new Error("Укажите полный путь к папке вложений");
    if (accessToken && (!shareUrl || !/^[a-f0-9]{64}$/.test(accessToken))) throw new Error("Неполное временное подключение");
    const name = "qa-report-" + (personal ? "personal-" + target.host.replace(/[^A-Za-z0-9_-]/g, "-") : project ? "project-" + target.pathname.split("/")[4].slice(-8) : (shareUrl ? "" : "qa-") + target.pathname.slice(-8));
    const command = windows ? "cmd" : "npx";
    const args = [...(windows ? ["/c", "npx"] : []), "--yes", "--ignore-scripts", "--package", (project || personal) ? bundle.origin + bundle.pathname : bundle.href, "qa-report-mcp"];
    const env = { ...(personal ? { QA_REPORT_PERSONAL_URL: target.href, QA_REPORT_PERSONAL_TOKEN: personal.token } : project ? { QA_REPORT_PROJECT_URL: target.href, QA_REPORT_PROJECT_TOKEN: project.token } : shareUrl ? { QA_REPORT_SHARE_URL: target.href } : { QA_REPORT_IMPORT_URL: target.href, QA_REPORT_IMPORT_TOKEN: connection.token }),
      ...(accessToken ? { QA_REPORT_MCP_ACCESS_TOKEN: accessToken } : {}),
      ...(fileRoot ? { QA_REPORT_FILE_ROOT: fileRoot } : {}), ...(readOnly ? { QA_REPORT_MCP_READ_ONLY: "1" } : {}) };
    if (client === "json") return { code: JSON.stringify({ mcpServers: { [name]: { command, args, env } } }, null, 2),
      help: "Добавьте сервер в личные настройки MCP-клиента, сохранив остальные подключения. Затем перезапустите подключение." };
    if (client === "claude" || client === "codex") {
      const quote = value => "'" + value.replaceAll("'", windows ? "''" : "'\\''") + "'";
      return { code: (client === "codex" ? "codex mcp add " : "claude mcp add --scope user --transport stdio ") + Object.entries(env).map(([key, value]) => "--env " + quote(key + "=" + value)).join(" ")
        + " " + name + " -- " + command + " " + args.map(quote).join(" "),
      help: "Выполните команду в терминале " + (windows ? "PowerShell" : "macOS / Linux") + ". Подключение сохранится в личных настройках " + (client === "codex" ? "Codex" : "Claude Code") + ". Затем откройте новый чат и проверьте подключение командой /mcp. При долгой первой загрузке повторите подключение." };
    }
    if (client !== "codex-config") throw new Error("Выберите клиент");
    return { code: `[mcp_servers.${name}]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\nstartup_timeout_sec = 120\n\n[mcp_servers.${name}.env]\n`
      + Object.entries(env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join("\n"),
    help: "Добавьте блок в личный ~/.codex/config.toml, сохранив остальные настройки. Перезапустите подключение; в Codex CLI проверьте его командой /mcp." };
  }

  function init({ shareUrl, canReply }) {
    const button = document.getElementById("shared-mcp-open"), dialog = document.getElementById("shared-mcp-dialog");
    const client = document.getElementById("shared-mcp-client"), platform = document.getElementById("shared-mcp-platform");
    const code = document.getElementById("shared-mcp-code"), help = document.getElementById("shared-mcp-help");
    const copy = document.getElementById("shared-mcp-copy"), state = document.getElementById("shared-mcp-state");
    if (button.dataset.mcpReady) return;
    button.dataset.mcpReady = "1";
    const corporate = document.documentElement.dataset.corporateSession === "required";
    const disconnect = document.getElementById("shared-mcp-disconnect");
    let packageUrl, temporary;
    async function connectionRequest(path, method, body) {
      const csrfResponse = await fetch("/api/auth/csrf", { cache: "no-store", credentials: "same-origin", redirect: "error" });
      if (!csrfResponse.ok) throw new Error();
      const { csrfToken } = await csrfResponse.json();
      const response = await fetch(path, { method, credentials: "same-origin", redirect: "error", cache: "no-store",
        headers: { "Content-Type": "application/json", "X-QA-CSRF-Token": csrfToken }, body: body && JSON.stringify(body) });
      if (!response.ok) throw new Error();
      return response.json();
    }
    platform.value = /Windows/i.test(navigator.userAgent) ? "windows" : "posix";
    document.getElementById("shared-mcp-permission").textContent = canReply
      ? "Ассистент сможет читать отчёт, менять статус исправления и комментарий. Статус проверки QA сохраняется."
      : "Эта ссылка даёт только просмотр. Ассистент сможет читать отчёт; для ответов попросите автора прислать ссылку с правом отвечать.";
    function update() {
      if (!packageUrl) return;
      if (corporate && (!temporary || temporary.expiresAt <= Date.now())) { code.value = ""; copy.disabled = true; state.textContent = "Подключение истекло. Закройте окно и подключите ИИ заново."; return; }
      const setup = buildSetup({ shareUrl, packageUrl, client: client.value, windows: platform.value === "windows", readOnly: !canReply, accessToken: temporary?.token });
      code.value = setup.code; help.textContent = setup.help; state.textContent = ""; copy.disabled = false;
      if (corporate) state.textContent = "Доступ до " + new Date(temporary.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + ". Выйдя из аккаунта, вы отключите ИИ.";
      if (disconnect) disconnect.hidden = !temporary;
    }
    client.addEventListener("change", update); platform.addEventListener("change", update);
    button.addEventListener("click", async () => {
      dialog.showModal(); copy.disabled = true; code.value = ""; state.textContent = "Готовим подключение…";
      try {
        if (corporate && (!temporary || temporary.expiresAt <= Date.now())) {
          const share = new URL(shareUrl);
          temporary = await connectionRequest("/api/mcp/connections", "POST", { reportId: share.pathname.split("/").pop(), reportToken: share.hash.slice(1) });
        }
        const response = await fetch("/api/mcp/package", { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
        if (!response.ok) throw new Error();
        const info = await response.json();
        if (!dialog.open) return;
        packageUrl = info.packageUrl; update();
      } catch { state.textContent = "Не удалось подготовить подключение. Закройте окно и попробуйте ещё раз."; }
    });
    copy.addEventListener("click", async () => {
      if (corporate && temporary?.expiresAt <= Date.now()) { update(); return; }
      try { await navigator.clipboard.writeText(code.value); state.textContent = "Скопировано. Добавьте подключение в выбранный клиент."; }
      catch { code.focus(); code.select(); state.textContent = "Скопируйте выделенный текст вручную."; }
    });
    disconnect?.addEventListener("click", async () => {
      if (!temporary) return;
      disconnect.disabled = true;
      try {
        await connectionRequest("/api/mcp/connections/" + temporary.id, "DELETE");
        temporary = undefined; code.value = ""; copy.disabled = true; disconnect.hidden = true;
        state.textContent = "ИИ отключён. Чтобы подключить его снова, откройте это окно заново.";
      } catch { state.textContent = "Не удалось отключить ИИ. Повторите попытку."; }
      finally { disconnect.disabled = false; }
    });
    document.getElementById("shared-mcp-close").addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => { code.value = ""; packageUrl = undefined; state.textContent = ""; button.focus(); });
    button.hidden = false;
  }
  root.QaReportMcpSetup = { buildSetup, init };
  if (typeof module !== "undefined") module.exports = { buildSetup };
})(typeof window === "undefined" ? globalThis : window);
