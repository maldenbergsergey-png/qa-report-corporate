(function (root) {
  "use strict";
  function parse(value, provider = "") {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" && url.protocol !== "http:" || url.username || url.password) return null;
      let match = url.pathname.match(/^(.*?)\/browse\/([A-Z][A-Z0-9_]*-\d+)\/?$/i);
      if (match && provider !== "eva") return { provider: "jira", baseUrl: url.origin + match[1], key: match[2].toUpperCase(), issueUrl: url.origin + match[1] + "/browse/" + match[2].toUpperCase() };
      match = url.pathname.match(/^(.*?)\/(?:desk|project)\/Task\/([^/]+)(?:\/(?:task|list))?\/?$/);
      if (!match) {
        const wrapper = url.pathname.match(/^(.*?)\/(?:struct\/Person\/[^/]+|(?:desk|project)(?:\/.*)?)\/?$/);
        const object = url.searchParams.get("obj")?.match(/^Task:(.+)$/);
        if (wrapper && object) match = ["", wrapper[1], object[1]];
      }
      if (!match || provider === "jira") return null;
      const key = decodeURIComponent(match[2]);
      if (!/^[A-Za-zА-Яа-яЁё0-9_.:-]{1,120}$/.test(key)) return null;
      return { provider: "eva", baseUrl: url.origin + match[1], key, issueUrl: url.origin + match[1] + "/desk/Task/" + encodeURIComponent(key) };
    } catch { return null; }
  }
  function commentId(value) {
    try {
      if (!parse(value, "eva")) return "";
      const url = new URL(value), explicit = url.searchParams.get("comment") || url.searchParams.get("commentId");
      const fragment = decodeURIComponent(url.hash);
      const reference = explicit || fragment.split(/#+/).at(-1);
      if (/^CmfComment:[a-zA-Z0-9_-]{1,120}$/.test(reference)) return reference;
      const uuid = reference.match(/^(?:CmfComment)?([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i);
      return uuid ? `CmfComment:${uuid[1]}` : "";
    } catch { return ""; }
  }
  const api = { parse, commentId, identity: value => parse(value)?.issueUrl || "" };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.QaReportTrackerLinks = api;
})(typeof window === "object" ? window : globalThis);
