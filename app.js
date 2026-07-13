const STORAGE_KEY = "qa-report-editor-draft-v2";
const DRAFT_SYNC_CHANNEL = "qa-report-draft-sync-v1";
const CLOUD_HISTORY_ENABLED_KEY = "qa-report-cloud-history-enabled-v1";
const CLIENT_ID_KEY = "qa-report-client-id-v1";
const WORKSPACE_KEY_STORAGE_KEY = "qa-report-workspace-key-v1";
const SERVER_HASHES_KEY = "qa-report-server-hashes-v1";
const DISMISSED_CLOUD_HASHES_KEY = "qa-report-dismissed-cloud-hashes-v1";
const DB_NAME = "qa-report-editor";
const DB_VERSION = 1;
const REPORT_STORE = "reports";
const HISTORY_LIMIT = 50;
const REQUIRED_API_REVISION = 5;
const FILE_ATTACHMENT_MAX_SIZE = 50 * 1024 * 1024;
const ATTACHMENT_UPLOAD_BATCH_SIZE = 1;
const { parseJiraMarkup, normalizeStatus } = window.QaReportJiraImport;
const nativeFetch = window.fetch.bind(window);
let authRedirectStarted = false;

window.fetch = async (...args) => {
  const response = await nativeFetch(...args);
  const target = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
  if (response.status === 401 && !String(target).startsWith("/api/auth/") && !authRedirectStarted) {
    authRedirectStarted = true;
    const callback = `${location.pathname}${location.search}`;
    location.assign(`/login?callbackUrl=${encodeURIComponent(callback)}`);
  }
  return response;
};

const STATUS_META = {
  OK: { className: "status-ok", color: "#22a06b", jiraColor: "#14892c" },
  "НЕ ОК": { className: "status-fail", color: "#c9372c", jiraColor: "#de350b" },
  "ПОЧТИ ОК": { className: "status-almost", color: "#579dff", jiraColor: "#59afe1" },
  "НЕ ПРОВЕРЕНО": { className: "status-unchecked", color: "#8270db", jiraColor: "#654982" },
  "ЧАСТИЧНО ПРОВЕРЕНО": {
    className: "status-partial",
    color: "#f18d13",
    jiraColor: "#ff8b00",
  },
  "ТРЕБУЕТ УТОЧНЕНИЯ": {
    className: "status-clarification",
    color: "#9f5f00",
    jiraColor: "#bf6700",
  },
};

const DEFAULT_COLUMNS = [
  { id: "check", title: "Проверка" },
  { id: "expected", title: "Ожидаемый результат" },
  { id: "actual", title: "Фактический результат" },
  { id: "comment", title: "Комментарий" },
];

function createRow(columns = DEFAULT_COLUMNS) {
  return {
    id: crypto.randomUUID(),
    status: "НЕ ПРОВЕРЕНО",
    cells: Object.fromEntries(columns.map((column) => [column.id, ""])),
  };
}

function createSection(title = "Основные проверки", columns = DEFAULT_COLUMNS, rowCount = 1) {
  const copiedColumns = columns.map((column) => ({ ...column }));
  return {
    id: crypto.randomUUID(),
    title,
    collapsed: false,
    columns: copiedColumns,
    rows: Array.from({ length: rowCount }, () => createRow(copiedColumns)),
  };
}

const DEFAULT_DRAFT = {
  draftId: crypto.randomUUID(),
  reportId: crypto.randomUUID(),
  publicId: createPublicId(),
  schemaVersion: 3,
  revision: 0,
  updatedAt: new Date(0).toISOString(),
  lastSavedBy: "",
  lastSavedClientId: "",
  issueUrl: "",
  environment: "STAGE",
  overallStatus: "OK",
  intro: "",
  sections: [createSection("Основные проверки", DEFAULT_COLUMNS, 2)],
};

const elements = {
  issueUrl: document.querySelector("#issueUrl"),
  environment: document.querySelector("#environment"),
  overallStatus: document.querySelector("#overallStatus"),
  reportCard: document.querySelector(".report-card"),
  introEditor: document.querySelector("#introEditor"),
  sections: document.querySelector("#sections"),
  sectionTemplate: document.querySelector("#sectionTemplate"),
  addSectionButton: document.querySelector("#addSectionButton"),
  previewButton: document.querySelector("#previewButton"),
  copyButton: document.querySelector("#copyButton"),
  copyVisualButton: document.querySelector("#copyVisualButton"),
  exportXlsxButton: document.querySelector("#exportXlsxButton"),
  clearButton: document.querySelector("#clearButton"),
  importButton: document.querySelector("#importButton"),
  previewModal: document.querySelector("#previewModal"),
  publishProgressModal: document.querySelector("#publishProgressModal"),
  publishProgressBar: document.querySelector("#publishProgressBar"),
  publishSteps: document.querySelector("#publishSteps"),
  publishStatusText: document.querySelector("#publishStatusText"),
  publishErrorText: document.querySelector("#publishErrorText"),
  publishProgressHint: document.querySelector("#publishProgressHint"),
  publishCancelButton: document.querySelector("#publishCancelButton"),
  closePreviewButton: document.querySelector("#closePreviewButton"),
  visualPreview: document.querySelector("#visualPreview"),
  markupPreview: document.querySelector("#markupPreview"),
  modalCopyButton: document.querySelector("#modalCopyButton"),
  modalCopyVisualButton: document.querySelector("#modalCopyVisualButton"),
  modalSaveMarkupButton: document.querySelector("#modalSaveMarkupButton"),
  importModal: document.querySelector("#importModal"),
  closeImportButton: document.querySelector("#closeImportButton"),
  importMarkup: document.querySelector("#importMarkup"),
  importWarning: document.querySelector("#importWarning"),
  applyImportButton: document.querySelector("#applyImportButton"),
  summaryTotal: document.querySelector("#summaryTotal"),
  summaryChart: document.querySelector("#summaryChart"),
  summaryList: document.querySelector("#summaryList"),
  saveState: document.querySelector("#saveState"),
  feedbackButton: document.querySelector("#feedbackButton"),
  toast: document.querySelector("#toast"),
  blockFormat: document.querySelector("#blockFormat"),
  linkButton: document.querySelector("#linkButton"),
  linkPopover: document.querySelector("#linkPopover"),
  linkPopoverTitle: document.querySelector("#linkPopoverTitle"),
  linkTextInput: document.querySelector("#linkTextInput"),
  linkUrlInput: document.querySelector("#linkUrlInput"),
  linkPopoverError: document.querySelector("#linkPopoverError"),
  closeLinkPopoverButton: document.querySelector("#closeLinkPopoverButton"),
  removeLinkButton: document.querySelector("#removeLinkButton"),
  applyLinkButton: document.querySelector("#applyLinkButton"),
  textColorInput: document.querySelector("#textColorInput"),
  textColorMenu: document.querySelector("#textColorMenu"),
  themeToggle: document.querySelector("#themeToggle"),
  settingsButton: document.querySelector("#settingsButton"),
  publishButton: document.querySelector("#publishButton"),
  jiraSettingsModal: document.querySelector("#jiraSettingsModal"),
  closeJiraSettingsButton: document.querySelector("#closeJiraSettingsButton"),
  settingsJiraSectionButton: document.querySelector("#settingsJiraSectionButton"),
  settingsHistorySectionButton: document.querySelector("#settingsHistorySectionButton"),
  settingsJiraSection: document.querySelector("#settingsJiraSection"),
  settingsHistorySection: document.querySelector("#settingsHistorySection"),
  settingsFooter: document.querySelector("#settingsFooter"),
  jiraConnections: document.querySelector("#jiraConnections"),
  saveJiraSettingsButton: document.querySelector("#saveJiraSettingsButton"),
  settingsSaveCheck: document.querySelector("#settingsSaveCheck"),
  cloudHistoryEnabled: document.querySelector("#cloudHistoryEnabled"),
  reportClientId: document.querySelector("#reportClientId"),
  reportWorkspaceKey: document.querySelector("#reportWorkspaceKey"),
  reportIdentityState: document.querySelector("#reportIdentityState"),
  undoButton: document.querySelector("#undoButton"),
  redoButton: document.querySelector("#redoButton"),
  historyButton: document.querySelector("#historyButton"),
  focusModeButton: document.querySelector("#focusModeButton"),
  jiraMenuButton: document.querySelector("#jiraMenuButton"),
  jiraMenu: document.querySelector("#jiraMenu"),
  copyMenuButton: document.querySelector("#copyMenuButton"),
  copyMenu: document.querySelector("#copyMenu"),
  focusExitButton: document.querySelector("#focusExitButton"),
  codeButton: document.querySelector("#codeButton"),
  imageButton: document.querySelector("#imageButton"),
  imageInput: document.querySelector("#imageInput"),
  commentImportUrl: document.querySelector("#commentImportUrl"),
  markupImportPane: document.querySelector("#markupImportPane"),
  commentImportPane: document.querySelector("#commentImportPane"),
  importSummary: document.querySelector("#importSummary"),
  historyModal: document.querySelector("#historyModal"),
  closeHistoryButton: document.querySelector("#closeHistoryButton"),
  historySearch: document.querySelector("#historySearch"),
  historyUsage: document.querySelector("#historyUsage"),
  historyList: document.querySelector("#historyList"),
  clearHistoryButton: document.querySelector("#clearHistoryButton"),
  saveHistorySnapshotButton: document.querySelector("#saveHistorySnapshotButton"),
  mediaViewerModal: document.querySelector("#mediaViewerModal"),
  mediaViewerImage: document.querySelector("#mediaViewerImage"),
  closeMediaViewerButton: document.querySelector("#closeMediaViewerButton"),
  codeEditorModal: document.querySelector("#codeEditorModal"),
  codeEditorTextarea: document.querySelector("#codeEditorTextarea"),
  codeEditorLineNumbers: document.querySelector("#codeEditorLineNumbers"),
  codeEditorLanguage: document.querySelector("#codeEditorLanguage"),
  codeEditorState: document.querySelector("#codeEditorState"),
  saveCodeButton: document.querySelector("#saveCodeButton"),
  closeCodeEditorButton: document.querySelector("#closeCodeEditorButton"),
  confirmModal: document.querySelector("#confirmModal"),
  confirmModalTitle: document.querySelector("#confirmModalTitle"),
  confirmModalMessage: document.querySelector("#confirmModalMessage"),
  closeConfirmButton: document.querySelector("#closeConfirmButton"),
  cancelConfirmButton: document.querySelector("#cancelConfirmButton"),
  acceptConfirmButton: document.querySelector("#acceptConfirmButton"),
  feedbackModal: document.querySelector("#feedbackModal"),
  closeFeedbackButton: document.querySelector("#closeFeedbackButton"),
  cancelFeedbackButton: document.querySelector("#cancelFeedbackButton"),
  draftSyncBanner: document.querySelector("#draftSyncBanner"),
  cloudConflictStatus: document.querySelector("#cloudConflictStatus"),
  versionConflictModal: document.querySelector("#versionConflictModal"),
  closeVersionConflictFooterButton: document.querySelector("#closeVersionConflictFooterButton"),
  localVersionPanel: document.querySelector("#localVersionPanel"),
  cloudVersionPanel: document.querySelector("#cloudVersionPanel"),
  localVersionSummary: document.querySelector("#localVersionSummary"),
  cloudVersionSummary: document.querySelector("#cloudVersionSummary"),
  localVersionPreview: document.querySelector("#localVersionPreview"),
  cloudVersionPreview: document.querySelector("#cloudVersionPreview"),
  selectLocalVersionButton: document.querySelector("#selectLocalVersionButton"),
  selectCloudVersionButton: document.querySelector("#selectCloudVersionButton"),
  saveBothVersionsButton: document.querySelector("#saveBothVersionsButton"),
  saveVersionChoiceButton: document.querySelector("#saveVersionChoiceButton"),
  versionCopyChoiceModal: document.querySelector("#versionCopyChoiceModal"),
  openLocalCopyButton: document.querySelector("#openLocalCopyButton"),
  openCloudCopyButton: document.querySelector("#openCloudCopyButton"),
};

const tabId = crypto.randomUUID();
const draftSyncChannel =
  typeof BroadcastChannel === "function" ? new BroadcastChannel(DRAFT_SYNC_CHANNEL) : null;
let draft = loadDraft();
let saveTimer;
let toastTimer;
let activeEditor = elements.introEditor;
let savedEditorRange = null;
let floatingMenu = null;
let cloudHistoryEnabled = loadCloudHistoryEnabled();
let objectStorageConfigured = false;
let reportClientId = loadReportClientId();
let reportWorkspaceKey = loadReportWorkspaceKey();
let serverReportHashes = loadServerReportHashes();
let dismissedCloudHashes = loadDismissedCloudHashes();
let undoStack = [];
let redoStack = [];
let historyCurrent = "";
let historyTimer;
let suppressHistory = false;
let importSource = "markup";
let pendingImportedDraft = null;
let dbPromise;
let draggedCodeBlock = null;
let draggedImageFigure = null;
let rowDragAutoScroll = null;
let pointerObjectGesture = null;
const suppressObjectOpenUntil = new WeakMap();
let editingCodeBlock = null;
let codeEditorInitialValue = "";
let stickyUpdateFrame = 0;
let linkEditorRange = null;
let editingLink = null;
let publishAbortController = null;
let publishInProgress = false;
let confirmResolver = null;
let hasUnsavedLocalChanges = false;
let applyingRemoteDraft = false;
let forceLocalDraftSave = false;
let pendingRemoteDraft = null;
let syncRecovery = null;
let versionConflictChoice = "";
let pendingCopyChoice = null;
let suppressNextServerSave = false;
const historyCommentTimers = new Map();

applyTheme(localStorage.getItem("qa-report-theme") || "light");
historyCurrent = serializeDraft();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createPublicId() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizePublicId(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-f0-9]/g, "").slice(0, 8);
}

function shortHashFromString(value) {
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 8);
}

function reportPublicId(report) {
  return (
    normalizePublicId(report?.publicId || report?.document?.publicId) ||
    shortHashFromString(report?.id || report?.document?.reportId || "")
  );
}

function isDefaultColumnTitle(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized || normalized === "новый столбец" || /^столбец \d+$/i.test(normalized);
}

function preserveKnownColumnMetadata(nextDraft, baseDraft = draft) {
  const next = normalizeDraft(nextDraft);
  const baseSections = new Map(normalizeDraft(baseDraft).sections.map((section) => [section.id, section]));
  next.sections.forEach((section) => {
    const baseSection = baseSections.get(section.id);
    if (!baseSection) return;
    const baseColumns = new Map(baseSection.columns.map((column) => [column.id, column]));
    section.columns.forEach((column) => {
      const baseColumn = baseColumns.get(column.id);
      if (!baseColumn) return;
      if (isDefaultColumnTitle(column.title) && !isDefaultColumnTitle(baseColumn.title)) {
        column.title = baseColumn.title;
      }
      ["name", "width", "required", "type"].forEach((key) => {
        if ((column[key] === undefined || column[key] === "" || column[key] === null) && baseColumn[key] !== undefined) {
          column[key] = baseColumn[key];
        }
      });
    });
  });
  return next;
}

function normalizeSections(sections) {
  return clone(sections).map((section, sectionIndex) => {
    const columns = (Array.isArray(section.columns) && section.columns.length ? section.columns : DEFAULT_COLUMNS).map(
      (column, columnIndex) => ({
        ...column,
        id: column.id || `column-${crypto.randomUUID()}`,
        title: String(column.title || column.name || "").trim() || `Столбец ${columnIndex + 1}`,
      }),
    );
    return {
      ...section,
      id: section.id || crypto.randomUUID(),
      title: String(section.title || "").trim() || `Раздел ${sectionIndex + 1}`,
      collapsed: Boolean(section.collapsed),
      columns,
      rows: (Array.isArray(section.rows) && section.rows.length ? section.rows : [createRow(columns)]).map((row) => {
        const cells = { ...(row.cells || {}) };
        columns.forEach((column) => {
          if (!Object.hasOwn(cells, column.id)) cells[column.id] = "";
        });
        return {
          ...row,
          id: row.id || crypto.randomUUID(),
          status: row.status || "НЕ ПРОВЕРЕНО",
          cells,
        };
      }),
    };
  });
}

function normalizeDraft(value) {
  const base = clone(DEFAULT_DRAFT);
  const parsed = value && typeof value === "object" ? value : {};
  const publicId = normalizePublicId(parsed.publicId) || createPublicId();
  const sections =
    Array.isArray(parsed.sections) && parsed.sections.length
      ? normalizeSections(parsed.sections)
      : normalizeSections(base.sections);
  const normalized = {
    ...base,
    ...parsed,
    draftId: parsed.draftId || parsed.reportId || crypto.randomUUID(),
    reportId: parsed.reportId || crypto.randomUUID(),
    publicId,
    schemaVersion: 3,
    revision: Number(parsed.revision) || 0,
    updatedAt: parsed.updatedAt || new Date(0).toISOString(),
    lastSavedBy: parsed.lastSavedBy || "",
    lastSavedClientId: parsed.lastSavedClientId || "",
    issueUrl: parsed.issueUrl || "",
    sections,
  };
  normalized.intro = sanitizeRichHtml(normalized.intro);
  normalized.sections.forEach((section) => {
    section.rows.forEach((row) => {
      Object.keys(row.cells || {}).forEach((columnId) => {
        row.cells[columnId] = sanitizeRichHtml(row.cells[columnId]);
      });
    });
  });
  return normalized;
}

function sanitizeRichHtml(value) {
  const template = document.createElement("template");
  template.innerHTML = String(value || "");
  const allowedTags = new Set([
    "A", "BR", "CODE", "DIV", "EM", "FIGURE", "H1", "H2", "H3", "IMG", "LI",
    "OL", "P", "PRE", "S", "SPAN", "STRONG", "U", "UL",
  ]);
  const allowedAttributes = new Set([
    "alt", "class", "contenteditable", "data-align", "data-attachment-id", "data-file-extension",
    "data-file-name", "data-file-size", "data-jira-id", "data-jira-name", "data-jira-thumbnail",
    "data-jira-url", "data-language", "data-mime-type", "data-qa-code-snippet", "data-data-url",
    "href", "rel", "src", "style", "target", "title",
  ]);
  const safeUrl = (raw, { image = false, fileData = false } = {}) => {
    const text = String(raw || "").trim();
    if (image && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(text)) return text;
    if (fileData && /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i.test(text)) return text;
    try {
      const url = new URL(text, window.location.origin);
      return ["http:", "https:"].includes(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  };
  template.content.querySelectorAll("*").forEach((node) => {
    if (!allowedTags.has(node.tagName)) {
      node.replaceWith(...node.childNodes);
      return;
    }
    [...node.attributes].forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || !allowedAttributes.has(name)) node.removeAttribute(attribute.name);
    });
    if (node.hasAttribute("href")) {
      const href = safeUrl(node.getAttribute("href"));
      if (!href) node.removeAttribute("href");
      else {
        node.setAttribute("href", href);
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      }
    }
    if (node.hasAttribute("src")) {
      const src = safeUrl(node.getAttribute("src"), { image: node.tagName === "IMG" });
      if (!src) node.removeAttribute("src");
      else node.setAttribute("src", src);
    }
    if (node.hasAttribute("data-data-url")) {
      const dataUrl = safeUrl(node.getAttribute("data-data-url"), { fileData: true });
      if (!dataUrl) node.removeAttribute("data-data-url");
    }
    if (node.hasAttribute("style")) {
      const color = node.style.color;
      const width = node.style.width;
      node.removeAttribute("style");
      if (color && /^(?:#[0-9a-f]{3,8}|rgb\([\d\s,.%]+\)|rgba\([\d\s,.%]+\))$/i.test(color)) node.style.color = color;
      if (width && /^(?:100|[1-9]?\d(?:\.\d+)?)%$/.test(width)) node.style.width = width;
    }
  });
  return template.innerHTML;
}

function draftContentSnapshot(value = draft) {
  const copy = clone(value);
  delete copy.revision;
  delete copy.updatedAt;
  delete copy.lastSavedBy;
  delete copy.lastSavedClientId;
  delete copy.tabId;
  delete copy.clientId;
  delete copy.browserId;
  delete copy.selectedCell;
  delete copy.focus;
  delete copy.scroll;
  delete copy.syncTimestamps;
  return copy;
}

function stripServerAttachmentsFromHtml(value) {
  if (!value || typeof value !== "string") return value || "";
  const template = document.createElement("template");
  template.innerHTML = value;
  template.content.querySelectorAll(".cell-image").forEach((figure) => {
    if (figure.querySelector("img")?.getAttribute("src")?.startsWith("data:")) figure.remove();
  });
  template.content.querySelectorAll(".cell-file").forEach((card) => {
    if (card.dataset.dataUrl?.startsWith("data:")) card.remove();
  });
  template.content.querySelectorAll("img, video, audio, source").forEach((node) => {
    if (node.getAttribute("src")?.startsWith("data:")) node.remove();
  });
  template.content.querySelectorAll("*").forEach((node) => {
    [...node.attributes].forEach((attribute) => {
      if (/^data:/i.test(attribute.value)) node.removeAttribute(attribute.name);
    });
  });
  return template.innerHTML;
}

function serverTextOnlyDocument(value = draft) {
  const copy = clone(value);
  copy.intro = stripServerAttachmentsFromHtml(copy.intro);
  copy.sections?.forEach((section) => {
    section.rows?.forEach((row) => {
      Object.keys(row.cells || {}).forEach((columnId) => {
        row.cells[columnId] = stripServerAttachmentsFromHtml(row.cells[columnId]);
      });
    });
  });
  return copy;
}

function serverTextOnlyDraftSnapshot(value = draft) {
  return draftContentSnapshot(serverTextOnlyDocument(value));
}

function createServerReportDocument(value = draft) {
  return normalizeDraft(serverTextOnlyDocument(value));
}

function draftContentHash(value = draft) {
  return JSON.stringify(serverTextOnlyDraftSnapshot(value));
}

function hasMeaningfulContentDiff(left, right) {
  return draftContentHash(left) !== draftContentHash(right);
}

function isNewerDraft(candidate, current = draft) {
  if (!candidate) return false;
  if (!current) return true;
  const candidateRevision = Number(candidate.revision) || 0;
  const currentRevision = Number(current.revision) || 0;
  if (candidate.draftId && current.draftId && candidate.draftId === current.draftId) {
    if (candidateRevision !== currentRevision) return candidateRevision > currentRevision;
  }
  const candidateTime = Date.parse(candidate.updatedAt || "") || 0;
  const currentTime = Date.parse(current.updatedAt || "") || 0;
  return candidateTime > currentTime;
}

function isSameDraftLineage(candidate, current = draft) {
  if (!candidate || !current) return false;
  if (candidate.draftId && current.draftId) return candidate.draftId === current.draftId;
  if (candidate.reportId && current.reportId) return candidate.reportId === current.reportId;
  return false;
}

function isSavedByThisBrowser(candidate) {
  return Boolean(candidate?.lastSavedClientId && candidate.lastSavedClientId === reportClientId);
}

function setSaveStatus(status, { saving = false } = {}) {
  elements.saveState.classList.toggle("saving", saving);
  elements.saveState.querySelector("span:last-child").textContent = status;
}

function loadDraft() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return normalizeDraft(DEFAULT_DRAFT);
    return normalizeDraft(JSON.parse(saved));
  } catch {
    return normalizeDraft(DEFAULT_DRAFT);
  }
}

function loadCloudHistoryEnabled() {
  try {
    return localStorage.getItem(CLOUD_HISTORY_ENABLED_KEY) === "true";
  } catch {
    return false;
  }
}

