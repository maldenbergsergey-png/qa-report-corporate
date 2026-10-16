(() => {
  const supportedThemes = new Set(["light", "dark", "graphite"]);
  let theme = "graphite";

  try {
    const savedTheme = localStorage.getItem("qa-report-theme");
    if (supportedThemes.has(savedTheme)) theme = savedTheme;
  } catch {
    // Keep the default theme when storage is unavailable.
  }

  document.documentElement.dataset.theme = theme;
  const colors = { light: "#f4f5f7", dark: "#111827", graphite: "#17191d" };
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", colors[theme]);
})();
