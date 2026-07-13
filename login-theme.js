(() => {
  const supportedThemes = new Set(["light", "dark", "graphite"]);
  let theme = "light";

  try {
    const savedTheme = localStorage.getItem("qa-report-theme");
    if (supportedThemes.has(savedTheme)) theme = savedTheme;
    else if (matchMedia("(prefers-color-scheme: dark)").matches) theme = "dark";
  } catch {
    // The light theme remains a safe fallback when storage is unavailable.
  }

  document.documentElement.dataset.theme = theme;
  const colors = { light: "#f4f5f7", dark: "#111827", graphite: "#17191d" };
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", colors[theme]);
})();