function loadReportClientId() {
  try {
    const saved = localStorage.getItem(CLIENT_ID_KEY);
    if (saved) return saved;
    const created = crypto.randomUUID();
    localStorage.setItem(CLIENT_ID_KEY, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

function loadReportWorkspaceKey() {
  try {
    return localStorage.getItem(WORKSPACE_KEY_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function loadServerReportHashes() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SERVER_HASHES_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function loadDismissedCloudHashes() {
  try {
    const parsed = JSON.parse(localStorage.getItem(DISMISSED_CLOUD_HASHES_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveServerReportHashes() {
  try {
    localStorage.setItem(SERVER_HASHES_KEY, JSON.stringify(serverReportHashes));
  } catch {
    // Hash-кэш нужен только для оптимистичной синхронизации. Если localStorage недоступен, сервер всё равно защитит от перезаписи.
  }
}

function saveDismissedCloudHashes() {
  try {
    localStorage.setItem(DISMISSED_CLOUD_HASHES_KEY, JSON.stringify(dismissedCloudHashes));
  } catch {
    // Dismissed hash влияет только на повторный показ уведомления.
  }
}

function dismissCloudHash(reportId, contentHash) {
  if (!reportId || !contentHash) return;
  dismissedCloudHashes[reportId] = contentHash;
  saveDismissedCloudHashes();
}

function clearDismissedCloudHash(reportId) {
  if (!reportId || !dismissedCloudHashes[reportId]) return;
  delete dismissedCloudHashes[reportId];
  saveDismissedCloudHashes();
}

function isCloudHashDismissed(reportId, contentHash) {
  return Boolean(reportId && contentHash && dismissedCloudHashes[reportId] === contentHash);
}

function setKnownServerHash(reportId, contentHash) {
  if (!reportId || !contentHash) return;
  serverReportHashes[reportId] = contentHash;
  saveServerReportHashes();
}

function forgetKnownServerHash(reportId) {
  if (!reportId || !serverReportHashes[reportId]) return;
  delete serverReportHashes[reportId];
  saveServerReportHashes();
}

function reportIdentityHeaders() {
  return {
    "X-QA-Report-Client": reportClientId,
    "X-QA-Report-Workspace": reportWorkspaceKey.trim(),
  };
}

async function reportApi(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...reportIdentityHeaders(),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(REPORT_STORE)) {
        const store = db.createObjectStore(REPORT_STORE, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function dbTransaction(mode, action) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(REPORT_STORE, mode);
    const store = transaction.objectStore(REPORT_STORE);
    let result;
    try {
      result = action(store);
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve(result?.result);
    transaction.onerror = () => reject(transaction.error);
  });
}

function issueKeyFromUrl(value) {
  try {
    return new URL(value).pathname.match(/\/browse\/([A-Z][A-Z0-9_]*-\d+)/i)?.[1]?.toUpperCase() || "";
  } catch {
    return "";
  }
}

async function saveReportSnapshot(reason = "manual") {
  flushDraftFromDom();
  const now = new Date().toISOString();
  const existing = await getReportRecord(draft.reportId);
  const issueKey = issueKeyFromUrl(draft.issueUrl);
  const record = {
    id: draft.reportId,
    publicId: draft.publicId,
    title: `${issueKey || "Без задачи"} — ${draft.environment}`,
    issueUrl: draft.issueUrl,
    issueKey,
    environment: draft.environment,
    overallStatus: draft.overallStatus,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastOpenedAt: now,
    reason,
    historyComment: existing?.historyComment || "",
    document: clone(draft),
    schemaVersion: 3,
  };
  await dbTransaction("readwrite", (store) => store.put(record));
  if (suppressNextServerSave) {
    suppressNextServerSave = false;
  } else {
    queueServerReportSave(record);
  }
  await trimReportHistory();
  return record;
}

function queueServerReportSave(record) {
  if (!cloudHistoryEnabled) return;
  saveReportToServer(record)
    .then((result) => {
      if (result.report?.contentHash) {
        setKnownServerHash(record.id, result.report.contentHash);
        clearDismissedCloudHash(record.id);
      }
      if (result.report?.publicId && draft.reportId === record.id) {
        draft.publicId = result.report.publicId;
        updateChecklistUrl();
      }
    })
    .catch((error) => {
      if (error.status === 409) {
        const serverReport = error.payload?.report;
        const serverHash = serverReport?.contentHash;
        if (serverReport?.document) {
          if (isSavedByThisBrowser(serverReport.document)) {
            if (!hasUnsavedLocalChanges && serializeDraft() === historyCurrent) {
              if (serverHash) setKnownServerHash(record.id, serverHash);
              applyDraftLocally(serverReport.document, { status: "Сохранено" });
            }
            return;
          }
          if (!isCloudHashDismissed(record.id, serverHash)) {
            showSyncRecovery({
              localDraft: record.document,
              serverDraft: serverReport.document,
              serverHash,
            });
          }
          hideDraftSyncBanner();
        }
        setSaveStatus("Локально сохранено");
        if (!isCloudHashDismissed(record.id, serverHash)) {
          showToast("Облачная версия изменилась. Локальная копия сохранена, облако не перезаписано.", 9000);
        }
      }
      // Серверная история дополняет локальную. Если сервер недоступен, редактор продолжает работать.
    });
}

async function uploadStoragePayload(reportId, file) {
  const response = await fetch("/api/storage/upload", {
    method: "POST",
    headers: { ...reportIdentityHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ reportId, file }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

async function migrateHtmlAttachmentsToStorage(html, reportId) {
  const container = document.createElement("div");
  container.innerHTML = html || "";
  for (const image of container.querySelectorAll("img[data-attachment-id]")) {
    if (!image.src.startsWith("data:")) continue;
    const [header, dataBase64 = ""] = image.src.split(",");
    if (!dataBase64) continue;
    const type = image.dataset.mimeType || header.match(/^data:([^;]+)/)?.[1] || "image/png";
    const result = await uploadStoragePayload(reportId, {
      name: image.dataset.fileName || `image.${type.split("/")[1]?.replace("jpeg", "jpg") || "png"}`,
      type,
      dataBase64,
    });
    image.src = result.url;
    image.dataset.storageKey = result.key;
  }
  for (const card of container.querySelectorAll(".cell-file[data-attachment-id]")) {
    const dataUrl = card.dataset.dataUrl || "";
    if (!dataUrl.startsWith("data:")) continue;
    const [header, dataBase64 = ""] = dataUrl.split(",");
    if (!dataBase64) continue;
    const result = await uploadStoragePayload(reportId, {
      name: card.dataset.fileName || "file",
      type: card.dataset.mimeType || header.match(/^data:([^;]+)/)?.[1] || "application/octet-stream",
      dataBase64,
    });
    card.dataset.dataUrl = result.url;
    card.dataset.storageKey = result.key;
  }
  return sanitizeRichHtml(container.innerHTML);
}

async function migrateDocumentAttachmentsToStorage(document, reportId) {
  const copy = normalizeDraft(clone(document));
  copy.intro = await migrateHtmlAttachmentsToStorage(copy.intro, reportId);
  for (const section of copy.sections) {
    for (const row of section.rows) {
      for (const columnId of Object.keys(row.cells || {})) {
        row.cells[columnId] = await migrateHtmlAttachmentsToStorage(row.cells[columnId], reportId);
      }
    }
  }
  return copy;
}

function isStoredObjectUrl(value) {
  try {
    return new URL(String(value || ""), window.location.origin).pathname.startsWith("/api/storage/object/");
  } catch {
    return false;
  }
}

function applyStorageReferences(sourceDocument) {
  const references = new Map();
  const collect = (html) => {
    const container = document.createElement("div");
    container.innerHTML = html || "";
    container.querySelectorAll("img[data-attachment-id]").forEach((image) => {
      if (isStoredObjectUrl(image.src)) references.set(image.dataset.attachmentId, { kind: "image", url: image.src });
    });
    container.querySelectorAll(".cell-file[data-attachment-id]").forEach((card) => {
      if (isStoredObjectUrl(card.dataset.dataUrl)) references.set(card.dataset.attachmentId, { kind: "file", url: card.dataset.dataUrl });
    });
  };
  collect(sourceDocument.intro);
  sourceDocument.sections.forEach((section) => section.rows.forEach((row) => Object.values(row.cells).forEach(collect)));
  const updateRoot = (root) => {
    root.querySelectorAll("img[data-attachment-id]").forEach((image) => {
      const reference = references.get(image.dataset.attachmentId);
      if (reference?.kind === "image") image.src = reference.url;
    });
    root.querySelectorAll(".cell-file[data-attachment-id]").forEach((card) => {
      const reference = references.get(card.dataset.attachmentId);
      if (reference?.kind === "file") card.dataset.dataUrl = reference.url;
    });
  };
  const updateHtml = (html) => {
    const container = document.createElement("div");
    container.innerHTML = html || "";
    updateRoot(container);
    return sanitizeRichHtml(container.innerHTML);
  };
  draft.intro = updateHtml(draft.intro);
  draft.sections.forEach((section) => section.rows.forEach((row) => {
    Object.keys(row.cells).forEach((columnId) => { row.cells[columnId] = updateHtml(row.cells[columnId]); });
  }));
  updateRoot(elements.introEditor);
  updateRoot(elements.sections);
  enhanceImageControls(elements.introEditor);
  enhanceImageControls(elements.sections);
  enhanceFileControls(elements.introEditor);
  enhanceFileControls(elements.sections);
}

async function saveReportToServer(record, { force = false } = {}) {
  const backend = await checkBackendCompatibility();
  const documentForCloud = backend.objectStorageConfigured
    ? await migrateDocumentAttachmentsToStorage(record.document, record.id)
    : record.document;
  const serverDocument = createServerReportDocument(documentForCloud);
  const result = await reportApi("/api/reports", {
    method: "POST",
    body: JSON.stringify({
      id: record.id,
      publicId: record.publicId,
      title: record.title,
      issueUrl: record.issueUrl,
      issueKey: record.issueKey,
      environment: record.environment,
      overallStatus: record.overallStatus,
      schemaVersion: record.schemaVersion,
      createdAt: record.createdAt,
      reason: record.reason,
      historyComment: record.historyComment || "",
      baseContentHash: serverReportHashes[record.id] || "",
      force,
      document: serverDocument,
    }),
  });
  if (backend.objectStorageConfigured && draft.reportId === record.id) {
    applyStorageReferences(documentForCloud);
    collectDocumentFields();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(draft)); } catch {}
    const localRecord = await getReportRecord(record.id);
    if (localRecord) await dbTransaction("readwrite", (store) => store.put({ ...localRecord, document: clone(draft) }));
  }
  return result;
}

async function getReportRecord(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(REPORT_STORE, "readonly").objectStore(REPORT_STORE).get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getAllReports() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(REPORT_STORE, "readwrite");
    const store = transaction.objectStore(REPORT_STORE);
    const request = store.getAll();
    let reports = [];
    request.onsuccess = () => {
      reports = (request.result || []).map((report) => {
        const publicId = normalizePublicId(report.publicId || report.document?.publicId) || createPublicId();
        if (report.publicId !== publicId || report.document?.publicId !== publicId) {
          report.publicId = publicId;
          if (report.document) report.document.publicId = publicId;
          store.put(report);
        }
        return report;
      });
    };
    transaction.oncomplete = () => resolve(reports.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    transaction.onerror = () => reject(transaction.error);
    request.onerror = () => reject(request.error);
  });
}

async function getServerReports() {
  if (!cloudHistoryEnabled) return [];
  try {
    const result = await reportApi("/api/reports");
    return (result.reports || []).map((report) => ({ ...report, source: "server" }));
  } catch {
    return [];
  }
}

async function getServerReport(id, { rememberHash = true } = {}) {
  if (!cloudHistoryEnabled) return null;
  const result = await reportApi(`/api/reports/${encodeURIComponent(id)}`);
  if (rememberHash && result.report?.contentHash) setKnownServerHash(result.report.id, result.report.contentHash);
  return result.report || null;
}

function routeChecklistPublicId() {
  const pathMatch = window.location.pathname.match(/^\/report\/([a-f0-9]{7,8})$/i);
  const hashMatch = window.location.hash.match(/^#\/checklists\/([a-f0-9]{7,8})$/i);
  return normalizePublicId(pathMatch?.[1] || hashMatch?.[1] || "");
}

function updateChecklistUrl(publicId = draft.publicId, { replace = true } = {}) {
  const normalized = normalizePublicId(publicId);
  if (!normalized) return;
  const next = `/report/${normalized}`;
  if (window.location.pathname === next && !window.location.search && !window.location.hash) return;
  if (replace) window.history.replaceState({}, "", next);
  else window.history.pushState({}, "", next);
}

async function findLocalReportByPublicId(publicId) {
  const reports = await getAllReports().catch(() => []);
  return reports.find((report) => normalizePublicId(report.publicId || report.document?.publicId) === publicId) || null;
}

async function openReportFromRoute() {
  const publicId = routeChecklistPublicId();
  if (!publicId) {
    updateChecklistUrl(draft.publicId);
    return;
  }
  // Черновик из localStorage загружается синхронно до IndexedDB. При быстром
  // обновлении страницы запись истории могла ещё не успеть сохраниться, но
  // совпадающий publicId уже однозначно указывает на открытый чек-лист.
  if (normalizePublicId(draft.publicId) === publicId) return;
  try {
    const localReport = await findLocalReportByPublicId(publicId);
    const fullReport = localReport || (cloudHistoryEnabled ? await getServerReport(publicId) : null);
    if (!fullReport?.document) throw new Error("not-found");
    applyDraftLocally(fullReport.document, { status: "Сохранено" });
  } catch {
    showToast("Чек-лист по ссылке не найден. Можно создать новый.");
  }
}

async function getAllHistoryReports() {
  const [serverReports, localReports] = await Promise.all([
    getServerReports(),
    getAllReports().catch(() => []),
  ]);
  const seen = new Set(serverReports.map((report) => report.id));
  return [
    ...serverReports,
    ...localReports
      .filter((report) => !seen.has(report.id))
      .map((report) => ({ ...report, source: "local" })),
  ].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

async function getFreshestStoredDraft() {
  const candidates = [];
  const stored = readStoredDraft();
  if (stored && isSameDraftLineage(stored)) candidates.push(stored);
  try {
    const currentReport = await getReportRecord(draft.reportId);
    if (currentReport?.document) {
      const reportDraft = normalizeDraft(currentReport.document);
      if (isSameDraftLineage(reportDraft)) candidates.push(reportDraft);
    }
  } catch {
    // IndexedDB может быть недоступна в приватном режиме; localStorage остаётся основным источником.
  }
  return candidates.reduce((freshest, item) => (isNewerDraft(item, freshest) ? item : freshest), null);
}

async function deleteReportRecord(id) {
  await dbTransaction("readwrite", (store) => store.delete(id));
}

async function deleteServerReport(id) {
  if (!cloudHistoryEnabled) return;
  await reportApi(`/api/reports/${encodeURIComponent(id)}`, { method: "DELETE" });
  forgetKnownServerHash(id);
}

async function updateLocalReportComment(id, historyComment) {
  const record = await getReportRecord(id);
  if (!record) return;
  record.historyComment = String(historyComment || "").slice(0, 1000);
  await dbTransaction("readwrite", (store) => store.put(record));
}

async function updateServerReportComment(id, historyComment) {
  if (!cloudHistoryEnabled) return;
  await reportApi(`/api/reports/${encodeURIComponent(id)}/comment`, {
    method: "PATCH",
    body: JSON.stringify({ historyComment }),
  });
}

async function clearServerReports() {
  if (!cloudHistoryEnabled) return;
  await reportApi("/api/reports", { method: "DELETE" });
  serverReportHashes = {};
  saveServerReportHashes();
}

async function trimReportHistory() {
  const reports = await getAllReports();
  for (const report of reports.slice(HISTORY_LIMIT)) await deleteReportRecord(report.id);
}

async function clearReportHistory() {
  await dbTransaction("readwrite", (store) => store.clear());
}

async function saveDraft() {
  flushDraftFromDom();
  if (!applyingRemoteDraft && !forceLocalDraftSave) {
    const stored = await getFreshestStoredDraft();
    if (stored && isNewerDraft(stored)) {
      if (hasUnsavedLocalChanges || serializeDraft() !== historyCurrent) {
        if (isSavedByThisBrowser(stored)) {
          applyRemoteDraft(stored);
          return false;
        }
        if (cloudHistoryEnabled) {
          showSyncRecovery({
            localDraft: draft,
            serverDraft: stored,
            serverHash: "",
          });
          setSaveStatus("Есть облачная версия");
          return false;
        }
      } else {
        applyRemoteDraft(stored);
        return false;
      }
    }
  }
  if (!applyingRemoteDraft) {
    draft = normalizeDraft(draft);
    draft.revision = (Number(draft.revision) || 0) + 1;
    draft.updatedAt = new Date().toISOString();
    draft.lastSavedBy = tabId;
    draft.lastSavedClientId = reportClientId;
  }
  let localStorageSaved = true;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // Большие отчёты с изображениями продолжают сохраняться в IndexedDB.
    localStorageSaved = false;
  }
  hasUnsavedLocalChanges = false;
  setSaveStatus("Сохранено");
  saveReportSnapshot("autosave").catch(() => {
    if (!localStorageSaved) setSaveStatus("Ошибка сохранения");
  });
  if (!applyingRemoteDraft) broadcastDraftUpdate();
  forceLocalDraftSave = false;
  return true;
}

function flushPendingDraftSave() {
  clearTimeout(saveTimer);
  flushDraftFromDom();
  if (!applyingRemoteDraft) {
    const stored = readStoredDraft();
    if (stored && isNewerDraft(stored) && (hasUnsavedLocalChanges || serializeDraft() !== historyCurrent)) {
      if (isSavedByThisBrowser(stored)) {
        applyRemoteDraft(stored);
        return false;
      }
      if (cloudHistoryEnabled) {
        showSyncRecovery({
          localDraft: draft,
          serverDraft: stored,
          serverHash: "",
        });
        setSaveStatus("Есть облачная версия");
        return false;
      }
    }
    draft = normalizeDraft(draft);
    draft.revision = (Number(draft.revision) || 0) + 1;
    draft.updatedAt = new Date().toISOString();
    draft.lastSavedBy = tabId;
    draft.lastSavedClientId = reportClientId;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
    hasUnsavedLocalChanges = false;
    setSaveStatus("Сохранено");
    if (!applyingRemoteDraft) broadcastDraftUpdate();
    saveReportSnapshot("autosave").catch(() => {});
    return true;
  } catch {
    setSaveStatus("Ошибка сохранения");
    saveReportSnapshot("autosave").catch(() => {});
    return false;
  }
}

function broadcastDraftUpdate() {
  draftSyncChannel?.postMessage({
    type: "draft-updated",
    storageKey: STORAGE_KEY,
    draft: clone(draft),
    draftId: draft.draftId,
    revision: draft.revision,
    updatedAt: draft.updatedAt,
    tabId,
  });
}

function readStoredDraft() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? normalizeDraft(JSON.parse(saved)) : null;
  } catch {
    return null;
  }
}

function hideDraftSyncBanner() {
  pendingRemoteDraft = null;
  if (elements.draftSyncBanner) elements.draftSyncBanner.hidden = true;
}

function showSyncRecovery({ localDraft, serverDraft, serverHash }) {
  if (!localDraft || !serverDraft) return;
  const safeServerDraft = preserveKnownColumnMetadata(serverDraft, localDraft);
  if (!hasMeaningfulContentDiff(localDraft, safeServerDraft)) {
    if (serverHash) setKnownServerHash(draft.reportId, serverHash);
    hideSyncRecovery();
    return;
  }
  syncRecovery = {
    localDraft: normalizeDraft(localDraft),
    serverDraft: safeServerDraft,
    serverHash: serverHash || serverReportHashes[draft.reportId] || "",
  };
  updateCloudConflictStatus();
  if (!elements.versionConflictModal.hidden) renderVersionConflictModal();
}

function updateCloudConflictStatus() {
  elements.cloudConflictStatus.hidden = !syncRecovery;
}

function hideSyncRecovery() {
  syncRecovery = null;
  updateCloudConflictStatus();
  closeVersionConflictModal();
}

function formatVersionTime(value) {
  const timestamp = Date.parse(value || "");
  if (!timestamp) return "нет данных";
  return new Date(timestamp).toLocaleString("ru-RU");
}

function countDraftAttachments(value) {
  const draftValue = normalizeDraft(value);
  let count = 0;
  const countInHtml = (html) => {
    if (!html) return;
    count += (String(html).match(/<figure\b[^>]*class="[^"]*\bcell-image\b/gi) || []).length;
    count += (String(html).match(/<span\b[^>]*class="[^"]*\bcell-file\b/gi) || []).length;
  };
  countInHtml(draftValue.intro);
  draftValue.sections.forEach((section) => {
    section.rows.forEach((row) => Object.values(row.cells || {}).forEach(countInHtml));
  });
  return count;
}

function getDraftStats(value) {
  const draftValue = normalizeDraft(value);
  return {
    updatedAt: formatVersionTime(draftValue.updatedAt),
    revision: Number(draftValue.revision) || 0,
    sections: draftValue.sections.length,
    rows: draftValue.sections.reduce((sum, section) => sum + section.rows.length, 0),
    attachments: countDraftAttachments(draftValue),
  };
}

function renderVersionSummary(target, stats) {
  target.innerHTML = [
    ["Изменена", stats.updatedAt],
    ["Revision", stats.revision],
    ["Разделы", stats.sections],
    ["Строки", stats.rows],
    ["Вложения", stats.attachments],
  ]
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd></div>`)
    .join("");
}

function cellText(value) {
  return htmlToText(value || "").replace(/\s+/g, " ").trim();
}

function getVersionDiffItems(localDraft, cloudDraft) {
  const local = normalizeDraft(localDraft);
  const cloud = normalizeDraft(cloudDraft);
  const items = [];
  if ((local.issueUrl || "") !== (cloud.issueUrl || "")) items.push("Отличается ссылка на задачу.");
  if ((local.environment || "") !== (cloud.environment || "")) items.push("Отличается окружение.");
  if ((local.overallStatus || "") !== (cloud.overallStatus || "")) items.push("Отличается итоговый статус.");
  if (cellText(local.intro) !== cellText(cloud.intro)) items.push("Отличается вводный текст.");
  if (local.sections.length !== cloud.sections.length) {
    items.push(`Количество разделов: локально ${local.sections.length}, в облаке ${cloud.sections.length}.`);
  }
  const sectionCount = Math.max(local.sections.length, cloud.sections.length);
  for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
    const localSection = local.sections[sectionIndex];
    const cloudSection = cloud.sections[sectionIndex];
    if (!localSection || !cloudSection) continue;
    const sectionName = localSection.title || cloudSection.title || `Раздел ${sectionIndex + 1}`;
    if ((localSection.title || "") !== (cloudSection.title || "")) {
      items.push(`Раздел ${sectionIndex + 1}: отличается название.`);
    }
    if (localSection.rows.length !== cloudSection.rows.length) {
      items.push(
        `${sectionName}: строк локально ${localSection.rows.length}, в облаке ${cloudSection.rows.length}.`,
      );
    }
    const rowCount = Math.max(localSection.rows.length, cloudSection.rows.length);
    let changedRows = 0;
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const localRow = localSection.rows[rowIndex];
      const cloudRow = cloudSection.rows[rowIndex];
      if (!localRow || !cloudRow) {
        changedRows += 1;
        continue;
      }
      const localRowSnapshot = JSON.stringify({
        status: localRow.status,
        cells: Object.fromEntries(Object.entries(localRow.cells || {}).map(([key, value]) => [key, cellText(value)])),
      });
      const cloudRowSnapshot = JSON.stringify({
        status: cloudRow.status,
        cells: Object.fromEntries(Object.entries(cloudRow.cells || {}).map(([key, value]) => [key, cellText(value)])),
      });
      if (localRowSnapshot !== cloudRowSnapshot) changedRows += 1;
    }
    if (changedRows) items.push(`${sectionName}: отличается строк ${changedRows}.`);
  }
  return items.slice(0, 8);
}

function renderVersionConflictModal() {
  if (!syncRecovery) return;
  collectDocumentFields();
  syncRecovery.localDraft = normalizeDraft(draft);
  if (!hasMeaningfulContentDiff(syncRecovery.localDraft, syncRecovery.serverDraft)) {
    elements.localVersionSummary.innerHTML = "<div><dt>Статус</dt><dd>Отличий не найдено</dd></div>";
    elements.cloudVersionSummary.innerHTML = "<div><dt>Статус</dt><dd>Отличий не найдено</dd></div>";
    elements.localVersionPreview.innerHTML = '<div class="history-empty">Отличий не найдено</div>';
    elements.cloudVersionPreview.innerHTML = '<div class="history-empty">Отличий не найдено</div>';
    versionConflictChoice = "";
    updateVersionConflictSelection();
    return;
  }
  versionConflictChoice = "";
  renderVersionSummary(elements.localVersionSummary, getDraftStats(syncRecovery.localDraft));
  renderVersionSummary(elements.cloudVersionSummary, getDraftStats(syncRecovery.serverDraft));
  elements.localVersionPreview.innerHTML = generateVisualPreview(syncRecovery.localDraft, syncRecovery.serverDraft);
  elements.cloudVersionPreview.innerHTML = generateVisualPreview(syncRecovery.serverDraft, syncRecovery.localDraft);
  updateVersionConflictSelection();
}

function setVersionConflictChoice(choice) {
  if (!syncRecovery) return;
  versionConflictChoice = choice;
  updateVersionConflictSelection();
}

function updateVersionConflictSelection() {
  const localSelected = versionConflictChoice === "local" || versionConflictChoice === "both";
  const cloudSelected = versionConflictChoice === "cloud" || versionConflictChoice === "both";
  elements.localVersionPanel.classList.toggle("selected", localSelected);
  elements.cloudVersionPanel.classList.toggle("selected", cloudSelected);
  elements.selectLocalVersionButton.classList.toggle("active", versionConflictChoice === "local");
  elements.selectCloudVersionButton.classList.toggle("active", versionConflictChoice === "cloud");
  elements.saveBothVersionsButton.classList.toggle("active", versionConflictChoice === "both");
  elements.saveVersionChoiceButton.disabled = !versionConflictChoice;
}

function openVersionConflictModal() {
  if (!syncRecovery) return;
  renderVersionConflictModal();
  elements.versionConflictModal.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeVersionConflictModal() {
  elements.versionConflictModal.hidden = true;
  if (
    elements.previewModal.hidden &&
    elements.importModal.hidden &&
    elements.historyModal.hidden &&
    elements.mediaViewerModal.hidden &&
    elements.codeEditorModal.hidden &&
    elements.confirmModal.hidden &&
    elements.feedbackModal.hidden &&
    elements.jiraSettingsModal.hidden &&
    elements.versionCopyChoiceModal.hidden
  ) {
    document.body.style.overflow = "";
  }
}

function closeVersionCopyChoiceModal() {
  elements.versionCopyChoiceModal.hidden = true;
  pendingCopyChoice = null;
  if (elements.versionConflictModal.hidden) document.body.style.overflow = "";
}

function applyDraftLocally(nextDraft, { status = "Сохранено" } = {}) {
  const normalized = normalizeDraft(nextDraft);
  applyingRemoteDraft = true;
  clearTimeout(saveTimer);
  clearTimeout(historyTimer);
  draft = normalized;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // Если draft слишком большой для localStorage, актуальная копия остаётся в IndexedDB.
  }
  historyCurrent = serializeDraft();
  hasUnsavedLocalChanges = false;
  undoStack = [];
  redoStack = [];
  render();
  updateChecklistUrl(draft.publicId);
  updateHistoryButtons();
  setSaveStatus(status);
  hideDraftSyncBanner();
  applyingRemoteDraft = false;
}

function applyRemoteDraft(remoteDraft) {
  applyDraftLocally(remoteDraft);
}

function applyServerReport(report, { silent = false, keepRecovery = true } = {}) {
  const localDraft = clone(draft);
  if (report?.contentHash) setKnownServerHash(report.id, report.contentHash);
  applyDraftLocally(report.document);
  if (keepRecovery) {
    showSyncRecovery({
      localDraft,
      serverDraft: report.document,
      serverHash: report.contentHash || "",
    });
  }
  if (!silent) showToast("Подтянута свежая облачная версия");
}

function keepCurrentDraft() {
  if (pendingRemoteDraft) {
    draft.revision = Math.max(Number(draft.revision) || 0, Number(pendingRemoteDraft.revision) || 0);
  }
  flushDraftFromDom();
  hideDraftSyncBanner();
  forceLocalDraftSave = true;
  saveDraft();
}

function applyCloudVersionFromRecovery() {
  if (!syncRecovery) return;
  const { serverDraft, serverHash } = syncRecovery;
  const reportId = serverDraft.reportId || draft.reportId;
  if (serverHash) {
    setKnownServerHash(reportId, serverHash);
    clearDismissedCloudHash(reportId);
  }
  applyDraftLocally(serverDraft, { status: "Сохранено" });
  hideSyncRecovery();
  suppressNextServerSave = true;
  saveReportSnapshot("cloud-sync").catch(() => {});
  showToast("Облачная версия подтянута");
}

function keepLocalVersionFromRecovery() {
  if (!syncRecovery) return;
  dismissCloudHash(draft.reportId, syncRecovery.serverHash);
  hideSyncRecovery();
  setSaveStatus("Локальная версия");
  showToast("Оставлена локальная версия");
}

async function overwriteCloudWithLocalVersion() {
  if (!syncRecovery) return;
  flushDraftFromDom();
  const now = new Date().toISOString();
  draft = normalizeDraft({
    ...draft,
    revision: (Number(draft.revision) || 0) + 1,
    updatedAt: now,
    lastSavedBy: tabId,
    lastSavedClientId: reportClientId,
  });
  const existing = await getReportRecord(draft.reportId);
  const issueKey = issueKeyFromUrl(draft.issueUrl);
  const record = {
    id: draft.reportId,
    title: `${issueKey || "Без задачи"} — ${draft.environment}`,
    issueUrl: draft.issueUrl,
    issueKey,
    environment: draft.environment,
    overallStatus: draft.overallStatus,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastOpenedAt: now,
    reason: "overwrite-cloud",
    historyComment: existing?.historyComment || "",
    document: clone(draft),
    schemaVersion: 3,
  };
  await dbTransaction("readwrite", (store) => store.put(record));
  const result = await saveReportToServer(record, { force: true });
  if (result.report?.contentHash) {
    setKnownServerHash(record.id, result.report.contentHash);
    clearDismissedCloudHash(record.id);
  }
  historyCurrent = serializeDraft();
  hasUnsavedLocalChanges = false;
  broadcastDraftUpdate();
  hideSyncRecovery();
  setSaveStatus("Сохранено");
  showToast("Локальная версия сохранена в облако");
}

function createConflictCopy(sourceDraft, label, historyComment) {
  const copy = normalizeDraft(clone(sourceDraft));
  copy.draftId = crypto.randomUUID();
  copy.reportId = crypto.randomUUID();
  copy.publicId = createPublicId();
  copy.revision = 0;
  copy.updatedAt = new Date(0).toISOString();
  copy.lastSavedBy = "";
  copy.lastSavedClientId = "";
  return { draft: copy, label, historyComment };
}

async function saveDraftCopyToHistory(copyItem) {
  const copyDraft = normalizeDraft(copyItem.draft);
  const now = new Date().toISOString();
  copyDraft.updatedAt = now;
  copyDraft.lastSavedBy = tabId;
  copyDraft.lastSavedClientId = reportClientId;
  const issueKey = issueKeyFromUrl(copyDraft.issueUrl);
  const record = {
    id: copyDraft.reportId,
    publicId: copyDraft.publicId,
    title: `${issueKey || "Без задачи"} — ${copyDraft.environment}`,
    issueUrl: copyDraft.issueUrl,
    issueKey,
    environment: copyDraft.environment,
    overallStatus: copyDraft.overallStatus,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
    reason: "version-copy",
    historyComment: copyItem.historyComment,
    document: clone(copyDraft),
    schemaVersion: 3,
  };
  await dbTransaction("readwrite", (store) => store.put(record));
  await saveReportToServer(record, { force: true }).then((result) => {
    if (result.report?.contentHash) setKnownServerHash(record.id, result.report.contentHash);
  });
  return { ...copyItem, draft: copyDraft, record };
}

async function saveBothVersionsFromConflict() {
  if (!syncRecovery) return;
  flushDraftFromDom();
  const localCopy = createConflictCopy(draft, "local-copy", "Локальная версия");
  const savedLocal = await saveDraftCopyToHistory(localCopy);
  const cloudDraft = normalizeDraft(syncRecovery.serverDraft);
  const cloudId = cloudDraft.reportId || draft.reportId;
  if (syncRecovery.serverHash) setKnownServerHash(cloudId, syncRecovery.serverHash);
  dismissCloudHash(cloudId, syncRecovery.serverHash);
  hideSyncRecovery();
  pendingCopyChoice = {
    local: savedLocal,
    cloud: {
      draft: cloudDraft,
      record: {
        id: cloudId,
        publicId: cloudDraft.publicId,
        contentHash: syncRecovery.serverHash || serverReportHashes[cloudId] || "",
      },
    },
  };
  elements.versionCopyChoiceModal.hidden = false;
  document.body.style.overflow = "hidden";
  showToast("Локальная версия сохранена отдельной копией");
}

async function openSavedConflictCopy(which) {
  if (!pendingCopyChoice?.[which]) return;
  const selected = pendingCopyChoice[which];
  applyDraftLocally(selected.draft, { status: "Сохранено" });
  setKnownServerHash(selected.record.id, serverReportHashes[selected.record.id] || "");
  closeVersionCopyChoiceModal();
  await saveReportSnapshot("open-version-copy").catch(() => {});
  showToast(which === "local" ? "Открыта локальная версия" : "Открыта версия из облака");
}

async function saveVersionConflictChoice() {
  if (!versionConflictChoice) return;
  if (versionConflictChoice === "cloud") {
    applyCloudVersionFromRecovery();
    return;
  }
  if (versionConflictChoice === "local") {
    await overwriteCloudWithLocalVersion();
    return;
  }
  if (versionConflictChoice === "both") {
    await saveBothVersionsFromConflict();
  }
}

function handleRemoteDraftUpdate(remoteDraft) {
  const normalized = preserveKnownColumnMetadata(remoteDraft, draft);
  if (normalized.lastSavedBy === tabId || normalized.tabId === tabId) return;
  if (!isSameDraftLineage(normalized)) return;
  if (!isNewerDraft(normalized)) return;
  applyRemoteDraft(normalized);
}

async function checkStoredDraftFreshness() {
  flushDraftFromDom();
  const stored = await getFreshestStoredDraft();
  if (stored) handleRemoteDraftUpdate(stored);
  await checkServerDraftFreshness();
}

async function checkServerDraftFreshness() {
  if (!cloudHistoryEnabled) {
    hideSyncRecovery();
    return;
  }
  if (!draft?.reportId) return;
  try {
    const knownHash = serverReportHashes[draft.reportId] || "";
    const report = await getServerReport(draft.reportId, { rememberHash: false });
    if (!report?.document || !isSameDraftLineage(report.document)) return;
    const serverDraft = normalizeDraft(report.document);
    if (!hasMeaningfulContentDiff(draft, serverDraft)) {
      if (report.contentHash) setKnownServerHash(draft.reportId, report.contentHash);
      return;
    }
    if (!report.contentHash || report.contentHash === knownHash) return;
    if (isCloudHashDismissed(draft.reportId, report.contentHash)) return;
    if (!isNewerDraft(serverDraft)) return;
    if (isSavedByThisBrowser(serverDraft)) {
      if (!hasUnsavedLocalChanges && serializeDraft() === historyCurrent) {
        setKnownServerHash(draft.reportId, report.contentHash);
        applyDraftLocally(serverDraft, { status: "Сохранено" });
      }
      return;
    }
    if (hasUnsavedLocalChanges || serializeDraft() !== historyCurrent) {
      showSyncRecovery({
        localDraft: draft,
        serverDraft,
        serverHash: report.contentHash || "",
      });
      setSaveStatus("Есть облачная версия");
      return;
    }
    showSyncRecovery({
      localDraft: draft,
      serverDraft,
      serverHash: report.contentHash || "",
    });
    setSaveStatus("Есть облачная версия");
  } catch {
    // Проверка облачной свежести не блокирует локальную работу.
  }
}

function scheduleSave() {
  flushDraftFromDom();
  hasUnsavedLocalChanges = true;
  setSaveStatus("Сохранение…", { saving: true });
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDraft, 400);
  scheduleHistoryCommit();
}

function saveLocalMutationNow() {
  flushDraftFromDom();
  hasUnsavedLocalChanges = true;
  setSaveStatus("Сохранение…", { saving: true });
  clearTimeout(saveTimer);
  forceLocalDraftSave = true;
  saveDraft();
  scheduleHistoryCommit();
}

function serializeDraft() {
  return JSON.stringify(draftContentSnapshot(draft));
}

function scheduleHistoryCommit() {
  if (suppressHistory) return;
  clearTimeout(historyTimer);
  historyTimer = setTimeout(() => {
    collectDocumentFields();
    const next = serializeDraft();
    if (next === historyCurrent) return;
    undoStack.push(historyCurrent);
    if (undoStack.length > 100) undoStack.shift();
    historyCurrent = next;
    redoStack = [];
    updateHistoryButtons();
  }, 500);
}

function updateHistoryButtons() {
  elements.undoButton.disabled = undoStack.length === 0;
  elements.redoButton.disabled = redoStack.length === 0;
}

function restoreSerializedDraft(serialized) {
  suppressHistory = true;
  const currentMeta = {
    draftId: draft.draftId,
    revision: draft.revision,
    updatedAt: draft.updatedAt,
    lastSavedBy: draft.lastSavedBy,
  };
  draft = normalizeDraft({ ...JSON.parse(serialized), ...currentMeta });
  historyCurrent = serialized;
  render();
  saveDraft();
  suppressHistory = false;
  updateHistoryButtons();
}

function undo() {
  clearTimeout(historyTimer);
  collectDocumentFields();
  const current = serializeDraft();
  if (current !== historyCurrent) {
    undoStack.push(historyCurrent);
    historyCurrent = current;
  }
  const previous = undoStack.pop();
  if (!previous) return updateHistoryButtons();
  redoStack.push(historyCurrent);
  restoreSerializedDraft(previous);
}

function redo() {
  const next = redoStack.pop();
  if (!next) return updateHistoryButtons();
  undoStack.push(historyCurrent);
  restoreSerializedDraft(next);
}

function collectDocumentFields() {
  draft.issueUrl = elements.issueUrl.value;
  draft.environment = elements.environment.value.trim() || "Не указано";
  draft.overallStatus = elements.overallStatus.value;
  draft.intro = cleanEditorHtml(elements.introEditor);
  collectSectionsFromDom();
}

function collectSectionsFromDom() {
  elements.sections.querySelectorAll(".check-section[data-section-id]").forEach((sectionElement) => {
    const section = draft.sections.find((item) => item.id === sectionElement.dataset.sectionId);
    if (!section) return;
    const title = sectionElement.querySelector(".section-title");
    if (title) section.title = title.value;
    section.collapsed = sectionElement.classList.contains("collapsed");
    sectionElement.querySelectorAll("th[data-column-id]").forEach((columnElement) => {
      const column = section.columns.find((item) => item.id === columnElement.dataset.columnId);
      const columnTitle = columnElement.querySelector("input");
      if (column && columnTitle) column.title = columnTitle.value;
    });
    sectionElement.querySelectorAll("tr[data-row-id]").forEach((rowElement) => {
      const row = section.rows.find((item) => item.id === rowElement.dataset.rowId);
      if (!row) return;
      rowElement.querySelectorAll(".cell-editor[data-column-id]").forEach((editor) => {
        row.cells[editor.dataset.columnId] = cleanEditorHtml(editor);
      });
      const status = rowElement.querySelector(".status-select");
      if (status) row.status = status.value;
    });
  });
}

function flushDraftFromDom() {
  collectDocumentFields();
}

function render() {
  elements.issueUrl.value = draft.issueUrl || "";
  elements.environment.value = draft.environment;
  elements.overallStatus.value = draft.overallStatus;
  setStatusClass(elements.overallStatus, draft.overallStatus);
  elements.introEditor.innerHTML = draft.intro;
  elements.introEditor.querySelectorAll("figcaption").forEach((caption) => caption.remove());
  highlightCodeBlocks(elements.introEditor);
  enhanceImageControls(elements.introEditor);
  enhanceFileControls(elements.introEditor);
  draft.intro = cleanEditorHtml(elements.introEditor);
  renderSections();
  renderSummary();
}

function renderSections() {
  elements.sections.innerHTML = "";
  draft.sections.forEach((section) => {
    const fragment = elements.sectionTemplate.content.cloneNode(true);
    const sectionElement = fragment.querySelector(".check-section");
    sectionElement.dataset.sectionId = section.id;
    sectionElement.draggable = true;
    sectionElement.classList.toggle("collapsed", Boolean(section.collapsed));

    const title = fragment.querySelector(".section-title");
    title.value = section.title;
    title.addEventListener("input", () => {
      section.title = title.value;
      scheduleSave();
    });

    fragment.querySelector(".collapse-section").addEventListener("click", () => {
      section.collapsed = !section.collapsed;
      sectionElement.classList.toggle("collapsed", section.collapsed);
      scheduleStickySectionUpdate();
      scheduleSave();
    });
    fragment.querySelector(".move-section-up").addEventListener("click", () => moveSection(section.id, -1));
    fragment.querySelector(".move-section-down").addEventListener("click", () => moveSection(section.id, 1));
    fragment.querySelector(".delete-section").addEventListener("click", () => deleteSection(section.id));
    fragment.querySelector(".add-row-button").addEventListener("click", () => {
      flushDraftFromDom();
      const currentSection = draft.sections.find((item) => item.id === section.id);
      if (!currentSection) return;
      currentSection.rows.push(createRow(currentSection.columns));
      renderSections();
      saveLocalMutationNow();
    });
    renderTable(fragment, section);
    enableSectionDragging(sectionElement, section.id);
    elements.sections.append(fragment);
    highlightCodeBlocks(sectionElement);
    enhanceImageControls(sectionElement);
    enhanceFileControls(sectionElement);
  });
  scheduleStickySectionUpdate();
}

function renderTable(fragment, section) {
  const table = fragment.querySelector(".check-table");
  const tableScroll = fragment.querySelector(".table-scroll");
  const headerTable = fragment.querySelector(".section-header-table");
  const headerScroll = fragment.querySelector(".section-header-scroll");
  const bodyColgroup = table.querySelector("colgroup");
  const headerColgroup = headerTable.querySelector("colgroup");
  const header = headerTable.querySelector("thead tr");
  bodyColgroup.append(createColumnElement("number-col"));
  headerColgroup.append(createColumnElement("number-col"));
  header.append(createHeader("№"));

  let totalWidth = 52 + 164 + 46;
  section.columns.forEach((column, index) => {
    column.width = Math.max(140, Number(column.width) || 240);
    bodyColgroup.append(createColumnElement("dynamic-col", column.width));
    headerColgroup.append(createColumnElement("dynamic-col", column.width));
    const th = createColumnHeader(section, column, index);
    th.dataset.columnId = column.id;
    header.append(th);
    totalWidth += column.width;
  });

  bodyColgroup.append(createColumnElement("status-col"), createColumnElement("actions-col"));
  headerColgroup.append(createColumnElement("status-col"), createColumnElement("actions-col"));
  header.append(createStatusHeader(section), createHeader(""));
  table.style.width = `${totalWidth}px`;
  table.style.minWidth = "100%";
  headerTable.style.width = `${totalWidth}px`;
  headerTable.style.minWidth = "100%";

  const tbody = fragment.querySelector("tbody");
  section.rows.forEach((row, index) => tbody.append(createRowElement(section, row, index)));
  tbody.addEventListener("dragover", (event) => {
    if (!hasDragType(event, "text/row-id")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    updateRowDragAutoScroll(event);
    const rows = [...tbody.querySelectorAll("tr[data-row-id]")];
    if (!rows.length) {
      clearRowDropState();
      tbody.classList.add("row-drop-empty");
      return;
    }
    const lastRow = rows.at(-1);
    if (lastRow && event.clientY > lastRow.getBoundingClientRect().bottom) {
      clearRowDropState();
      lastRow.classList.add("row-drop-after");
    }
  });
  tbody.addEventListener("dragleave", (event) => {
    if (!hasDragType(event, "text/row-id")) return;
    if (event.relatedTarget && tbody.contains(event.relatedTarget)) return;
    tbody.classList.remove("row-drop-empty");
    clearRowDropState(tbody);
  });
  tbody.addEventListener("drop", (event) => {
    const sourceId = event.dataTransfer.getData("text/row-id");
    if (!sourceId) return;
    const directRow = event.target.closest("tr[data-row-id]");
    if (directRow && tbody.contains(directRow)) return;
    event.preventDefault();
    event.stopPropagation();
    tbody.classList.remove("row-drop-empty");
    const targetRow = section.rows.at(-1);
    if (targetRow) {
      moveRowTo(section, sourceId, targetRow.id, true);
    } else {
      moveRowToSectionEnd(section, sourceId);
    }
    clearRowDragState();
  });
  tableScroll?.addEventListener("scroll", () => {
    if (headerScroll) headerScroll.scrollLeft = tableScroll.scrollLeft;
    scheduleStickySectionUpdate();
  });
}

function createColumnElement(className, width = null) {
  const col = document.createElement("col");
  col.className = className;
  if (width !== null) col.style.width = `${width}px`;
  return col;
}

function getSectionTableWidth(section) {
  return 52 + 164 + 46 + section.columns.reduce((sum, item) => sum + (Number(item.width) || 240), 0);
}

function getStickyOffset() {
  const toolbarRect = document.querySelector(".editor-toolbar")?.getBoundingClientRect();
  return Math.max(0, toolbarRect?.bottom || 0) + 8;
}

function updateStickyOffsets() {
  const stickyTop = getStickyOffset();
  document.documentElement.style.setProperty("--section-sticky-top", `${stickyTop}px`);
  let hasStuckSection = false;
  elements.sections?.querySelectorAll(".section-sticky-block").forEach((stickyBlock) => {
    const rect = stickyBlock.getBoundingClientRect();
    const isPushedOut = rect.top < stickyTop - 1;
    const isStuck = !isPushedOut && rect.top <= stickyTop + 1;
    stickyBlock.classList.toggle("is-pushed-out", isPushedOut);
    stickyBlock.classList.toggle("is-stuck", isStuck);
    hasStuckSection ||= isStuck;
  });
  document.body.classList.toggle("section-sticky-active", hasStuckSection);
}

function updateStickySection() {
  stickyUpdateFrame = 0;
  updateStickyOffsets();
}

function scheduleStickySectionUpdate() {
  if (stickyUpdateFrame) return;
  stickyUpdateFrame = requestAnimationFrame(updateStickySection);
}

function createHeader(content, html = false) {
  const th = document.createElement("th");
  if (html) th.innerHTML = content;
  else th.textContent = content;
  return th;
}

function hasDragType(event, type) {
  return [...(event.dataTransfer?.types || [])].includes(type);
}

function clearColumnDragState() {
  document
    .querySelectorAll(
      ".column-dragging, .column-drop-before, .column-drop-after, .column-drop-target",
    )
    .forEach((item) =>
      item.classList.remove(
        "column-dragging",
        "column-drop-before",
        "column-drop-after",
        "column-drop-target",
      ),
    );
}

function setColumnDropTarget(sectionElement, columnIndex, placeAfter) {
  sectionElement
    ?.querySelectorAll(".column-drop-before, .column-drop-after, .column-drop-target")
    .forEach((item) =>
      item.classList.remove("column-drop-before", "column-drop-after", "column-drop-target"),
    );
  sectionElement?.querySelectorAll(`tr > *:nth-child(${columnIndex + 1})`).forEach((cell) => {
    cell.classList.add("column-drop-target");
    cell.classList.toggle("column-drop-before", !placeAfter);
    cell.classList.toggle("column-drop-after", placeAfter);
  });
}

function createColumnHeader(section, column, index) {
  const th = document.createElement("th");
  th.className = "editable-column-header";
  const dragHandle = document.createElement("span");
  dragHandle.className = "column-drag-handle";
  dragHandle.textContent = "⋮⋮";
  dragHandle.title = "Перетащить столбец";
  dragHandle.draggable = true;
  dragHandle.addEventListener("dragstart", (event) => {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/column-id", column.id);
    const sectionElement = th.closest(".check-section");
    sectionElement?.querySelectorAll(`th[data-column-id="${column.id}"], td[data-column-id="${column.id}"]`).forEach((cell) => {
      cell.classList.add("column-dragging");
    });
    const ghost = document.createElement("div");
    ghost.className = "column-drag-ghost";
    ghost.textContent = column.title || "Столбец";
    document.body.append(ghost);
    event.dataTransfer.setDragImage(ghost, 24, 20);
    requestAnimationFrame(() => ghost.remove());
  });
  dragHandle.addEventListener("dragend", () => {
    clearColumnDragState();
  });
  th.addEventListener("dragover", (event) => {
    if (!hasDragType(event, "text/column-id")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = th.getBoundingClientRect();
    const placeAfter = event.clientX > rect.left + rect.width / 2;
    const sectionElement = th.closest(".check-section");
    const cellIndex = [...th.parentElement.children].indexOf(th);
    setColumnDropTarget(sectionElement, cellIndex, placeAfter);
  });
  th.addEventListener("dragleave", () => {
    th.classList.remove("column-drop-before", "column-drop-after", "column-drop-target");
  });
  th.addEventListener("drop", (event) => {
    const sourceId = event.dataTransfer.getData("text/column-id");
    if (!sourceId) return;
    event.preventDefault();
    event.stopPropagation();
    clearColumnDragState();
    const rect = th.getBoundingClientRect();
    moveColumnTo(section, sourceId, column.id, event.clientX > rect.left + rect.width / 2);
  });
  const input = document.createElement("input");
  input.value = column.title;
  input.setAttribute("aria-label", `Название столбца ${column.title}`);
  input.addEventListener("input", () => {
    column.title = input.value;
    input.setAttribute("aria-label", `Название столбца ${input.value || "Без названия"}`);
    scheduleSave();
  });
  const menuButton = document.createElement("button");
  menuButton.type = "button";
  menuButton.className = "column-menu-button";
  menuButton.textContent = "•••";
  menuButton.title = "Действия со столбцом";
  menuButton.addEventListener("click", (event) => {
    event.stopPropagation();
    const items = [
      { label: "Вставить столбец слева", icon: "column-insert-left", action: () => insertColumn(section, index) },
      { label: "Вставить столбец справа", icon: "column-insert-right", action: () => insertColumn(section, index + 1) },
    ];
    if (index > 0) {
      items.push({ label: "Переместить влево", icon: "arrow-left", action: () => moveColumn(section, column.id, -1) });
    }
    if (index < section.columns.length - 1) {
      items.push({ label: "Переместить вправо", icon: "arrow-right", action: () => moveColumn(section, column.id, 1) });
    }
    items.push({
      label: "Удалить столбец",
      icon: "trash",
      danger: true,
      action: () => deleteColumn(section, column.id),
    });
    showFloatingMenu(menuButton, items);
  });
  th.append(dragHandle, input, menuButton);
  const resizer = document.createElement("span");
  resizer.className = "column-resizer";
  resizer.title = "Изменить ширину столбца";
  resizer.addEventListener("pointerdown", (event) => startColumnResize(event, section, column));
  th.append(resizer);
  return th;
}

function startColumnResize(event, section, column) {
  event.preventDefault();
  event.stopPropagation();
  const startX = event.clientX;
  const startWidth = Math.max(140, Number(column.width) || 240);
  const onMove = (moveEvent) => {
    column.width = Math.max(140, Math.min(1000, startWidth + moveEvent.clientX - startX));
    const sectionElement = elements.sections.querySelector(`[data-section-id="${section.id}"]`);
    const col = sectionElement?.querySelector(`th[data-column-id="${column.id}"]`);
    if (!col) return;
    const colIndex = [...col.parentElement.children].indexOf(col);
    const total = 52 + 164 + 46 + section.columns.reduce((sum, item) => sum + (Number(item.width) || 240), 0);
    updateSectionColumnLayout(sectionElement, colIndex, column.width, total);
  };
  const onUp = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    scheduleSave();
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
}

function updateSectionColumnLayout(sectionElement, columnIndex, columnWidth, tableWidth) {
  sectionElement.querySelectorAll("colgroup").forEach((colgroup) => {
    const colElement = colgroup.children[columnIndex];
    if (colElement) colElement.style.width = `${columnWidth}px`;
  });
  sectionElement.querySelectorAll(".check-table, .section-header-table").forEach((table) => {
    table.style.width = `${tableWidth}px`;
  });
}

function createStatusHeader(section) {
  const th = document.createElement("th");
  th.className = "status-header";
  const label = document.createElement("span");
  label.innerHTML = 'Статус <span class="required">*</span>';
  const menuButton = document.createElement("button");
  menuButton.type = "button";
  menuButton.className = "column-menu-button";
  menuButton.textContent = "•••";
  menuButton.title = "Действия рядом со статусом";
  menuButton.addEventListener("click", (event) => {
    event.stopPropagation();
    showFloatingMenu(menuButton, [
      {
        label: "Вставить столбец слева",
        icon: "column-insert-left",
        action: () => insertColumn(section, section.columns.length),
      },
    ]);
  });
  th.append(label, menuButton);
  return th;
}

function createRowElement(section, row, index) {
  const tr = document.createElement("tr");
  tr.dataset.rowId = row.id;

  const numberCell = document.createElement("td");
  numberCell.className = "row-number";
  const rowDragHandle = document.createElement("span");
  rowDragHandle.className = "row-drag-handle";
  rowDragHandle.textContent = "⋮⋮";
  rowDragHandle.title = "Перетащить строку";
  rowDragHandle.draggable = true;
  const rowNumber = document.createElement("span");
  rowNumber.className = "row-number-text";
  rowNumber.textContent = `${index + 1}.`;
  numberCell.append(rowDragHandle, rowNumber);
  tr.append(numberCell);

  section.columns.forEach((column) => {
    const td = document.createElement("td");
    td.className = "editor-cell";
    td.dataset.columnId = column.id;
    td.addEventListener("dragover", (event) => {
      if (!hasDragType(event, "text/column-id")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const rect = td.getBoundingClientRect();
      const sectionElement = tr.closest(".check-section");
      setColumnDropTarget(sectionElement, [...tr.children].indexOf(td), event.clientX > rect.left + rect.width / 2);
    });
    td.addEventListener("drop", (event) => {
      const sourceId = event.dataTransfer.getData("text/column-id");
      if (!sourceId) return;
      event.preventDefault();
      event.stopPropagation();
      clearColumnDragState();
      const rect = td.getBoundingClientRect();
      moveColumnTo(section, sourceId, column.id, event.clientX > rect.left + rect.width / 2);
    });
    const editor = document.createElement("div");
    editor.className = "cell-editor";
    editor.contentEditable = "true";
    editor.dataset.columnId = column.id;
    editor.dataset.placeholder = column.title || "Введите значение";
    editor.innerHTML = row.cells[column.id] || "";
    editor.querySelectorAll("figcaption").forEach((caption) => caption.remove());
    row.cells[column.id] = editor.innerHTML;
    editor.addEventListener("input", () => {
      row.cells[column.id] = cleanEditorHtml(editor);
      renderSummary();
      scheduleSave();
    });
    td.append(editor);
    tr.append(td);
  });

  const statusCell = document.createElement("td");
  const statusSelect = createStatusSelect(row.status);
  statusSelect.addEventListener("change", () => {
    row.status = statusSelect.value;
    setStatusClass(statusSelect, row.status);
    renderSummary();
    scheduleSave();
  });
  statusCell.append(statusSelect);
  tr.append(statusCell);

  const actions = document.createElement("td");
  actions.className = "row-actions";
  const menuButton = document.createElement("button");
  menuButton.className = "row-menu-button";
  menuButton.type = "button";
  menuButton.title = "Действия со строкой";
  menuButton.textContent = "•••";
  menuButton.addEventListener("click", (event) => {
    event.stopPropagation();
    showFloatingMenu(menuButton, [
      { label: "Добавить строку выше", icon: "row-insert-above", action: () => applyRowAction(section, row.id, "insert-above") },
      { label: "Добавить строку ниже", icon: "row-insert-below", action: () => applyRowAction(section, row.id, "insert-below") },
      { label: "Дублировать", icon: "copy", action: () => applyRowAction(section, row.id, "duplicate") },
      { label: "Новый раздел отсюда", icon: "section-split", action: () => applyRowAction(section, row.id, "split") },
      { label: "Поднять выше", icon: "arrow-up", action: () => applyRowAction(section, row.id, "move-up") },
      { label: "Опустить ниже", icon: "arrow-down", action: () => applyRowAction(section, row.id, "move-down") },
      {
        label: "Удалить",
        icon: "trash",
        danger: true,
        action: () => applyRowAction(section, row.id, "delete"),
      },
    ]);
  });
  actions.append(menuButton);
  tr.append(actions);
  rowDragHandle.addEventListener("dragstart", (event) => {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/row-id", row.id);
    tr.classList.add("row-dragging");
  });
  rowDragHandle.addEventListener("dragend", clearRowDragState);
  tr.addEventListener("dragover", (event) => {
    if (!hasDragType(event, "text/row-id")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    updateRowDragAutoScroll(event);
    const rect = tr.getBoundingClientRect();
    const placeAfter = event.clientY > rect.top + rect.height / 2;
    clearRowDropState();
    tr.classList.add(placeAfter ? "row-drop-after" : "row-drop-before");
  });
  tr.addEventListener("dragleave", (event) => {
    if (!hasDragType(event, "text/row-id")) return;
    if (event.relatedTarget && tr.contains(event.relatedTarget)) return;
    tr.classList.remove("row-drop-before", "row-drop-after");
  });
  tr.addEventListener("drop", (event) => {
    const sourceId = event.dataTransfer.getData("text/row-id");
    if (!sourceId) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = tr.getBoundingClientRect();
    moveRowTo(section, sourceId, row.id, event.clientY > rect.top + rect.height / 2);
    clearRowDragState();
  });
  return tr;
}

function createStatusSelect(value) {
  const select = document.createElement("select");
  select.className = "status-select";
  Object.keys(STATUS_META).forEach((status) => {
    const option = document.createElement("option");
    option.value = status;
    option.textContent = status;
    select.append(option);
  });
  select.value = value;
  setStatusClass(select, value);
  return select;
}

function insertColumn(section, index) {
  flushDraftFromDom();
  const currentSection = draft.sections.find((item) => item.id === section.id);
  if (!currentSection) return;
  const column = { id: `column-${crypto.randomUUID()}`, title: "Новый столбец" };
  const insertionIndex = Math.max(0, Math.min(index, currentSection.columns.length));
  currentSection.columns.splice(insertionIndex, 0, column);
  currentSection.rows.forEach((row) => (row.cells[column.id] = ""));
  closeFloatingMenu();
  renderSections();
  saveLocalMutationNow();
  const target = elements.sections.querySelector(
    `[data-section-id="${currentSection.id}"] th[data-column-id="${column.id}"] input`,
  );
  target?.select();
}

function moveColumn(section, columnId, offset) {
  flushDraftFromDom();
  const currentSection = draft.sections.find((item) => item.id === section.id);
  if (!currentSection) return;
  const index = currentSection.columns.findIndex((column) => column.id === columnId);
  const targetIndex = index + offset;
  if (index < 0 || targetIndex < 0 || targetIndex >= currentSection.columns.length) return;
  const [column] = currentSection.columns.splice(index, 1);
  currentSection.columns.splice(targetIndex, 0, column);
  closeFloatingMenu();
  renderSections();
  saveLocalMutationNow();
}

function moveColumnTo(section, sourceId, targetId, placeAfter = false) {
  flushDraftFromDom();
  const currentSection = draft.sections.find((item) => item.id === section.id);
  if (!currentSection) return;
  const sourceIndex = currentSection.columns.findIndex((column) => column.id === sourceId);
  const targetIndex = currentSection.columns.findIndex((column) => column.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return;
  let insertionIndex = targetIndex + (placeAfter ? 1 : 0);
  if (sourceIndex < insertionIndex) insertionIndex -= 1;
  if (sourceIndex === insertionIndex) return;
  const [column] = currentSection.columns.splice(sourceIndex, 1);
  currentSection.columns.splice(insertionIndex, 0, column);
  renderSections();
  saveLocalMutationNow();
}

function clearRowDropState(root = document) {
  root
    .querySelectorAll?.(".row-drop-before, .row-drop-after")
    .forEach((item) => item.classList.remove("row-drop-before", "row-drop-after"));
}

function updateRowDragAutoScroll(event) {
  const scrollElement = document.scrollingElement || document.documentElement;
  const threshold = 96;
  const maxSpeed = 18;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  let speed = 0;
  if (event.clientY < threshold) {
    speed = -Math.round(((threshold - event.clientY) / threshold) * maxSpeed);
  } else if (viewportHeight - event.clientY < threshold) {
    speed = Math.round(((threshold - (viewportHeight - event.clientY)) / threshold) * maxSpeed);
  }

  if (!speed) {
    if (rowDragAutoScroll) {
      cancelAnimationFrame(rowDragAutoScroll.frame);
      rowDragAutoScroll = null;
    }
    return;
  }

  if (rowDragAutoScroll) {
    rowDragAutoScroll.speed = speed;
    return;
  }

  rowDragAutoScroll = { speed, frame: 0 };
  const tick = () => {
    if (!rowDragAutoScroll) return;
    scrollElement.scrollTop += rowDragAutoScroll.speed;
    rowDragAutoScroll.frame = requestAnimationFrame(tick);
  };
  rowDragAutoScroll.frame = requestAnimationFrame(tick);
}

function stopRowDragAutoScroll() {
  if (!rowDragAutoScroll) return;
  cancelAnimationFrame(rowDragAutoScroll.frame);
  rowDragAutoScroll = null;
}

function clearRowDragState() {
  stopRowDragAutoScroll();
  document.querySelectorAll(".row-dragging").forEach((item) => item.classList.remove("row-dragging"));
  document.querySelectorAll(".row-drop-empty").forEach((item) => item.classList.remove("row-drop-empty"));
  clearRowDropState();
}

function normalizeColumnTitle(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function adaptRowCellsForSection(row, sourceSection, targetSection) {
  if (sourceSection.id === targetSection.id) return row;
  const sourceColumnsByTitle = new Map(
    sourceSection.columns.map((column) => [normalizeColumnTitle(column.title), column]),
  );
  const usedSourceIds = new Set();
  const mappedCells = {};
  targetSection.columns.forEach((targetColumn, index) => {
    let sourceColumn = sourceSection.columns.find((column) => column.id === targetColumn.id);
    if (!sourceColumn) {
      sourceColumn = sourceColumnsByTitle.get(normalizeColumnTitle(targetColumn.title));
    }
    if (!sourceColumn || usedSourceIds.has(sourceColumn.id)) {
      sourceColumn = sourceSection.columns[index];
    }
    if (sourceColumn) usedSourceIds.add(sourceColumn.id);
    mappedCells[targetColumn.id] = sourceColumn ? row.cells[sourceColumn.id] || "" : "";
  });
  row.cells = mappedCells;
  return row;
}

function moveRowTo(targetSectionRef, sourceId, targetId, placeAfter = false) {
  flushDraftFromDom();
  const targetSection = draft.sections.find((item) => item.id === targetSectionRef.id);
  const sourceSection = draft.sections.find((item) => item.rows.some((row) => row.id === sourceId));
  if (!targetSection || !sourceSection) return;
  const sourceIndex = sourceSection.rows.findIndex((row) => row.id === sourceId);
  const targetIndex = targetSection.rows.findIndex((row) => row.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return;
  let insertionIndex = targetIndex + (placeAfter ? 1 : 0);
  if (sourceSection.id === targetSection.id) {
    if (sourceIndex < insertionIndex) insertionIndex -= 1;
    if (sourceIndex === insertionIndex) return;
  }
  const [row] = sourceSection.rows.splice(sourceIndex, 1);
  adaptRowCellsForSection(row, sourceSection, targetSection);
  targetSection.rows.splice(insertionIndex, 0, row);
  renderSections();
  renderSummary();
  saveLocalMutationNow();
}

function moveRowToSectionEnd(targetSectionRef, sourceId) {
  flushDraftFromDom();
  const targetSection = draft.sections.find((item) => item.id === targetSectionRef.id);
  const sourceSection = draft.sections.find((item) => item.rows.some((row) => row.id === sourceId));
  if (!targetSection || !sourceSection) return;
  const sourceIndex = sourceSection.rows.findIndex((row) => row.id === sourceId);
  if (sourceIndex < 0) return;
  if (sourceSection.id === targetSection.id && sourceIndex === sourceSection.rows.length - 1) return;
  const [row] = sourceSection.rows.splice(sourceIndex, 1);
  adaptRowCellsForSection(row, sourceSection, targetSection);
  targetSection.rows.push(row);
  renderSections();
  renderSummary();
  saveLocalMutationNow();
}

function deleteColumn(section, columnId) {
  flushDraftFromDom();
  const currentSection = draft.sections.find((item) => item.id === section.id);
  if (!currentSection) return;
  currentSection.columns = currentSection.columns.filter((column) => column.id !== columnId);
  currentSection.rows.forEach((row) => delete row.cells[columnId]);
  closeFloatingMenu();
  renderSections();
  renderSummary();
  saveLocalMutationNow();
}

function splitSectionAtRow(section, rowIndex) {
  flushDraftFromDom();
  const currentSection = draft.sections.find((item) => item.id === section.id);
  if (!currentSection) return;
  if (rowIndex <= 0) {
    showToast("Выберите строку ниже первой");
    return;
  }
  const sectionIndex = draft.sections.findIndex((item) => item.id === currentSection.id);
  const movedRows = currentSection.rows.splice(rowIndex);
  const newSection = {
    id: crypto.randomUUID(),
    title: `${currentSection.title} — продолжение`,
    collapsed: false,
    columns: clone(currentSection.columns),
    rows: movedRows,
  };
  draft.sections.splice(sectionIndex + 1, 0, newSection);
  renderSections();
  renderSummary();
  saveLocalMutationNow();
}

function applyRowAction(section, rowId, action) {
  flushDraftFromDom();
  const currentSection = draft.sections.find((item) => item.id === section.id);
  if (!currentSection) return;
  const index = currentSection.rows.findIndex((row) => row.id === rowId);
  if (index < 0) return;
  if (action === "insert-above") {
    currentSection.rows.splice(index, 0, createRow(currentSection.columns));
  } else if (action === "insert-below") {
    currentSection.rows.splice(index + 1, 0, createRow(currentSection.columns));
  } else if (action === "duplicate") {
    currentSection.rows.splice(index + 1, 0, { ...clone(currentSection.rows[index]), id: crypto.randomUUID() });
  } else if (action === "split") {
    splitSectionAtRow(currentSection, index);
    return;
  } else if (action === "move-up" && index > 0) {
    [currentSection.rows[index - 1], currentSection.rows[index]] = [currentSection.rows[index], currentSection.rows[index - 1]];
  } else if (action === "move-down" && index < currentSection.rows.length - 1) {
    [currentSection.rows[index + 1], currentSection.rows[index]] = [currentSection.rows[index], currentSection.rows[index + 1]];
  } else if (action === "delete") {
    if (currentSection.rows.length === 1) {
      showToast("В разделе должна остаться хотя бы одна строка");
      return;
    }
    currentSection.rows.splice(index, 1);
  }
  renderSections();
  renderSummary();
  saveLocalMutationNow();
}

function deleteSection(sectionId) {
  if (draft.sections.length === 1) {
    showToast("В отчёте должен остаться хотя бы один раздел");
    return;
  }
  draft.sections = draft.sections.filter((section) => section.id !== sectionId);
  renderSections();
  renderSummary();
  scheduleSave();
}

function moveSection(sectionId, offset) {
  const index = draft.sections.findIndex((section) => section.id === sectionId);
  const next = index + offset;
  if (index < 0 || next < 0 || next >= draft.sections.length) return;
  [draft.sections[index], draft.sections[next]] = [draft.sections[next], draft.sections[index]];
  renderSections();
  scheduleSave();
}

function enableSectionDragging(sectionElement, sectionId) {
  const handle = sectionElement.querySelector(".drag-handle");
  let handlePressed = false;
  handle.addEventListener("pointerdown", () => (handlePressed = true));
  sectionElement.addEventListener("pointerup", () => (handlePressed = false));
  sectionElement.addEventListener("pointercancel", () => (handlePressed = false));
  sectionElement.addEventListener("dragstart", (event) => {
    if (!handlePressed) return event.preventDefault();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", sectionId);
    sectionElement.classList.add("dragging");
  });
  sectionElement.addEventListener("dragend", () => {
    sectionElement.classList.remove("dragging");
    document.querySelectorAll(".check-section").forEach((item) => item.classList.remove("drag-over"));
  });
  sectionElement.addEventListener("dragover", (event) => {
    event.preventDefault();
    sectionElement.classList.add("drag-over");
  });
  sectionElement.addEventListener("dragleave", () => sectionElement.classList.remove("drag-over"));
  sectionElement.addEventListener("drop", (event) => {
    event.preventDefault();
    const sourceId = event.dataTransfer.getData("text/plain");
    const source = draft.sections.findIndex((section) => section.id === sourceId);
    const target = draft.sections.findIndex((section) => section.id === sectionId);
    if (source < 0 || target < 0 || source === target) return;
    const [moved] = draft.sections.splice(source, 1);
    draft.sections.splice(target, 0, moved);
    renderSections();
    scheduleSave();
  });
}

function showFloatingMenu(anchor, items) {
  closeFloatingMenu();
  const menu = document.createElement("div");
  menu.className = "floating-context-menu";
  items.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    if (item.icon) button.append(createUiIcon(item.icon));
    const label = document.createElement("span");
    label.textContent = item.label;
    button.append(label);
    if (item.danger) button.className = "danger-text";
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      item.action();
      closeFloatingMenu();
    });
    menu.append(button);
  });
  document.body.append(menu);
  floatingMenu = menu;
  const anchorRect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const margin = 8;
  let left = Math.min(anchorRect.right - menuRect.width, window.innerWidth - menuRect.width - margin);
  left = Math.max(margin, left);
  let top = anchorRect.bottom + 6;
  if (top + menuRect.height > window.innerHeight - margin) {
    top = Math.max(margin, anchorRect.top - menuRect.height - 6);
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function createUiIcon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("ui-icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#icon-${name}`);
  svg.append(use);
  return svg;
}

function closeFloatingMenu() {
  floatingMenu?.remove();
  floatingMenu = null;
}

function setStatusClass(select, status) {
  Object.values(STATUS_META).forEach((meta) => select.classList.remove(meta.className));
  const meta = STATUS_META[status] || STATUS_META["НЕ ПРОВЕРЕНО"];
  select.classList.add(meta.className);
}

function hasRowContent(row) {
  return (
    Object.values(row.cells).some((value) => htmlToText(value) || /<img|<pre/i.test(value)) ||
    row.status !== "НЕ ПРОВЕРЕНО" ||
    Object.keys(row.cells).length === 0
  );
}

function renderSummary() {
  const rows = draft.sections.flatMap((section) => section.rows).filter(hasRowContent);
  elements.summaryTotal.textContent = rows.length;
  elements.summaryChart.innerHTML = "";
  elements.summaryList.innerHTML = "";
  Object.entries(STATUS_META).forEach(([status, meta]) => {
    const count = rows.filter((row) => row.status === status).length;
    const segment = document.createElement("div");
    segment.className = "chart-segment";
    segment.style.width = rows.length ? `${(count / rows.length) * 100}%` : "0";
    segment.style.background = meta.color;
    elements.summaryChart.append(segment);
    const item = document.createElement("div");
    item.className = "summary-row";
    item.innerHTML = `<span class="summary-color" style="background:${meta.color}"></span><span class="summary-label">${status}</span><span class="summary-count">${count}</span>`;
    elements.summaryList.append(item);
  });
}

function htmlToText(html) {
  const container = document.createElement("div");
  container.innerHTML = html || "";
  return (container.textContent || "").trim();
}

function wrapSpreadsheetLongLine(line, maxLength = 96) {
  const chunks = [];
  let rest = String(line || "");
  while (rest.length > maxLength) {
    const window = rest.slice(0, maxLength + 1);
    const softBreak = Math.max(
      window.lastIndexOf(","),
      window.lastIndexOf(";"),
      window.lastIndexOf(" "),
      window.lastIndexOf("&"),
    );
    const index = softBreak > Math.floor(maxLength * 0.55) ? softBreak + 1 : maxLength;
    chunks.push(rest.slice(0, index).trimEnd());
    rest = rest.slice(index).trimStart();
  }
  chunks.push(rest);
  return chunks.join("\n");
}

function normalizeSpreadsheetCodeBlock(value) {
  return String(value || "")
    .split("\n")
    .map((line) => wrapSpreadsheetLongLine(line, 92))
    .join("\n")
    .trim();
}

function htmlToSpreadsheetText(html) {
  const container = document.createElement("div");
  container.innerHTML = html || "";
  container.querySelectorAll("[data-editor-ui], figcaption").forEach((node) => node.remove());
  const lines = [];
  let current = "";
  const append = (value) => {
    current += String(value || "").replace(/\u00a0/g, " ");
  };
  const newline = () => {
    const line = current.trimEnd();
    if (line || lines.length) lines.push(line);
    current = "";
  };
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      append(node.textContent || "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.matches?.("[data-editor-ui]")) return;
    if (node.matches?.(".cell-file")) {
      const name = node.dataset.jiraName || node.dataset.fileName || "файл";
      const link = node.dataset.jiraUrl || "";
      append(link ? `[Файл: ${name}] ${link}` : `[Файл: ${name}]`);
      return;
    }
    const tag = node.tagName.toLowerCase();
    if (tag === "br") {
      newline();
      return;
    }
    if (tag === "img") {
      const name = node.dataset.jiraName || node.dataset.fileName || node.alt || "изображение";
      const link = node.dataset.jiraUrl || (node.src && !node.src.startsWith("data:") ? node.src : "");
      append(link ? `[Изображение: ${name}] ${link}` : `[Изображение: ${name}]`);
      return;
    }
    if (tag === "a") {
      const text = node.textContent?.trim() || node.getAttribute("href") || "";
      const href = node.getAttribute("href") || "";
      append(href && href !== text ? `${text} (${href})` : text);
      return;
    }
    if (tag === "pre") {
      newline();
      append(`Код:\n${normalizeSpreadsheetCodeBlock(extractCodeText(node))}`);
      newline();
      return;
    }
    const block = ["p", "div", "figure", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6"].includes(tag);
    if (tag === "li" && current.trim()) newline();
    for (const child of node.childNodes) walk(child);
    if (block) newline();
  };
  for (const child of container.childNodes) walk(child);
  if (current.trim()) newline();
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function extractCodeText(node) {
  let output = "";
  const walk = (current) => {
    if (current.nodeType === Node.TEXT_NODE) {
      output += current.textContent || "";
      return;
    }
    if (current.nodeType !== Node.ELEMENT_NODE) return;
    if (current.matches?.("[data-editor-ui]")) return;
    if (current.tagName === "BR") {
      output += "\n";
      return;
    }
    const block = ["DIV", "P"].includes(current.tagName);
    for (const child of current.childNodes) walk(child);
    if (block && output && !output.endsWith("\n")) output += "\n";
  };
  for (const child of node.childNodes) walk(child);
  return output.replace(/\u00a0/g, " ").replace(/\n+$/, "");
}

function htmlToWiki(html) {
  const container = document.createElement("div");
  container.innerHTML = html || "";
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    if (node.matches?.(".cell-file")) return fileCardToWiki(node);
    const tag = node.tagName.toLowerCase();
    if ((tag === "span" && node.style.color) || (tag === "font" && node.getAttribute("color"))) {
      const content = [...node.childNodes].map(walk).join("");
      if (!content.trim()) return "";
      if (/\{color(?::[^}]+)?\}/i.test(content)) return content;
      const color = node.style.color || node.getAttribute("color");
      return `{color:${cssColorToHex(color)}}${content}{color}`;
    }
    const content = [...node.childNodes].map(walk).join("");
    if (tag === "strong" || tag === "b") return `*${content}*`;
    if (tag === "em" || tag === "i") return `_${content}_`;
    if (tag === "u") return `+${content}+`;
    if (tag === "s" || tag === "strike") return `-${content}-`;
    if (tag === "a") return `[${content}|${node.getAttribute("href") || ""}]`;
    if (tag === "pre") {
      return `{code}\n${extractCodeText(node)}\n{code}`;
    }
    if (tag === "img") {
      const name = node.dataset.jiraName || node.dataset.fileName || node.alt || "image.png";
      if (isStoredObjectUrl(node.src)) return `[${name}|${node.src}]`;
      // Ссылка по имени вложения даёт Jira возможность открыть изображение
      // во встроенном просмотрщике, а параметр thumbnail оставляет его компактным.
      return `!${name}|thumbnail!`;
    }
    if (tag === "figure") return `\n${content}\n`;
    if (tag === "br") return "\n";
    if (tag === "ul") return [...node.children].map((item) => `* ${walk(item).trim()}`).join("\n");
    if (tag === "ol") return [...node.children].map((item) => `# ${walk(item).trim()}`).join("\n");
    if (tag === "li") return content;
    if (/h[1-6]/.test(tag)) return `h${tag.slice(1)}. ${content}\n`;
    if (tag === "p" || tag === "div") return `${content}\n`;
    return content;
  }
  return normalizeJiraColorMarkup(
    [...container.childNodes].map(walk).join("").replace(/\n{3,}/g, "\n\n").trim(),
  );
}

function escapeWiki(value) {
  return htmlToWiki(value).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "\n\u00a0\n");
}

function normalizeJiraCellWhitespace(value) {
  const lines = String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim());

  while (lines[0] === "") lines.shift();
  while (lines.at(-1) === "") lines.pop();

  const normalized = [];
  for (const line of lines) {
    if (!line) {
      if (normalized.length && normalized.at(-1) !== "") normalized.push("");
      continue;
    }
    normalized.push(line);
  }
  return normalized.join("\n");
}

function jiraCell(value) {
  let content = normalizeJiraColorMarkup(htmlToWiki(value));
  const protectedBlocks = [];
  content = content.replace(/\{code(?::[^}]+)?\}[\s\S]*?\{code\}/gi, (block) => {
    const token = `@@JIRA_PROTECTED_${protectedBlocks.length}@@`;
    protectedBlocks.push(block);
    return token;
  });
  content = content.replace(/![^!\r\n]+!/g, (block) => {
    const token = `@@JIRA_IMAGE_${protectedBlocks.length}@@`;
    // Jira распознаёт служебную вертикальную черту внутри image markup.
    // Блок временно вынимается, чтобы общий экранировщик ячейки не превратил
    // её в часть имени файла.
    protectedBlocks.push(block);
    return token;
  });
  content = content.replace(/\[[^\]\r\n]+\|https?:\/\/[^\]\r\n]+\]/g, (block) => {
    const token = `@@JIRA_LINK_${protectedBlocks.length}@@`;
    protectedBlocks.push(block);
    return token;
  });
  // Если перед image-макросом оставить Jira-перенос `\\`, Jira перестаёт
  // распознавать изображение и воспринимает `|thumbnail` как новую ячейку.
  // Поэтому только на границе текста и изображения используем обычный пробел.
  content = content
    .replace(/[ \t]*(?:\r?\n)+[ \t]*(?=@@JIRA_IMAGE_\d+@@)/g, " ")
    .replace(/(@@JIRA_IMAGE_\d+@@)[ \t]*(?:\r?\n)+[ \t]*/g, "$1 ");
  content = normalizeJiraCellWhitespace(content);
  content = content
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/[ \t]*(?:\r?\n)+[ \t]*/g, (breaks) => {
      const count = (breaks.match(/\n/g) || []).length;
      return count > 1 ? "\n\u00a0\n" : "\n";
    });
  content = content.replace(
    /@@JIRA_(?:PROTECTED|IMAGE|LINK)_(\d+)@@/g,
    (_, index) => protectedBlocks[Number(index)] || "",
  );
  return content.trim() ? content : " ";
}

