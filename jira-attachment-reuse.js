/* Shared publication planning. A filename alone never proves file identity. */
(function (root) {
  "use strict";
  function issueIdentity(value) {
    try {
      const url = new URL(value); const match = url.pathname.match(/^(.*?)\/browse\/([A-Z][A-Z0-9_]*-\d+)\/?$/i);
      if (!match || !["http:","https:"].includes(url.protocol) || url.username || url.password) return "";
      return `${url.origin}${match[1]}/browse/${match[2].toUpperCase()}`;
    } catch { return ""; }
  }
  function sourceUrl(value, issueUrl) {
    try { const url = new URL(value, issueUrl); return value && url.origin === new URL(issueUrl).origin && !url.username && !url.password && ["http:","https:"].includes(url.protocol) ? url.href : ""; } catch { return ""; }
  }
  function read(node) {
    const dataUrl = node.tagName === "IMG" ? node.getAttribute("src") || "" : node.dataset.dataUrl || "";
    return { attachmentId:node.dataset.attachmentId, name:node.dataset.fileName || node.dataset.jiraName || node.getAttribute("alt") || "file",
      external: /^https?:/i.test(dataUrl),
      type:node.dataset.mimeType || "application/octet-stream", dataUrl:dataUrl.startsWith("data:") ? dataUrl : "",
      source:{ issueUrl:issueIdentity(node.dataset.jiraSourceIssue), id:node.dataset.jiraId || "", name:node.dataset.jiraName || "", hash:node.dataset.jiraSourceHash || "", kind:node.dataset.jiraKind || (node.tagName === "IMG" ? "image":"file") } };
  }
  const key = asset => JSON.stringify([asset.attachmentId,asset.dataUrl,asset.source.issueUrl,asset.source.id]);
  function collect(value) {
    const assets = new Map();
    const htmls = [value.intro, ...(value.sections || []).flatMap(section => (section.rows || []).flatMap(row => Object.values(row.cells || {})))];
    for (const html of htmls) {
      const template = document.createElement("template"); template.innerHTML = html || "";
      for (const node of template.content.querySelectorAll("img[data-attachment-id], .cell-file[data-attachment-id]")) {
        const asset = read(node);
        if (!asset.external && (asset.dataUrl || asset.source.id || node.classList.contains("jira-attachment-reference"))) assets.set(key(asset), asset);
      }
    }
    return [...assets.values()];
  }
  async function digest(dataUrl) {
    const match = String(dataUrl).match(/^data:([^;,]+);base64,([a-z0-9+/=]*)$/i);
    if (!match) throw new Error("Некорректные локальные данные файла");
    const raw = atob(match[2]); const bytes = Uint8Array.from(raw,c=>c.charCodeAt(0));
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(n=>n.toString(16).padStart(2,"0")).join("");
    return {hash, dataBase64:match[2], type:match[1]};
  }
  function uniqueName(original, names) {
    const name = String(original || "file").replace(/[\r\n\u0000/\\]/g,"_");
    if (![...names].some(value=>value.toLowerCase()===name.toLowerCase())) { names.add(name); return name; }
    const dot=name.lastIndexOf("."); const stem=dot>0?name.slice(0,dot):name, ext=dot>0?name.slice(dot):"";
    let n=2; while([...names].some(value=>value.toLowerCase()===`${stem} (${n})${ext}`.toLowerCase())) n++;
    const chosen=`${stem} (${n})${ext}`; names.add(chosen);return chosen;
  }
  async function plan(assets, { issueUrl, attachments, loadSource, signal }) {
    const target = issueIdentity(issueUrl); if (!target) throw new Error("Некорректная задача для публикации");
    if (!Array.isArray(attachments)) throw new Error("Не удалось проверить вложения Jira");
    const remote = new Map(attachments.map(file=>[String(file.id),file]));
    const names = new Set(attachments.map(file=>file.filename)); const nameCounts = new Map();
    attachments.forEach(file=>nameCounts.set(file.filename,(nameCounts.get(file.filename)||0)+1));
    const reused = new Map(), uploads = new Map(), downloads = new Map(), hashes = new Map();
    const getDigest = data => { if (!hashes.has(data)) hashes.set(data,digest(data)); return hashes.get(data); };
    const localSources = new Map();
    for (const asset of assets) if (asset.dataUrl && asset.source.issueUrl && asset.source.id) {
      const bytes = await getDigest(asset.dataUrl);
      if (bytes.hash === asset.source.hash) localSources.set(`${asset.source.issueUrl}#${asset.source.id}`, asset.dataUrl);
    }
    for (const asset of assets) {
      signal?.throwIfAborted?.();
      const original = { key:key(asset), attachmentId:asset.attachmentId };
      let bytes = asset.dataUrl ? await getDigest(asset.dataUrl) : null;
      const current = asset.source.issueUrl === target ? remote.get(asset.source.id) : null;
      const unchanged = !bytes || (asset.source.hash && asset.source.hash === bytes.hash);
      if (current && unchanged) {
        if (nameCounts.get(current.filename)>1 && !sourceUrl(current.content,target)) throw new Error(`Jira не вернула точную ссылку на «${current.filename}» с одинаковыми именами`);
        if (!reused.has(String(current.id))) reused.set(String(current.id),{...current, originals:[], hash:bytes?.hash || asset.source.hash, issueUrl:target, exactUrl:nameCounts.get(current.filename)>1});
        reused.get(String(current.id)).hash ||= bytes?.hash || asset.source.hash;
        reused.get(String(current.id)).originals.push(original); continue;
      }
      if (!bytes) {
        if (!asset.source.issueUrl || !asset.source.id) throw new Error(`Не удалось определить исходное вложение «${asset.name}». Импортируйте его из Jira ещё раз`);
        const sourceKey=`${asset.source.issueUrl}#${asset.source.id}`;
        if (!downloads.has(sourceKey)) downloads.set(sourceKey,localSources.has(sourceKey) ? Promise.resolve(localSources.get(sourceKey)) : loadSource(asset.source));
        let data;
        try { data=await downloads.get(sourceKey); }
        catch(error) { throw new Error(`Не удалось получить «${asset.name}» из исходной Jira: ${error.message}`); }
        bytes=await getDigest(data);
      }
      // Identical content with the same original name is uploaded once per publication.
      const uploadKey=JSON.stringify([asset.name,bytes.hash]);
      if (!uploads.has(uploadKey)) uploads.set(uploadKey,{attachmentId:crypto.randomUUID(),name:uniqueName(asset.name,names),type:bytes.type,dataBase64:bytes.dataBase64,hash:bytes.hash,issueUrl:target,originals:[]});
      uploads.get(uploadKey).originals.push(original);
    }
    return {reused:[...reused.values()],uploads:[...uploads.values()]};
  }
  function bindings(entries) {
    return entries.flatMap(entry=>(entry.originals || []).map(original=>({...entry,key:original.key,attachmentId:original.attachmentId,originals:undefined})));
  }
  function applyRoot(container, changes) {
    const byKey = new Map(changes.map(change=>[change.key,change]));
      for (const node of container.querySelectorAll("img[data-attachment-id], .cell-file[data-attachment-id]")) {
        const change=byKey.get(key(read(node)));if(!change)continue;
        node.dataset.jiraId=String(change.id);node.dataset.jiraName=change.filename;
        node.dataset.jiraUrl=sourceUrl(change.content,change.issueUrl);
        node.dataset.jiraSourceIssue=issueIdentity(change.issueUrl);node.dataset.jiraSourceHash=change.hash || "";
        if(change.exactUrl) node.dataset.jiraExactUrl="true";else delete node.dataset.jiraExactUrl;
      }
  }
  function apply(value, changes) {
    const html = content => {
      const template=document.createElement("template");template.innerHTML=content || "";
      applyRoot(template.content, changes);
      return template.innerHTML;
    };
    value.intro=html(value.intro);
    for(const section of value.sections || [])for(const row of section.rows || [])for(const column of Object.keys(row.cells || {}))row.cells[column]=html(row.cells[column]);
  }
  root.QaReportJiraReuse={issueIdentity,sourceUrl,collect,digest,uniqueName,plan,bindings,apply,applyRoot};
})(typeof window === "undefined" ? globalThis : window);