function normalizeJiraColorMarkup(value) {
  const protectedBlocks = [];
  let output = String(value || "").replace(/\{code(?::[^}]+)?\}[\s\S]*?\{code\}/gi, (block) => {
    const token = `@@JIRA_CODE_COLOR_${protectedBlocks.length}@@`;
    protectedBlocks.push(block);
    return token;
  });
  output = balanceJiraColorMarkup(output)
    .replace(/\{color:[^}]+\}\s*\{color\}/gi, "")
    .replace(/\{color\}\s*\{color\}/gi, "");
  let previous = "";
  while (output !== previous) {
    previous = output;
    output = output.replace(
      /\{color:(#[0-9a-f]{3,8})\}([\s\S]*?)\{color\}\s*\{color:\1\}([\s\S]*?)\{color\}/gi,
      "{color:$1}$2$3{color}",
    );
  }
  return output.replace(
    /@@JIRA_CODE_COLOR_(\d+)@@/g,
    (_, index) => protectedBlocks[Number(index)] || "",
  );
}

function balanceJiraColorMarkup(value) {
  const tokenPattern = /\{color(?::([^}]+))?\}/gi;
  const source = String(value || "");
  let output = "";
  let offset = 0;
  let activeColor = "";
  let activeStart = -1;
  let activeHasContent = false;
  for (const match of source.matchAll(tokenPattern)) {
    const text = source.slice(offset, match.index);
    output += text;
    if (activeColor && text.trim()) activeHasContent = true;
    offset = match.index + match[0].length;
    if (match[1]) {
      if (activeColor) {
        if (activeHasContent) output += "{color}";
        else output = output.slice(0, activeStart);
      }
      activeColor = cssColorToHex(match[1]).toLowerCase();
      activeStart = output.length;
      activeHasContent = false;
      output += `{color:${activeColor}}`;
      continue;
    }
    if (!activeColor) continue;
    if (activeHasContent) output += "{color}";
    else output = output.slice(0, activeStart);
    activeColor = "";
    activeStart = -1;
    activeHasContent = false;
  }
  const tail = source.slice(offset);
  output += tail;
  if (activeColor) {
    if (tail.trim()) output += "{color}";
    else output = output.slice(0, activeStart);
  }
  return output;
}

function generateMarkup() {
  collectDocumentFields();
  const blocks = [];
  const heading = [];
  const overallColor = STATUS_META[draft.overallStatus].jiraColor;
  heading.push(
    `*Проверено на ${draft.environment}*`,
    `{color:${overallColor}}*ТЕСТ — ${draft.overallStatus}*{color}`,
  );
  blocks.push(heading.join("\n"));
  const intro = htmlToWiki(draft.intro);
  if (intro) blocks.push(intro);

  draft.sections.forEach((section) => {
    const rows = section.rows.filter(hasRowContent);
    if (!rows.length) return;
    const lines = [`h2. ${section.title || "Раздел"}`];
    lines.push(
      `||${["Номер", ...section.columns.map((column) => column.title || "Без названия"), "Статус"].join("||")}||`,
    );
    rows.forEach((row, index) => {
      const values = section.columns.map((column) => jiraCell(row.cells[column.id] || ""));
      const status = `{color:${STATUS_META[row.status].jiraColor}}*${row.status}*{color}`;
      lines.push(`|${[`${index + 1}.`, ...values, status].join("|")}|`);
    });
    blocks.push(lines.join("\n"));
  });
  return blocks.join("\n\n");
}

function byId(items = []) {
  return new Map(items.filter((item) => item?.id).map((item) => [item.id, item]));
}

function generateVisualPreview(sourceDraft = draft, compareDraft = null) {
  if (sourceDraft === draft) collectDocumentFields();
  const previewDraft = normalizeDraft(sourceDraft);
  const oppositeDraft = compareDraft ? normalizeDraft(compareDraft) : null;
  const oppositeSections = byId(oppositeDraft?.sections || []);
  const wrapper = document.createElement("div");
  const overallColor = STATUS_META[previewDraft.overallStatus]?.jiraColor || STATUS_META["НЕ ПРОВЕРЕНО"].jiraColor;
  wrapper.innerHTML = `<h1>Отчёт о тестировании</h1><p><strong>Проверено на ${escapeHtml(previewDraft.environment)}</strong><br><strong style="color:${overallColor}">ТЕСТ — ${escapeHtml(previewDraft.overallStatus)}</strong></p>`;
  if (htmlToText(previewDraft.intro) || /<img|<pre/i.test(previewDraft.intro)) {
    const intro = document.createElement("div");
    intro.className =
      oppositeDraft && cellText(previewDraft.intro) !== cellText(oppositeDraft.intro)
        ? "version-diff-changed"
        : "";
    intro.innerHTML = previewEditorHtml(previewDraft.intro);
    wrapper.append(intro);
  }
  previewDraft.sections.forEach((section) => {
    const oppositeSection = oppositeSections.get(section.id);
    const sectionOnlyHere = Boolean(oppositeDraft && !oppositeSection);
    const oppositeColumns = byId(oppositeSection?.columns || []);
    const oppositeRows = byId(oppositeSection?.rows || []);
    const rows = section.rows.filter(hasRowContent);
    if (!rows.length && !sectionOnlyHere) return;
    const heading = document.createElement("h2");
    heading.textContent = section.title || "Раздел";
    if (sectionOnlyHere || (oppositeSection && (section.title || "") !== (oppositeSection.title || ""))) {
      heading.className = "version-diff-changed";
    }
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    thead.innerHTML = `<tr><th>Номер</th>${section.columns
      .map((column) => {
        const oppositeColumn = oppositeColumns.get(column.id);
        const changed =
          sectionOnlyHere || !oppositeColumn || (column.title || "") !== (oppositeColumn.title || "");
        return `<th class="${changed ? "version-diff-cell" : ""}">${escapeHtml(column.title || "Без названия")}</th>`;
      })
      .join("")}<th>Статус</th></tr>`;
    const tbody = document.createElement("tbody");
    rows.forEach((row, index) => {
      const tr = document.createElement("tr");
      const oppositeRow = oppositeRows.get(row.id);
      const rowOnlyHere = Boolean(oppositeDraft && !oppositeRow);
      if (sectionOnlyHere || rowOnlyHere) tr.classList.add("version-diff-row");
      tr.innerHTML = `<td>${index + 1}.</td>${section.columns
        .map((column) => {
          const oppositeColumn = oppositeColumns.get(column.id);
          const columnOnlyHere = Boolean(oppositeDraft && !oppositeColumn);
          const changed =
            sectionOnlyHere ||
            rowOnlyHere ||
            columnOnlyHere ||
            (oppositeDraft && cellText(row.cells?.[column.id] || "") !== cellText(oppositeRow?.cells?.[column.id] || ""));
          return `<td class="${changed ? "version-diff-cell" : ""}">${previewEditorHtml(row.cells[column.id] || "")}</td>`;
        })
        .join("")}<td class="${sectionOnlyHere || rowOnlyHere || (oppositeDraft && row.status !== oppositeRow?.status) ? "version-diff-cell" : ""}"><strong style="color:${STATUS_META[row.status]?.jiraColor || STATUS_META["НЕ ПРОВЕРЕНО"].jiraColor}">${row.status}</strong></td>`;
      tbody.append(tr);
    });
    table.append(thead, tbody);
    wrapper.append(heading, table);
  });
  return wrapper.innerHTML;
}

function generatePortableHtml() {
  const container = document.createElement("div");
  container.innerHTML = generateVisualPreview();
  container.style.fontFamily = "Arial, sans-serif";
  container.style.color = "#172b4d";
  container.style.background = "#ffffff";
  container.querySelectorAll("h1").forEach((item) => {
    item.style.fontSize = "24px";
    item.style.margin = "0 0 16px";
  });
  container.querySelectorAll("h2").forEach((item) => {
    item.style.fontSize = "19px";
    item.style.margin = "24px 0 8px";
  });
  container.querySelectorAll("table").forEach((table) => {
    table.style.width = "100%";
    table.style.borderCollapse = "collapse";
  });
  container.querySelectorAll("th, td").forEach((cell) => {
    cell.style.padding = "8px";
    cell.style.border = "1px solid #c7cdd4";
    cell.style.verticalAlign = "top";
    cell.style.textAlign = "left";
  });
  container.querySelectorAll("th").forEach((cell) => {
    cell.style.background = "#f1f2f4";
    cell.style.fontWeight = "700";
  });
  container.querySelectorAll("figure").forEach((figure) => {
    figure.style.margin = "6px 0";
  });
  container.querySelectorAll("img").forEach((image) => {
    image.style.display = "block";
    image.style.maxWidth = image.style.width || "320px";
    image.style.height = "auto";
  });
  container.querySelectorAll("pre").forEach((block) => {
    block.style.padding = "10px";
    block.style.border = "1px solid #c7cdd4";
    block.style.borderRadius = "6px";
    block.style.background = "#f4f5f7";
    block.style.whiteSpace = "pre-wrap";
  });
  return container.outerHTML;
}

function previewEditorHtml(html) {
  const container = document.createElement("div");
  container.innerHTML = html || "";
  container.querySelectorAll("[data-editor-ui]").forEach((item) => item.remove());
  container.querySelectorAll(".cell-code-block").forEach((block) => {
    block.classList.remove("code-selected", "code-dragging", "code-expanded");
    block.removeAttribute("draggable");
    block.removeAttribute("tabindex");
  });
  container.querySelectorAll(".cell-image").forEach((figure) => {
    figure.classList.remove("image-selected");
    figure.removeAttribute("tabindex");
  });
  container.querySelectorAll(".cell-file").forEach((card) => {
    card.removeAttribute("tabindex");
  });
  return container.innerHTML;
}

function setReportIdentityState(message, type = "") {
  elements.reportIdentityState.textContent = message;
  elements.reportIdentityState.className = `connection-state ${type}`.trim();
}

function updateCloudHistorySettingsState() {
  const enabled = elements.cloudHistoryEnabled ? Boolean(elements.cloudHistoryEnabled.checked) : cloudHistoryEnabled;
  if (elements.cloudHistoryEnabled) elements.cloudHistoryEnabled.checked = enabled;
  if (elements.reportWorkspaceKey) elements.reportWorkspaceKey.disabled = !enabled;
  const workspaceKey = elements.reportWorkspaceKey?.value?.trim() || reportWorkspaceKey.trim();
  const message = !enabled
    ? "Чек-листы сохраняются только локально в этом браузере."
    : workspaceKey
      ? `Синхронизация включена. Пространство: ${workspaceKey}.`
      : "Синхронизация включена для вашей корпоративной учётной записи.";
  setReportIdentityState(message);
}

function setSettingsSavedState(saved) {
  elements.saveJiraSettingsButton.classList.toggle("is-saved", saved);
  elements.settingsSaveCheck.hidden = !saved;
}

function markSettingsDirty() {
  setSettingsSavedState(false);
}

function fillReportIdentityForm() {
  elements.cloudHistoryEnabled.checked = cloudHistoryEnabled;
  elements.reportClientId.value = reportClientId;
  elements.reportWorkspaceKey.value = reportWorkspaceKey;
  updateCloudHistorySettingsState();
}

function saveReportIdentitySettings() {
  const wasCloudEnabled = cloudHistoryEnabled;
  const previousWorkspaceKey = reportWorkspaceKey;
  cloudHistoryEnabled = Boolean(elements.cloudHistoryEnabled.checked);
  localStorage.setItem(CLOUD_HISTORY_ENABLED_KEY, String(cloudHistoryEnabled));
  reportWorkspaceKey = elements.reportWorkspaceKey.value.trim();
  if (reportWorkspaceKey) {
    localStorage.setItem(WORKSPACE_KEY_STORAGE_KEY, reportWorkspaceKey);
  } else {
    localStorage.removeItem(WORKSPACE_KEY_STORAGE_KEY);
  }
  const workspaceChanged = previousWorkspaceKey !== reportWorkspaceKey;
  if (!cloudHistoryEnabled) {
    hideSyncRecovery();
    serverReportHashes = {};
    dismissedCloudHashes = {};
    saveServerReportHashes();
    saveDismissedCloudHashes();
  } else if (!wasCloudEnabled || workspaceChanged) {
    if (workspaceChanged) {
      serverReportHashes = {};
      dismissedCloudHashes = {};
      saveServerReportHashes();
      saveDismissedCloudHashes();
    }
    saveReportSnapshot(workspaceChanged ? "change-cloud-workspace" : "enable-cloud-history").catch(() => {});
  }
  updateCloudHistorySettingsState();
  elements.reportIdentityState.classList.add("success");
  enhanceImageControls(elements.introEditor);
  enhanceImageControls(elements.sections);
  enhanceFileControls(elements.introEditor);
  enhanceFileControls(elements.sections);
}

function setSettingsSection(section) {
  const history = section === "history";
  const jira = !history;
  elements.settingsJiraSectionButton.classList.toggle("active", jira);
  elements.settingsHistorySectionButton.classList.toggle("active", history);
  elements.settingsJiraSection.hidden = !jira;
  elements.settingsHistorySection.hidden = !history;
  elements.settingsJiraSection.classList.toggle("active", jira);
  elements.settingsHistorySection.classList.toggle("active", history);
  elements.settingsFooter.hidden = !history;
}

async function authCsrfToken() {
  const response = await fetch("/api/auth/csrf", { cache: "no-store" });
  const payload = await response.json();
  return payload.csrfToken;
}

function renderJiraConnections(instances) {
  elements.jiraConnections.replaceChildren();
  if (!instances.length) {
    elements.jiraConnections.innerHTML = `
      <div class="jira-empty-state">
        <strong>Нет доступных подключений</strong>
        <span>Администратор ещё не добавил Jira для этого приложения.</span>
      </div>`;
    return;
  }
  for (const instance of instances) {
    const card = document.createElement("div");
    card.className = "jira-connection-card";
    const description = instance.connected
      ? `Подключено: ${instance.displayName || instance.jiraUsername || "ваша учётная запись"}`
      : `Jira ${instance.version || "Data Center"} · требуется одноразовое подтверждение`;
    card.innerHTML = `<div><strong>${escapeHtml(instance.name)}</strong><small>${escapeHtml(description)}</small></div>`;
    const actions = document.createElement("div");
    actions.className = "jira-connection-actions";
    const button = document.createElement("button");
    button.type = "button";
    button.className = instance.connected ? "button button-secondary" : "button button-primary";
    button.textContent = instance.connected ? "Отключить" : "Подключить";
    button.dataset.jiraConnectionAction = instance.connected ? "disconnect" : "connect";
    button.dataset.instanceId = instance.id;
    actions.append(button);
    card.append(actions);
    elements.jiraConnections.append(card);
  }
}

async function loadJiraConnections() {
  try {
    const response = await fetch("/api/jira/connections", { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    renderJiraConnections(payload.instances || []);
  } catch (error) {
    elements.jiraConnections.innerHTML = `
      <div class="jira-empty-state">
        <strong>Jira пока не настроена</strong>
        <span>${escapeHtml(friendlyJiraError(error))}</span>
      </div>`;
  }
}

async function connectJira(instanceId) {
  const csrfToken = await authCsrfToken();
  const response = await fetch("/api/jira/oauth/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instanceId, csrfToken, callbackUrl: `${location.pathname}${location.search}` }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  location.assign(payload.authorizeUrl);
}

async function disconnectJira(instanceId) {
  const csrfToken = await authCsrfToken();
  const response = await fetch(`/api/jira/connections/${encodeURIComponent(instanceId)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ csrfToken }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  await loadJiraConnections();
}

function openJiraSettings() {
  fillReportIdentityForm();
  setSettingsSection("jira");
  setSettingsSavedState(false);
  setReportIdentityState(
    !cloudHistoryEnabled
      ? "Чек-листы сохраняются только локально в этом браузере."
      : reportWorkspaceKey.trim()
        ? `Синхронизация включена. Пространство: ${reportWorkspaceKey.trim()}.`
        : "Синхронизация включена для вашей корпоративной учётной записи.",
  );
  elements.jiraSettingsModal.hidden = false;
  document.body.style.overflow = "hidden";
  loadJiraConnections();
}

function closeJiraSettings() {
  elements.jiraSettingsModal.hidden = true;
  document.body.style.overflow = "";
}

function saveJiraSettings() {
  try {
    saveReportIdentitySettings();
    setSettingsSavedState(true);
  } catch (error) {
    setSettingsSavedState(false);
    showToast(`Не удалось сохранить настройки: ${error.message}`, 9000);
  }
}

function parseIssueUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new Error("Укажите полную ссылку на задачу Jira");
  }
  const match = url.pathname.match(/\/browse\/([A-Z][A-Z0-9_]*-\d+)(?:\/|$)/i);
  if (!match) throw new Error("В ссылке не найден ключ задачи Jira");
  return { issueKey: match[1].toUpperCase(), issueUrl: url.toString() };
}

class JiraRequestError extends Error {
  constructor(message, { status = 0, path = "", payload = {}, retryAfter = 0, code = "" } = {}) {
    super(message);
    this.name = "JiraRequestError";
    this.status = status;
    this.path = path;
    this.payload = payload;
    this.retryAfter = retryAfter;
    this.code = code;
  }
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Запрос отменён", "AbortError"));
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new DOMException("Запрос отменён", "AbortError"));
      },
      { once: true },
    );
  });
}

function friendlyJiraError(error) {
  if (error?.name === "AbortError") return "Публикация отменена";
  const message = String(error?.message || "");
  if (/JIRA_INSTANCES_JSON|не настроен список Jira/i.test(message)) {
    return "На этом стенде ещё не добавлены адреса Jira. После настройки администратором здесь появятся доступные подключения.";
  }
  if (/не удалось определить Jira|отсутствует в серверном allowlist|другому адресу Jira/i.test(message)) {
    return "Эта Jira пока не подключена к приложению. Обратитесь к администратору, чтобы добавить её адрес.";
  }
  if (/не найден идентификатор комментария/i.test(message)) {
    return "Это ссылка на задачу, а нужна ссылка именно на комментарий. В Jira откройте меню нужного комментария, выберите «Скопировать ссылку» и вставьте её сюда.";
  }
  if (error instanceof JiraRequestError) {
    if (error.status === 413) return "Запрос слишком большой. Уменьшите размер вложения или отчёта.";
    if (error.status === 429) return "Jira временно ограничила частоту запросов. Повторите позже.";
    if (error.code === "JIRA_AUTH_REQUIRED" || error.status === 401) {
      return "Сначала откройте Настройки → Jira и подключите нужную Jira.";
    }
    if (error.status === 403) return "У вашей учётной записи Jira недостаточно прав для этого действия.";
    if (error.status === 404) return "Комментарий или задача не найдены. Проверьте ссылку и доступ к задаче.";
    if (error.status >= 500) return "Jira сейчас недоступна. Попробуйте ещё раз немного позже.";
  }
  return message || "Не удалось выполнить действие в Jira. Попробуйте ещё раз.";
}

function validateJiraCommentUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new Error("Вставьте полную ссылку на комментарий Jira.");
  }
  const commentId =
    url.searchParams.get("focusedCommentId") ||
    url.searchParams.get("commentId") ||
    url.searchParams.get("selectedItem")?.match(/comment-(\d+)/i)?.[1] ||
    url.hash.match(/comment-(\d+)/i)?.[1];
  if (!/^\d+$/.test(String(commentId || ""))) {
    throw new Error("Это ссылка на задачу, а нужна ссылка именно на комментарий. В Jira откройте меню нужного комментария, выберите «Скопировать ссылку» и вставьте её сюда.");
  }
  return url.toString();
}

function shouldOpenJiraSettings(error) {
  if (error instanceof JiraRequestError) return error.code === "JIRA_AUTH_REQUIRED" || error.status === 401 || error.status === 403;
  return /настро|токен|адрес|ключ/i.test(error?.message || "");
}

async function jiraRequest(path, body, options = {}) {
  const { signal, retries = 0 } = options;
  let attempt = 0;
  while (true) {
    try {
      const safeBody = { ...(body || {}) };
      for (const field of ["token", "password", "cookie", "authorization", "user", "baseUrl", "authMethod"]) delete safeBody[field];
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(safeBody),
        signal,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const retryAfter = Number(response.headers.get("Retry-After") || 0);
        throw new JiraRequestError(result.error || `Ошибка подключения: HTTP ${response.status}`, {
          status: response.status,
          path,
          payload: result,
          retryAfter: Number.isFinite(retryAfter) ? retryAfter : 0,
          code: result.errorCode || "",
        });
      }
      return result;
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      const retryable =
        error instanceof JiraRequestError
          ? error.status === 429 || error.status >= 500
          : true;
      if (!retryable || attempt >= retries) throw error;
      const delay =
        error instanceof JiraRequestError && error.retryAfter
          ? Math.min(error.retryAfter * 1000, 8000)
          : error instanceof JiraRequestError && error.status === 429
            ? 1200 * (attempt + 1)
            : 800;
      attempt += 1;
      await wait(delay, signal);
    }
  }
}

async function publishJiraRequest(path, body, options = {}) {
  const retries = path.includes("/attachments") ? 2 : 1;
  return jiraRequest(path, body, { ...options, retries });
}

function assertCurrentBackend(result) {
  if (Number(result?.apiRevision) >= REQUIRED_API_REVISION) return;
  throw new Error(
    "Интерфейс обновлён, но сервер приложения запущен на старой версии. " +
      "Полностью перезапустите Node-процесс или пересоберите Docker-контейнер.",
  );
}

async function checkBackendCompatibility() {
  const response = await fetch("/api/health", { cache: "no-store" });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Backend приложения недоступен: HTTP ${response.status}`);
  assertCurrentBackend(result);
  objectStorageConfigured = Boolean(result.objectStorageConfigured);
  return result;
}

async function refreshObjectStorageUi() {
  try {
    await checkBackendCompatibility();
  } catch {
    objectStorageConfigured = false;
  }
  enhanceImageControls(elements.introEditor);
  enhanceImageControls(elements.sections);
  enhanceFileControls(elements.introEditor);
  enhanceFileControls(elements.sections);
}

const PUBLISH_STEPS = ["prepare", "attachments", "comment", "verify"];

function openPublishProgress() {
  elements.publishProgressModal.hidden = false;
  elements.publishCancelButton.textContent = "Отменить";
  elements.publishCancelButton.disabled = false;
  elements.publishErrorText.hidden = true;
  elements.publishErrorText.textContent = "";
  elements.publishProgressHint.textContent = "Не закрывайте страницу до завершения публикации.";
  document.body.style.overflow = "hidden";
}

function closePublishProgress() {
  elements.publishProgressModal.hidden = true;
  if (
    elements.previewModal.hidden &&
    elements.importModal.hidden &&
    elements.jiraSettingsModal.hidden &&
    elements.feedbackModal.hidden
  ) {
    document.body.style.overflow = "";
  }
}

function setPublishProgress({ step = "prepare", percent = 0, status = "", error = "" } = {}) {
  elements.publishProgressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  elements.publishStatusText.textContent = status || "Публикация в Jira";
  elements.publishSteps.querySelectorAll("li").forEach((item) => {
    const index = PUBLISH_STEPS.indexOf(item.dataset.step);
    const current = PUBLISH_STEPS.indexOf(step);
    item.classList.toggle("done", index >= 0 && index < current && !error);
    item.classList.toggle("active", item.dataset.step === step && !error);
    item.classList.toggle("error", item.dataset.step === step && Boolean(error));
  });
  if (error) {
    elements.publishErrorText.textContent = error;
    elements.publishErrorText.hidden = false;
    elements.publishProgressHint.textContent = "Черновик сохранён. Уже созданные вложения или комментарии не откатываются.";
    elements.publishCancelButton.textContent = "Закрыть";
    elements.publishCancelButton.disabled = false;
  }
}

function finishPublishProgress(status) {
  setPublishProgress({ step: "verify", percent: 100, status });
  elements.publishSteps.querySelectorAll("li").forEach((item) => {
    item.classList.remove("active", "error");
    item.classList.add("done");
  });
  elements.publishCancelButton.textContent = "Закрыть";
  elements.publishCancelButton.disabled = false;
  elements.publishProgressHint.textContent = "Публикация завершена.";
}

function cancelPublishProgress() {
  if (publishInProgress && publishAbortController) {
    publishAbortController.abort();
    elements.publishCancelButton.disabled = true;
    elements.publishStatusText.textContent = "Останавливаем публикацию...";
    return;
  }
  closePublishProgress();
}

async function uploadPendingImages(settings, issue, options = {}) {
  const { signal, onProgress = () => {} } = options;
  const files = [...collectLocalImages(), ...collectLocalFiles()];
  if (!files.length) return [];
  const uploaded = [];
  let index = 0;
  onProgress({ done: 0, total: files.length });
  while (index < files.length) {
    signal?.throwIfAborted?.();
    const batch = files.slice(index, index + ATTACHMENT_UPLOAD_BATCH_SIZE);
    try {
      const result = await publishJiraRequest(
        "/api/jira/attachments",
        {
          ...settings,
          ...issue,
          files: batch.map(({ attachmentId, name, type, dataBase64 }) => ({
            attachmentId,
            name,
            type,
            dataBase64,
          })),
        },
        { signal },
      );
      const attachments = result.attachments || [];
      uploaded.push(...attachments);
      applyUploadedAttachments(attachments);
      saveDraft();
      index += batch.length;
      onProgress({ done: index, total: files.length, current: batch.at(-1)?.name || "" });
    } catch (error) {
      if (error instanceof JiraRequestError && error.status === 413 && batch.length === 1) {
        throw new JiraRequestError(
          `Вложение «${batch[0].name}» слишком большое для nginx/Jira. ` +
            "Файлы отправляются по одному; если файл небольшой, увеличьте лимит тела запроса в reverse proxy.",
          {
            status: 413,
            path: "/api/jira/attachments",
            payload: error.payload,
          },
        );
      }
      throw error;
    }
  }
  saveDraft();
  render();
  return uploaded;
}

function splitWikiComment(comment) {
  const body = String(comment.body || "");
  const blocks = body.split(/\n\n(?=h2\. )/);
  if (blocks.length <= 1) return [];
  return blocks.map((block, index) => ({
    format: "wiki",
    body: `*Часть ${index + 1} из ${blocks.length}*\n\n${block}`,
  }));
}

function splitJiraComment(comment) {
  return splitWikiComment(comment);
}

async function postJiraComment(settings, issue, comment, signal) {
  const result = await publishJiraRequest(
    "/api/jira/comment",
    {
      ...settings,
      ...issue,
      comment,
    },
    { signal },
  );
  assertCurrentBackend(result);
  if (!result.verified || !result.commentId) {
    throw new Error(
      `Backend ${result.appVersion || "неизвестной версии"} не вернул подтверждение комментария`,
    );
  }
  return result;
}

async function publishCommentWithFallback(settings, issue, comment, signal) {
  try {
    return [await postJiraComment(settings, issue, comment, signal)];
  } catch (error) {
    if (!(error instanceof JiraRequestError) || error.status !== 413) throw error;
    const parts = splitJiraComment(comment);
    if (!parts.length) throw error;
    const results = [];
    for (let index = 0; index < parts.length; index += 1) {
      setPublishProgress({
        step: "comment",
        percent: 72 + Math.round(((index + 1) / parts.length) * 16),
        status: `Публикация комментария: часть ${index + 1} из ${parts.length}`,
      });
      results.push(await postJiraComment(settings, issue, parts[index], signal));
    }
    return results;
  }
}

async function publishToJira() {
  const publishButtonHtml = elements.publishButton.innerHTML;
  if (publishInProgress) return;
  try {
    collectDocumentFields();
    const issue = parseIssueUrl(draft.issueUrl);
    const settings = {};
    await checkBackendCompatibility();
    const confirmed = await askConfirmation(
      `Опубликовать отчёт комментарием в задаче ${issue.issueKey}?`,
      { title: "Отправка в Jira", confirmText: "Отправить" },
    );
    if (!confirmed) return;
    publishAbortController = new AbortController();
    publishInProgress = true;
    openPublishProgress();
    setPublishProgress({ step: "prepare", percent: 8, status: "Подготовка отчёта" });
    elements.publishButton.disabled = true;
    elements.publishButton.innerHTML =
      '<span class="primary-action-icon">…</span><span class="primary-action-label">Отправляем…</span>';
    await uploadPendingImages(settings, issue, {
      signal: publishAbortController.signal,
      onProgress: ({ done, total }) => {
        const percent = total ? 15 + Math.round((done / total) * 45) : 55;
        setPublishProgress({
          step: "attachments",
          percent,
          status: `Загрузка вложений: ${done} из ${total}`,
        });
      },
    });
    const comment = { format: "wiki", body: generateMarkup() };
    setPublishProgress({ step: "comment", percent: 68, status: "Публикация комментария" });
    const results = await publishCommentWithFallback(settings, issue, comment, publishAbortController.signal);
    setPublishProgress({ step: "verify", percent: 96, status: "Проверка созданного комментария" });
    const result = results.at(-1);
    finishPublishProgress(
      results.length > 1
        ? `Опубликовано комментариев: ${results.length}`
        : "Комментарий опубликован",
    );
    showToast(`Опубликовано в ${issue.issueKey}`);
    if (result?.commentUrl) window.open(result.commentUrl, "_blank", "noopener");
  } catch (error) {
    console.error("Ошибка публикации Jira:", error);
    const message = friendlyJiraError(error);
    setPublishProgress({
      step:
        error instanceof JiraRequestError && error.path.includes("/attachments")
          ? "attachments"
          : error instanceof JiraRequestError && error.path.includes("/comment")
            ? "comment"
            : "prepare",
      percent: 100,
      status: "Публикация остановлена",
      error: message,
    });
    showToast(message, 9000);
    if (shouldOpenJiraSettings(error)) openJiraSettings();
  } finally {
    publishInProgress = false;
    publishAbortController = null;
    elements.publishButton.disabled = false;
    elements.publishButton.innerHTML = publishButtonHtml;
  }
}

function openPreview() {
  elements.markupPreview.value = generateMarkup();
  elements.visualPreview.innerHTML = generateVisualPreview();
  elements.previewModal.hidden = false;
  document.body.style.overflow = "hidden";
}

function closePreview() {
  elements.previewModal.hidden = true;
  document.body.style.overflow = "";
}

function openImport() {
  elements.importMarkup.value = "";
  elements.commentImportUrl.value = "";
  elements.importWarning.hidden = true;
  elements.importSummary.hidden = true;
  pendingImportedDraft = null;
  elements.importModal.hidden = false;
  document.body.style.overflow = "hidden";
  if (importSource === "markup") elements.importMarkup.focus();
}

function closeImport() {
  elements.importModal.hidden = true;
  document.body.style.overflow = "";
}

function setFocusMode(enabled) {
  document.querySelector(".app-shell").classList.toggle("focus-mode", enabled);
  document.body.classList.toggle("focus-mode-active", enabled);
  elements.focusExitButton.hidden = !enabled;
  elements.focusModeButton.querySelector("span:last-child").textContent = enabled ? "Выйти" : "Фокус";
  requestAnimationFrame(scheduleStickySectionUpdate);
}

async function openHistory() {
  await saveReportSnapshot("open-history").catch(() => {});
  elements.historyModal.hidden = false;
  document.body.style.overflow = "hidden";
  await renderHistoryList();
}

async function saveHistoryCommentNow(report, commentField) {
  const key = `${report.source}:${report.id}`;
  clearTimeout(historyCommentTimers.get(key));
  historyCommentTimers.delete(key);
  const value = commentField.value;
  if (value === (report.historyComment || "")) return;
  const action =
    report.source === "server"
      ? updateServerReportComment(report.id, value)
      : updateLocalReportComment(report.id, value);
  await action;
  if (report.source === "server") {
    await updateLocalReportComment(report.id, value).catch(() => {});
  }
  report.historyComment = value;
  if (report.id === draft.reportId) setSaveStatus("Комментарий сохранён");
}

async function flushVisibleHistoryComments() {
  const fields = [...elements.historyList.querySelectorAll(".history-comment-field")];
  await Promise.allSettled(fields.map((field) => field.__saveHistoryComment?.()));
}

function closeHistory() {
  flushVisibleHistoryComments().catch(() => setSaveStatus("Ошибка комментария"));
  elements.historyModal.hidden = true;
  document.body.style.overflow = "";
}

async function renderHistoryList() {
  const reports = await getAllHistoryReports();
  const query = elements.historySearch.value.trim().toLowerCase();
  const filtered = reports.filter((report) =>
    `${report.title} ${report.issueKey} ${report.issueUrl} ${report.historyComment || ""}`.toLowerCase().includes(query),
  );
  const serverCount = reports.filter((report) => report.source === "server").length;
  const localCount = reports.length - serverCount;
  elements.historyUsage.textContent = `Всего: ${reports.length} · Облако: ${serverCount} · Локально: ${localCount}`;
  elements.historyList.innerHTML = "";
  if (!filtered.length) {
    const title = reports.length ? "Ничего не найдено" : "Отчётов пока нет";
    elements.historyList.innerHTML = `<div class="history-empty"><p>${title}</p><button class="button button-primary" type="button" data-create-empty-report>Создать</button></div>`;
    elements.historyList.querySelector("[data-create-empty-report]")?.addEventListener("click", () => {
      closeHistory();
      resetDraft();
    });
    return;
  }
  filtered.forEach((report) => {
    const item = document.createElement("article");
    item.className = "history-item";
    item.classList.toggle("current", report.id === draft.reportId);
    const info = document.createElement("div");
    info.className = "history-item-info";
    const publicId = reportPublicId(report);
    const issueLabel = report.issueKey || issueKeyFromUrl(report.issueUrl) || "Без задачи";
    info.innerHTML = `<h3>${escapeHtml(issueLabel)}</h3><p><code>${escapeHtml(publicId)}</code> · ${new Date(report.updatedAt).toLocaleString("ru-RU")}</p>`;
    const commentField = document.createElement("textarea");
    commentField.className = "history-comment-field";
    commentField.rows = 2;
    commentField.placeholder = "Комментарий к отчёту";
    commentField.value = report.historyComment || "";
    commentField.__saveHistoryComment = () => saveHistoryCommentNow(report, commentField);
    commentField.addEventListener("input", () => {
      const key = `${report.source}:${report.id}`;
      clearTimeout(historyCommentTimers.get(key));
      historyCommentTimers.set(
        key,
        setTimeout(() => {
          saveHistoryCommentNow(report, commentField).catch(() => setSaveStatus("Ошибка комментария"));
        }, 500),
      );
    });
    commentField.addEventListener("blur", () => {
      saveHistoryCommentNow(report, commentField).catch(() => setSaveStatus("Ошибка комментария"));
    });
    const actions = document.createElement("div");
    actions.className = "history-item-actions";
    const openButton = createSmallButton("Открыть", async () => {
      await saveReportSnapshot("before-open-history");
      const fullReport = report.source === "server" ? await getServerReport(report.id) : report;
      suppressHistory = true;
      draft = normalizeDraft(clone(fullReport.document));
      historyCurrent = serializeDraft();
      undoStack = [];
      redoStack = [];
      render();
      updateChecklistUrl(draft.publicId);
      saveDraft();
      suppressHistory = false;
      closeHistory();
      showToast("Отчёт восстановлен из истории");
    });
    const copyButton = createSmallButton("Копия", async () => {
      await saveReportSnapshot("before-copy-history");
      const fullReport = report.source === "server" ? await getServerReport(report.id) : report;
      draft = normalizeDraft(clone(fullReport.document));
      draft.draftId = crypto.randomUUID();
      draft.reportId = crypto.randomUUID();
      draft.publicId = createPublicId();
      historyCurrent = serializeDraft();
      undoStack = [];
      redoStack = [];
      render();
      updateChecklistUrl(draft.publicId);
      saveDraft();
      closeHistory();
      showToast("Создана копия отчёта");
    });
    const deleteButton = createSmallButton("Удалить", async () => {
      const confirmed = await askConfirmation(`Удалить отчёт «${report.title}»?`, {
        title: "Удаление отчёта",
        confirmText: "Удалить",
        danger: true,
      });
      if (!confirmed) return;
      if (report.source === "server") {
        await deleteServerReport(report.id);
      } else {
        await deleteReportRecord(report.id);
      }
      if (report.id === draft.reportId) {
        draft = normalizeDraft({
          ...clone(DEFAULT_DRAFT),
          draftId: crypto.randomUUID(),
          reportId: crypto.randomUUID(),
          publicId: createPublicId(),
        });
        historyCurrent = serializeDraft();
        undoStack = [];
        redoStack = [];
        render();
        updateChecklistUrl(draft.publicId);
        updateHistoryButtons();
      }
      await renderHistoryList();
    }, true);
    actions.append(openButton, copyButton, deleteButton);
    item.append(info, commentField, actions);
    elements.historyList.append(item);
  });
}

function createSmallButton(label, action, danger = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `button button-ghost${danger ? " danger-text" : ""}`;
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

function insertHtmlAtCursor(html) {
  activeEditor.focus();
  document.execCommand("insertHTML", false, html);
  activeEditor.dispatchEvent(new Event("input", { bubbles: true }));
}

function insertHtmlAtSelection(html, preferredRange = null) {
  const selection = window.getSelection();
  const preferredNode = preferredRange?.commonAncestorContainer;
  let range =
    preferredRange && preferredNode?.isConnected && activeEditor.contains(preferredNode)
      ? preferredRange.cloneRange()
      : selection?.rangeCount && activeEditor.contains(selection.anchorNode)
        ? selection.getRangeAt(0)
        : null;
  if (!range) {
    range = document.createRange();
    range.selectNodeContents(activeEditor);
    range.collapse(false);
  }
  range.deleteContents();
  const template = document.createElement("template");
  template.innerHTML = html;
  const fragment = template.content;
  const lastNode = fragment.lastChild;
  range.insertNode(fragment);
  if (lastNode) {
    range.setStartAfter(lastNode);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    savedEditorRange = range.cloneRange();
  }
  activeEditor.normalize();
  activeEditor.dispatchEvent(new Event("input", { bubbles: true }));
}

function cleanEditorHtml(editor) {
  const clone = editor.cloneNode(true);
  clone.querySelectorAll("[data-editor-ui]").forEach((item) => item.remove());
  clone.querySelectorAll(".cell-code-block").forEach((block) => {
    block.classList.remove("code-collapsed", "code-expanded", "code-selected", "code-dragging");
    delete block.dataset.previousColumnWidth;
    delete block.dataset.dragBound;
    block.removeAttribute("draggable");
    block.removeAttribute("tabindex");
  });
  clone.querySelectorAll(".cell-image").forEach((figure) => {
    figure.classList.remove("image-selected", "image-dragging");
    delete figure.dataset.dragBound;
    figure.removeAttribute("draggable");
    figure.removeAttribute("tabindex");
  });
  clone.querySelectorAll(".cell-file").forEach((card) => {
    card.removeAttribute("tabindex");
  });
  return sanitizeRichHtml(clone.innerHTML);
}

function cssColorToHex(color) {
  if (/^#[0-9a-f]{3,8}$/i.test(color)) return color.toLowerCase();
  const match = String(color).match(/\d+(?:\.\d+)?/g);
  if (!match || match.length < 3) return color;
  return `#${match
    .slice(0, 3)
    .map((value) => Math.max(0, Math.min(255, Number(value))).toString(16).padStart(2, "0"))
    .join("")}`;
}

async function writeClipboardText(value, successMessage = "Скопировано") {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  showToast(successMessage);
}

function codeSnippetHtml(language, code, width = "") {
  const widthStyle = width ? ` style="width:${escapeHtml(width)}"` : "";
  return `<pre class="cell-code-block" data-qa-code-snippet="true" data-language="${escapeHtml(language || "text")}"${widthStyle}><code>${escapeHtml(code)}</code></pre>`;
}

async function copyCodeSnippet(block, language, code) {
  const jiraCode = `{code}\n${code}\n{code}`;
  const html = codeSnippetHtml(language, code, block.style.width || "");
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      throw new Error("Расширенный буфер обмена не поддерживается");
    }
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([jiraCode], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      }),
    ]);
    showToast("Код скопирован: Jira-разметка и сниппет");
  } catch {
    await writeClipboardText(jiraCode, "Код скопирован в разметке Jira");
  }
}

function highlightJson(code) {
  const escaped = escapeHtml(code);
  return escaped.replace(
    /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"\s*:)|("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match, key, string, literal, number) => {
      if (key) return `<span class="code-key">${key}</span>`;
      if (string) return `<span class="code-string">${string}</span>`;
      if (literal) return `<span class="code-literal">${literal}</span>`;
      if (number) return `<span class="code-number">${number}</span>`;
      return match;
    },
  );
}

function createObjectActionButton({ icon, title, className = "", action }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `object-action-button ${className}`.trim();
  button.title = title;
  button.setAttribute("aria-label", title);
  button.append(createUiIcon(icon));
  button.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await action(event, button);
  });
  return button;
}

function createImageResizeHint() {
  const hint = document.createElement("span");
  hint.className = "image-resize-hint";
  hint.dataset.editorUi = "true";
  hint.contentEditable = "false";
  hint.title = "Потяните угол, чтобы изменить размер";
  hint.setAttribute("aria-hidden", "true");
  hint.innerHTML =
    '<svg viewBox="0 0 20 20" focusable="false">' +
    '<path d="M6 14 14 6" />' +
    '<path d="M10.5 6H14v3.5" />' +
    '<path d="M9.5 14H6v-3.5" />' +
    "</svg>";
  return hint;
}

function highlightCodeBlock(block) {
  const code = extractCodeText(block);
  let codeElement = block.querySelector(":scope > code");
  if (!codeElement) {
    codeElement = document.createElement("code");
    block.replaceChildren(codeElement);
  }
  codeElement.innerHTML = escapeHtml(code);
  block.querySelectorAll(":scope > [data-editor-ui]").forEach((item) => item.remove());
  const lines = code.split("\n").length;
  block.classList.remove("code-collapsed", "code-expanded");
  block.classList.add("code-preview");
  block.tabIndex = 0;
  block.setAttribute("aria-label", `Код, ${lines} ${pluralizeLines(lines)}. Открыть код`);

  const meta = document.createElement("span");
  meta.className = "code-preview-meta";
  meta.dataset.editorUi = "true";
  meta.contentEditable = "false";
  meta.textContent = `Код · ${lines} ${pluralizeLines(lines)}`;

  const controls = document.createElement("span");
  controls.className = "object-action-panel code-controls";
  controls.dataset.editorUi = "true";
  controls.contentEditable = "false";

  const copyButton = createObjectActionButton({
    icon: "copy",
    title: "Копировать код",
    className: "code-copy",
    action: () => copyCodeSnippet(block, block.dataset.language || "text", code),
  });
  const menuButton = createObjectActionButton({
    icon: "more",
    title: "Действия с кодом",
    className: "code-menu",
    action: (_event, button) =>
      showFloatingMenu(button, [
        {
          label: "Преобразовать в текст",
          icon: "code",
          action: () => convertCodeSnippetToText(block),
        },
      ]),
  });
  const deleteButton = createObjectActionButton({
    icon: "trash",
    title: "Удалить фрагмент кода",
    className: "object-action-danger code-delete",
    action: () => deleteEditorObject(block, "Фрагмент кода удалён — отменить можно через Ctrl/Cmd+Z"),
  });
  controls.append(copyButton, deleteButton, menuButton);
  block.prepend(meta, controls);
  enableCodeObject(block);
}

function pluralizeLines(count) {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return "строк";
  if (mod10 === 1) return "строка";
  if (mod10 >= 2 && mod10 <= 4) return "строки";
  return "строк";
}

function highlightCodeBlocks(root = document) {
  root.querySelectorAll("pre.cell-code-block").forEach((block) => {
    ensureCodeBlockBoundaries(block);
    highlightCodeBlock(block);
  });
}

function ensureCodeBlockBoundaries(block) {
  const createParagraph = () => {
    const paragraph = document.createElement("p");
    paragraph.innerHTML = "<br>";
    return paragraph;
  };
  if (!block.previousSibling || block.previousSibling.nodeType !== Node.ELEMENT_NODE) {
    block.before(createParagraph());
  }
  if (!block.nextSibling || block.nextSibling.nodeType !== Node.ELEMENT_NODE) {
    block.after(createParagraph());
  }
}

function getCodeColumnContext(block) {
  const editor = block.closest(".cell-editor");
  const sectionElement = block.closest(".check-section");
  if (!editor || !sectionElement) return null;
  const section = draft.sections.find((item) => item.id === sectionElement.dataset.sectionId);
  const column = section?.columns.find((item) => item.id === editor.dataset.columnId);
  if (!column) return null;
  const header = sectionElement.querySelector(`th[data-column-id="${column.id}"]`);
  const columnIndex = header ? [...header.parentElement.children].indexOf(header) : -1;
  if (columnIndex < 0) return null;
  return { editor, sectionElement, section, column, columnIndex };
}

function applyColumnWidth(context, width) {
  context.column.width = Math.max(140, Math.min(1000, Math.round(width)));
  updateSectionColumnLayout(
    context.sectionElement,
    context.columnIndex,
    context.column.width,
    52 + 164 + 46 + context.section.columns.reduce((sum, item) => sum + (Number(item.width) || 240), 0),
  );
  scheduleSave();
}

function expandColumnForCode(block) {
  const context = getCodeColumnContext(block);
  if (!context) return;
  if (!block.dataset.previousColumnWidth) {
    block.dataset.previousColumnWidth = String(Number(context.column.width) || 240);
  }
  const desiredWidth = Math.min(
    1000,
    Math.max(Number(context.column.width) || 240, block.scrollWidth + 44),
  );
  if (desiredWidth > (Number(context.column.width) || 240)) {
    applyColumnWidth(context, desiredWidth);
  }
}

function restoreColumnAfterCode(block) {
  const context = getCodeColumnContext(block);
  const previousWidth = Number(block.dataset.previousColumnWidth);
  if (!context || !previousWidth) return;
  const anotherExpandedBlock = context.sectionElement.querySelector(
    `.cell-editor[data-column-id="${context.column.id}"] .cell-code-block.code-expanded`,
  );
  delete block.dataset.previousColumnWidth;
  if (!anotherExpandedBlock) applyColumnWidth(context, previousWidth);
}

function selectCodeBlock(block) {
  document.querySelectorAll(".cell-code-block.code-selected").forEach((item) => {
    if (item !== block) item.classList.remove("code-selected");
  });
  document.querySelectorAll(".cell-image.image-selected").forEach((item) => item.classList.remove("image-selected"));
  block.classList.add("code-selected");
  block.tabIndex = 0;
  block.focus({ preventScroll: true });
}

function commitCodeChange(block) {
  const editor = block.closest(".cell-editor, .intro-editor");
  editor?.dispatchEvent(new Event("input", { bubbles: true }));
}

function startCodeResize(event, block) {
  event.preventDefault();
  event.stopPropagation();
  selectCodeBlock(block);
  suppressObjectOpenUntil.set(block, Date.now() + 500);
  const editor = block.closest(".cell-editor, .intro-editor");
  const startX = event.clientX;
  const startWidth = block.getBoundingClientRect().width;
  const maxWidth = Math.max(160, editor?.clientWidth || startWidth);
  document.body.classList.add("resizing-code");
  const onMove = (moveEvent) => {
    const width = Math.max(160, Math.min(maxWidth, startWidth + moveEvent.clientX - startX));
    block.style.width = `${Math.round(width)}px`;
  };
  const onEnd = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onEnd);
    document.removeEventListener("pointercancel", onEnd);
    document.body.classList.remove("resizing-code");
    suppressObjectOpenUntil.set(block, Date.now() + 300);
    commitCodeChange(block);
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onEnd);
  document.addEventListener("pointercancel", onEnd);
}

function rangeFromPoint(x, y, editor) {
  const nativeRange =
    document.caretRangeFromPoint?.(x, y) ||
    document.caretPositionFromPoint?.(x, y);
  if (nativeRange?.offsetNode) {
    if (!editor.contains(nativeRange.offsetNode)) return null;
    const converted = document.createRange();
    converted.setStart(nativeRange.offsetNode, nativeRange.offset);
    converted.collapse(true);
    return converted;
  }
  return nativeRange && editor.contains(nativeRange.startContainer) ? nativeRange : null;
}

function enableCodeObject(block) {
  block.draggable = true;
  if (block.dataset.dragBound === "true") return;
  block.dataset.dragBound = "true";
  block.addEventListener("dragstart", (event) => {
    if (event.target.closest("[data-editor-ui]")) {
      event.preventDefault();
      return;
    }
    event.stopPropagation();
    const language = block.dataset.language || "text";
    const code = extractCodeText(block);
    draggedCodeBlock = block;
    suppressObjectOpenUntil.set(block, Date.now() + 500);
    block.classList.add("code-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", `{code}\n${code}\n{code}`);
    event.dataTransfer.setData("text/html", codeSnippetHtml(language, code, block.style.width || ""));
  });
  block.addEventListener("dragend", () => {
    block.classList.remove("code-dragging");
    suppressObjectOpenUntil.set(block, Date.now() + 300);
    draggedCodeBlock = null;
    document.querySelectorAll(".code-drop-target").forEach((item) => item.classList.remove("code-drop-target"));
  });
}

function parseCodeFromClipboard(html, plainText) {
  if (html) {
    const container = document.createElement("div");
    container.innerHTML = html;
    const block = container.querySelector("pre[data-qa-code-snippet], pre.cell-code-block");
    if (block) {
      return {
        language: block.dataset.language || detectCodeLanguage(block.textContent || ""),
        code: block.textContent || "",
        width: block.style.width || "",
      };
    }
  }
  const fenced = String(plainText || "").match(/^\s*```([a-z0-9_-]*)[^\n]*\n([\s\S]*?)\n```\s*$/i);
  if (fenced) {
    return {
      language: (fenced[1] || detectCodeLanguage(fenced[2])).trim().toLowerCase(),
      code: fenced[2],
      width: "",
    };
  }
  const match = String(plainText || "").match(/^\s*\{code(?::([^}]+))?\}\r?\n?([\s\S]*?)\r?\n?\{code\}\s*$/i);
  if (!match) return null;
  return {
    language: (match[1] || detectCodeLanguage(match[2])).trim().toLowerCase(),
    code: match[2],
    width: "",
  };
}

function insertCodeSnippet(editor, snippet, range = null) {
  activeEditor = editor;
  const code = formatCode(snippet.code);
  const language = String(snippet.language || detectCodeLanguage(code) || "text").toLowerCase();
  const html = `<p><br></p>${codeSnippetHtml(language, code, snippet.width)}<p><br></p>`;
  insertHtmlAtSelection(html, range);
  highlightCodeBlocks(editor);
}

function textToEditorHtml(value) {
  return escapeHtml(String(value || "")).replace(/\r\n?/g, "\n").replace(/\n/g, "<br>");
}

function stripInlineColors(root) {
  root.querySelectorAll?.("span[style], font[color]").forEach((node) => {
    if (node.matches("span[style]")) node.style.color = "";
    if (node.matches("font[color]")) node.removeAttribute("color");
    const element = node;
    if (element.getAttribute("style") === "") element.removeAttribute("style");
    if (
      element.tagName === "FONT" ||
      (element.tagName === "SPAN" && !element.getAttribute("style") && !element.attributes.length)
    ) {
      element.replaceWith(...element.childNodes);
    }
  });
}

function wrapSelectionWithColor(range, color) {
  const fragment = range.extractContents();
  stripInlineColors(fragment);
  const span = document.createElement("span");
  span.style.color = color;
  span.append(fragment);
  range.insertNode(span);
  range.setStartAfter(span);
  range.collapse(true);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  savedEditorRange = range.cloneRange();
}

function convertCodeSnippetToText(block) {
  const editor = block.closest(".cell-editor, .intro-editor");
  if (!editor) return;
  if (block.matches(".cell-code-block.code-expanded")) restoreColumnAfterCode(block);
  const code = extractCodeText(block);
  const replacement = document.createElement("p");
  replacement.innerHTML = textToEditorHtml(code) || "<br>";
  block.replaceWith(replacement);
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  showToast("Код преобразован в текст — отменить можно через Ctrl/Cmd+Z");
}

function deleteEditorObject(object, message) {
  const editor = object.closest(".cell-editor, .intro-editor");
  if (object.matches(".cell-code-block.code-expanded")) restoreColumnAfterCode(object);
  object.remove();
  editor?.dispatchEvent(new Event("input", { bubbles: true }));
  showToast(message);
}

function openCodeEditor(block) {
  editingCodeBlock = block;
  codeEditorInitialValue = extractCodeText(block);
  elements.codeEditorTextarea.value = codeEditorInitialValue;
  updateCodeEditorLineNumbers();
  elements.codeEditorLanguage.textContent = `${codeEditorInitialValue.split("\n").length} ${pluralizeLines(codeEditorInitialValue.split("\n").length)}`;
  elements.codeEditorState.textContent = "Изменений нет";
  elements.saveCodeButton.disabled = true;
  elements.codeEditorModal.hidden = false;
  setCodeEditorBackgroundInert(true);
  document.body.style.overflow = "hidden";
  requestAnimationFrame(() => elements.codeEditorTextarea.focus());
}

function setCodeEditorBackgroundInert(inert) {
  document.querySelectorAll(".topbar, .workspace, #focusExitButton, #feedbackButton").forEach((element) => {
    element.inert = inert;
  });
}

function updateCodeEditorLineNumbers() {
  const lineCount = Math.max(1, elements.codeEditorTextarea.value.split("\n").length);
  elements.codeEditorLineNumbers.textContent = Array.from(
    { length: lineCount },
    (_, index) => index + 1,
  ).join("\n");
  elements.codeEditorLineNumbers.scrollTop = elements.codeEditorTextarea.scrollTop;
}

function codeEditorIsDirty() {
  return (
    !elements.codeEditorModal.hidden &&
    Boolean(editingCodeBlock) &&
    elements.codeEditorTextarea.value !== codeEditorInitialValue
  );
}

function saveCodeChanges() {
  if (!editingCodeBlock?.isConnected) return closeCodeEditor(true);
  const code = formatCode(elements.codeEditorTextarea.value);
  let codeElement = editingCodeBlock.querySelector(":scope > code");
  if (!codeElement) {
    codeElement = document.createElement("code");
    editingCodeBlock.append(codeElement);
  }
  codeElement.textContent = code;
  codeEditorInitialValue = code;
  highlightCodeBlock(editingCodeBlock);
  commitCodeChange(editingCodeBlock);
  closeCodeEditor(true);
  showToast("Изменения кода сохранены");
}

async function closeCodeEditor(force = false) {
  if (!force && codeEditorIsDirty()) {
    const confirmed = await askConfirmation(
      "Изменения кода не сохранены. Закрыть редактор и потерять их?",
      { title: "Несохранённый код", confirmText: "Закрыть без сохранения", danger: true },
    );
    if (!confirmed) return false;
  }
  elements.codeEditorModal.hidden = true;
  setCodeEditorBackgroundInert(false);
  document.body.style.overflow = "";
  editingCodeBlock = null;
  codeEditorInitialValue = "";
  return true;
}

function openMediaViewer(image) {
  elements.mediaViewerImage.src = image.src;
  elements.mediaViewerImage.alt = image.dataset.fileName || "Вложение";
  elements.mediaViewerModal.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeMediaViewer() {
  elements.mediaViewerModal.hidden = true;
  elements.mediaViewerImage.removeAttribute("src");
  document.body.style.overflow = "";
}

function detectCodeLanguage(code) {
  const source = String(code || "").trim();
  if (!source) return "text";
  try {
    const parsed = JSON.parse(source);
    if (parsed && typeof parsed === "object") return "json";
  } catch {}
  if (/^(?:<!doctype|<\?xml|<[\w:-]+[\s>])/i.test(source)) return "html";
  if (/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S+/m.test(source)) return "http";
  if (/\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE)\b/i.test(source)) return "sql";
  if (/^\s*(?:#!\/.*\b(?:bash|sh)|(?:npm|yarn|pnpm|git|curl|docker)\s+)/m.test(source)) return "bash";
  if (/\b(?:interface|type)\s+\w+\s*[={]|:\s*(?:string|number|boolean)\b/.test(source)) return "typescript";
  if (/\b(?:const|let|var|function|=>|console\.log|import\s.+from|export\s+(?:default|const|function))\b/.test(source)) return "javascript";
  if (/^\s*(?:def|class)\s+\w+|^\s*(?:from\s+\S+\s+import|import\s+\S+)|\bprint\(/m.test(source)) return "python";
  if (/\b(?:public|private|protected)\s+(?:static\s+)?(?:class|void|String|int|boolean)\b/.test(source)) return "java";
  if (/[.#][\w-]+\s*\{[^}]*:[^}]*\}/s.test(source)) return "css";
  if (source.includes("\n") && /^[\w.-]+:\s+\S+/m.test(source) && !/[{};]/.test(source)) return "yaml";
  return "text";
}

function formatCode(code) {
  const source = String(code || "").replace(/\r\n?/g, "\n").replace(/\t/g, "  ").trim();
  if (!source) return "";
  try {
    return JSON.stringify(JSON.parse(source), null, 2);
  } catch {
    return source;
  }
}

function looksLikeCode(value) {
  const source = String(value || "").trim();
  if (!source) return false;
  const hasCyrillic = /[а-яё]/i.test(source);
  const detectedLanguage = detectCodeLanguage(source);
  if (detectedLanguage !== "text") {
    if (!hasCyrillic) return true;
    return /[{}()[\];]|^\s*(?:const|let|var|function|import|export|class|def|SELECT|INSERT|UPDATE|DELETE)\b/im.test(source);
  }
  if (!source.includes("\n")) return false;

  const lines = source.split("\n").map((line) => line.trimEnd());
  const meaningfulLines = lines.filter((line) => line.trim());
  if (!meaningfulLines.length) return false;
  if (hasCyrillic) return false;

  const jsonishStart = /^[\s]*[{\[]/.test(source);
  const indentedLines = meaningfulLines.filter((line) => /^(?:\s{2,}|\t)\S/.test(line)).length;
  const structuralLines = meaningfulLines.filter((line) =>
    /(?:=>|[{}[\];]|\)\s*[,;]?$)/.test(line),
  ).length;
  const codeAssignmentLines = meaningfulLines.filter((line) =>
    /^\s*(?:const|let|var|return|await|this\.|[\w$.[\]'"]+)\s*(?:=|\+=|-=|=>)\s*/.test(line),
  ).length;
  const objectLikeLines = meaningfulLines.filter((line) =>
    /^\s*["']?[\w$.-]+["']?\s*:\s*.+,?\s*$/.test(line),
  ).length;
  const commandLines = meaningfulLines.filter((line) =>
    /^\s*(?:npm|yarn|pnpm|git|curl|docker|kubectl|ssh|cd|mkdir|rm|cp|mv)\b/.test(line),
  ).length;
  const codeScore =
    (jsonishStart ? 3 : 0) +
    indentedLines +
    structuralLines +
    codeAssignmentLines * 2 +
    objectLikeLines +
    commandLines * 2;

  return (
    (jsonishStart && structuralLines >= 1) ||
    codeScore >= 4 ||
    codeAssignmentLines >= 2 ||
    commandLines >= 2
  );
}

function isPlainUrl(value) {
  return /^(?:https?:\/\/|www\.)[^\s]+$/i.test(String(value || "").trim());
}

function normalizeLinkUrl(value) {
  const url = String(value || "").trim();
  return /^www\./i.test(url) ? `https://${url}` : url;
}

function linkifyPlainText(value) {
  const source = String(value || "");
  const pattern = /(?:https?:\/\/|www\.)[^\s]+/gi;
  let output = "";
  let offset = 0;
  for (const match of source.matchAll(pattern)) {
    output += escapeHtml(source.slice(offset, match.index));
    output += `<a href="${escapeHtml(normalizeLinkUrl(match[0]))}" target="_blank" rel="noopener noreferrer">${escapeHtml(match[0])}</a>`;
    offset = match.index + match[0].length;
  }
  return `${output}${escapeHtml(source.slice(offset))}`.replace(/\r?\n/g, "<br>");
}

function insertCodeBlock() {
  if (!activeEditor?.matches(".cell-editor, .intro-editor")) return;
  const rangeNode = savedEditorRange?.commonAncestorContainer;
  const range =
    savedEditorRange && rangeNode?.isConnected && activeEditor.contains(rangeNode)
      ? savedEditorRange.cloneRange()
      : null;
  const selection = range && !range.collapsed ? range.toString() : "";
  const code = formatCode(selection);
  const language = detectCodeLanguage(code);
  const marker = crypto.randomUUID();
  const html = `<p><br></p><pre class="cell-code-block" data-new-code="${marker}" data-language="${language}"><code>${escapeHtml(code)}</code></pre><p><br></p>`;
  insertHtmlAtSelection(html, range);
  highlightCodeBlocks(activeEditor);
  const inserted = activeEditor.querySelector(`pre[data-new-code="${marker}"]`);
  inserted?.removeAttribute("data-new-code");
  if (inserted) openCodeEditor(inserted);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function openFeedback() {
  elements.feedbackModal.hidden = false;
  document.body.style.overflow = "hidden";
  requestAnimationFrame(() => elements.cancelFeedbackButton.focus());
}

function closeFeedback() {
  elements.feedbackModal.hidden = true;
  document.body.style.overflow = "";
}

async function insertImages(files) {
  if (!activeEditor?.matches(".cell-editor, .intro-editor")) return;
  for (const file of [...files]) {
    if (!isImageLikeFile(file)) continue;
    if (file.size > FILE_ATTACHMENT_MAX_SIZE) {
      showToast(`Файл ${file.name} больше ${formatFileSize(FILE_ATTACHMENT_MAX_SIZE)}`);
      continue;
    }
    const dataUrl = await readFileAsDataUrl(file);
    const attachmentId = crypto.randomUUID();
    insertHtmlAtCursor(
      `<figure class="cell-image" contenteditable="false" data-align="left"><img src="${dataUrl}" alt="" data-attachment-id="${attachmentId}" data-file-name="${escapeHtml(file.name)}" data-mime-type="${escapeHtml(file.type)}"></figure><p><br></p>`,
    );
  }
  enhanceImageControls(activeEditor);
}

function getFileExtension(name = "", mimeType = "") {
  const extension = String(name || "").split(".").pop();
  if (extension && extension !== name) return extension.slice(0, 8).toUpperCase();
  const subtype = String(mimeType || "").split("/")[1] || "FILE";
  return subtype.replace(/[^a-z0-9]+/gi, "").slice(0, 8).toUpperCase() || "FILE";
}

function isImageLikeFile(file) {
  if (file.type?.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i.test(file.name || "");
}

function formatFileSize(size) {
  const bytes = Number(size) || 0;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} МБ`;
  if (bytes >= 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  return `${bytes} Б`;
}

function createFileCardHtml({ id, name, type, size, dataUrl }) {
  const extension = getFileExtension(name, type);
  return (
    `<figure class="cell-file" contenteditable="false" tabindex="0" ` +
    `data-attachment-id="${escapeHtml(id)}" ` +
    `data-file-name="${escapeHtml(name)}" ` +
    `data-file-extension="${escapeHtml(extension)}" ` +
    `data-mime-type="${escapeHtml(type || "application/octet-stream")}" ` +
    `data-file-size="${escapeHtml(String(size || 0))}" ` +
    `data-data-url="${escapeHtml(dataUrl)}">` +
    `<span class="file-type-badge">${escapeHtml(extension)}</span>` +
    `<span class="file-card-body">` +
    `<strong class="file-card-name" title="${escapeHtml(name)}">${escapeHtml(name)}</strong>` +
    `<span class="file-card-meta">${escapeHtml(formatFileSize(size))}</span>` +
    `</span>` +
    `</figure><p><br></p>`
  );
}

async function insertFiles(files) {
  if (!activeEditor?.matches(".cell-editor, .intro-editor")) return;
  for (const file of [...files]) {
    if (isImageLikeFile(file)) continue;
    if (file.size > FILE_ATTACHMENT_MAX_SIZE) {
      showToast(`Файл «${file.name}» больше ${formatFileSize(FILE_ATTACHMENT_MAX_SIZE)}`);
      continue;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      insertHtmlAtCursor(
        createFileCardHtml({
          id: crypto.randomUUID(),
          name: file.name || `file-${Date.now()}`,
          type: file.type || "application/octet-stream",
          size: file.size,
          dataUrl,
        }),
      );
    } catch {
      showToast(`Не удалось прочитать файл «${file.name || "без названия"}»`);
    }
  }
  enhanceFileControls(activeEditor);
}

async function insertAttachments(files) {
  const list = [...files];
  const images = list.filter(isImageLikeFile);
  const ordinaryFiles = list.filter((file) => !isImageLikeFile(file));
  if (images.length) await insertImages(images);
  if (ordinaryFiles.length) await insertFiles(ordinaryFiles);
}

function fileCardToWiki(card) {
  const name = card.dataset.jiraName || card.dataset.fileName || "file";
  const storageUrl = isStoredObjectUrl(card.dataset.dataUrl) ? card.dataset.dataUrl : "";
  const url = card.dataset.jiraUrl || storageUrl;
  if (card.dataset.jiraName) return `[^${name}]`;
  return url ? `[${name}|${url}]` : `[Файл: ${name}]`;
}

function extractFileCardHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = html || "";
  const card = template.content.querySelector(".cell-file");
  if (!card) return "";
  card.querySelectorAll("[data-editor-ui]").forEach((item) => item.remove());
  card.classList.remove("file-selected");
  card.contentEditable = "false";
  card.removeAttribute("tabindex");
  return `${card.outerHTML}<p><br></p>`;
}

async function downloadFileCard(card) {
  try {
    const dataUrl = card.dataset.dataUrl || card.dataset.jiraUrl || "";
    if (!dataUrl) throw new Error("У файла нет локальных данных");
    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = card.dataset.fileName || card.dataset.jiraName || "file";
    document.body.append(link);
    link.click();
    link.remove();
  } catch {
    showToast("Не удалось скачать файл");
  }
}

async function copyFileLink(card) {
  const clone = card.cloneNode(true);
  clone.querySelectorAll("[data-editor-ui]").forEach((item) => item.remove());
  clone.classList.remove("file-selected");
  clone.removeAttribute("tabindex");
  const html = `${clone.outerHTML}<p><br></p>`;
  const plain = card.dataset.fileName || card.dataset.jiraName || "Файл";
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      throw new Error("Расширенный буфер обмена не поддерживается");
    }
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([plain], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      }),
    ]);
    showToast("Файл скопирован");
  } catch {
    await writeClipboardText(plain, "Имя файла скопировано");
  }
}

async function uploadEditorObjectToStorage(object, kind) {
  const isImage = kind === "image";
  const source = isImage ? object.querySelector("img")?.src : object.dataset.dataUrl;
  if (!source) return showToast("У объекта нет данных для загрузки");
  try {
    const backend = await checkBackendCompatibility();
    if (!backend.objectStorageConfigured) throw new Error("корпоративное хранилище не настроено на сервере");
    const sourceResponse = await fetch(source);
    const blob = await sourceResponse.blob();
    const dataUrl = await readFileAsDataUrl(new File([blob], "upload", { type: blob.type }));
    const name = isImage
      ? object.querySelector("img")?.dataset.fileName || `image.${blob.type.split("/")[1]?.replace("jpeg", "jpg") || "png"}`
      : object.dataset.fileName || "file";
    showToast("Загружаем в корпоративное хранилище…", 3500);
    const response = await fetch("/api/storage/upload", {
      method: "POST",
      headers: { ...reportIdentityHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        reportId: draft.reportId,
        file: { name, type: blob.type || object.dataset.mimeType, dataBase64: dataUrl.split(",")[1] || "" },
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    if (isImage) {
      const image = object.querySelector("img");
      image.src = result.url;
      image.dataset.fileName = name;
      image.dataset.storageKey = result.key;
    } else {
      object.dataset.dataUrl = result.url;
      object.dataset.storageKey = result.key;
    }
    object.closest(".cell-editor, .intro-editor")?.dispatchEvent(new Event("input", { bubbles: true }));
    if (isImage) enhanceImageControls(object.closest(".cell-editor, .intro-editor") || document);
    else enhanceFileControls(object.closest(".cell-editor, .intro-editor") || document);
    showToast("Файл загружен в корпоративное хранилище");
  } catch (error) {
    showToast(`Не удалось загрузить: ${error.message}`, 6500);
  }
}

function createStorageStatusBadge(stored) {
  const badge = document.createElement("span");
  badge.className = `storage-object-status ${stored ? "stored" : "pending"}`;
  badge.dataset.editorUi = "true";
  badge.contentEditable = "false";
  badge.title = stored ? "Сохранено в корпоративном хранилище" : "Ожидает загрузки в корпоративное хранилище";
  badge.textContent = stored ? "☁" : "";
  return badge;
}

function replaceStoredObjectWithLink(object, kind) {
  const isImage = kind === "image";
  const image = isImage ? object.querySelector("img") : null;
  const url = isImage ? image?.src : object.dataset.dataUrl;
  if (!isStoredObjectUrl(url)) return showToast("Объект ещё не загружен в хранилище");
  const name = isImage
    ? image.dataset.fileName || image.alt || "Изображение"
    : object.dataset.fileName || "Файл";
  const paragraph = document.createElement("p");
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = name;
  paragraph.append(link);
  const editor = object.closest(".cell-editor, .intro-editor");
  object.replaceWith(paragraph);
  editor?.dispatchEvent(new Event("input", { bubbles: true }));
  showToast("Объект заменён ссылкой");
}

function showFileMenu(card, anchor = card) {
  const stored = isStoredObjectUrl(card.dataset.dataUrl);
  const storageAction = stored
      ? { label: "Заменить на ссылку", icon: "link", action: () => replaceStoredObjectWithLink(card, "file") }
      : objectStorageConfigured
        ? { label: "Загрузить в хранилище", icon: "download", action: () => uploadEditorObjectToStorage(card, "file") }
        : null;
  showFloatingMenu(anchor, [
    storageAction,
    { label: "Скачать файл", icon: "download", action: () => downloadFileCard(card) },
  ].filter(Boolean));
}

function enhanceFileControls(root = document) {
  root.querySelectorAll(".cell-file").forEach((card) => {
    ensureMediaBoundaries(card);
    card.querySelectorAll(":scope > [data-editor-ui]").forEach((item) => item.remove());
    const name = card.dataset.fileName || card.dataset.jiraName || "Файл";
    card.tabIndex = 0;
    card.setAttribute("aria-label", `Файл ${name}`);
    const nameNode = card.querySelector(".file-card-name");
    if (nameNode) nameNode.title = name;
    const stored = isStoredObjectUrl(card.dataset.dataUrl);
    if (stored || (cloudHistoryEnabled && objectStorageConfigured)) card.append(createStorageStatusBadge(stored));
    const controls = document.createElement("span");
    controls.className = "object-action-panel file-controls";
    controls.dataset.editorUi = "true";
    controls.contentEditable = "false";
    controls.append(
      createObjectActionButton({
        icon: "copy",
        title: "Копировать файл",
        action: () => copyFileLink(card),
      }),
      createObjectActionButton({
        icon: "trash",
        title: "Удалить файл",
        className: "object-action-danger",
        action: () => deleteEditorObject(card, "Файл удалён — отменить можно через Ctrl/Cmd+Z"),
      }),
      createObjectActionButton({
        icon: "more",
        title: "Ещё действия",
        action: (_event, button) => showFileMenu(card, button),
      }),
    );
    card.append(controls);
  });
}

async function imageToPngBlob(image) {
  const response = await fetch(image.src);
  const sourceBlob = await response.blob();
  if (sourceBlob.type === "image/png") return sourceBlob;
  const bitmap = await createImageBitmap(sourceBlob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Не удалось преобразовать изображение"))),
      "image/png",
    );
  });
}

function imageFallbackMarkup(image) {
  const filename = image.dataset.jiraName || image.dataset.fileName || "";
  if (filename) return `!${filename}|thumbnail!`;
  return image.dataset.jiraUrl || image.src;
}

async function copyImageToClipboard(image) {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      throw new Error("Копирование изображений не поддерживается");
    }
    const png = await imageToPngBlob(image);
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    showToast("Изображение скопировано");
  } catch {
    await writeClipboardText(
      imageFallbackMarkup(image),
      image.dataset.jiraName || image.dataset.fileName
        ? "Скопирована Jira-разметка изображения"
        : "Скопирована ссылка на изображение",
    );
  }
}

async function downloadImage(image) {
  try {
    const response = await fetch(image.src);
    const blob = await response.blob();
    const extension = blob.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
    const filename =
      image.dataset.fileName ||
      image.dataset.jiraName ||
      `screenshot.${extension}`;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
  } catch {
    showToast("Не удалось скачать изображение");
  }
}

function enhanceImageControls(root = document) {
  root.querySelectorAll(".cell-image").forEach((figure) => {
    ensureMediaBoundaries(figure);
    figure.querySelectorAll(":scope > [data-editor-ui]").forEach((item) => item.remove());
    const image = figure.querySelector("img");
    if (!image) return;
    figure.tabIndex = 0;
    figure.setAttribute("aria-label", "Открыть изображение");
    const stored = isStoredObjectUrl(image.src);
    if (stored || (cloudHistoryEnabled && objectStorageConfigured)) figure.append(createStorageStatusBadge(stored));
    const controls = document.createElement("span");
    controls.className = "object-action-panel image-controls";
    controls.dataset.editorUi = "true";
    controls.contentEditable = "false";
    const copyButton = createObjectActionButton({
      icon: "copy",
      title: "Копировать изображение",
      action: () => copyImageToClipboard(image),
    });
    const deleteButton = createObjectActionButton({
      icon: "trash",
      title: "Удалить изображение",
      className: "object-action-danger",
      action: () => deleteEditorObject(figure, "Изображение удалено — отменить можно через Ctrl/Cmd+Z"),
    });
    const moreButton = createObjectActionButton({
      icon: "more",
      title: "Ещё действия",
      action: (_event, button) => showImageMenu(figure, button),
    });
    controls.append(copyButton, deleteButton, moreButton);
    figure.append(controls, createImageResizeHint());
    enableImageObject(figure);
  });
}

function ensureMediaBoundaries(figure) {
  const createParagraph = () => {
    const paragraph = document.createElement("p");
    paragraph.innerHTML = "<br>";
    return paragraph;
  };
  if (!figure.previousSibling) figure.before(createParagraph());
  if (!figure.nextSibling) figure.after(createParagraph());
}

function commitImageChange(figure) {
  const editor = figure.closest(".cell-editor, .intro-editor");
  editor?.dispatchEvent(new Event("input", { bubbles: true }));
}

function selectImage(figure) {
  document.querySelectorAll(".cell-image.image-selected").forEach((item) => {
    if (item !== figure) item.classList.remove("image-selected");
  });
  document.querySelectorAll(".cell-code-block.code-selected").forEach((item) => item.classList.remove("code-selected"));
  document.querySelectorAll(".cell-file.file-selected").forEach((item) => item.classList.remove("file-selected"));
  figure.classList.add("image-selected");
  figure.tabIndex = 0;
  figure.focus({ preventScroll: true });
}

function setImageAlignment(figure, alignment) {
  figure.dataset.align = alignment;
  commitImageChange(figure);
}

function showImageMenu(figure, anchor = figure) {
  selectImage(figure);
  const stored = isStoredObjectUrl(figure.querySelector("img")?.src);
  const storageAction = stored
      ? { label: "Заменить на ссылку", icon: "link", action: () => replaceStoredObjectWithLink(figure, "image") }
      : objectStorageConfigured
        ? { label: "Загрузить в хранилище", icon: "download", action: () => uploadEditorObjectToStorage(figure, "image") }
        : null;
  showFloatingMenu(anchor, [
    storageAction,
    { label: "Скачать изображение", icon: "download", action: () => downloadImage(figure.querySelector("img")) },
    { label: "Выровнять слева", icon: "align-left", action: () => setImageAlignment(figure, "left") },
    { label: "Выровнять по центру", icon: "align-center", action: () => setImageAlignment(figure, "center") },
    { label: "Выровнять справа", icon: "align-right", action: () => setImageAlignment(figure, "right") },
    {
      label: "По ширине ячейки",
      icon: "stretch",
      action: () => {
        figure.style.width = "100%";
        commitImageChange(figure);
      },
    },
  ].filter(Boolean));
}

function enableImageObject(figure) {
  figure.draggable = true;
  if (figure.dataset.dragBound === "true") return;
  figure.dataset.dragBound = "true";
  figure.addEventListener("dragstart", (event) => {
    if (event.target.closest("[data-editor-ui]")) {
      event.preventDefault();
      return;
    }
    event.stopPropagation();
    const clone = figure.cloneNode(true);
    clone.querySelectorAll("[data-editor-ui]").forEach((item) => item.remove());
    clone.classList.remove("image-selected", "image-dragging");
    clone.removeAttribute("draggable");
    delete clone.dataset.dragBound;
    draggedImageFigure = figure;
    suppressObjectOpenUntil.set(figure, Date.now() + 500);
    figure.classList.add("image-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/html", clone.outerHTML);
    event.dataTransfer.setData("text/plain", imageFallbackMarkup(figure.querySelector("img")));
  });
  figure.addEventListener("dragend", () => {
    figure.classList.remove("image-dragging");
    suppressObjectOpenUntil.set(figure, Date.now() + 300);
    draggedImageFigure = null;
    document.querySelectorAll(".code-drop-target").forEach((item) => item.classList.remove("code-drop-target"));
  });
}

function startImageResize(event, figure) {
  event.preventDefault();
  event.stopPropagation();
  closeFloatingMenu();
  selectImage(figure);
  suppressObjectOpenUntil.set(figure, Date.now() + 500);
  const editor = figure.closest(".cell-editor, .intro-editor");
  const startX = event.clientX;
  const startWidth = figure.getBoundingClientRect().width;
  const maxWidth = Math.max(80, editor?.clientWidth || startWidth);
  document.body.classList.add("resizing-image");

  const onMove = (moveEvent) => {
    const width = Math.max(80, Math.min(maxWidth, startWidth + moveEvent.clientX - startX));
    figure.style.width = `${Math.round(width)}px`;
  };
  const onEnd = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onEnd);
    document.removeEventListener("pointercancel", onEnd);
    document.body.classList.remove("resizing-image");
    suppressObjectOpenUntil.set(figure, Date.now() + 300);
    commitImageChange(figure);
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onEnd);
  document.addEventListener("pointercancel", onEnd);
}

function collectLocalImages() {
  const images = [];
  const container = document.createElement("div");
  const usedNumbers = [];
  const allHtml = [
    draft.intro,
    ...draft.sections.flatMap((section) =>
      section.rows.flatMap((row) => Object.values(row.cells)),
    ),
  ];
  allHtml.forEach((html) => {
    container.innerHTML = html || "";
    container.querySelectorAll("img").forEach((image) => {
      const name = image.dataset.jiraName || image.dataset.fileName || "";
      const match = name.match(/^screenshot-(\d+)\./i);
      if (match) usedNumbers.push(Number(match[1]));
    });
  });
  let screenshotNumber = Math.max(0, ...usedNumbers) + 1;
  const extensionByType = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
  };
  const collectFromHtml = (html, location) => {
    container.innerHTML = html || "";
    container.querySelectorAll("img[data-attachment-id]").forEach((image) => {
      // Локальный data URL остаётся исходником изображения и после публикации.
      // Загружаем его заново при каждой отправке: старое вложение пользователь
      // мог удалить из Jira, а новый комментарий не должен от него зависеть.
      if (!image.src.startsWith("data:")) return;
      const [, dataBase64 = ""] = image.src.split(",");
      const type = image.dataset.mimeType || "image/png";
      const extension = extensionByType[type] || "png";
      images.push({
        attachmentId: image.dataset.attachmentId,
        name: `screenshot-${screenshotNumber}.${extension}`,
        type,
        dataBase64,
        ...location,
      });
      screenshotNumber += 1;
    });
  };
  collectFromHtml(draft.intro, { location: "intro" });
  for (const section of draft.sections) {
    for (const row of section.rows) {
      for (const [columnId, html] of Object.entries(row.cells)) {
        collectFromHtml(html, {
          location: "cell",
          sectionId: section.id,
          rowId: row.id,
          columnId,
        });
      }
    }
  }
  return images;
}

function collectLocalFiles() {
  const files = [];
  const collectFromHtml = (html, location) => {
    const container = document.createElement("div");
    container.innerHTML = html || "";
    container.querySelectorAll(".cell-file[data-attachment-id]").forEach((card) => {
      if (card.dataset.jiraUrl) return;
      const dataUrl = card.dataset.dataUrl || "";
      const [, dataBase64 = ""] = dataUrl.split(",");
      if (!dataBase64) return;
      files.push({
        attachmentId: card.dataset.attachmentId,
        name: card.dataset.fileName || "file",
        type: card.dataset.mimeType || "application/octet-stream",
        size: Number(card.dataset.fileSize) || 0,
        dataBase64,
        ...location,
      });
    });
  };
  collectFromHtml(draft.intro, { location: "intro" });
  for (const section of draft.sections) {
    for (const row of section.rows) {
      for (const [columnId, html] of Object.entries(row.cells)) {
        collectFromHtml(html, {
          location: "cell",
          sectionId: section.id,
          rowId: row.id,
          columnId,
        });
      }
    }
  }
  return files;
}

function collectCurrentAttachments() {
  const attachments = [];
  const seen = new Set();
  const collectFromHtml = (html) => {
    const container = document.createElement("div");
    container.innerHTML = html || "";
    container.querySelectorAll("img").forEach((image) => {
      const filename = image.dataset.jiraName || image.dataset.fileName || image.alt || "image.png";
      if (seen.has(filename)) return;
      seen.add(filename);
      attachments.push({
        filename,
        id: image.dataset.jiraId || image.dataset.attachmentId || "",
        content: image.dataset.jiraUrl || image.src || "",
        thumbnail: image.dataset.jiraThumbnail || image.src || "",
      });
    });
    container.querySelectorAll(".cell-file").forEach((card) => {
      const filename = card.dataset.jiraName || card.dataset.fileName || "file";
      if (seen.has(filename)) return;
      seen.add(filename);
      attachments.push({
        filename,
        id: card.dataset.jiraId || card.dataset.attachmentId || "",
        content: card.dataset.jiraUrl || "",
        thumbnail: "",
      });
    });
  };
  collectFromHtml(draft.intro);
  draft.sections.forEach((section) => {
    section.rows.forEach((row) => {
      Object.values(row.cells).forEach(collectFromHtml);
    });
  });
  return attachments;
}

function applyUploadedAttachmentsToRoot(root, byLocalId) {
  let changed = false;
  root.querySelectorAll("img[data-attachment-id]").forEach((image) => {
    const uploadedFile = byLocalId.get(image.dataset.attachmentId);
    if (!uploadedFile) return;
    image.dataset.jiraName = uploadedFile.filename || image.dataset.fileName || "";
    image.dataset.jiraId = uploadedFile.id || "";
    image.dataset.jiraUrl = uploadedFile.content || "";
    if (uploadedFile.thumbnail) image.dataset.jiraThumbnail = uploadedFile.thumbnail;
    changed = true;
  });
  root.querySelectorAll(".cell-file[data-attachment-id]").forEach((card) => {
    const uploadedFile = byLocalId.get(card.dataset.attachmentId);
    if (!uploadedFile) return;
    card.dataset.jiraName = uploadedFile.filename || card.dataset.fileName || "";
    card.dataset.jiraId = uploadedFile.id || "";
    card.dataset.jiraUrl = uploadedFile.content || "";
    changed = true;
  });
  return changed;
}

function applyUploadedAttachments(uploaded) {
  const byLocalId = new Map(uploaded.map((item) => [item.attachmentId, item]));
  const updateHtml = (html) => {
    const container = document.createElement("div");
    container.innerHTML = html || "";
    const changed = applyUploadedAttachmentsToRoot(container, byLocalId);
    return changed ? container.innerHTML : html;
  };
  draft.intro = updateHtml(draft.intro);
  for (const section of draft.sections) {
    for (const row of section.rows) {
      for (const column of section.columns) {
        row.cells[column.id] = updateHtml(row.cells[column.id] || "");
      }
    }
  }
  applyUploadedAttachmentsToRoot(elements.introEditor, byLocalId);
  applyUploadedAttachmentsToRoot(elements.sections, byLocalId);
}

async function prepareImport() {
  try {
    let imported;
    if (importSource === "markup") {
      imported = parseJiraMarkup(elements.importMarkup.value);
    } else {
      const commentUrl = validateJiraCommentUrl(elements.commentImportUrl.value);
      const result = await jiraRequest("/api/jira/import-comment", {
        commentUrl,
      });
      imported = parseJiraMarkup(result.body, result.attachments || []);
      imported.issueUrl = result.issueUrl || "";
    }
    pendingImportedDraft = imported;
    const rows = imported.sections.reduce((sum, section) => sum + section.rows.length, 0);
    const columns = imported.sections.reduce((sum, section) => sum + section.columns.length, 0);
    elements.importSummary.textContent = `Найдено: ${imported.sections.length} таблиц, ${rows} строк, ${columns} пользовательских колонок. Окружение: ${imported.environment}; итог: ${imported.overallStatus}.`;
    elements.importSummary.hidden = false;
    elements.importWarning.hidden = true;
    return imported;
  } catch (error) {
    elements.importWarning.textContent = friendlyJiraError(error);
    elements.importWarning.hidden = false;
    pendingImportedDraft = null;
    throw error;
  }
}

async function applyImport(mode = "replace") {
  try {
    const imported = pendingImportedDraft || (await prepareImport());
    await saveReportSnapshot("before-import");
    if (mode === "append") {
      draft.sections.push(...clone(imported.sections));
      if (imported.intro) draft.intro += imported.intro;
    } else {
      const issueUrl = draft.issueUrl;
      draft = normalizeDraft({
        ...imported,
        draftId: crypto.randomUUID(),
        reportId: crypto.randomUUID(),
        publicId: createPublicId(),
        issueUrl: imported.issueUrl || issueUrl,
      });
    }
    scheduleHistoryCommit();
    saveDraft();
    render();
    updateChecklistUrl(draft.publicId);
    closeImport();
    showToast(`Импортировано таблиц: ${imported.sections.length}`);
  } catch {
    // Ошибка уже показана в окне импорта.
  }
}

async function applyImportedChecklist(imported, metadata = {}) {
  await saveReportSnapshot("before-inbound-import").catch(() => {});
  const nextDraft = normalizeDraft({
    ...imported,
    draftId: crypto.randomUUID(),
    reportId: metadata.checklistId || crypto.randomUUID(),
    publicId: normalizePublicId(metadata.publicId) || createPublicId(),
  });
  const title = String(metadata.title || "").trim();
  if (title && nextDraft.sections[0]) nextDraft.sections[0].title = title;
  const issueUrl = String(metadata.issueKey || "").trim();
  if (issueUrl) nextDraft.issueUrl = issueUrl;
  draft = nextDraft;
  historyCurrent = serializeDraft();
  undoStack = [];
  redoStack = [];
  render();
  updateChecklistUrl(draft.publicId);
  updateHistoryButtons();
  forceLocalDraftSave = true;
  await saveDraft();
  await saveReportSnapshot("inbound-import").catch(() => {});
}

async function handleInboundChecklistImport() {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("importToken");
  if (!token) return;
  try {
    setSaveStatus("Импортируем чек-лист…", { saving: true });
    const response = await fetch(`/api/checklists/import/${encodeURIComponent(token)}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    if (payload.format !== "jira") throw new Error("Ссылка содержит неподдерживаемый формат импорта");
    const imported = parseJiraMarkup(payload.content);
    await applyImportedChecklist(imported, payload);
    window.history.replaceState({}, "", `/report/${draft.publicId}`);
    showToast("Чек-лист импортирован из QA Assistant", 5000);
  } catch (error) {
    setSaveStatus("Ошибка импорта");
    showToast(`Не удалось импортировать чек-лист: ${error.message}`, 9000);
  }
}

async function copyMarkup() {
  const markup = generateMarkup();
  if (!draft.sections.some((section) => section.rows.some(hasRowContent))) {
    showToast("Добавьте хотя бы одну заполненную строку");
    return;
  }
  await writeClipboardText(markup, "Разметка скопирована — можно вставлять в Jira");
}

async function copyPreviewMarkup() {
  const markup = elements.markupPreview.value;
  if (!markup.trim()) {
    showToast("Разметка пуста");
    return;
  }
  try {
    await navigator.clipboard.writeText(markup);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = markup;
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  showToast("Разметка из предпросмотра скопирована");
}

async function savePreviewMarkupToDraft() {
  try {
    const imported = parseJiraMarkup(elements.markupPreview.value, collectCurrentAttachments());
    await saveReportSnapshot("before-preview-markup-save");
    draft = normalizeDraft({
      ...imported,
      draftId: draft.draftId,
      reportId: draft.reportId,
      issueUrl: draft.issueUrl,
      environment: imported.environment || draft.environment,
      overallStatus: imported.overallStatus || draft.overallStatus,
      revision: draft.revision,
      updatedAt: draft.updatedAt,
      lastSavedBy: draft.lastSavedBy,
    });
    scheduleHistoryCommit();
    saveDraft();
    render();
    elements.visualPreview.innerHTML = generateVisualPreview();
    elements.markupPreview.value = generateMarkup();
    showToast("Изменения разметки сохранены в таблицу");
  } catch (error) {
    showToast(`Не удалось сохранить разметку: ${error.message}`, 9000);
  }
}

async function copyVisualReport() {
  if (!draft.sections.some((section) => section.rows.some(hasRowContent))) {
    showToast("Добавьте хотя бы одну заполненную строку");
    return;
  }
  const html = generatePortableHtml();
  const textContainer = document.createElement("div");
  textContainer.innerHTML = html;
  const plainText = textContainer.innerText;
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      throw new Error("Расширенный буфер обмена недоступен");
    }
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([plainText], { type: "text/plain" }),
      }),
    ]);
  } catch {
    const holder = document.createElement("div");
    holder.contentEditable = "true";
    holder.style.position = "fixed";
    holder.style.left = "-9999px";
    holder.innerHTML = html;
    document.body.append(holder);
    const range = document.createRange();
    range.selectNodeContents(holder);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand("copy");
    selection.removeAllRanges();
    holder.remove();
  }
  showToast("Визуальная таблица скопирована");
}

const XLSX_STATUS_STYLES = {
  OK: 5,
  "НЕ ОК": 6,
  "ПОЧТИ ОК": 7,
  "НЕ ПРОВЕРЕНО": 8,
  "ЧАСТИЧНО ПРОВЕРЕНО": 9,
  "ТРЕБУЕТ УТОЧНЕНИЯ": 10,
};

function xlsxEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function columnName(index) {
  let value = "";
  let current = index;
  while (current > 0) {
    const mod = (current - 1) % 26;
    value = String.fromCharCode(65 + mod) + value;
    current = Math.floor((current - mod) / 26);
  }
  return value;
}

function createSharedStringStore() {
  const values = [];
  const indexByValue = new Map();
  return {
    add(value) {
      const text = String(value ?? "");
      if (!indexByValue.has(text)) {
        indexByValue.set(text, values.length);
        values.push(text);
      }
      return indexByValue.get(text);
    },
    xml() {
      const items = values.map((value) => `<si><t xml:space="preserve">${xlsxEscape(value)}</t></si>`).join("");
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${values.length}" uniqueCount="${values.length}">${items}</sst>`;
    },
  };
}

function xlsxCell(ref, value, styleId, sharedStrings) {
  const style = styleId ? ` s="${styleId}"` : "";
  return `<c r="${ref}" t="s"${style}><v>${sharedStrings.add(value)}</v></c>`;
}

function xlsxRow(index, cells, options = {}) {
  const height = options.height ? ` ht="${options.height}" customHeight="1"` : "";
  return `<row r="${index}"${height}>${cells.join("")}</row>`;
}

function estimateXlsxRowHeight(values, columns) {
  const maxLines = values.reduce((max, value, index) => {
    const width = Math.max(10, columns[index]?.width || 18);
    const explicitLines = String(value || "").split("\n");
    const estimated = explicitLines.reduce(
      (sum, line) => sum + Math.max(1, Math.ceil(line.length / Math.max(12, width * 1.05))),
      0,
    );
    return Math.max(max, estimated);
  }, 1);
  return Math.min(360, Math.max(22, 17 + (maxLines - 1) * 15));
}

function getXlsxStatusStyle(status) {
  return XLSX_STATUS_STYLES[status] || XLSX_STATUS_STYLES["НЕ ПРОВЕРЕНО"];
}

function buildXlsxWorksheet() {
  collectDocumentFields();
  const sharedStrings = createSharedStringStore();
  const rows = [];
  const merges = [];
  let rowIndex = 1;
  const maxDynamicColumns = draft.sections.reduce((max, section) => Math.max(max, section.columns.length), 0);
  const exportDynamicColumns = Math.max(4, maxDynamicColumns);
  const totalColumns = exportDynamicColumns + 2;
  const lastColumn = columnName(totalColumns);
  const bodyColumns = [
    { width: 7 },
    ...Array.from({ length: exportDynamicColumns }, (_, index) => {
      const widths = draft.sections
        .map((section) => Number(section.columns[index]?.width) || 240)
        .filter(Boolean);
      const px = widths.length ? Math.max(...widths) : 240;
      return { width: Math.max(20, Math.min(56, Math.round(px / 7))) };
    }),
    { width: 24 },
  ];
  const columnXml = bodyColumns
    .map((column, index) => `<col min="${index + 1}" max="${index + 1}" width="${column.width}" customWidth="1"/>`)
    .join("");

  rows.push(xlsxRow(rowIndex, [xlsxCell("A1", "QA Report — чек-лист", 1, sharedStrings)], { height: 28 }));
  merges.push(`A${rowIndex}:${lastColumn}${rowIndex}`);
  rowIndex += 1;

  rows.push(
    xlsxRow(
      rowIndex,
      [
        xlsxCell(`A${rowIndex}`, "Задача", 12, sharedStrings),
        xlsxCell(`B${rowIndex}`, draft.issueUrl || "Не указана", 13, sharedStrings),
        xlsxCell(`D${rowIndex}`, "Окружение", 12, sharedStrings),
        xlsxCell(`E${rowIndex}`, draft.environment || "Не указано", 13, sharedStrings),
        xlsxCell(`F${rowIndex}`, draft.overallStatus || "НЕ ПРОВЕРЕНО", getXlsxStatusStyle(draft.overallStatus), sharedStrings),
      ],
      { height: 22 },
    ),
  );
  merges.push(`B${rowIndex}:C${rowIndex}`);
  rowIndex += 1;

  const intro = htmlToSpreadsheetText(draft.intro);
  if (intro) {
    rowIndex += 1;
    rows.push(xlsxRow(rowIndex, [xlsxCell(`A${rowIndex}`, "Вводный текст", 2, sharedStrings)]));
    merges.push(`A${rowIndex}:${lastColumn}${rowIndex}`);
    rowIndex += 1;
    rows.push(
      xlsxRow(rowIndex, [xlsxCell(`A${rowIndex}`, intro, 3, sharedStrings)], {
        height: estimateXlsxRowHeight([intro], [{ width: totalColumns * 18 }]),
      }),
    );
    merges.push(`A${rowIndex}:${lastColumn}${rowIndex}`);
    rowIndex += 1;
  }

  draft.sections.forEach((section) => {
    const contentRows = section.rows.filter(hasRowContent);
    if (!contentRows.length) return;
    rowIndex += 2;
    rows.push(xlsxRow(rowIndex, [xlsxCell(`A${rowIndex}`, section.title || "Раздел", 4, sharedStrings)], { height: 24 }));
    merges.push(`A${rowIndex}:${lastColumn}${rowIndex}`);
    rowIndex += 1;

    const headers = [
      "№",
      ...Array.from({ length: exportDynamicColumns }, (_, index) => section.columns[index]?.title || ""),
      "Статус",
    ];
    rows.push(
      xlsxRow(
        rowIndex,
        headers.map((header, index) => xlsxCell(`${columnName(index + 1)}${rowIndex}`, header, 2, sharedStrings)),
        { height: 22 },
      ),
    );
    rowIndex += 1;

    contentRows.forEach((row, index) => {
      const cellContent = Array.from({ length: exportDynamicColumns }, (_, columnIndex) => {
        const column = section.columns[columnIndex];
        const html = column ? row.cells[column.id] || "" : "";
        return {
          value: column ? htmlToSpreadsheetText(html) : "",
          code: /<pre[\s>]/i.test(html),
        };
      });
      const values = [
        `${index + 1}.`,
        ...cellContent.map((cell) => cell.value),
        row.status || "НЕ ПРОВЕРЕНО",
      ];
      const cells = values.map((value, cellIndex) => {
        const ref = `${columnName(cellIndex + 1)}${rowIndex}`;
        const isStatus = cellIndex === values.length - 1;
        const isCode = cellIndex > 0 && cellIndex < values.length - 1 && cellContent[cellIndex - 1]?.code;
        return xlsxCell(
          ref,
          value,
          isStatus ? getXlsxStatusStyle(row.status) : cellIndex === 0 ? 11 : isCode ? 14 : 3,
          sharedStrings,
        );
      });
      rows.push(xlsxRow(rowIndex, cells, { height: estimateXlsxRowHeight(values, bodyColumns) }));
      rowIndex += 1;
    });
  });

  const mergeXml = merges.length
    ? `<mergeCells count="${merges.length}">${merges.map((ref) => `<mergeCell ref="${ref}"/>`).join("")}</mergeCells>`
    : "";
  const sheetXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="18"/><cols>${columnXml}</cols><sheetData>${rows.join("")}</sheetData>` +
    `${mergeXml}<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
  return { sheetXml, sharedStringsXml: sharedStrings.xml() };
}

function xlsxStylesXml() {
  const fillColors = [
    "FFFFFF",
    "1F4E78",
    "D9EAF7",
    "263238",
    "D9EAD3",
    "F4CCCC",
    "D9EAF7",
    "EADCF8",
    "FCE5CD",
    "FFF2CC",
    "F6F8FA",
  ];
  const fills = fillColors
    .map((color) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${color}"/><bgColor indexed="64"/></patternFill></fill>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="5"><font><sz val="11"/><color rgb="FF172B4D"/><name val="Calibri"/></font><font><b/><sz val="16"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FF172B4D"/><name val="Calibri"/></font><font><b/><sz val="12"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><sz val="10"/><color rgb="FF172B4D"/><name val="Consolas"/></font></fonts><fills count="${fillColors.length + 2}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${fills}</fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD0D7DE"/></left><right style="thin"><color rgb="FFD0D7DE"/></right><top style="thin"><color rgb="FFD0D7DE"/></top><bottom style="thin"><color rgb="FFD0D7DE"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="15"><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFill="1" applyFont="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFill="1" applyFont="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="3" fillId="5" borderId="1" xfId="0" applyFill="1" applyFont="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="6" borderId="1" xfId="0" applyFill="1" applyFont="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="7" borderId="1" xfId="0" applyFill="1" applyFont="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="8" borderId="1" xfId="0" applyFill="1" applyFont="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="9" borderId="1" xfId="0" applyFill="1" applyFont="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="10" borderId="1" xfId="0" applyFill="1" applyFont="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="11" borderId="1" xfId="0" applyFill="1" applyFont="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0"><alignment horizontal="center" vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFill="1" applyFont="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0"><alignment vertical="center" shrinkToFit="1"/></xf><xf numFmtId="0" fontId="4" fillId="12" borderId="1" xfId="0" applyFill="1" applyFont="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
}

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}

function writeUint16(output, value) {
  output.push(value & 0xff, (value >>> 8) & 0xff);
}

function writeUint32(output, value) {
  output.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function createZip(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  files.forEach((file) => {
    const nameBytes = encoder.encode(file.name);
    const dataBytes = encoder.encode(file.content);
    const checksum = crc32(dataBytes);
    const local = [];
    writeUint32(local, 0x04034b50);
    writeUint16(local, 20);
    writeUint16(local, 0);
    writeUint16(local, 0);
    writeUint16(local, 0);
    writeUint16(local, 0);
    writeUint32(local, checksum);
    writeUint32(local, dataBytes.length);
    writeUint32(local, dataBytes.length);
    writeUint16(local, nameBytes.length);
    writeUint16(local, 0);
    chunks.push(new Uint8Array(local), nameBytes, dataBytes);
    const centralEntry = [];
    writeUint32(centralEntry, 0x02014b50);
    writeUint16(centralEntry, 20);
    writeUint16(centralEntry, 20);
    writeUint16(centralEntry, 0);
    writeUint16(centralEntry, 0);
    writeUint16(centralEntry, 0);
    writeUint16(centralEntry, 0);
    writeUint32(centralEntry, checksum);
    writeUint32(centralEntry, dataBytes.length);
    writeUint32(centralEntry, dataBytes.length);
    writeUint16(centralEntry, nameBytes.length);
    writeUint16(centralEntry, 0);
    writeUint16(centralEntry, 0);
    writeUint16(centralEntry, 0);
    writeUint16(centralEntry, 0);
    writeUint32(centralEntry, 0);
    writeUint32(centralEntry, offset);
    central.push(new Uint8Array(centralEntry), nameBytes);
    offset += local.length + nameBytes.length + dataBytes.length;
  });
  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  const end = [];
  writeUint32(end, 0x06054b50);
  writeUint16(end, 0);
  writeUint16(end, 0);
  writeUint16(end, files.length);
  writeUint16(end, files.length);
  writeUint32(end, centralSize);
  writeUint32(end, offset);
  writeUint16(end, 0);
  return new Blob([...chunks, ...central, new Uint8Array(end)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

function buildChecklistXlsxBlob() {
  const { sheetXml, sharedStringsXml } = buildXlsxWorksheet();
  const now = new Date().toISOString();
  return createZip([
    { name: "[Content_Types].xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>` },
    { name: "_rels/.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>` },
    { name: "docProps/app.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>QA Report</Application></Properties>` },
    { name: "docProps/core.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>QA Report</dc:creator><cp:lastModifiedBy>QA Report</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>` },
    { name: "xl/workbook.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Чек-лист" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>` },
    { name: "xl/worksheets/sheet1.xml", content: sheetXml },
    { name: "xl/styles.xml", content: xlsxStylesXml() },
    { name: "xl/sharedStrings.xml", content: sharedStringsXml },
  ]);
}

function safeExportFilename() {
  const issueKey = issueKeyFromUrl(draft.issueUrl) || "checklist";
  return `${issueKey}-${new Date().toISOString().slice(0, 10)}.xlsx`
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-");
}

function exportChecklistXlsx() {
  if (!draft.sections.some((section) => section.rows.some(hasRowContent))) {
    showToast("Добавьте хотя бы одну заполненную строку");
    return;
  }
  try {
    const blob = buildChecklistXlsxBlob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = safeExportFilename();
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("XLSX-файл сформирован");
  } catch (error) {
    console.error("Ошибка экспорта XLSX:", error);
    showToast(`Не удалось экспортировать XLSX: ${error.message}`, 5000);
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function showToast(message, duration = 2500) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.title = message;
  elements.toast.classList.add("visible");
  toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), duration);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  if (!elements.themeToggle) return;
  const iconMap = { light: "#icon-sun", graphite: "#icon-contrast", dark: "#icon-moon" };
  elements.themeToggle.querySelector(".theme-icon use")?.setAttribute(
    "href",
    iconMap[theme] || "#icon-moon",
  );
  document.querySelectorAll(".theme-menu-item").forEach((item) => {
    const isActive = item.dataset.theme === theme;
    item.classList.toggle("current", isActive);
    item.setAttribute("aria-current", isActive ? "true" : "false");
  });
}

function closeHeaderDropdowns(exceptMenu = null) {
  [
    [elements.jiraMenuButton, elements.jiraMenu],
    [elements.copyMenuButton, elements.copyMenu],
  ].forEach(([button, menu]) => {
    if (!button || !menu || menu === exceptMenu) return;
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    button.closest(".header-dropdown")?.classList.remove("open");
  });
}

function toggleHeaderDropdown(button, menu) {
  const willOpen = menu.hidden;
  closeHeaderDropdowns(menu);
  menu.hidden = !willOpen;
  button.setAttribute("aria-expanded", String(willOpen));
  button.closest(".header-dropdown")?.classList.toggle("open", willOpen);
  if (willOpen) menu.querySelector("button:not(:disabled)")?.focus();
}

function askConfirmation(message, options = {}) {
  if (confirmResolver) confirmResolver(false);
  elements.confirmModalTitle.textContent = options.title || "Подтвердите действие";
  elements.confirmModalMessage.textContent = message;
  elements.acceptConfirmButton.textContent = options.confirmText || "Подтвердить";
  elements.acceptConfirmButton.className =
    `button ${options.danger ? "button-danger" : "button-primary"}`;
  elements.confirmModal.hidden = false;
  document.body.style.overflow = "hidden";
  elements.acceptConfirmButton.focus();
  return new Promise((resolve) => {
    confirmResolver = resolve;
  });
}

function resolveConfirmation(value) {
  if (!confirmResolver) return;
  const resolve = confirmResolver;
  confirmResolver = null;
  elements.confirmModal.hidden = true;
  document.body.style.overflow =
    elements.codeEditorModal.hidden &&
    elements.previewModal.hidden &&
    elements.importModal.hidden &&
    elements.jiraSettingsModal.hidden &&
    elements.historyModal.hidden
      ? ""
      : "hidden";
  resolve(value);
}

async function resetDraft() {
  const confirmed = await askConfirmation("Очистить текущий отчёт и создать новый?", {
    title: "Новый отчёт",
    confirmText: "Создать новый",
    danger: true,
  });
  if (!confirmed) return;
  saveReportSnapshot("before-new").catch(() => {});
  hideDraftSyncBanner();
  hideSyncRecovery();
  draft = normalizeDraft(clone(DEFAULT_DRAFT));
  draft.draftId = crypto.randomUUID();
  draft.reportId = crypto.randomUUID();
  draft.publicId = createPublicId();
  draft.sections = [createSection("Основные проверки", DEFAULT_COLUMNS, 2)];
  historyCurrent = serializeDraft();
  undoStack = [];
  redoStack = [];
  render();
  updateHistoryButtons();
  forceLocalDraftSave = true;
  saveDraft();
  showToast("Создан новый отчёт");
}

elements.addSectionButton.addEventListener("click", () => {
  flushDraftFromDom();
  const previous = draft.sections[draft.sections.length - 1];
  const section = createSection(`Новый раздел ${draft.sections.length + 1}`, previous?.columns || DEFAULT_COLUMNS);
  draft.sections.push(section);
  renderSections();
  saveLocalMutationNow();
});

["input", "change"].forEach((eventName) => {
  [elements.issueUrl, elements.environment, elements.overallStatus].forEach((control) => {
    control.addEventListener(eventName, () => {
      collectDocumentFields();
      if (control === elements.overallStatus) setStatusClass(control, draft.overallStatus);
      scheduleSave();
    });
  });
});

elements.introEditor.addEventListener("input", () => {
  draft.intro = cleanEditorHtml(elements.introEditor);
  scheduleSave();
});

document.querySelectorAll("[data-command]").forEach((button) => {
  button.addEventListener("click", () => {
    document.execCommand(button.dataset.command, false);
    activeEditor.focus();
  });
});
elements.blockFormat.addEventListener("change", () => {
  document.execCommand("formatBlock", false, elements.blockFormat.value);
  activeEditor.focus();
});
elements.linkButton.addEventListener("pointerdown", () => {
  const selection = window.getSelection();
  if (selection?.rangeCount && activeEditor.contains(selection.anchorNode)) {
    savedEditorRange = selection.getRangeAt(0).cloneRange();
  }
});
function anchorFromRange(range) {
  if (!range) return null;
  const parentAnchor = (node) =>
    (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest?.("a") || null;
  return (
    parentAnchor(range.startContainer) ||
    parentAnchor(range.endContainer) ||
    parentAnchor(range.commonAncestorContainer)
  );
}

function positionLinkPopover() {
  const buttonRect = elements.linkButton.getBoundingClientRect();
  const popoverWidth = Math.min(360, window.innerWidth - 24);
  const left = Math.max(12, Math.min(buttonRect.left, window.innerWidth - popoverWidth - 12));
  elements.linkPopover.style.width = `${popoverWidth}px`;
  elements.linkPopover.style.left = `${left}px`;
  elements.linkPopover.style.top = `${buttonRect.bottom + 8}px`;
}

function closeLinkPopover() {
  elements.linkPopover.hidden = true;
  elements.linkPopoverError.hidden = true;
  linkEditorRange = null;
  editingLink = null;
}

function openLinkPopover() {
  linkEditorRange = savedEditorRange?.cloneRange() || null;
  editingLink = anchorFromRange(linkEditorRange);
  const selectedText = linkEditorRange?.toString().trim() || "";
  const selectedUrl = isPlainUrl(selectedText) ? normalizeLinkUrl(selectedText) : "";
  elements.linkPopoverTitle.textContent = editingLink ? "Изменить ссылку" : "Добавить ссылку";
  elements.linkTextInput.value = editingLink?.textContent || selectedText || "";
  elements.linkUrlInput.value = editingLink?.getAttribute("href") || selectedUrl;
  elements.removeLinkButton.hidden = !editingLink;
  elements.linkPopoverError.hidden = true;
  elements.linkPopover.hidden = false;
  positionLinkPopover();
  requestAnimationFrame(() =>
    (elements.linkTextInput.value ? elements.linkUrlInput : elements.linkTextInput).focus(),
  );
}

function applyLinkFromPopover() {
  const title = elements.linkTextInput.value.trim();
  const url = normalizeLinkUrl(elements.linkUrlInput.value);
  if (!title) {
    elements.linkPopoverError.textContent = "Введите текст ссылки";
    elements.linkPopoverError.hidden = false;
    return;
  }
  if (!/^https?:\/\/\S+$/i.test(url)) {
    elements.linkPopoverError.textContent =
      "Введите адрес, начинающийся с www., http:// или https://";
    elements.linkPopoverError.hidden = false;
    return;
  }
  elements.linkUrlInput.value = url;
  const range = linkEditorRange?.cloneRange();
  if (editingLink?.isConnected && range) range.selectNode(editingLink);
  insertHtmlAtSelection(
    `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a>`,
    range,
  );
  closeLinkPopover();
  activeEditor.focus();
}

function removeEditedLink() {
  if (!editingLink?.isConnected) return closeLinkPopover();
  const text = document.createTextNode(editingLink.textContent || "");
  editingLink.replaceWith(text);
  activeEditor.dispatchEvent(new Event("input", { bubbles: true }));
  closeLinkPopover();
  activeEditor.focus();
}

elements.linkButton.addEventListener("click", openLinkPopover);
elements.applyLinkButton.addEventListener("click", applyLinkFromPopover);
elements.removeLinkButton.addEventListener("click", removeEditedLink);
elements.closeLinkPopoverButton.addEventListener("click", closeLinkPopover);
[elements.linkTextInput, elements.linkUrlInput].forEach((input) => {
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyLinkFromPopover();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeLinkPopover();
      activeEditor.focus();
    }
  });
});
elements.textColorInput.addEventListener("pointerdown", () => {
  const selection = window.getSelection();
  if (selection?.rangeCount && activeEditor?.contains(selection.anchorNode)) {
    savedEditorRange = selection.getRangeAt(0).cloneRange();
  }
});
function closeTextColorMenu() {
  elements.textColorMenu.hidden = true;
  elements.textColorInput.setAttribute("aria-expanded", "false");
}

elements.textColorInput.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  const willOpen = elements.textColorMenu.hidden;
  elements.textColorMenu.hidden = !willOpen;
  elements.textColorInput.setAttribute("aria-expanded", String(willOpen));
});
elements.textColorMenu.addEventListener("click", (event) => {
  const swatch = event.target.closest("button[data-color]");
  if (!swatch) return;
  event.preventDefault();
  event.stopPropagation();
  const color = swatch.dataset.color;
  const range = savedEditorRange?.cloneRange();
  activeEditor?.focus();
  if (range && !range.collapsed) {
    wrapSelectionWithColor(range, color);
    activeEditor.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    showToast("Выделите текст, чтобы применить цвет");
  }
  closeTextColorMenu();
});
elements.codeButton.addEventListener("pointerdown", (event) => {
  const selection = window.getSelection();
  if (selection?.rangeCount && activeEditor?.contains(selection.anchorNode)) {
    savedEditorRange = selection.getRangeAt(0).cloneRange();
  }
  event.preventDefault();
});
elements.codeButton.addEventListener("click", insertCodeBlock);
elements.imageButton.addEventListener("pointerdown", () => {
  const selection = window.getSelection();
  if (selection?.rangeCount && activeEditor?.contains(selection.anchorNode)) {
    savedEditorRange = selection.getRangeAt(0).cloneRange();
  }
});
elements.imageButton.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  elements.imageInput.click();
});
elements.imageInput.addEventListener("change", async () => {
  await insertAttachments(elements.imageInput.files);
  elements.imageInput.value = "";
});
document.addEventListener("paste", async (event) => {
  const pasteTarget = event.target;
  const isNativeTextControl =
    pasteTarget?.matches?.("input:not([type='file']), textarea") ||
    pasteTarget?.isContentEditable;

  if (
    isNativeTextControl &&
    !pasteTarget.closest?.(".cell-editor, .intro-editor")
  ) {
    return;
  }
  if (!elements.codeEditorModal.hidden) {
    if (event.target === elements.codeEditorTextarea) return;
    event.preventDefault();
    elements.codeEditorTextarea.focus();
    return;
  }
  if (!elements.linkPopover.hidden) {
    if (elements.linkPopover.contains(event.target)) return;
    event.preventDefault();
    const input =
      document.activeElement === elements.linkTextInput
        ? elements.linkTextInput
        : elements.linkUrlInput;
    const pastedText = event.clipboardData?.getData("text/plain") || "";
    input.focus();
    input.setRangeText(pastedText, input.selectionStart, input.selectionEnd, "end");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  const editor = event.target.closest?.(".cell-editor, .intro-editor") || activeEditor;
  if (!editor?.matches(".cell-editor, .intro-editor")) return;
  const pastedFiles = [...(event.clipboardData?.files || [])];
  if (pastedFiles.length) {
    event.preventDefault();
    activeEditor = editor;
    await insertAttachments(pastedFiles);
    return;
  }
  const html = event.clipboardData?.getData("text/html") || "";
  const plainText = event.clipboardData?.getData("text/plain") || "";
  const fileCardHtml = extractFileCardHtml(html);
  if (fileCardHtml) {
    event.preventDefault();
    activeEditor = editor;
    const selection = window.getSelection();
    const range =
      selection?.rangeCount && editor.contains(selection.anchorNode)
        ? selection.getRangeAt(0).cloneRange()
        : null;
    insertHtmlAtSelection(fileCardHtml, range);
    enhanceFileControls(editor);
    return;
  }
  let snippet = parseCodeFromClipboard(html, plainText);
  if (!snippet && looksLikeCode(plainText)) {
    const code = formatCode(plainText);
    snippet = { language: detectCodeLanguage(code), code, width: "" };
  }
  const selection = window.getSelection();
  const range =
    selection?.rangeCount && editor.contains(selection.anchorNode)
      ? selection.getRangeAt(0).cloneRange()
      : null;
  if (snippet) {
    event.preventDefault();
    insertCodeSnippet(editor, snippet, range);
    return;
  }
  if (isPlainUrl(plainText)) {
    event.preventDefault();
    activeEditor = editor;
    const url = normalizeLinkUrl(plainText);
    insertHtmlAtSelection(
      `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`,
      range,
    );
    return;
  }
  const textToPaste = plainText || htmlToText(html);
  if (textToPaste) {
    event.preventDefault();
    activeEditor = editor;
    const cleanHtml = /(?:https?:\/\/|www\.)[^\s]+/i.test(textToPaste)
      ? linkifyPlainText(textToPaste)
      : textToEditorHtml(textToPaste);
    insertHtmlAtSelection(cleanHtml, range);
  }
});
document.addEventListener("focusin", (event) => {
  if (event.target.matches(".intro-editor, .cell-editor")) {
    activeEditor = event.target;
    savedEditorRange = null;
  }
});
document.addEventListener("selectionchange", () => {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !activeEditor?.contains(selection.anchorNode)) return;
  savedEditorRange = selection.getRangeAt(0).cloneRange();
});
document.addEventListener("pointerdown", (event) => {
  if (
    !elements.linkPopover.hidden &&
    !event.target.closest("#linkPopover, #linkButton")
  ) {
    closeLinkPopover();
  }
  const codeBlock = event.target.closest(".cell-code-block");
  if (codeBlock && !event.target.closest("[data-editor-ui]")) {
    const rect = codeBlock.getBoundingClientRect();
    const onResizeHandle = rect.right - event.clientX <= 18 && rect.bottom - event.clientY <= 18;
    if (onResizeHandle) {
      startCodeResize(event, codeBlock);
      return;
    }
    pointerObjectGesture = {
      object: codeBlock,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    return;
  }
  const figure = event.target.closest(".cell-image");
  if (!figure) {
    const fileCard = event.target.closest(".cell-file");
    if (fileCard && !event.target.closest("[data-editor-ui]")) {
      pointerObjectGesture = {
        object: fileCard,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
      };
    }
    return;
  }
  const rect = figure.getBoundingClientRect();
  const onResizeHandle = rect.right - event.clientX <= 26 && rect.bottom - event.clientY <= 26;
  if (onResizeHandle) {
    startImageResize(event, figure);
    return;
  }
  if (!event.target.closest("[data-editor-ui]")) {
    pointerObjectGesture = {
      object: figure,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
  }
});
document.addEventListener("pointermove", (event) => {
  if (!pointerObjectGesture || pointerObjectGesture.moved) return;
  const distance = Math.hypot(
    event.clientX - pointerObjectGesture.startX,
    event.clientY - pointerObjectGesture.startY,
  );
  if (distance > 5) {
    pointerObjectGesture.moved = true;
    suppressObjectOpenUntil.set(pointerObjectGesture.object, Date.now() + 350);
  }
});
document.addEventListener("pointerup", () => {
  if (pointerObjectGesture?.moved) {
    suppressObjectOpenUntil.set(pointerObjectGesture.object, Date.now() + 350);
  }
  pointerObjectGesture = null;
});
document.addEventListener("pointercancel", () => {
  if (pointerObjectGesture) {
    suppressObjectOpenUntil.set(pointerObjectGesture.object, Date.now() + 350);
  }
  pointerObjectGesture = null;
});
document.addEventListener("click", (event) => {
  const codeBlock = event.target.closest(".cell-code-block");
  if (codeBlock && !event.target.closest("[data-editor-ui]")) {
    event.preventDefault();
    event.stopPropagation();
    if ((suppressObjectOpenUntil.get(codeBlock) || 0) <= Date.now()) openCodeEditor(codeBlock);
    return;
  }
  const figure = event.target.closest(".cell-image");
  if (figure && !event.target.closest("[data-editor-ui]")) {
    event.preventDefault();
    event.stopPropagation();
    if ((suppressObjectOpenUntil.get(figure) || 0) <= Date.now()) {
      openMediaViewer(figure.querySelector("img"));
    }
    return;
  }
  const fileCard = event.target.closest(".cell-file");
  if (fileCard && !event.target.closest("[data-editor-ui]")) {
    event.preventDefault();
    event.stopPropagation();
    document.querySelectorAll(".cell-file.file-selected").forEach((item) => {
      if (item !== fileCard) item.classList.remove("file-selected");
    });
    document.querySelectorAll(".cell-image.image-selected").forEach((item) => item.classList.remove("image-selected"));
    document.querySelectorAll(".cell-code-block.code-selected").forEach((item) => item.classList.remove("code-selected"));
    fileCard.classList.add("file-selected");
    fileCard.focus({ preventScroll: true });
    return;
  }
  document.querySelectorAll(".cell-image.image-selected").forEach((item) => {
    item.classList.remove("image-selected");
  });
  document.querySelectorAll(".cell-file.file-selected").forEach((item) => {
    item.classList.remove("file-selected");
  });
  document.querySelectorAll(".cell-code-block.code-selected").forEach((item) => {
    item.classList.remove("code-selected");
  });
});

document.addEventListener("dragover", (event) => {
  if (hasDragType(event, "text/row-id")) updateRowDragAutoScroll(event);
  if (!draggedCodeBlock && !draggedImageFigure) return;
  const editor = event.target.closest?.(".cell-editor, .intro-editor");
  if (!editor) return;
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect = "move";
  document.querySelectorAll(".code-drop-target").forEach((item) => {
    if (item !== editor) item.classList.remove("code-drop-target");
  });
  editor.classList.add("code-drop-target");
});

document.addEventListener("drop", (event) => {
  if (!draggedCodeBlock && !draggedImageFigure) return;
  const editor = event.target.closest?.(".cell-editor, .intro-editor");
  if (!editor) return;
  event.preventDefault();
  event.stopPropagation();
  const range = rangeFromPoint(event.clientX, event.clientY, editor);
  if (draggedCodeBlock) {
    const sourceBlock = draggedCodeBlock;
    const sourceEditor = sourceBlock.closest(".cell-editor, .intro-editor");
    const snippet = parseCodeFromClipboard(
      event.dataTransfer.getData("text/html"),
      event.dataTransfer.getData("text/plain"),
    );
    if (!snippet) return;
    insertCodeSnippet(editor, snippet, range);
    sourceBlock.remove();
    sourceEditor?.dispatchEvent(new Event("input", { bubbles: true }));
    draggedCodeBlock = null;
  } else if (draggedImageFigure) {
    const sourceFigure = draggedImageFigure;
    const sourceEditor = sourceFigure.closest(".cell-editor, .intro-editor");
    const html = event.dataTransfer.getData("text/html");
    if (!html) return;
    activeEditor = editor;
    insertHtmlAtSelection(html, range);
    enhanceImageControls(editor);
    sourceFigure.remove();
    sourceEditor?.dispatchEvent(new Event("input", { bubbles: true }));
    draggedImageFigure = null;
  }
  editor.classList.remove("code-drop-target");
});

elements.jiraMenuButton.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleHeaderDropdown(elements.jiraMenuButton, elements.jiraMenu);
});
elements.copyMenuButton.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleHeaderDropdown(elements.copyMenuButton, elements.copyMenu);
});
elements.jiraMenu.addEventListener("click", () => closeHeaderDropdowns());
elements.copyMenu.addEventListener("click", () => closeHeaderDropdowns());
elements.previewButton.addEventListener("click", openPreview);
elements.feedbackButton.addEventListener("click", openFeedback);
elements.closeFeedbackButton.addEventListener("click", closeFeedback);
elements.cancelFeedbackButton.addEventListener("click", closeFeedback);
elements.copyButton.addEventListener("click", copyMarkup);
elements.copyVisualButton.addEventListener("click", copyVisualReport);
elements.exportXlsxButton.addEventListener("click", exportChecklistXlsx);
elements.modalCopyButton.addEventListener("click", copyPreviewMarkup);
elements.modalCopyVisualButton.addEventListener("click", copyVisualReport);
elements.modalSaveMarkupButton.addEventListener("click", savePreviewMarkupToDraft);
elements.closePreviewButton.addEventListener("click", closePreview);
elements.clearButton.addEventListener("click", resetDraft);
elements.importButton.addEventListener("click", openImport);
elements.closeImportButton.addEventListener("click", closeImport);
elements.applyImportButton.addEventListener("click", () => applyImport("replace"));
elements.closeMediaViewerButton.addEventListener("click", closeMediaViewer);
elements.closeCodeEditorButton.addEventListener("click", () => closeCodeEditor());
elements.saveCodeButton.addEventListener("click", saveCodeChanges);
elements.acceptConfirmButton.addEventListener("click", () => resolveConfirmation(true));
elements.cancelConfirmButton.addEventListener("click", () => resolveConfirmation(false));
elements.closeConfirmButton.addEventListener("click", () => resolveConfirmation(false));
elements.codeEditorTextarea.addEventListener("input", () => {
  updateCodeEditorLineNumbers();
  const lineCount = Math.max(1, elements.codeEditorTextarea.value.split("\n").length);
  elements.codeEditorLanguage.textContent = `${lineCount} ${pluralizeLines(lineCount)}`;
  const dirty = codeEditorIsDirty();
  elements.codeEditorState.textContent = dirty ? "Есть несохранённые изменения" : "Изменений нет";
  elements.saveCodeButton.disabled = !dirty;
});
elements.codeEditorTextarea.addEventListener("scroll", () => {
  elements.codeEditorLineNumbers.scrollTop = elements.codeEditorTextarea.scrollTop;
});
elements.codeEditorTextarea.addEventListener("keydown", (event) => {
  event.stopPropagation();
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    if (codeEditorIsDirty()) saveCodeChanges();
    return;
  }
  if (event.key === "Escape") {
    if (!elements.feedbackModal.hidden) {
      closeFeedback();
      return;
    }
    event.preventDefault();
    closeCodeEditor();
    return;
  }
  if (event.key === "Tab") {
    event.preventDefault();
    const start = elements.codeEditorTextarea.selectionStart;
    const end = elements.codeEditorTextarea.selectionEnd;
    elements.codeEditorTextarea.setRangeText("  ", start, end, "end");
    elements.codeEditorTextarea.dispatchEvent(new Event("input", { bubbles: true }));
  }
});
elements.codeEditorModal.addEventListener("keydown", (event) => {
  event.stopPropagation();
  if (event.key === "Escape") {
    event.preventDefault();
    closeCodeEditor();
  }
});
document.addEventListener(
  "focusin",
  (event) => {
    if (
      elements.codeEditorModal.hidden ||
      elements.codeEditorModal.contains(event.target) ||
      (!elements.confirmModal.hidden && elements.confirmModal.contains(event.target))
    ) {
      return;
    }
    elements.codeEditorTextarea.focus();
  },
  true,
);
document.querySelectorAll(".import-source-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    importSource = tab.dataset.importSource;
    document.querySelectorAll(".import-source-tab").forEach((item) => item.classList.remove("active"));
    tab.classList.add("active");
    elements.markupImportPane.hidden = importSource !== "markup";
    elements.commentImportPane.hidden = importSource !== "comment";
    elements.importSummary.hidden = true;
    pendingImportedDraft = null;
  });
});
elements.undoButton.addEventListener("click", undo);
elements.redoButton.addEventListener("click", redo);
elements.historyButton.addEventListener("click", openHistory);
elements.closeHistoryButton.addEventListener("click", closeHistory);
elements.historySearch.addEventListener("input", () => renderHistoryList().catch(() => {}));
elements.saveHistorySnapshotButton.addEventListener("click", async () => {
  await saveReportSnapshot("manual");
  await renderHistoryList();
  showToast("Снимок отчёта сохранён");
});
elements.clearHistoryButton.addEventListener("click", async () => {
  const reports = await getAllHistoryReports();
  if (!reports.length) return;
  const confirmed = await askConfirmation(`Удалить всю историю для текущей привязки (${reports.length} отчётов)?`, {
    title: "Очистка истории",
    confirmText: "Очистить",
    danger: true,
  });
  if (!confirmed) return;
  await clearReportHistory();
  await clearServerReports().catch(() => {});
  serverReportHashes = {};
  dismissedCloudHashes = {};
  saveServerReportHashes();
  saveDismissedCloudHashes();
  draft = normalizeDraft({ ...clone(DEFAULT_DRAFT), draftId: crypto.randomUUID(), reportId: crypto.randomUUID(), publicId: createPublicId() });
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Если localStorage недоступен, достаточно очистки IndexedDB и серверной истории.
  }
  historyCurrent = serializeDraft();
  undoStack = [];
  redoStack = [];
  hasUnsavedLocalChanges = false;
  render();
  updateChecklistUrl(draft.publicId);
  updateHistoryButtons();
  await renderHistoryList();
});
elements.focusModeButton.addEventListener("click", () => {
  const enabled = !document.querySelector(".app-shell").classList.contains("focus-mode");
  setFocusMode(enabled);
});
elements.focusExitButton.addEventListener("click", () => setFocusMode(false));
elements.settingsButton.addEventListener("click", openJiraSettings);
elements.jiraConnections.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-jira-connection-action]");
  if (!button) return;
  button.disabled = true;
  try {
    if (button.dataset.jiraConnectionAction === "connect") await connectJira(button.dataset.instanceId);
    else await disconnectJira(button.dataset.instanceId);
  } catch (error) {
    showToast(friendlyJiraError(error), 9000);
    button.disabled = false;
  }
});
elements.closeJiraSettingsButton.addEventListener("click", closeJiraSettings);
elements.saveJiraSettingsButton.addEventListener("click", saveJiraSettings);
elements.publishButton.addEventListener("click", publishToJira);
elements.publishCancelButton.addEventListener("click", cancelPublishProgress);
elements.cloudConflictStatus.addEventListener("click", openVersionConflictModal);
elements.closeVersionConflictFooterButton.addEventListener("click", closeVersionConflictModal);
elements.selectLocalVersionButton.addEventListener("click", () => setVersionConflictChoice("local"));
elements.selectCloudVersionButton.addEventListener("click", () => setVersionConflictChoice("cloud"));
elements.saveBothVersionsButton.addEventListener("click", () => setVersionConflictChoice("both"));
elements.saveVersionChoiceButton.addEventListener("click", () => {
  saveVersionConflictChoice().catch((error) => {
    showToast(`Не удалось сохранить выбор: ${error.message}`, 9000);
  });
});
elements.openLocalCopyButton.addEventListener("click", () => openSavedConflictCopy("local"));
elements.openCloudCopyButton.addEventListener("click", () => openSavedConflictCopy("cloud"));
elements.settingsJiraSectionButton.addEventListener("click", () => setSettingsSection("jira"));
elements.settingsHistorySectionButton.addEventListener("click", () => setSettingsSection("history"));
elements.jiraSettingsModal.addEventListener("input", markSettingsDirty);
elements.jiraSettingsModal.addEventListener("change", markSettingsDirty);
elements.cloudHistoryEnabled.addEventListener("change", () => updateCloudHistorySettingsState());
elements.reportWorkspaceKey.addEventListener("input", () => updateCloudHistorySettingsState());
elements.themeToggle.addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = document.getElementById("themeMenu");
  if (!menu) return;
  if (menu.hidden) {
    closeHeaderDropdowns();
    menu.hidden = false;
    elements.themeToggle.setAttribute("aria-expanded", "true");
    menu.querySelector("button")?.focus();
  } else {
    menu.hidden = true;
    elements.themeToggle.setAttribute("aria-expanded", "false");
  }
});

document.querySelectorAll(".theme-menu-item").forEach((item) => {
  item.addEventListener("click", () => {
    const theme = item.dataset.theme;
    localStorage.setItem("qa-report-theme", theme);
    applyTheme(theme);
    const menu = document.getElementById("themeMenu");
    menu.hidden = true;
    elements.themeToggle.setAttribute("aria-expanded", "false");
    elements.themeToggle.focus();
  });
});
document.querySelectorAll(".preview-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".preview-tab").forEach((item) => item.classList.remove("active"));
    tab.classList.add("active");
    const visual = tab.dataset.previewTab === "visual";
    elements.visualPreview.hidden = !visual;
    elements.markupPreview.hidden = visual;
  });
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".header-dropdown")) closeHeaderDropdowns();
  if (!event.target.closest(".theme-selector")) {
    const themeMenu = document.getElementById("themeMenu");
    if (themeMenu && !themeMenu.hidden) {
      themeMenu.hidden = true;
      elements.themeToggle?.setAttribute("aria-expanded", "false");
    }
  }
  if (!event.target.closest(".toolbar-color-wrap") && !elements.textColorMenu.hidden) {
    closeTextColorMenu();
  }
  if (!event.target.closest(".floating-context-menu, .row-menu-button, .column-menu-button, .cell-image, .cell-file, .cell-code-block")) {
    closeFloatingMenu();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!elements.textColorMenu.hidden) {
    closeTextColorMenu();
    elements.textColorInput.focus();
    return;
  }
  const themeMenu = document.getElementById("themeMenu");
  if (themeMenu && !themeMenu.hidden) {
    themeMenu.hidden = true;
    elements.themeToggle?.setAttribute("aria-expanded", "false");
    elements.themeToggle?.focus();
    return;
  }
  const openedMenu = document.querySelector(".header-dropdown.open");
  if (!openedMenu) return;
  const trigger = openedMenu.querySelector(".header-dropdown-trigger");
  closeHeaderDropdowns();
  trigger?.focus();
});
window.addEventListener("resize", () => {
  closeHeaderDropdowns();
  closeFloatingMenu();
  if (!elements.linkPopover.hidden) positionLinkPopover();
  scheduleStickySectionUpdate();
});
draftSyncChannel?.addEventListener("message", (event) => {
  if (event.data?.type !== "draft-updated" || event.data.storageKey !== STORAGE_KEY) return;
  handleRemoteDraftUpdate(event.data.draft);
});
window.addEventListener("storage", (event) => {
  if (event.key !== STORAGE_KEY || !event.newValue) return;
  try {
    handleRemoteDraftUpdate(JSON.parse(event.newValue));
  } catch {
    // Некорректное значение storage игнорируем.
  }
});
window.addEventListener("focus", checkStoredDraftFreshness);
window.addEventListener("hashchange", () => {
  openReportFromRoute().catch(() => {});
});
window.addEventListener("blur", flushPendingDraftSave);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    checkStoredDraftFreshness();
  } else {
    flushPendingDraftSave();
  }
});
window.addEventListener("scroll", () => {
  closeFloatingMenu();
  scheduleStickySectionUpdate();
}, true);
document.addEventListener("keydown", (event) => {
  const focusedObject = document.activeElement;
  if (
    (event.key === "Enter" || event.key === " ") &&
    focusedObject?.matches?.(".cell-code-block, .cell-image, .cell-file") &&
    event.target === focusedObject
  ) {
    event.preventDefault();
    if (focusedObject.matches(".cell-code-block")) openCodeEditor(focusedObject);
    else if (focusedObject.matches(".cell-image")) openMediaViewer(focusedObject.querySelector("img"));
    else downloadFileCard(focusedObject);
    return;
  }
  if (event.key === "Backspace" || event.key === "Delete") {
    const selectedImage = document.querySelector(".cell-image.image-selected");
    const selectedFile = document.querySelector(".cell-file.file-selected");
    const object = selectedImage || selectedFile;
    if (object && document.activeElement === object) {
      event.preventDefault();
      const editor = object.closest(".cell-editor, .intro-editor");
      object.remove();
      editor?.dispatchEvent(new Event("input", { bubbles: true }));
      showToast(selectedFile ? "Файл удалён" : "Изображение удалено");
      return;
    }
  }
  if (event.key === "Escape") {
    if (!elements.confirmModal.hidden) {
      resolveConfirmation(false);
      return;
    }
    if (!elements.linkPopover.hidden) {
      closeLinkPopover();
      activeEditor.focus();
      return;
    }
    if (!elements.codeEditorModal.hidden) {
      closeCodeEditor();
      return;
    }
    if (!elements.mediaViewerModal.hidden) {
      closeMediaViewer();
      return;
    }
    if (!elements.previewModal.hidden) closePreview();
    if (!elements.importModal.hidden) closeImport();
    if (!elements.jiraSettingsModal.hidden) closeJiraSettings();
    if (!elements.historyModal.hidden) closeHistory();
    if (document.querySelector(".app-shell").classList.contains("focus-mode")) setFocusMode(false);
  }
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "z") {
    event.preventDefault();
    undo();
  }
  if (
    (event.metaKey || event.ctrlKey) &&
    ((event.shiftKey && event.key.toLowerCase() === "z") || event.key.toLowerCase() === "y")
  ) {
    event.preventDefault();
    redo();
  }
  if ((event.metaKey || event.ctrlKey) && event.key === "s") {
    event.preventDefault();
    collectDocumentFields();
    saveDraft();
    showToast("Сохранено");
  }
});
window.addEventListener("beforeunload", (event) => {
  if (codeEditorIsDirty()) {
    event.preventDefault();
    event.returnValue = "";
  }
  if (!elements.historyModal.hidden) flushVisibleHistoryComments().catch(() => {});
  flushPendingDraftSave();
});

render();
refreshObjectStorageUi();
if (!routeChecklistPublicId()) updateChecklistUrl(draft.publicId);
updateHistoryButtons();
openReportFromRoute()
  .catch(() => {})
  .finally(() => checkStoredDraftFreshness());
handleInboundChecklistImport();
