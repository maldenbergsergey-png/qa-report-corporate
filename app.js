const STORAGE_KEY = "qa-report-editor-draft-v2";
const DRAFT_LOCATION_KEY = "qa-report-draft-location-v1";
const LOCAL_DRAFT_COPY_LIMIT = 1024 * 1024;
const DRAFT_SYNC_CHANNEL = "qa-report-draft-sync-v1";
const HISTORY_PROJECT_NAMES_KEY = "qa-report-project-names-v1";
const HISTORY_PROJECT_COLORS_KEY = "qa-report-project-colors-v1";
const PINNED_COLUMNS_KEY = "qa-report-pinned-columns-v1";
const CLOUD_HISTORY_ENABLED_KEY = "qa-report-cloud-history-enabled-v1";
const CLIENT_ID_KEY = "qa-report-client-id-v1";
const WORKSPACE_KEY_STORAGE_KEY = "qa-report-workspace-key-v1";
const SERVER_HASHES_KEY = "qa-report-server-hashes-v1";
const DISMISSED_CLOUD_HASHES_KEY = "qa-report-dismissed-cloud-hashes-v1";
const DB_NAME = "qa-report-editor";
const DB_VERSION = 1;
const REPORT_STORE = "reports";
const HISTORY_LIMIT = 50;
const REQUIRED_API_REVISION = 9;
const ATTACHMENT_UPLOAD_BATCH_SIZE = 1;
const { parseJiraMarkup, normalizeStatus, stripSectionNumber } = window.QaReportJiraImport;
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

function loadDefaultColumns() {
  try {
    const stored = JSON.parse(localStorage.getItem("qa-report-default-columns-v1"));
    if (Array.isArray(stored) && stored.every(column => column && typeof column.id === "string" && typeof column.title === "string" && column.title.trim()) &&
        new Set(stored.map(column => column.id)).size === stored.length) return stored.map(column => ({ id: column.id, title: column.title }));
  } catch {}
  return DEFAULT_COLUMNS.map(column => ({ ...column }));
}

let defaultColumnsDraft = [];
let defaultColumnHighlightId = "";
let defaultColumnDraggingId = "";

function clearDefaultColumnDropIndicators() {
  document.querySelectorAll("#defaultColumnsList .drop-before, #defaultColumnsList .drop-after")
    .forEach(card => card.classList.remove("drop-before", "drop-after"));
}

function renderDefaultColumnsSettings() {
  const list = document.getElementById("defaultColumnsList");
  list.replaceChildren();
  const locked = label => {
    const item = document.createElement("div");
    item.className = "default-column-card locked";
    item.title = `${label} — неизменяемый столбец`;
    item.append(createUiIcon("lock"), document.createTextNode(label));
    return item;
  };
  list.append(locked("№"));
  defaultColumnsDraft.forEach((column, index) => {
    const card = document.createElement("div");
    card.className = "default-column-card";
    card.dataset.defaultColumnId = column.id;
    if (column.id === defaultColumnHighlightId) {
      card.classList.add("just-moved");
      setTimeout(() => card.classList.remove("just-moved"), 900);
    }
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "default-column-handle";
    handle.title = "Перетащить столбец";
    handle.setAttribute("aria-label", "Перетащить столбец");
    handle.append(createUiIcon("drag"));
    handle.draggable = true;
    handle.addEventListener("dragstart", event => {
      event.stopPropagation();
      defaultColumnDraggingId = column.id;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/default-column", column.id);
      requestAnimationFrame(() => card.classList.add("is-dragging"));
    });
    handle.addEventListener("dragend", () => {
      defaultColumnDraggingId = "";
      card.classList.remove("is-dragging");
      clearDefaultColumnDropIndicators();
    });
    card.addEventListener("dragover", event => {
      if (!defaultColumnDraggingId || defaultColumnDraggingId === column.id) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const placeAfter = event.clientX >= card.getBoundingClientRect().left + card.getBoundingClientRect().width / 2;
      clearDefaultColumnDropIndicators();
      card.classList.add(placeAfter ? "drop-after" : "drop-before");
    });
    card.addEventListener("dragleave", event => {
      if (!card.contains(event.relatedTarget)) card.classList.remove("drop-before", "drop-after");
    });
    card.addEventListener("drop", event => {
      const id = defaultColumnDraggingId || event.dataTransfer.getData("text/default-column");
      const from = defaultColumnsDraft.findIndex(item => item.id === id);
      if (from < 0) return;
      event.preventDefault(); event.stopPropagation();
      const placeAfter = event.clientX >= card.getBoundingClientRect().left + card.getBoundingClientRect().width / 2;
      let destination = index + (placeAfter ? 1 : 0);
      const [moving] = defaultColumnsDraft.splice(from, 1);
      if (from < destination) destination -= 1;
      defaultColumnsDraft.splice(destination, 0, moving);
      defaultColumnDraggingId = "";
      defaultColumnHighlightId = moving.id;
      clearDefaultColumnDropIndicators();
      renderDefaultColumnsSettings(); setSettingsSavedState(false);
    });
    const input = document.createElement("input");
    input.value = column.title; input.setAttribute("aria-label", `Название столбца по умолчанию ${index + 1}`);
    input.addEventListener("input", () => { column.title = input.value; setSettingsSavedState(false); });
    const actions = document.createElement("div"); actions.className = "default-column-actions";
    for (const [label, offset, icon] of [["Переместить влево", -1, "arrow-left"], ["Переместить вправо", 1, "arrow-right"], ["Удалить столбец", 0, "trash"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `object-action-button${icon === "trash" ? " object-action-danger" : ""}`;
      button.title = label;
      button.setAttribute("aria-label", label);
      button.append(createUiIcon(icon));
      button.disabled = offset !== 0 && (index + offset < 0 || index + offset >= defaultColumnsDraft.length);
      button.addEventListener("click", () => {
        if (offset) {
          defaultColumnHighlightId = column.id;
          [defaultColumnsDraft[index], defaultColumnsDraft[index + offset]] = [defaultColumnsDraft[index + offset], defaultColumnsDraft[index]];
        } else {
          defaultColumnHighlightId = "";
          defaultColumnsDraft.splice(index, 1);
        }
        renderDefaultColumnsSettings();
        setSettingsSavedState(false);
        if (offset) {
          requestAnimationFrame(() => {
            const moved = list.querySelector(`[data-default-column-id="${CSS.escape(column.id)}"]`);
            moved?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
            moved?.querySelector(`[aria-label="${label}"]`)?.focus();
          });
        }
      }); actions.append(button);
    }
    card.append(handle, input, actions); list.append(card);
  });
  list.append(locked("Статус"));
}

function saveDefaultColumnsSettings() {
  if (defaultColumnsDraft.some(column => !column.title.trim())) throw new Error("Введите названия столбцов по умолчанию");
  const columns = defaultColumnsDraft.map(column => ({ id: column.id, title: column.title.trim() }));
  localStorage.setItem("qa-report-default-columns-v1", JSON.stringify(columns));
  DEFAULT_DRAFT.sections = [createSection("Основные проверки", columns, 2)];
}

function toggleStatusSort(sectionId) {
  flushDraftFromDom();
  const section = draft.sections.find(item => item.id === sectionId);
  if (!section) return;
  section.statusSort = !section.statusSort;
  closeSelectionMenus();
  renderSections(); saveLocalMutationNow();
}

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
  environment: "",
  overallStatus: "",
  intro: "",
  numberingMode: "section",
  sectionNumberingMode: "automatic",
  sections: [createSection("Основные проверки", loadDefaultColumns(), 2)],
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
  publishScopeModal: document.querySelector("#publishScopeModal"),
  publishScopeSelectAll: document.querySelector("#publishScopeSelectAll"),
  publishScopeList: document.querySelector("#publishScopeList"),
  publishScopeSummary: document.querySelector("#publishScopeSummary"),
  closePublishScopeButton: document.querySelector("#closePublishScopeButton"),
  cancelPublishScopeButton: document.querySelector("#cancelPublishScopeButton"),
  acceptPublishScopeButton: document.querySelector("#acceptPublishScopeButton"),
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
  showLinkUrlButton: document.querySelector("#showLinkUrlButton"),
  openLinkButton: document.querySelector("#openLinkButton"),
  applyLinkButton: document.querySelector("#applyLinkButton"),
  textColorInput: document.querySelector("#textColorInput"),
  textColorMenu: document.querySelector("#textColorMenu"),
  themeToggle: document.querySelector("#themeToggle"),
  settingsButton: document.querySelector("#settingsButton"),
  publishButton: document.querySelector("#publishButton"),
  jiraSettingsModal: document.querySelector("#jiraSettingsModal"),
  closeJiraSettingsButton: document.querySelector("#closeJiraSettingsButton"),
  settingsChecklistSectionButton: document.querySelector("#settingsChecklistSectionButton"),
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
  reportMenuButton: document.querySelector("#reportMenuButton"),
  reportMenu: document.querySelector("#reportMenu"),
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
  historyProjectFilter: document.querySelector("#historyProjectFilter"),
  historySort: document.querySelector("#historySort"),
  historySelectionToggle: document.querySelector("#historySelectionToggle"),
  historySelectionToolbar: document.querySelector("#historySelectionToolbar"),
  historySelectAll: document.querySelector("#historySelectAll"),
  historySelectionCount: document.querySelector("#historySelectionCount"),
  historySelectionExit: document.querySelector("#historySelectionExit"),
  deleteSelectedHistoryButton: document.querySelector("#deleteSelectedHistoryButton"),
  projectSettingsList: document.querySelector("#projectSettingsList"),
  historyUsage: document.querySelector("#historyUsage"),
  historyList: document.querySelector("#historyList"),
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
  alternativeConfirmButton: document.querySelector("#alternativeConfirmButton"),
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

const sanitizedDraftFields = new WeakMap();
const tabId = crypto.randomUUID();
const draftSyncChannel =
  typeof BroadcastChannel === "function" ? new BroadcastChannel(DRAFT_SYNC_CHANNEL) : null;
let draft = loadDraft();
let saveTimer;
let localEditGeneration = 0;
let savedContentForHistory = null;
let draftWriteQueue = Promise.resolve();
let reportMetadataWorker = null;
let reportMetadataWorkerDisabled = false;
let reportMetadataRequestId = 0;
const reportMetadataRequests = new Map();
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
const HISTORY_MEMORY_LIMIT = 32 * 1024 * 1024;
const HISTORY_STEP_LIMIT = 100;
let historyCurrent = "";
let historyTimer;
let suppressHistory = false;
let importSource = "markup";
let selectedReportFile = null;
let reportDragDepth = 0;
let pendingImportedDraft = null;
let preparedImport = null;
let importWizard = null;
let importPlanSummary = null;
let importBusy = false;
let importContext = null;
let pendingImportErrors = [];
let dbPromise;
let draggedCodeBlock = null;
let draggedImageFigure = null;
let rowDragAutoScroll = null;
let pointerObjectGesture = null;
const suppressObjectOpenUntil = new WeakMap();
let editingCodeBlock = null;
let codeEditorInitialValue = "";
let stickyUpdateFrame = 0;
let pinnedColumns = loadPinnedColumns();
let selectionMode = false;
let selectedRowIds = new Set();
let selectionDraftId = null;
let selectionTransferAction = "copy";
const selectionUi = Object.fromEntries([
  "Toggle", "Toolbar", "All", "Count", "StatusButton", "StatusMenu", "StatusOptions", "StatusCount", "StatusApply",
  "MoveButton", "MoveMenu", "TransferHint", "Search", "Destinations", "NewSection", "CreateForm", "CreateSubmit", "NewTitle", "CopyButton", "Delete", "Exit",
].map((name) => [name, document.getElementById(`selection${name}`)]));
let linkEditorRange = null;
let editingLink = null;
let linkPopoverAnchor = null;
let pointerLinkGesture = null;
let publishAbortController = null;
let publishInProgress = false;
let publishScopeResolver = null;
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
let historyRenderRequestId = 0;
let historyLoading = false;
let historySelectionMode = false;
let historyDeleting = false;
let historyFilteredReports = [];
const selectedHistoryReportIds = new Set();
const pendingHistoryServerSaves = new Map();
let projectSettingsRequestId = 0;
let projectSettingsLoaded = false;

function syncBodyModalOverflow() {
  document.body.style.overflow = document.querySelector(".modal-backdrop:not([hidden]), #fileViewerDialog[open]")
    ? "hidden"
    : "";
}

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
  return copyDraftValue(sections).map((section, sectionIndex) => {
    const columns = (Array.isArray(section.columns) ? section.columns : DEFAULT_COLUMNS).map(
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
    jiraPublication: window.QaReportJiraPublication.normalize(parsed.jiraPublication, parsed.reportId),
    revision: Number(parsed.revision) || 0,
    updatedAt: parsed.updatedAt || new Date(0).toISOString(),
    lastSavedBy: parsed.lastSavedBy || "",
    lastSavedClientId: parsed.lastSavedClientId || "",
    issueUrl: parsed.issueUrl || "",
    environment: String(parsed.environment || "").trim().replace(/^Не указано$/i, ""),
    overallStatus: parsed.overallStatus || "",
    numberingMode: ChecklistNumbering.normalizeMode(parsed.numberingMode),
    sectionNumberingMode: ChecklistNumbering.normalizeSectionMode(parsed.sectionNumberingMode),
    sections,
  };
  sanitizeDraftHtmlField(normalized, "intro", parsed);
  normalized.sections.forEach((section, sectionIndex) => {
    section.rows.forEach((row, rowIndex) => {
      const previousCells = parsed.sections?.[sectionIndex]?.rows?.[rowIndex]?.cells;
      Object.keys(row.cells || {}).forEach((columnId) => {
        sanitizeDraftHtmlField(row.cells, columnId, previousCells);
      });
    });
  });
  return normalized;
}

function sanitizeDraftHtmlField(owner, key, previousOwner) {
  // Only a value previously returned by the sanitizer may bypass parsing.
  // Loading/importing a new object, or changing any field, runs the same sanitizer.
  const value = owner[key];
  const checked = previousOwner && sanitizedDraftFields.get(previousOwner);
  const safeValue = checked?.has(key) && checked.get(key) === value ? value : sanitizeRichHtml(value);
  owner[key] = safeValue;
  let fields = sanitizedDraftFields.get(owner);
  if (!fields) { fields = new Map(); sanitizedDraftFields.set(owner, fields); }
  fields.set(key, safeValue);
}

function sanitizeRichHtml(value) {
  const template = document.createElement("template");
  template.innerHTML = String(value || "");
  const allowedTags = new Set([
    "A", "BR", "CODE", "DIV", "EM", "FIGURE", "H1", "H2", "H3", "IMG", "LI",
    "OL", "P", "PRE", "S", "SPAN", "STRONG", "SUB", "SUP", "U", "UL",
  ]);
  const allowedAttributes = new Set([
    "alt", "class", "contenteditable", "data-align", "data-attachment-id", "data-file-extension",
    "data-file-name", "data-file-size", "data-jira-id", "data-jira-name", "data-jira-thumbnail",
    "data-jira-options", "data-jira-url", "data-jira-source-issue", "data-jira-source-hash", "data-jira-kind", "data-jira-exact-url", "data-language", "data-mime-type", "data-qa-code-snippet", "data-data-url",
    "href", "rel", "src", "style", "target", "title",
  ]);
  const safeUrl = (raw, { image = false, fileData = false } = {}) => {
    const text = String(raw || "").trim();
    if (image && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(text)) return text;
    if (fileData && /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[a-z0-9+/=]*$/i.test(text)) return text;
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
  template.content.querySelectorAll(".jira-image-placeholder[data-jira-name]").forEach((placeholder) => {
    placeholder.textContent = placeholder.dataset.jiraName;
  });
  return template.innerHTML;
}

function copyDraftValue(value) {
  // Documents contain JSON values. Copy containers while sharing immutable HTML
  // strings, instead of encoding and decoding every embedded attachment.
  if (value && typeof value.toJSON === "function") return copyDraftValue(value.toJSON());
  if (Array.isArray(value)) return Array.from(value, (item) => copyDraftValue(item) ?? null);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
      const copy = copyDraftValue(item);
      return copy === undefined ? [] : [[key, copy]];
    }));
  }
  if (typeof value === "number") return Number.isFinite(value) ? (value || 0) : null;
  if (["undefined", "function", "symbol"].includes(typeof value)) return undefined;
  if (typeof value === "bigint") throw new TypeError("Draft values must be JSON-compatible");
  return value;
}

function draftContentFields(value = draft) {
  const copy = { ...value };
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

function draftContentSnapshot(value = draft) {
  return clone(draftContentFields(value));
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
  elements.saveState.classList.toggle("save-error", status === "Ошибка сохранения");
  elements.saveState.classList.toggle("save-dirty", status === "Есть несохранённые изменения");
  elements.saveState.setAttribute("aria-label", status);
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
  const text = String(value || "").trim();
  if (/^[A-Z][A-Z0-9_]*-\d+$/i.test(text)) return text.toUpperCase();
  try {
    const pathname = new URL(text).pathname;
    const match = pathname.match(/\/browse\/([A-Z][A-Z0-9_]*-\d+)(?:\/|$)/i)
      || pathname.match(/\/([A-Z][A-Z0-9_]*-\d+)\/?$/i);
    return match?.[1]?.toUpperCase() || "";
  } catch {
    return "";
  }
}

function reportIssueLabel(report) {
  const issueUrl = report.document?.issueUrl ?? (report.issueUrl || report.issueKey || "");
  return issueKeyFromUrl(issueUrl) || String(issueUrl).trim() || "Без задачи";
}

function reportProjectKey(report) {
  const issueKey = issueKeyFromUrl(reportIssueLabel(report));
  return issueKey ? issueKey.replace(/-\d+$/, "") : "";
}

function loadProjectNames() {
  try {
    const saved = JSON.parse(localStorage.getItem(HISTORY_PROJECT_NAMES_KEY) || "{}");
    return Object.fromEntries(Object.entries(saved || {}).filter(([key, name]) =>
      /^[A-Z][A-Z0-9_]*$/.test(key) && typeof name === "string" && name.trim(),
    ).map(([key, name]) => [key, name.trim().slice(0, 120)]));
  } catch {
    return {};
  }
}

function normalizeProjectColor(value) {
  const hex = String(value || "").trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex)) return `#${[...hex].map(char => char.repeat(2)).join("").toLowerCase()}`;
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toLowerCase()}` : "";
}

function loadProjectColors() {
  try {
    const saved = JSON.parse(localStorage.getItem(HISTORY_PROJECT_COLORS_KEY) || "{}");
    return Object.fromEntries(Object.entries(saved || {}).filter(([key, color]) =>
      /^[A-Z][A-Z0-9_]*$/.test(key) && typeof color === "string" && normalizeProjectColor(color),
    ).map(([key, color]) => [key, normalizeProjectColor(color)]));
  } catch {
    return {};
  }
}

function defaultProjectColor() {
  return normalizeProjectColor(getComputedStyle(document.documentElement).getPropertyValue("--primary")) || "#579dff";
}

function bindProjectColorControls() {
  elements.projectSettingsList.querySelectorAll("[data-project-row]").forEach(row => {
    const picker = row.querySelector("[data-project-color-picker]");
    const code = row.querySelector("[data-project-color-key]");
    picker.addEventListener("input", () => {
      code.value = picker.value;
      code.setCustomValidity("");
      code.removeAttribute("aria-invalid");
      markSettingsDirty();
    });
    code.addEventListener("input", () => {
      const color = normalizeProjectColor(code.value);
      const invalid = Boolean(code.value.trim() && !color);
      code.setCustomValidity(invalid ? "Введите цвет в формате #RRGGBB, например #E5484D." : "");
      code.setAttribute("aria-invalid", String(invalid));
      picker.value = color || defaultProjectColor();
    });
    code.addEventListener("blur", () => {
      const color = normalizeProjectColor(code.value);
      if (color) code.value = color;
    });
    row.querySelector("[data-reset-project-color]").addEventListener("click", () => {
      code.value = "";
      code.setCustomValidity("");
      code.removeAttribute("aria-invalid");
      picker.value = defaultProjectColor();
      markSettingsDirty();
    });
  });
}

function historyProjectKeys(reports) {
  return [...new Set(reports.map(reportProjectKey).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function renderHistoryProjectFilter(reports, names) {
  const selected = elements.historyProjectFilter.value;
  const keys = historyProjectKeys(reports);
  elements.historyProjectFilter.innerHTML = '<option value="">Все проекты</option>'
    + keys.map(key => `<option value="${escapeHtml(key)}">${escapeHtml(names[key] || key)}</option>`).join("")
    + (reports.some(report => !reportProjectKey(report)) ? '<option value="none">Без проекта</option>' : "");
  elements.historyProjectFilter.value = keys.includes(selected) || selected === "none" && reports.some(report => !reportProjectKey(report))
    ? selected : "";
}

function resetProjectSettingsForm() {
  projectSettingsRequestId++;
  projectSettingsLoaded = false;
  elements.projectSettingsList.setAttribute("aria-busy", "false");
  elements.projectSettingsList.innerHTML = "";
}

async function fillProjectSettingsForm() {
  const requestId = ++projectSettingsRequestId;
  projectSettingsLoaded = true;
  elements.projectSettingsList.setAttribute("aria-busy", "true");
  const skeleton = `<div class="project-settings-row project-settings-skeleton" aria-hidden="true">
    <div class="history-skeleton-bar project-skeleton-key"></div>
    <div class="history-skeleton-bar project-skeleton-name"></div>
    <div class="history-skeleton-bar project-skeleton-color"></div>
  </div>`;
  elements.projectSettingsList.innerHTML = `<span class="sr-only" role="status">Загрузка проектов</span>${skeleton.repeat(3)}`;
  let reports;
  try {
    reports = await getAllHistoryReports();
  } catch {
    if (requestId !== projectSettingsRequestId) return;
    projectSettingsLoaded = false;
    elements.projectSettingsList.setAttribute("aria-busy", "false");
    elements.projectSettingsList.innerHTML = '<p class="settings-note" role="status">Не удалось загрузить проекты.</p><button class="button button-secondary" type="button" data-retry-projects>Повторить</button>';
    elements.projectSettingsList.querySelector("[data-retry-projects]").addEventListener("click", fillProjectSettingsForm);
    return;
  }
  if (requestId !== projectSettingsRequestId) return;
  elements.projectSettingsList.setAttribute("aria-busy", "false");
  const names = loadProjectNames();
  const colors = loadProjectColors();
  const keys = historyProjectKeys([...reports, draft]);
  elements.projectSettingsList.innerHTML = keys.length
    ? keys.map(key => `<div class="project-settings-row" data-project-row="${escapeHtml(key)}"><code>${escapeHtml(key)}</code>
      <label class="project-name-field"><span class="sr-only">Название проекта ${escapeHtml(key)}</span><input type="text" data-project-key="${escapeHtml(key)}" maxlength="120" placeholder="Название проекта" value="${escapeHtml(names[key] || "")}" /></label>
      <div class="project-color-field"><span class="project-color-caption">Цвет метки</span><div class="project-color-controls">
        <input class="project-color-picker" type="color" data-project-color-picker="${escapeHtml(key)}" aria-label="Выбрать цвет проекта ${escapeHtml(key)}" value="${colors[key] || defaultProjectColor()}" />
        <input class="project-color-code" type="text" data-project-color-key="${escapeHtml(key)}" aria-label="HEX-код цвета проекта ${escapeHtml(key)}" maxlength="7" spellcheck="false" autocomplete="off" placeholder="Авто" value="${colors[key] || ""}" />
        <button class="project-color-reset icon-button" type="button" data-reset-project-color aria-label="Сбросить цвет проекта ${escapeHtml(key)}" title="Стандартный цвет">×</button>
      </div></div></div>`).join("")
    : '<p class="settings-note" role="status">Проектов пока нет. Укажите ключ или ссылку на задачу в чек-листе — проект появится здесь автоматически.</p>';
  bindProjectColorControls();
}

function saveProjectSettings() {
  const inputs = elements.projectSettingsList.querySelectorAll("[data-project-key]");
  if (!inputs.length) return;
  const names = loadProjectNames();
  const colors = loadProjectColors();
  const colorInputs = elements.projectSettingsList.querySelectorAll("[data-project-color-key]");
  for (const input of colorInputs) {
    const color = normalizeProjectColor(input.value);
    if (input.value.trim() && !color) {
      setSettingsSection("projects");
      input.setCustomValidity("Введите цвет в формате #RRGGBB, например #E5484D.");
      input.setAttribute("aria-invalid", "true");
      input.reportValidity();
      throw new Error(`Укажите цвет проекта ${input.dataset.projectColorKey} в формате #RRGGBB.`);
    }
    if (color) colors[input.dataset.projectColorKey] = color;
    else delete colors[input.dataset.projectColorKey];
  }
  inputs.forEach(input => {
    const key = input.dataset.projectKey;
    const name = input.value.trim().slice(0, 120);
    if (name) names[key] = name;
    else delete names[key];
    input.value = name;
  });
  localStorage.setItem(HISTORY_PROJECT_NAMES_KEY, JSON.stringify(names));
  localStorage.setItem(HISTORY_PROJECT_COLORS_KEY, JSON.stringify(colors));
  colorInputs.forEach(input => { input.value = normalizeProjectColor(input.value); });
  if (!elements.historyModal.hidden) flushVisibleHistoryComments().then(() => renderHistoryList()).catch(() => {});
}

async function getReportMetadata(id) {
  if (typeof Worker !== "function" || reportMetadataWorkerDisabled) return getReportRecord(id);
  await openDatabase(); // The existing main-thread code owns schema initialization.
  try {
    if (!reportMetadataWorker) {
      reportMetadataWorker = new Worker("/draft-storage-worker.js?v=2");
      reportMetadataWorker.addEventListener("message", ({ data }) => {
        const pending = reportMetadataRequests.get(data.requestId);
        if (!pending) return;
        reportMetadataRequests.delete(data.requestId);
        clearTimeout(pending.timer);
        if (data.error) pending.reject(new Error(data.error));
        else pending.resolve(data.metadata);
      });
      reportMetadataWorker.addEventListener("error", () => {
        reportMetadataWorkerDisabled = true;
        reportMetadataWorker.terminate();
        reportMetadataWorker = null;
        for (const pending of reportMetadataRequests.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error("Metadata worker unavailable"));
        }
        reportMetadataRequests.clear();
      });
    }
    return await new Promise((resolve, reject) => {
      const requestId = ++reportMetadataRequestId;
      const timer = setTimeout(() => {
        reportMetadataRequests.delete(requestId);
        reject(new Error("Metadata read timed out"));
      }, 10000);
      reportMetadataRequests.set(requestId, { resolve, reject, timer });
      reportMetadataWorker.postMessage({ requestId, databaseName: DB_NAME,
        databaseVersion: DB_VERSION, storeName: REPORT_STORE, reportId: id });
    });
  } catch {
    // Older browsers, blocked workers, and storage errors retain the old path.
    return getReportRecord(id);
  }
}

async function saveReportSnapshot(reason = "manual", candidate = null, { expectedDocument, validate } = {}) {
  if (!candidate) flushDraftFromDom();
  const snapshot = candidate || copyDraftValue(draft);
  const now = new Date().toISOString();
  const existing = await getReportMetadata(snapshot.reportId);
  const issueKey = issueKeyFromUrl(snapshot.issueUrl);
  const historyContentFingerprint = QaReportHistory.contentFingerprint(snapshot);
  const previousFingerprint = existing?.historyContentFingerprint
    || (existing?.document ? QaReportHistory.contentFingerprint(existing.document) : "");
  const unchanged = previousFingerprint === historyContentFingerprint;
  const record = {
    id: snapshot.reportId,
    publicId: snapshot.publicId,
    title: `${reportIssueLabel(snapshot)} — ${snapshot.environment}`,
    issueUrl: snapshot.issueUrl,
    issueKey,
    environment: snapshot.environment,
    overallStatus: snapshot.overallStatus,
    createdAt: existing?.createdAt || existing?.updatedAt || now,
    updatedAt: unchanged ? existing.updatedAt || existing.createdAt || now : now,
    historyContentFingerprint,
    lastOpenedAt: now,
    reason,
    historyComment: existing?.historyComment || "",
    document: snapshot,
    schemaVersion: 3,
  };
  const expected = JSON.stringify(expectedDocument);
  let conflict;
  await dbTransaction("readwrite", (store) => {
    if (expectedDocument === undefined) return store.put(record);
    const request = store.get(record.id);
    request.onsuccess = () => {
      try {
        validate?.();
        if (JSON.stringify(request.result?.document) !== expected) {
          throw Object.assign(new Error("Отчёт изменился во время сохранения. Повторяем приём"), { localImportRetryable: true });
        }
        store.put({ ...record, historyComment: request.result?.historyComment || "" });
      } catch (error) { conflict = error; }
    };
    return request;
  });
  if (conflict) throw conflict;
  if (suppressNextServerSave) {
    suppressNextServerSave = false;
  } else if (!["before-import", "before-inbound-import"].includes(reason)) {
    queueServerReportSave(record);
  }
  if (candidate) trimReportHistory().catch(() => {});
  else await trimReportHistory();
  return record;
}

function queueServerReportSave(record) {
  if (!cloudHistoryEnabled) return;
  const pending = pendingHistoryServerSaves.get(record.id) || new Set();
  pendingHistoryServerSaves.set(record.id, pending);
  const saving = saveReportToServer(record)
    .then((result) => {
      if (result.report?.contentHash) {
        setKnownServerHash(record.id, result.report.contentHash);
        clearDismissedCloudHash(record.id);
      }
      if (result.report?.publicId && draft.reportId === record.id) {
        if (draft.publicId !== result.report.publicId) {
          draft.publicId = result.report.publicId;
          scheduleSave({ collect: false });
        }
        updateChecklistUrl();
      }
    })
    .catch((error) => {
      if (error.status === 409) {
        if (draft.reportId !== record.id) return;
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
    }).finally(() => {
      pending.delete(saving);
      if (!pending.size) pendingHistoryServerSaves.delete(record.id);
    });
  pending.add(saving);
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

async function cacheOpenedServerReport(report) {
  const record = { ...report,
    historyContentFingerprint: QaReportHistory.contentFingerprint(report.document),
  };
  await dbTransaction("readwrite", store => store.put(record));
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
  const location = readDraftLocation();
  const publicId = routeChecklistPublicId() || (isNewerDraft(location) ? location?.publicId : "");
  if (!publicId) {
    updateChecklistUrl(draft.publicId);
    return;
  }
  // Черновик из localStorage загружается синхронно до IndexedDB. При быстром
  // обновлении страницы запись истории могла ещё не успеть сохраниться, но
  // совпадающий publicId уже однозначно указывает на открытый чек-лист.
  if (normalizePublicId(draft.publicId) === publicId && !isNewerDraft(location)) return;
  try {
    const localReport = location?.publicId === publicId
      ? await getReportRecord(location.reportId) : await findLocalReportByPublicId(publicId);
    const fullReport = localReport || (cloudHistoryEnabled ? await getServerReport(publicId) : null);
    if (!fullReport?.document) throw new Error("not-found");
    if (!localReport) await cacheOpenedServerReport(fullReport).catch(() => {});
    applyDraftLocally(fullReport.document, { status: "Сохранено" });
  } catch {
    showToast("Чек-лист по ссылке не найден. Можно создать новый.");
  }
}

function historyTimestamp(report, field) {
  const timestamp = Date.parse(report[field] || report[field === "createdAt" ? "updatedAt" : "createdAt"] || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sortHistoryReports(reports, mode = "updated") {
  const field = mode === "created" ? "createdAt" : "updatedAt";
  const secondary = field === "createdAt" ? "updatedAt" : "createdAt";
  return reports.sort((a, b) => historyTimestamp(b, field) - historyTimestamp(a, field)
    || historyTimestamp(b, secondary) - historyTimestamp(a, secondary)
    || String(a.id).localeCompare(String(b.id)));
}

function historyDatesMarkup(report) {
  return [["createdAt", "Создан"], ["updatedAt", "Изменён"]].map(([field, label]) => {
    const timestamp = historyTimestamp(report, field);
    if (!timestamp) return `<span>${label} —</span>`;
    const date = new Date(timestamp);
    const compact = date.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
    return `<span>${label} <time datetime="${date.toISOString()}" title="${date.toLocaleString("ru-RU")}">${compact}</time></span>`;
  }).join("");
}

async function getAllHistoryReports() {
  const [serverReports, localReports] = await Promise.all([
    getServerReports(),
    getAllReports().catch(() => []),
  ]);
  const seen = new Set(serverReports.map((report) => report.id));
  const localById = new Map(localReports.map(report => [report.id, report]));
  return [
    ...serverReports.map(report => {
      const local = localById.get(report.id);
      // A local edit may still be uploading when the history list is requested.
      return local && historyTimestamp(local, "updatedAt") > historyTimestamp(report, "updatedAt")
        ? { ...report, updatedAt: local.updatedAt, jiraPublication: local.document?.jiraPublication } : report;
    }),
    ...localReports
      .filter((report) => !seen.has(report.id))
      .map((report) => ({ ...report, source: "local" })),
  ].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

async function getFreshestStoredDraft() {
  const candidates = [];
  const stored = readStoredDraft({ normalize: false });
  if (stored && isSameDraftLineage(stored)) candidates.push(stored);
  try {
    const metadata = await getReportMetadata(draft.reportId);
    if (metadata?.document && isSameDraftLineage(metadata.document) && isNewerDraft(metadata.document)) {
      const currentReport = await getReportRecord(draft.reportId);
      const reportDraft = currentReport?.document;
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
  const value = String(historyComment || "").slice(0, 1000);
  if (value === (record.historyComment || "")) return record;
  record.historyComment = value;
  record.updatedAt = new Date().toISOString();
  await dbTransaction("readwrite", (store) => store.put(record));
  return record;
}

async function updateServerReportComment(id, historyComment) {
  if (!cloudHistoryEnabled) return;
  return reportApi(`/api/reports/${encodeURIComponent(id)}/comment`, {
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
  // Read only keys and dates; history documents may contain large attachments.
  await dbTransaction("readwrite", (store) => {
    const count = store.count();
    count.onsuccess = () => {
      if (count.result <= HISTORY_LIMIT) return;
      const entries = [];
      const request = store.index("updatedAt").openKeyCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          entries.push({ id: cursor.primaryKey, updatedAt: cursor.key });
          cursor.continue();
          return;
        }
        // A forward cursor keeps the previous primary-key order for equal dates.
        entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        entries.slice(HISTORY_LIMIT).forEach(({ id }) => store.delete(id));
      };
    };
    return count;
  });
}

async function clearReportHistory() {
  await dbTransaction("readwrite", (store) => store.clear());
}

async function saveDraft({ collect = true } = {}) {
  if (collect) flushDraftFromDom();
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
  const saving = persistLocalDraft();
  forceLocalDraftSave = false;
  return saving.completion;
}

// localStorage is a fast copy; reports with attachments may fit only in IndexedDB.
function persistLocalDraft({ forceLocalCopy = false } = {}) {
  const currentDraft = draft;
  const generation = localEditGeneration;
  const snapshot = copyDraftValue(draft);
  const content = serializeDraft();
  savedContentForHistory = { draft: currentDraft, generation, content };
  const isCurrent = () => draft === currentDraft && localEditGeneration === generation
    && draft.reportId === snapshot.reportId && draft.revision === snapshot.revision;
  const localStorageSaved = writeLocalDraftCopy(snapshot, forceLocalCopy ? 0 : content.length);
  hasUnsavedLocalChanges = !localStorageSaved;
  setSaveStatus(localStorageSaved ? "Сохранено" : "Сохранение…", { saving: !localStorageSaved });
  // Keep writes in request order, including a save started during a slow write.
  const write = draftWriteQueue.catch(() => {}).then(() => saveReportSnapshot("autosave", snapshot));
  draftWriteQueue = write;
  const completion = write.then(() => {
    if (isCurrent()) {
      hasUnsavedLocalChanges = false;
      setSaveStatus("Сохранено");
      try { localStorage.setItem(DRAFT_LOCATION_KEY, JSON.stringify(draftSaveMetadata(snapshot))); } catch {}
      if (!applyingRemoteDraft) broadcastDraftUpdate(snapshot);
    }
    return true;
  }, () => {
    if (isCurrent()) {
      hasUnsavedLocalChanges = !localStorageSaved;
      if (!localStorageSaved) setSaveStatus("Ошибка сохранения");
      else if (!applyingRemoteDraft) broadcastDraftUpdate(snapshot, { localStorageOnly: true });
    }
    return localStorageSaved;
  });
  return { localStorageSaved, completion };
}

function writeLocalDraftCopy(snapshot, contentLength) {
  // Keep the existing small-report fallback and its file format. Large reports
  // already use IndexedDB; do not repeatedly encode a copy that cannot fit.
  if (contentLength > LOCAL_DRAFT_COPY_LIMIT) return false;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    return true;
  } catch {
    return false;
  }
}

function draftSaveMetadata(value = draft) {
  const { reportId, publicId, draftId, revision, updatedAt, lastSavedBy, lastSavedClientId } = value;
  return { reportId, publicId, draftId, revision, updatedAt, lastSavedBy, lastSavedClientId };
}

function readDraftLocation() {
  try {
    const value = JSON.parse(localStorage.getItem(DRAFT_LOCATION_KEY) || "null");
    return value?.reportId && normalizePublicId(value.publicId) ? value : null;
  } catch {
    return null;
  }
}

async function handleDraftSyncMessage(message) {
  if (message?.type !== "draft-updated" || message.storageKey !== STORAGE_KEY) return;
  // Accept messages from a tab that still runs the previous application version.
  if (message.draft) { handleRemoteDraftUpdate(message.draft); return; }
  if (!isSameDraftLineage(message) || !isNewerDraft(message) || message.tabId === tabId) return;
  const reportId = draft.reportId;
  try {
    const remote = message.localStorageOnly ? readStoredDraft({ normalize: false })
      : (await getReportRecord(message.reportId))?.document;
    if (draft.reportId === reportId && isSameDraftLineage(remote) && isNewerDraft(remote)) {
      handleRemoteDraftUpdate(remote);
    }
  } catch {
    // A missing or unavailable store must not replace the current document.
  }
}

function flushPendingDraftSave() {
  clearTimeout(saveTimer);
  flushDraftFromDom();
  if (!applyingRemoteDraft) {
    const stored = readStoredDraft({ normalize: false });
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
  return persistLocalDraft({ forceLocalCopy: true }).localStorageSaved;
}

function broadcastDraftUpdate(snapshot = draft, { localStorageOnly = false } = {}) {
  draftSyncChannel?.postMessage({
    type: "draft-updated",
    storageKey: STORAGE_KEY,
    ...draftSaveMetadata(snapshot),
    localStorageOnly,
    tabId,
  });
}

function readStoredDraft({ normalize = true } = {}) {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved);
    return normalize ? normalizeDraft(parsed) : parsed;
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
  syncBodyModalOverflow();
}

function closeVersionConflictModal() {
  elements.versionConflictModal.hidden = true;
  syncBodyModalOverflow();
}

function closeVersionCopyChoiceModal() {
  elements.versionCopyChoiceModal.hidden = true;
  pendingCopyChoice = null;
  syncBodyModalOverflow();
}

function applyDraftLocally(nextDraft, { status = "Сохранено" } = {}) {
  const normalized = normalizeDraft(nextDraft);
  applyingRemoteDraft = true;
  clearTimeout(saveTimer);
  clearTimeout(historyTimer);
  draft = normalized;
  historyCurrent = serializeDraft();
  writeLocalDraftCopy(draft, historyCurrent.length);
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
    title: `${reportIssueLabel(draft)} — ${draft.environment}`,
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
  copy.jiraPublication = null;
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
    title: `${reportIssueLabel(copyDraft)} — ${copyDraft.environment}`,
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
  syncBodyModalOverflow();
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

function scheduleSave({ collect = true } = {}) {
  // Input handlers that already updated the current draft can skip the full scan.
  // Structural operations keep the existing collection path.
  if (collect) flushDraftFromDom();
  localEditGeneration++;
  hasUnsavedLocalChanges = true;
  setSaveStatus("Есть несохранённые изменения");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveDraft({ collect: false }), 400);
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
  return JSON.stringify(draftContentFields(draft));
}

function scheduleHistoryCommit() {
  if (suppressHistory) return;
  clearTimeout(historyTimer);
  historyTimer = setTimeout(() => {
    // Input handlers already collected the changed field; structural handlers
    // collected the document before scheduling this commit. Reuse the save text.
    const cached = savedContentForHistory;
    const next = cached?.draft === draft && cached.generation === localEditGeneration
      ? cached.content : serializeDraft();
    if (next === historyCurrent) return;
    undoStack.push(historyCurrent);
    historyCurrent = next;
    redoStack = [];
    updateHistoryButtons();
  }, 500);
}

function trimHistoryStacks() {
  // JSON snapshots include embedded attachments. Count two bytes per character
  // conservatively, and keep the nearest undo/redo even for an oversized report.
  let bytes = 2 * (historyCurrent.length + [...undoStack, ...redoStack]
    .reduce((total, snapshot) => total + snapshot.length, 0));
  while (bytes > HISTORY_MEMORY_LIMIT || undoStack.length + redoStack.length > HISTORY_STEP_LIMIT) {
    const stack = undoStack.length > 1 && (redoStack.length <= 1 || undoStack.length >= redoStack.length)
      ? undoStack : redoStack.length > 1 ? redoStack : null;
    if (!stack) break;
    bytes -= 2 * stack.shift().length;
  }
}

function updateHistoryButtons() {
  trimHistoryStacks();
  if (savedContentForHistory && (savedContentForHistory.draft !== draft
    || savedContentForHistory.generation !== localEditGeneration)) savedContentForHistory = null;
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

function setReportMetadataError(control, message = "") {
  const error = document.getElementById(`${control.id}Error`);
  if (message) control.setAttribute("aria-invalid", "true");
  else control.removeAttribute("aria-invalid");
  error.textContent = message;
  error.hidden = !message;
}

function reportMetadataError(control) {
  if (control === elements.issueUrl) {
    if (!control.value.trim()) return "Укажите ссылку на задачу";
    try {
      parseIssueUrl(control.value);
      return "";
    } catch (error) {
      return error.message;
    }
  }
  if (control === elements.environment) {
    return control.value.trim().replace(/^Не указано$/i, "") ? "" : "Укажите окружение";
  }
  return Object.hasOwn(STATUS_META, control.value) ? "" : "Выберите итог проверки";
}

function validateReportMetadata() {
  let firstInvalid = null;
  for (const control of [elements.environment, elements.overallStatus]) {
    const message = reportMetadataError(control);
    setReportMetadataError(control, message);
    if (message && !firstInvalid) firstInvalid = control;
  }
  if (!firstInvalid) return true;
  environmentPicker.close();
  firstInvalid.scrollIntoView({ block: "center", behavior: "smooth" });
  firstInvalid.focus({ preventScroll: true });
  showToast("Заполните окружение и итог перед публикацией");
  return false;
}

async function validateReportPublication() {
  const message = reportMetadataError(elements.issueUrl);
  setReportMetadataError(elements.issueUrl, message);
  if (!message) return validateReportMetadata();
  environmentPicker.close();
  const previousFocus = document.activeElement;
  const edit = await askConfirmation(
    "Для публикации отчёта нужна полная ссылка на конкретную задачу. Добавьте её в поле «Ссылка на задачу».",
    { title: "Укажите задачу", confirmText: "Заполнить ссылку" },
  );
  if (edit) {
    setFocusMode(false);
    elements.issueUrl.scrollIntoView({ block: "center", behavior: "smooth" });
    elements.issueUrl.focus({ preventScroll: true });
  } else {
    const returnFocus = previousFocus?.getClientRects().length ? previousFocus : elements.copyMenuButton;
    returnFocus.focus({ preventScroll: true });
  }
  return false;
}

function collectDocumentFields() {
  localEditGeneration++;
  draft.issueUrl = elements.issueUrl.value;
  draft.environment = elements.environment.value.trim();
  draft.overallStatus = elements.overallStatus.value;
  draft.intro = cleanEditorHtml(elements.introEditor);
  collectSectionsFromDom();
}

function collectSectionsFromDom() {
  const sectionsById = new Map(draft.sections.map((section) => [section.id, section]));
  elements.sections.querySelectorAll(".check-section[data-section-id]").forEach((sectionElement) => {
    const section = sectionsById.get(sectionElement.dataset.sectionId);
    if (!section) return;
    const columnsById = new Map(section.columns.map((column) => [column.id, column]));
    const rowsById = new Map(section.rows.map((row) => [row.id, row]));
    const title = sectionElement.querySelector(".section-title");
    if (title) section.title = title.value;
    const sectionNumber = sectionElement.querySelector(".section-number-input");
    if (sectionNumber && draft.sectionNumberingMode === "manual") section.manualNumber = ChecklistNumbering.normalizeSectionNumber(sectionNumber.value);
    section.collapsed = sectionElement.classList.contains("collapsed");
    sectionElement.querySelectorAll("th[data-column-id]").forEach((columnElement) => {
      const column = columnsById.get(columnElement.dataset.columnId);
      const columnTitle = columnElement.querySelector("input");
      if (column && columnTitle) column.title = columnTitle.value;
    });
    sectionElement.querySelectorAll("tr[data-row-id]").forEach((rowElement) => {
      const row = rowsById.get(rowElement.dataset.rowId);
      if (!row) return;
      rowElement.querySelectorAll(".cell-editor[data-column-id]").forEach((editor) => {
        row.cells[editor.dataset.columnId] = cleanEditorHtml(editor);
      });
      const number = rowElement.querySelector(".row-number-input");
      if (number && draft.numberingMode === "manual") row.manualNumber = ChecklistNumbering.normalizeNumber(number.value);
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
  setReportMetadataError(elements.issueUrl);
  elements.environment.value = draft.environment;
  environmentPicker.close();
  renderEnvironmentOptions();
  elements.overallStatus.value = draft.overallStatus;
  setStatusClass(elements.overallStatus, draft.overallStatus);
  setReportMetadataError(elements.environment);
  setReportMetadataError(elements.overallStatus);
  elements.introEditor.innerHTML = draft.intro;
  elements.introEditor.querySelectorAll("figcaption").forEach((caption) => caption.remove());
  highlightCodeBlocks(elements.introEditor);
  enhanceImageControls(elements.introEditor);
  enhanceFileControls(elements.introEditor);
  draft.intro = cleanEditorHtml(elements.introEditor);
  renderSections();
  renderSummary();
  renderPublicationState();
}

function createSelectionCheckbox(label) {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "selection-checkbox";
  input.setAttribute("aria-label", label);
  return input;
}

function closeSelectionMenus() {
  for (const name of ["Status", "Move"]) {
    selectionUi[`${name}Menu`].hidden = true;
    selectionUi[`${name}Button`].setAttribute("aria-expanded", "false");
  }
}

function setSelectionMode(enabled) {
  flushDraftFromDom();
  selectionMode = enabled;
  selectedRowIds.clear();
  closeSelectionMenus();
  selectionUi.Toolbar.hidden = !enabled;
  selectionUi.Toggle.setAttribute("aria-pressed", String(enabled));
  document.body.classList.toggle("selection-mode", enabled);
  renderSections();
  if (!enabled) selectionUi.Toggle.focus();
}

function updateSelectionUi() {
  const rows = draft.sections.flatMap((section) => section.rows);
  const currentIds = new Set(rows.map((row) => row.id));
  selectedRowIds = new Set([...selectedRowIds].filter((id) => currentIds.has(id)));
  const count = selectedRowIds.size;
  selectionUi.Count.textContent = `Выбрано: ${count}`;
  selectionUi.All.checked = count > 0 && count === rows.length;
  selectionUi.All.indeterminate = count > 0 && count < rows.length;
  selectionUi.Delete.disabled = count === 0;
  selectionUi.CopyButton.disabled = count === 0 || selectionCopyBusy;
  selectionUi.MoveButton.disabled = count === 0;
  selectionUi.MoveButton.title = "Копировать или перенести выбранные строки в раздел";
  if (selectionUi.MoveButton.disabled && !selectionUi.MoveMenu.hidden) closeSelectionMenus();
  elements.sections.querySelectorAll("[data-selection-row]").forEach((checkbox) => {
    checkbox.checked = selectedRowIds.has(checkbox.dataset.selectionRow);
    checkbox.closest("tr").classList.toggle("row-selected", checkbox.checked);
  });
  const sectionsById = new Map(draft.sections.map((section) => [section.id, section]));
  elements.sections.querySelectorAll("[data-selection-section]").forEach((checkbox) => {
    const section = sectionsById.get(checkbox.dataset.selectionSection);
    const selected = section.rows.filter((row) => selectedRowIds.has(row.id)).length;
    checkbox.checked = selected > 0 && selected === section.rows.length;
    checkbox.indeterminate = selected > 0 && selected < section.rows.length;
  });
  if (!selectionUi.MoveMenu.hidden) updateSelectionTransferAction();
}

function openSelectionMenu(name) {
  if (name === "Move" && !selectedRowIds.size) return;
  const opening = selectionUi[`${name}Menu`].hidden;
  closeSelectionMenus();
  if (!opening) return;
  selectionUi[`${name}Menu`].hidden = false;
  selectionUi[`${name}Button`].setAttribute("aria-expanded", "true");
  if (name === "Move") {
    flushDraftFromDom();
    selectionUi.Search.value = "";
    setSelectionCreateExpanded(false);
    document.querySelector('[name="selectionTransferAction"][value="copy"]').checked = true;
    updateSelectionTransferAction();
    selectionUi.Search.focus();
  } else {
    selectionUi.StatusOptions.querySelector("input")?.focus();
  }
  scheduleStickySectionUpdate();
}

function updateSelectionTransferAction() {
  selectionTransferAction = document.querySelector('[name="selectionTransferAction"]:checked').value;
  const copying = selectionTransferAction === "copy";
  const canTransfer = copying || window.QaReportTable.canMove(draft.sections, selectedRowIds);
  selectionUi.TransferHint.textContent = copying ? "Исходные строки останутся на месте."
    : canTransfer ? "Строки будут удалены из исходных разделов."
    : "Для переноса верните исходный порядок выбранных строк.";
  selectionUi.CreateSubmit.textContent = copying ? "Копировать в новый раздел" : "Перенести в новый раздел";
  selectionUi.CreateSubmit.disabled = !selectedRowIds.size || !canTransfer;
  renderSelectionDestinations();
}

function renderSelectionDestinations() {
  selectionUi.Destinations.replaceChildren();
  const search = normalizeColumnTitle(selectionUi.Search.value);
  const matching = draft.sections.filter((section) => normalizeColumnTitle(section.title).includes(search));
  for (const section of matching) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = section.title;
    button.title = section.title;
    const copying = selectionTransferAction === "copy";
    const hasRowsElsewhere = draft.sections.some((source) => source.id !== section.id && source.rows.some((row) => selectedRowIds.has(row.id)));
    button.disabled = !selectedRowIds.size || (!copying && (!window.QaReportTable.canMove(draft.sections, selectedRowIds, section.id) || !hasRowsElsewhere));
    if (button.disabled) button.title = section.statusSort ? "Верните исходный порядок строк в разделе назначения" : "Перенос недоступен: проверьте сортировку и выбранные строки";
    button.addEventListener("click", () => transferSelectedRows(section.id));
    selectionUi.Destinations.append(button);
  }
  scheduleStickySectionUpdate();
  if (!matching.length) {
    const empty = document.createElement("p");
    empty.textContent = "Разделы не найдены";
    selectionUi.Destinations.append(empty);
  }
}

// Record a bulk operation as its own undo step, including when text was just edited.
function commitSelectionMutation(mutate) {
  clearTimeout(historyTimer);
  const before = serializeDraft();
  if (historyCurrent !== before) undoStack.push(historyCurrent);
  mutate();
  renderSections();
  renderSummary();
  saveLocalMutationNow();
  clearTimeout(historyTimer);
  undoStack.push(before);
  historyCurrent = serializeDraft();
  redoStack = [];
  updateHistoryButtons();
}

async function moveSelectedRows(targetId, newTitle = "") {
  return transferSelectedRows(targetId, newTitle, "move");
}

async function transferSelectedRows(targetId, newTitle = "", action = selectionTransferAction) {
  const copying = action === "copy";
  if (!copying && !window.QaReportTable.canMove(draft.sections, selectedRowIds, targetId)) return;
  flushDraftFromDom();
  const ids = new Set(selectedRowIds);
  const documentId = draft.draftId;
  const target = draft.sections.find((section) => section.id === targetId);
  const count = draft.sections.filter((section) => copying || section.id !== targetId)
    .reduce((sum, section) => sum + section.rows.filter((row) => ids.has(row.id)).length, 0);
  if (!count || (!target && !newTitle)) return;
  closeSelectionMenus();
  const rowWord = count % 10 === 1 && count % 100 !== 11 ? "строку"
    : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? "строки" : "строк";
  const verb = copying ? "скопировать" : "перенести";
  const message = newTitle
    ? `Создать раздел «${newTitle}» и ${verb} в него ${count} ${rowWord}?`
    : `${copying ? "Скопировать" : "Перенести"} ${count} ${rowWord} в раздел «${target.title}»?`;
  const confirmed = await askConfirmation(`${message} ${copying ? "Исходные строки останутся на месте." : "Строки будут удалены из исходных разделов."}`, {
    title: copying ? "Копирование строк" : "Перенос строк", confirmText: copying ? "Копировать" : "Перенести",
  });
  if (!confirmed) { selectionUi.MoveButton.focus(); return; }
  if (draft.draftId !== documentId) { showToast("Отчёт изменился. Выберите строки заново."); return; }
  flushDraftFromDom();
  if (targetId && !draft.sections.some((section) => section.id === targetId)) {
    showToast("Раздел больше не существует. Выберите другой раздел.");
    return;
  }
  if (!draft.sections.some((section) => (copying || section.id !== targetId) && section.rows.some((row) => ids.has(row.id)))) return;
  if (!copying && !window.QaReportTable.canMove(draft.sections, ids, targetId)) return;
  let destinationId = targetId;
  let transferredCount = 0;
  commitSelectionMutation(() => {
    if (newTitle) {
      const source = draft.sections.find((section) => section.rows.some((row) => ids.has(row.id)));
      const section = createSection(newTitle, source.columns, 0);
      draft.sections.push(section);
      destinationId = section.id;
    }
    transferredCount = copying
      ? window.QaReportSelection.copyRows(draft.sections, ids, destinationId, () => crypto.randomUUID())
      : window.QaReportSelection.moveRows(draft.sections, ids, destinationId, () => crypto.randomUUID(), createRow);
    if (!copying) selectedRowIds.clear();
  });
  const destination = [...elements.sections.children].find((section) => section.dataset.sectionId === destinationId);
  destination?.scrollIntoView({ behavior: "smooth", block: "start" });
  showToast(`${copying ? "Скопировано" : "Перенесено"} строк: ${transferredCount}`);
}

let selectionCopyBusy = false;

let selectionCopyOptionsResolver = null;

function updateSelectionCopyOptions() {
  const withSections = document.querySelector('[name="selectionCopyGrouping"]:checked').value === "sections";
  document.getElementById("selectionCopyTitleField").hidden = withSections;
  document.getElementById("selectionCopySectionNumbersOption").hidden = !withSections;
  document.getElementById("selectionCopyPreserveSectionNumbers").disabled = !withSections;
  document.getElementById("selectionCopyGroupingHint").hidden = withSections;
}

function askSelectionCopyOptions(ids) {
  document.querySelector('[name="selectionCopyGrouping"][value="sections"]').checked = true;
  document.getElementById("selectionCopyTitle").value = "Выбранные пункты";
  document.getElementById("selectionCopyPreserveRowNumbers").checked = true;
  document.getElementById("selectionCopyPreserveSectionNumbers").checked = true;
  const sections = draft.sections.filter(section => section.rows.some(row => ids.has(row.id)));
  const count = sections.reduce((sum, section) => sum + section.rows.filter(row => ids.has(row.id)).length, 0);
  document.getElementById("selectionCopyOptionsSummary").textContent = `Выбрано пунктов: ${count} · разделов: ${sections.length}`;
  updateSelectionCopyOptions();
  document.getElementById("selectionCopyOptionsModal").hidden = false;
  syncBodyModalOverflow();
  document.querySelector('[name="selectionCopyGrouping"]:checked').focus();
  return new Promise(resolve => { selectionCopyOptionsResolver = resolve; });
}

function resolveSelectionCopyOptions(accepted) {
  if (!selectionCopyOptionsResolver) return;
  const resolve = selectionCopyOptionsResolver;
  selectionCopyOptionsResolver = null;
  const grouping = document.querySelector('[name="selectionCopyGrouping"]:checked').value;
  const options = accepted ? {
    grouping,
    title: document.getElementById("selectionCopyTitle").value.trim() || "Выбранные пункты",
    preserveRows: document.getElementById("selectionCopyPreserveRowNumbers").checked,
    preserveSections: grouping === "sections" && document.getElementById("selectionCopyPreserveSectionNumbers").checked,
  } : null;
  document.getElementById("selectionCopyOptionsModal").hidden = true;
  syncBodyModalOverflow();
  resolve(options);
}



async function saveSelectionCopy(before, next) {
  const db = await openDatabase();
  let sourceRecord, copyRecord;
  // Either both history entries are durable, or neither write is committed.
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(REPORT_STORE, "readwrite");
    const store = transaction.objectStore(REPORT_STORE);
    const request = store.get(before.reportId);
    request.onsuccess = () => {
      try {
        sourceRecord = portableHistoryRecord(before, "before-selection-copy", request.result);
        copyRecord = portableHistoryRecord(next, "selection-copy");
        copyRecord.historyComment = `Выбранные пункты из чек-листа ${before.publicId}`;
        store.put(sourceRecord);
        store.add(copyRecord);
      } catch { transaction.abort(); }
    };
    transaction.oncomplete = resolve;
    transaction.onerror = transaction.onabort = () => reject(new Error("Не удалось сохранить чек-листы в истории. Проверьте свободное место в браузере и повторите копирование."));
  });
  queueServerReportSave(sourceRecord);
  queueServerReportSave(copyRecord);
}

async function copySelectedRowsToNewChecklist() {
  if (selectionCopyBusy) return;
  flushDraftFromDom();
  const ids = new Set(selectedRowIds);
  if (!draft.sections.some((section) => section.rows.some((row) => ids.has(row.id)))) return;
  const documentId = draft.draftId;
  selectionCopyBusy = true;
  updateSelectionUi();
  closeSelectionMenus();
  try {
    const copyOptions = await askSelectionCopyOptions(ids);
    if (!copyOptions) return;
    if (draft.draftId !== documentId) throw new Error("Отчёт изменился. Выберите строки заново.");
    clearTimeout(saveTimer);
    if (await saveDraft() === false) throw new Error("Не удалось сохранить текущий чек-лист. Проверьте сохранение и повторите копирование.");
    if (draft.draftId !== documentId) throw new Error("Отчёт изменился. Выберите строки заново.");
    flushDraftFromDom();
    const before = clone(draft);
    const beforeContent = serializeDraft();
    const sections = window.QaReportSelection.copySelection(before.sections, ids, () => crypto.randomUUID(), {
      grouping: copyOptions.grouping, title: copyOptions.title,
      rowNumbers: copyOptions.preserveRows ? ChecklistNumbering.rowNumbers(before) : null,
      sectionNumbers: copyOptions.preserveSections ? ChecklistNumbering.sectionNumbers(before) : null,
    });
    if (!sections.length) return;
    const next = normalizeDraft({
      ...clone(DEFAULT_DRAFT),
      issueUrl: before.issueUrl, environment: before.environment, overallStatus: before.overallStatus,
      intro: before.intro, numberingMode: before.numberingMode, sections,
      draftId: crypto.randomUUID(), reportId: crypto.randomUUID(), publicId: createPublicId(),
      revision: 1, updatedAt: new Date().toISOString(), lastSavedBy: tabId, lastSavedClientId: reportClientId,
    });
    ChecklistNumbering.configureImport(next, copyOptions.preserveRows, before.numberingMode, copyOptions.preserveSections);
    await saveSelectionCopy(before, next);
    const count = sections.reduce((sum, section) => sum + section.rows.length, 0);
    const unchanged = () => {
      flushDraftFromDom();
      return draft.draftId === documentId && serializeDraft() === beforeContent;
    };
    if (!unchanged()) {
      showToast("Новый чек-лист сохранён в истории. Текущий отчёт изменился и остаётся открытым.");
      return;
    }
    const open = await askConfirmation(
      `Скопировано ${count} ${window.QaReportImportOptions.itemWord(count)}. Оба чек-листа доступны в истории.`,
      { title: "Новый чек-лист создан", confirmText: "Открыть новый", cancelText: "Остаться в текущем" },
    );
    if (open && unchanged()) {
      applyDraftLocally(next);
      broadcastDraftUpdate();
      showToast("Открыт новый чек-лист с выбранными пунктами");
    } else if (open) {
      showToast("Текущий отчёт изменился. Новый чек-лист доступен в истории.");
    }
  } catch (error) {
    showToast(error.message || "Не удалось скопировать выбранные пункты", 9000);
  } finally {
    selectionCopyBusy = false;
    updateSelectionUi();
    if (draft.draftId === documentId && selectionMode && elements.confirmModal.hidden) selectionUi.CopyButton.focus();
  }
}

async function deleteSelectedRows() {
  flushDraftFromDom();
  const ids = new Set(selectedRowIds);
  if (!ids.size) return;
  const documentId = draft.draftId;
  const allSelected = draft.sections.every((section) => section.rows.every((row) => ids.has(row.id)));
  closeSelectionMenus();
  const confirmed = await askConfirmation(
    `Удалить выбранные строки (${ids.size})?${allSelected ? " Останется раздел «Основные проверки» с двумя пустыми строками." : " Опустевшие разделы сохранят одну пустую строку."}`,
    { title: "Удаление строк", confirmText: "Удалить", danger: true },
  );
  if (!confirmed) { selectionUi.Delete.focus(); return; }
  if (draft.draftId !== documentId) { showToast("Отчёт изменился. Выберите строки заново."); return; }
  flushDraftFromDom();
  if (!draft.sections.some((section) => section.rows.some((row) => ids.has(row.id)))) return;
  let deletedCount = 0;
  commitSelectionMutation(() => {
    const result = window.QaReportSelection.deleteRows(draft.sections, ids, createRow,
      () => createSection("Основные проверки", loadDefaultColumns(), 2));
    draft.sections = result.sections;
    deletedCount = result.count;
    selectedRowIds.clear();
  });
  showToast(`Удалено строк: ${deletedCount}`);
  selectionUi.All.focus();
}

let renderSectionsRevision = 0;

function captureChecklistViewport() {
  const page = document.scrollingElement || document.documentElement;
  return {
    pageLeft: page.scrollLeft,
    pageTop: page.scrollTop,
    sections: new Map([...elements.sections.querySelectorAll(".check-section[data-section-id]")].map(sectionElement => [
      sectionElement.dataset.sectionId,
      sectionElement.querySelector(".table-scroll")?.scrollLeft || 0,
    ])),
  };
}

function restoreChecklistViewport(viewport) {
  const page = document.scrollingElement || document.documentElement;
  for (const [sectionId, scrollLeft] of viewport.sections) {
    const sectionElement = elements.sections.querySelector(`[data-section-id="${CSS.escape(sectionId)}"]`);
    const tableScroll = sectionElement?.querySelector(".table-scroll");
    const headerScroll = sectionElement?.querySelector(".section-header-scroll");
    if (tableScroll) tableScroll.scrollLeft = scrollLeft;
    if (headerScroll) headerScroll.scrollLeft = scrollLeft;
  }
  page.scrollLeft = viewport.pageLeft;
  page.scrollTop = viewport.pageTop;
}

function renderSections() {
  const preserveViewport = selectionDraftId === draft.draftId;
  const viewport = preserveViewport ? captureChecklistViewport() : null;
  const revision = ++renderSectionsRevision;
  if (selectionDraftId !== draft.draftId) {
    selectedRowIds.clear();
    selectionDraftId = draft.draftId;
    closeSelectionMenus();
  }
  const rowNumbers = ChecklistNumbering.rowNumbers(draft);
  const sectionNumbers = ChecklistNumbering.sectionNumbers(draft);
  elements.sections.innerHTML = "";
  draft.sections.forEach((section) => {
    const fragment = elements.sectionTemplate.content.cloneNode(true);
    const sectionElement = fragment.querySelector(".check-section");
    sectionElement.dataset.sectionId = section.id;
    sectionElement.draggable = true;
    sectionElement.classList.toggle("collapsed", Boolean(section.collapsed));

    const sectionNumber = fragment.querySelector(".section-number");
    if (draft.sectionNumberingMode === "manual") {
      const input = document.createElement("input");
      input.type = "text"; input.className = "section-number-input"; input.placeholder = "№";
      input.value = sectionNumbers.get(section.id); input.maxLength = 60;
      input.setAttribute("aria-label", `Номер раздела «${section.title}»`);
      input.addEventListener("input", () => {
        section.manualNumber = ChecklistNumbering.normalizeSectionNumber(input.value);
        if (draft.numberingMode === "hierarchical") {
          const numbers = ChecklistNumbering.rowNumbers(draft);
          sectionElement.querySelectorAll("tr[data-row-id]").forEach(row => {
            row.querySelector(".row-number-text").textContent = numbers.get(row.dataset.rowId);
          });
        }
        scheduleSave();
      });
      input.addEventListener("change", () => { flushDraftFromDom(); renderSections(); saveLocalMutationNow(); });
      sectionNumber.replaceWith(input);
    } else sectionNumber.textContent = `${sectionNumbers.get(section.id)}.`;
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
    renderTable(fragment, section, rowNumbers);
    enableSectionDragging(sectionElement, section.id);
    elements.sections.append(fragment);
    highlightCodeBlocks(sectionElement);
    enhanceImageControls(sectionElement);
    enhanceFileControls(sectionElement);
  });
  updateSelectionUi();
  applyPinnedColumns();
  if (viewport) {
    restoreChecklistViewport(viewport);
    requestAnimationFrame(() => {
      if (revision === renderSectionsRevision) restoreChecklistViewport(viewport);
    });
  }
  scheduleStickySectionUpdate();
}

function renderTable(fragment, section, rowNumbers) {
  const table = fragment.querySelector(".check-table");
  const tableScroll = fragment.querySelector(".table-scroll");
  tableScroll.tabIndex = 0;
  tableScroll.setAttribute("role", "region");
  tableScroll.setAttribute("aria-label", `Таблица раздела «${section.title}»`);
  const headerTable = fragment.querySelector(".section-header-table");
  const headerScroll = fragment.querySelector(".section-header-scroll");
  const bodyColgroup = table.querySelector("colgroup");
  const headerColgroup = headerTable.querySelector("colgroup");
  const header = headerTable.querySelector("thead tr");
  if (selectionMode) {
    bodyColgroup.append(createColumnElement("selection-col", 44));
    headerColgroup.append(createColumnElement("selection-col", 44));
    const cell = document.createElement("th");
    cell.className = "selection-cell";
    const checkbox = createSelectionCheckbox(`Выбрать все строки раздела «${section.title}»`);
    checkbox.dataset.selectionSection = section.id;
    checkbox.addEventListener("change", () => {
      section.rows.forEach((row) => checkbox.checked ? selectedRowIds.add(row.id) : selectedRowIds.delete(row.id));
      updateSelectionUi();
    });
    cell.append(checkbox);
    header.append(cell);
  }
  bodyColgroup.append(createColumnElement("number-col", ChecklistNumbering.columnWidth(draft)));
  headerColgroup.append(createColumnElement("number-col", ChecklistNumbering.columnWidth(draft)));
  const numberHeader = createHeader("№");
  numberHeader.className = "number-header";
  header.append(numberHeader);

  let totalWidth = ChecklistNumbering.columnWidth(draft) + 164 + 40 + (selectionMode ? 44 : 0);
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
  const actionsHeader = createHeader("");
  actionsHeader.className = "actions-header";
  header.append(createStatusHeader(section), actionsHeader);
  table.style.width = `${totalWidth}px`;
  table.style.minWidth = "100%";
  headerTable.style.width = `${totalWidth}px`;
  headerTable.style.minWidth = "100%";

  const tbody = fragment.querySelector("tbody");
  window.QaReportTable.visibleRows(section).forEach((row) => tbody.append(createRowElement(section, row, rowNumbers.get(row.id))));
  tbody.addEventListener("dragover", (event) => {
    if (section.statusSort || !hasDragType(event, "text/row-id")) return;
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
    if (section.statusSort || !hasDragType(event, "text/row-id")) return;
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
  return ChecklistNumbering.columnWidth(draft) + 164 + 40 + (selectionMode ? 44 : 0) + section.columns.reduce((sum, item) => sum + (Number(item.width) || 240), 0);
}

function getStickyOffset() {
  const toolbar = document.querySelector(".editor-toolbar");
  if (selectionMode && toolbar) {
    const top = parseFloat(getComputedStyle(toolbar).top) || 0;
    selectionUi.Toolbar.style.top = `${top + toolbar.getBoundingClientRect().height + 8}px`;
  }
  const toolbarRect = (selectionMode ? selectionUi.Toolbar : toolbar)?.getBoundingClientRect();
  return Math.max(0, toolbarRect?.bottom || 0) + 8;
}

function updateSelectionMenuLayout() {
  for (const [menu, list] of [[selectionUi.StatusMenu, selectionUi.StatusOptions], [selectionUi.MoveMenu, selectionUi.Destinations]]) {
    if (menu.hidden) continue;
    const scrollTop = list.scrollTop;
    // Only the options list scrolls. Keep search, the creation form and actions visible.
    menu.style.transform = "";
    menu.style.maxHeight = `${Math.max(0, Math.min(520, window.innerHeight - 24))}px`;
    const rect = menu.getBoundingClientRect();
    const fixedHeight = rect.height - list.getBoundingClientRect().height;
    const minimumHeight = fixedHeight + Math.min(72, list.scrollHeight);
    const availableBelow = window.innerHeight - rect.top - 12;
    const shift = Math.min(Math.max(0, rect.top - 12), Math.max(0, minimumHeight - availableBelow));
    if (shift) menu.style.transform = `translateY(-${shift}px)`;
    menu.style.maxHeight = `${Math.max(0, Math.min(520, availableBelow + shift))}px`;
    // Temporary expansion during measurement must not clamp the user's position.
    list.scrollTop = scrollTop;
  }
}

function updateStickyOffsets() {
  updatePinnedColumnOffsets();
  const stickyTop = getStickyOffset();
  // Gap covers follow their own panels, including while section headers change.
  for (const panel of [document.querySelector(".editor-toolbar"), selectionUi.Toolbar]) {
    if (!panel) continue;
    const top = parseFloat(getComputedStyle(panel).top) || 0;
    panel.classList.toggle("is-stuck", !panel.hidden && panel.getBoundingClientRect().top <= top + 1);
  }
  document.documentElement.style.setProperty("--section-sticky-top", `${stickyTop}px`);
  updateSelectionMenuLayout();
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
      label: "Очистить столбец",
      icon: "broom",
      danger: true,
      action: () => clearSectionColumn(section.id, column.id),
    });
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
    const total = getSectionTableWidth(section);
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
  label.innerHTML = 'Статус <span class="required">*</span>' + (section.statusSort ? ' ↓' : '');
  const menuButton = document.createElement("button");
  menuButton.type = "button";
  menuButton.className = "column-menu-button";
  menuButton.textContent = "•••";
  menuButton.title = "Действия рядом со статусом";
  menuButton.addEventListener("click", (event) => {
    event.stopPropagation();
    showFloatingMenu(menuButton, [
      { label: section.statusSort ? "Вернуть исходный порядок" : "Сортировать по статусу", icon: section.statusSort ? "undo" : "arrow-down", action: () => toggleStatusSort(section.id) },
      {
        label: "Вставить столбец слева",
        icon: "column-insert-left",
        action: () => insertColumn(section, section.columns.length),
      },
      {
        label: "Очистить столбец",
        icon: "broom",
        danger: true,
        action: () => clearSectionColumn(section.id),
      },
    ]);
  });
  th.addEventListener("contextmenu", event => { event.preventDefault(); menuButton.click(); });
  th.append(label, menuButton);
  return th;
}

function createRowElement(section, row, number) {
  const tr = document.createElement("tr");
  tr.dataset.rowId = row.id;
  if (selectionMode) {
    const cell = document.createElement("td");
    cell.className = "selection-cell";
    const checkbox = createSelectionCheckbox(`Выбрать строку ${number.replace(/\.$/, "")} раздела «${section.title}»`);
    checkbox.dataset.selectionRow = row.id;
    checkbox.addEventListener("change", () => {
      checkbox.checked ? selectedRowIds.add(row.id) : selectedRowIds.delete(row.id);
      updateSelectionUi();
    });
    cell.append(checkbox);
    tr.append(cell);
  }

  const numberCell = document.createElement("td");
  numberCell.className = "row-number";
  const rowDragHandle = document.createElement("span");
  rowDragHandle.className = "row-drag-handle";
  rowDragHandle.textContent = "⋮⋮";
  rowDragHandle.title = "Перетащить строку";
  rowDragHandle.draggable = !section.statusSort;
  rowDragHandle.hidden = Boolean(section.statusSort);
  const manual = draft.numberingMode === "manual";
  const rowNumber = document.createElement(manual ? "input" : "span");
  rowNumber.className = manual ? "row-number-text row-number-input" : "row-number-text";
  if (manual) {
    rowNumber.type = "text";
    rowNumber.value = number;
    rowNumber.placeholder = "№";
    rowNumber.setAttribute("aria-label", `Номер пункта в разделе «${section.title}»`);
    rowNumber.addEventListener("input", () => {
      row.manualNumber = ChecklistNumbering.normalizeNumber(rowNumber.value);
      scheduleSave();
    });
    rowNumber.addEventListener("change", () => {
      saveLocalMutationNow();
    });
  } else rowNumber.textContent = number;
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
      updateCellFromEditor(section.id, row.id, column.id, editor);
    });
    td.append(editor);
    tr.append(td);
  });

  const statusCell = document.createElement("td");
  statusCell.className = "status-cell";
  const statusSelect = createStatusSelect(row.status);
  statusSelect.addEventListener("change", () => {
    row.status = statusSelect.value;
    setStatusClass(statusSelect, row.status);
    if (section.statusSort) {
      flushDraftFromDom(); renderSections(); renderSummary(); saveLocalMutationNow(); return;
    }
    // The captured row may predate autosave. scheduleSave synchronizes the current draft.
    scheduleSave();
    renderSummary();
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
      { label: row.pendingBug ? "Проверить создание бага" : row.bugs?.some(b => b.attachmentsPending || b.evidencePending) ? "Завершить создание бага" : "Завести баг-репорт", icon: "bug", action: () => window.QaReportBugUI.open(section.id, row.id, menuButton) },
      { label: "Добавить строку выше", icon: "row-insert-above", disabled: Boolean(section.statusSort), action: () => applyRowAction(section, row.id, "insert-above") },
      { label: "Добавить строку ниже", icon: "row-insert-below", disabled: Boolean(section.statusSort), action: () => applyRowAction(section, row.id, "insert-below") },
      { label: "Дублировать", icon: "copy", action: () => applyRowAction(section, row.id, "duplicate") },
      { label: "Новый раздел отсюда", icon: "section-split", disabled: Boolean(section.statusSort), action: () => applyRowAction(section, row.id, "split") },
      { label: "Поднять выше", icon: "arrow-up", disabled: Boolean(section.statusSort), action: () => applyRowAction(section, row.id, "move-up") },
      { label: "Опустить ниже", icon: "arrow-down", disabled: Boolean(section.statusSort), action: () => applyRowAction(section, row.id, "move-down") },
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
    if (section.statusSort) { event.preventDefault(); return; }
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/row-id", row.id);
    tr.classList.add("row-dragging");
  });
  rowDragHandle.addEventListener("dragend", clearRowDragState);
  tr.addEventListener("dragover", (event) => {
    if (section.statusSort || !hasDragType(event, "text/row-id")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    updateRowDragAutoScroll(event);
    const rect = tr.getBoundingClientRect();
    const placeAfter = event.clientY > rect.top + rect.height / 2;
    clearRowDropState();
    tr.classList.add(placeAfter ? "row-drop-after" : "row-drop-before");
  });
  tr.addEventListener("dragleave", (event) => {
    if (section.statusSort || !hasDragType(event, "text/row-id")) return;
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

function updateCellFromEditor(sectionId, rowId, columnId, editor) {
  // Autosave replaces draft objects. Resolve IDs instead of mutating a captured row.
  const section = draft.sections.find((item) => item.id === sectionId);
  const row = section?.rows.find((item) => item.id === rowId);
  if (!row || !section.columns.some((column) => column.id === columnId)) return;
  const hadContent = hasRowContent(row);
  row.cells[columnId] = cleanEditorHtml(editor);
  scheduleSave({ collect: false });
  if (hadContent !== hasRowContent(row)) renderSummary();
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
  if (!window.QaReportTable.canMove(draft.sections, new Set([sourceId]), targetSectionRef.id)) return;
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
  if (!window.QaReportTable.canMove(draft.sections, new Set([sourceId]), targetSectionRef.id)) return;
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

function clearSectionColumn(sectionId, columnId = null) {
  flushDraftFromDom();
  const section = draft.sections.find((item) => item.id === sectionId);
  if (!section || (columnId !== null && !section.columns.some((column) => column.id === columnId))) return;
  const isStatus = columnId === null;
  if (!section.rows.some((row) => isStatus ? row.status !== "НЕ ПРОВЕРЕНО" : Boolean(row.cells[columnId]))) return;
  closeFloatingMenu();
  commitSelectionMutation(() => {
    section.rows.forEach((row) => {
      if (isStatus) row.status = "НЕ ПРОВЕРЕНО";
      else row.cells[columnId] = "";
    });
  });
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
  if (draft.sections.find(item => item.id === section.id)?.statusSort) return;
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
  if (currentSection.statusSort && ["insert-above", "insert-below", "split", "move-up", "move-down"].includes(action)) return;
  const index = currentSection.rows.findIndex((row) => row.id === rowId);
  if (index < 0) return;
  if (action === "insert-above") {
    currentSection.rows.splice(index, 0, createRow(currentSection.columns));
  } else if (action === "insert-below") {
    currentSection.rows.splice(index + 1, 0, createRow(currentSection.columns));
  } else if (action === "duplicate") {
    currentSection.rows.splice(currentSection.statusSort ? currentSection.rows.length : index + 1, 0, { ...clone(currentSection.rows[index]), id: crypto.randomUUID(), ...(draft.numberingMode === "manual" ? { manualNumber: "" } : {}) });
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
    button.disabled = Boolean(item.disabled);
    if (item.disabled) button.title = "Верните исходный порядок строк, чтобы выполнить действие";
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
  if (!status) return;
  const meta = STATUS_META[status] || STATUS_META["НЕ ПРОВЕРЕНО"];
  select.classList.add(meta.className);
}

function hasRowContent(row) {
  return (
    row.status !== "НЕ ПРОВЕРЕНО" ||
    Object.keys(row.cells).length === 0 ||
    Object.values(row.cells).some((value) => /<img|<pre/i.test(value) || htmlToText(value))
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

function escapeWikiNotEquals(value, protect = value => value) {
  // Protect generated escapes from the later table-cell backslash conversion.
  return value.replace(/!=/g, () => protect("\\!="));
}

function htmlToWiki(html, {protect = value => value, forPublication = false} = {}) {
  const container = document.createElement("div");
  container.innerHTML = html || "";
  function childrenToWiki(parent) {
    const parts = [];
    let inline = "";
    const flush = () => { if (inline) parts.push({value:inline, gap:1}); inline = ""; };
    for (const child of parent.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE && child.matches("[data-editor-ui]")) continue;
      const block = child.nodeType === Node.ELEMENT_NODE && /^(P|DIV|FIGURE|PRE|UL|OL|H[1-6])$/.test(child.tagName);
      if (!block) { inline += walk(child); continue; }
      flush();
      const empty = /^(P|DIV)$/.test(child.tagName) && child.querySelectorAll("br").length <= 1 && [...child.childNodes].every(node =>
        node.nodeType === Node.TEXT_NODE ? !node.textContent.trim() : node.nodeType === Node.ELEMENT_NODE && node.tagName === "BR");
      parts.push({value:empty ? "" : walk(child), gap:child.tagName === "P" ? 2 : 1});
    }
    flush();
    let output = "";
    parts.forEach((part, index) => {
      if (index) {
        const previous = parts[index-1];
        const trailing = previous.value ? (output.match(/\n*$/)?.[0].length || 0) : 0;
        const leading = part.value.match(/^\n*/)?.[0].length || 0;
        output += "\n".repeat(Math.max(0, Math.max(previous.gap,part.gap) - trailing - leading));
      }
      output += part.value;
    });
    return output;
  }
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = forPublication
        ? window.QaReportJiraPublication.textForPublication(node.textContent, { wiki: true, protect })
        : node.textContent;
      return escapeWikiNotEquals(text, protect);
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    if (node.matches?.("[data-editor-ui]")) return "";
    if (node.matches?.(".cell-file")) return protect(fileCardToWiki(node));
    if (node.matches?.(".jira-image-placeholder")) {
      const name = node.dataset.jiraName || "image.png";
      const options = node.dataset.jiraOptions;
      return protect(`!${name}${options ? `|${options}` : ""}!`);
    }
    if (node.matches?.(".jira-file-placeholder")) return protect(`[^${node.dataset.jiraName || "file"}]`);
    const tag = node.tagName.toLowerCase();
    if (forPublication && tag === "code" && node.parentElement?.tagName !== "PRE") {
      return protect(`{{${extractCodeText(node)}}}`);
    }
    if ((tag === "span" && node.style.color) || (tag === "font" && node.getAttribute("color"))) {
      const content = childrenToWiki(node);
      if (!content.trim()) return content;
      if (/\{color(?::[^}]+)?\}/i.test(content)) return content;
      const color = node.style.color || node.getAttribute("color");
      return `{color:${cssColorToHex(color)}}${content}{color}`;
    }
    const content = childrenToWiki(node);
    if (tag === "strong" || tag === "b") return `*${content}*`;
    if (tag === "em" || tag === "i") return `_${content}_`;
    if (tag === "u") return `+${content}+`;
    if (tag === "s" || tag === "strike") return `-${content}-`;
    if (tag === "sup") return `^${content}^`;
    if (tag === "sub") return `~${content}~`;
    if (tag === "code" && node.parentElement?.tagName !== "PRE") return protect(`{{${extractCodeText(node)}}}`);
    if (tag === "a") return protect(`[${content}|${node.getAttribute("href") || ""}]`);
    if (tag === "pre") {
      return protect(`{code}\n${extractCodeText(node)}\n{code}`);
    }
    if (tag === "img") {
      const name = node.dataset.jiraName || node.dataset.fileName || node.alt || "image.png";
      if (isStoredObjectUrl(node.src)) return protect(`[${name}|${node.src}]`);
      const jiraOptions = node.dataset.jiraOptions;
      if (jiraOptions) return protect(`!${node.dataset.jiraExactUrl === "true" && node.dataset.jiraUrl ? node.dataset.jiraUrl : name}|${jiraOptions}!`);
      // Ссылка по имени вложения даёт Jira возможность открыть изображение
      // во встроенном просмотрщике, а параметр thumbnail оставляет его компактным.
      return protect(`!${node.dataset.jiraExactUrl === "true" && node.dataset.jiraUrl ? node.dataset.jiraUrl : name}|thumbnail!`);
    }
    if (tag === "figure") return content;
    if (tag === "br") return "\n";
    if (tag === "ul") return protect("\n" + [...node.children].map((item) => `* ${walk(item).trim()}`).join("\n") + "\n", "list");
    if (tag === "ol") return protect("\n" + [...node.children].map((item) => `# ${walk(item).trim()}`).join("\n") + "\n", "list");
    if (tag === "li") return content;
    if (/h[1-6]/.test(tag)) return `h${tag.slice(1)}. ${content}\n`;
    if (tag === "p" || tag === "div") return content;
    return content;
  }
  return normalizeJiraColorMarkup(
    childrenToWiki(container).trim(),
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

  return lines.join("\n");
}

function jiraCell(value, {forPublication = false} = {}) {
  const protectedBlocks = [];
  const tokenPrefix = `@@JIRA_CELL_${crypto.randomUUID()}_`;
  // Generate syntax only after escaping text; never run a second escape over it.
  const escapeCellText = text => text.replace(/\\/g, "&#92;").replace(/\|/g, "\\|");
  let content = htmlToWiki(value, {forPublication, protect: (block, kind) => {
    const token = `${tokenPrefix}${protectedBlocks.length}@@`;
    protectedBlocks.push(kind === "list" ? escapeCellText(block) : block);
    return token;
  }});
  content = escapeCellText(normalizeJiraCellWhitespace(content))
    // Whitespace separates the break from !image!, {code} and the next break.
    .replace(/\n/g, "\\\\ ");
  // Lists/links may contain protected children, so restore parents first.
  for (let index = protectedBlocks.length - 1; index >= 0; index--) {
    content = content.split(`${tokenPrefix}${index}@@`).join(protectedBlocks[index]);
  }
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
      /\{color:(#[0-9a-f]{3,8})\}([\s\S]*?)\{color\}(\s*)\{color:\1\}([\s\S]*?)\{color\}/gi,
      "{color:$1}$2$3$4{color}",
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

function sectionsForPublication(sectionIds = null, sourceDraft = draft, statuses = null) {
  const selectedIds = sectionIds == null ? null : new Set(sectionIds);
  const selectedStatuses = statuses == null ? null : new Set(statuses);
  const sections = sourceDraft.sections.filter((section) => !selectedIds || selectedIds.has(section.id));
  if (!selectedStatuses) return sections;
  return sections.map((section) => ({
    ...section,
    rows: section.rows.filter((row) => selectedStatuses.has(row.status) && hasRowContent(row)),
  })).filter((section) => section.rows.length > 0);
}

function generateMarkup(options = {}) {
  const { sectionIds = null, statuses = null, forPublication = false } = options;
  const publicationText = value => forPublication
    ? window.QaReportJiraPublication.textForPublication(value, { wiki: true })
    : value;
  collectDocumentFields();
  const rowNumbers = ChecklistNumbering.rowNumbers(draft);
  const blocks = [];
  const heading = [];
  if (draft.environment) heading.push(`*Проверено на ${escapeWikiNotEquals(publicationText(draft.environment))}*`);
  if (draft.overallStatus) {
    const overallColor = STATUS_META[draft.overallStatus]?.jiraColor || STATUS_META["НЕ ПРОВЕРЕНО"].jiraColor;
    heading.push(`{color:${overallColor}}*ТЕСТ — ${draft.overallStatus}*{color}`);
  }
  if (heading.length) blocks.push(heading.join("\n"));
  const intro = htmlToWiki(draft.intro, {forPublication});
  if (intro) blocks.push(intro);

  sectionsForPublication(sectionIds, draft, statuses).forEach((section) => {
    const rows = section.rows.filter(hasRowContent);
    if (!rows.length) return;
    const lines = [`h2. ${escapeWikiNotEquals(publicationText(ChecklistNumbering.sectionTitle(draft, section)))}`];
    lines.push(
      `||${["Номер", ...section.columns.map((column) => escapeWikiNotEquals(publicationText(column.title || "Без названия"))), "Статус"].join("||")}||`,
    );
    rows.forEach((row) => {
      const values = section.columns.map((column) => jiraCell(row.cells[column.id] || "", {forPublication}));
      const status = `{color:${STATUS_META[row.status].jiraColor}}*${row.status}*{color}`;
      lines.push(`|${[jiraCell(escapeHtml(rowNumbers.get(row.id)), {forPublication}), ...values, status].join("|")}|`);
    });
    blocks.push(lines.join("\n"));
  });
  return blocks.join("\n\n");
}

function byId(items = []) {
  return new Map(items.filter((item) => item?.id).map((item) => [item.id, item]));
}

function generateVisualPreview(sourceDraft = draft, compareDraft = null, options = {}) {
  if (sourceDraft === draft) collectDocumentFields();
  const previewDraft = normalizeDraft(sourceDraft);
  const rowNumbers = ChecklistNumbering.rowNumbers(previewDraft);
  const oppositeDraft = compareDraft ? normalizeDraft(compareDraft) : null;
  const oppositeSections = byId(oppositeDraft?.sections || []);
  const wrapper = document.createElement("div");
  const overallColor = STATUS_META[previewDraft.overallStatus]?.jiraColor || STATUS_META["НЕ ПРОВЕРЕНО"].jiraColor;
  const heading = [];
  if (previewDraft.environment) heading.push(`<strong>Проверено на ${escapeHtml(previewDraft.environment)}</strong>`);
  if (previewDraft.overallStatus) heading.push(`<strong style="color:${overallColor}">ТЕСТ — ${escapeHtml(previewDraft.overallStatus)}</strong>`);
  wrapper.innerHTML = `<h1>Отчёт о тестировании</h1>${heading.length ? `<p>${heading.join("<br>")}</p>` : ""}`;
  if (htmlToText(previewDraft.intro) || /<img|<pre/i.test(previewDraft.intro)) {
    const intro = document.createElement("div");
    intro.className =
      oppositeDraft && cellText(previewDraft.intro) !== cellText(oppositeDraft.intro)
        ? "version-diff-changed"
        : "";
    intro.innerHTML = previewEditorHtml(previewDraft.intro);
    wrapper.append(intro);
  }
  sectionsForPublication(options.sectionIds, previewDraft, options.statuses).forEach((section) => {
    const oppositeSection = oppositeSections.get(section.id);
    const sectionOnlyHere = Boolean(oppositeDraft && !oppositeSection);
    const oppositeColumns = byId(oppositeSection?.columns || []);
    const oppositeRows = byId(oppositeSection?.rows || []);
    const rows = section.rows.filter(hasRowContent);
    if (!rows.length && !sectionOnlyHere) return;
    const heading = document.createElement("h2");
    heading.textContent = ChecklistNumbering.sectionTitle(previewDraft, section);
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
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      const oppositeRow = oppositeRows.get(row.id);
      const rowOnlyHere = Boolean(oppositeDraft && !oppositeRow);
      if (sectionOnlyHere || rowOnlyHere) tr.classList.add("version-diff-row");
      tr.innerHTML = `<td>${escapeHtml(rowNumbers.get(row.id))}</td>${section.columns
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

function wrapPortableUrls(container) {
  container.querySelectorAll("td").forEach((cell) => {
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    const urlNodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (/https?:\/\//i.test(node.data) && !node.parentElement?.closest("pre, code")) urlNodes.push(node);
    }
    urlNodes.forEach((node) => {
      const fragment = document.createDocumentFragment();
      let offset = 0;
      for (const match of node.data.matchAll(/https?:\/\/\S+/gi)) {
        fragment.append(document.createTextNode(node.data.slice(offset, match.index)));
        const url = document.createElement("span");
        url.style.overflowWrap = "anywhere";
        url.style.wordBreak = "break-word";
        url.style.whiteSpace = "normal";
        url.textContent = match[0];
        fragment.append(url);
        offset = match.index + match[0].length;
      }
      fragment.append(document.createTextNode(node.data.slice(offset)));
      node.replaceWith(fragment);
    });
  });
}

function generatePortableHtml(options = {}) {
  const container = document.createElement("div");
  container.innerHTML = generateVisualPreview(draft, null, options);
  container.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif';
  container.style.color = "#202124";
  container.style.background = "#ffffff";
  container.style.lineHeight = "1.5";
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
    table.style.background = "#ffffff";
    table.style.fontSize = "14px";
  });
  container.querySelectorAll("th, td").forEach((cell) => {
    cell.style.padding = "10px";
    cell.style.border = "1px solid #cfd6dd";
    cell.style.verticalAlign = "top";
    cell.style.textAlign = "left";
    cell.style.overflowWrap = "normal";
    cell.style.wordBreak = "normal";
    cell.style.hyphens = "none";
  });
  container.querySelectorAll("td").forEach((cell) => {
    cell.style.overflowWrap = "break-word";
  });
  container.querySelectorAll("th").forEach((cell) => {
    cell.style.background = "#e9edf2";
    cell.style.fontWeight = "700";
  });
  container.querySelectorAll("table").forEach((table) => {
    const headers = [...table.querySelectorAll("thead tr:first-child th")];
    if (headers.length) {
      const rows = [...(table.tBodies[0]?.rows || [])];
      const widths = headers.map((cell, index) => {
        const titleLength = cell.textContent.replace(/\s+/g, " ").trim().length;
        let longestWord = 0;
        rows.forEach((row) => {
          const text = (row.cells[index]?.textContent || "").replace(/https?:\/\/\S+/gi, " ");
          for (const word of text.match(/\S+/g) || []) longestWord = Math.max(longestWord, word.length);
        });
        const minimumWidth = Math.min(240, Math.max(72, titleLength * 8 + 24, longestWord * 8 + 24));
        cell.style.width = `${minimumWidth}px`;
        cell.style.minWidth = `${minimumWidth}px`;
        cell.setAttribute("width", String(minimumWidth));
        return minimumWidth;
      });
      table.style.tableLayout = "fixed";
      table.style.minWidth = `${widths.reduce((sum, width) => sum + width, 0)}px`;
    }
  });
  container.querySelectorAll("tbody tr:nth-child(even)").forEach((row) => {
    row.style.background = "#fafbfc";
  });
  container.querySelectorAll("p").forEach((paragraph) => {
    paragraph.style.margin = "0";
  });
  container.querySelectorAll("figure").forEach((figure) => {
    figure.style.margin = "6px 0";
  });
  container.querySelectorAll("img").forEach((image) => {
    image.style.display = "block";
    image.style.maxWidth = "100%";
    image.style.height = "auto";
  });
  container.querySelectorAll("pre").forEach((block) => {
    block.style.padding = "10px";
    block.style.border = "1px solid #c7cdd4";
    block.style.borderRadius = "6px";
    block.style.background = "#f4f5f7";
    block.style.whiteSpace = "pre-wrap";
  });
  wrapPortableUrls(container);
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
  elements.saveJiraSettingsButton.querySelector(".settings-save-label").textContent = saved ? "Сохранено" : "Сохранить";
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
  const selected = ["checklist", "columns", "projects", "environments", "connect", "jira", "history", "appearance"].includes(section) ? section : "checklist";
  if (selected === "projects" && !projectSettingsLoaded) fillProjectSettingsForm();
  elements.jiraSettingsModal.querySelectorAll("[data-settings-section]").forEach((button) => {
    const active = button.dataset.settingsSection === selected;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  elements.jiraSettingsModal.querySelectorAll("[data-settings-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.settingsPanel !== selected;
    panel.classList.toggle("active", !panel.hidden);
  });
  if (selected === "connect") refreshDictationConnect();
  document.getElementById("settingsContent").scrollTop = 0;
  document.getElementById("themeMenu").hidden = true;
  elements.themeToggle.setAttribute("aria-expanded", "false");
}

function loadPinnedColumns() {
  try {
    const saved = JSON.parse(localStorage.getItem(PINNED_COLUMNS_KEY) || "{}");
    return { number: saved?.number === true, status: saved?.status === true };
  } catch {
    return { number: false, status: false };
  }
}

function fillPinnedColumnsForm() {
  document.getElementById("pinNumberColumn").checked = pinnedColumns.number;
  document.getElementById("pinStatusColumn").checked = pinnedColumns.status;
}

function savePinnedColumns() {
  const next = {
    number: document.getElementById("pinNumberColumn").checked,
    status: document.getElementById("pinStatusColumn").checked,
  };
  localStorage.setItem(PINNED_COLUMNS_KEY, JSON.stringify(next));
  pinnedColumns = next;
  applyPinnedColumns();
}

function applyPinnedColumns() {
  document.body.classList.toggle("pin-number-columns", pinnedColumns.number);
  document.body.classList.toggle("pin-status-columns", pinnedColumns.status);
  scheduleStickySectionUpdate();
}

function updatePinnedColumnOffsets() {
  elements.sections.querySelectorAll(".check-section").forEach((section) => {
    const actionsWidth = section.querySelector(".section-header-table .actions-header")?.getBoundingClientRect().width || 40;
    const actionsOffset = `${actionsWidth}px`;
    if (section.style.getPropertyValue("--pinned-status-right") !== actionsOffset) {
      section.style.setProperty("--pinned-status-right", actionsOffset);
    }
    const checkboxCell = section.querySelector(".section-header-table .selection-cell");
    const offset = checkboxCell?.getBoundingClientRect().width || 0;
    const value = `${offset}px`;
    if (section.style.getPropertyValue("--pinned-number-left") !== value) {
      section.style.setProperty("--pinned-number-left", value);
    }
  });
}

function fillChecklistSettingsForm() {
  defaultColumnsDraft = loadDefaultColumns();
  renderDefaultColumnsSettings();
  elements.jiraSettingsModal.querySelectorAll('[name="numberingMode"]').forEach((input) => {
    input.checked = input.value === ChecklistNumbering.normalizeMode(draft.numberingMode);
  });
  elements.jiraSettingsModal.querySelectorAll('[name="sectionNumberingMode"]').forEach((input) => {
    input.checked = input.value === ChecklistNumbering.normalizeSectionMode(draft.sectionNumberingMode);
  });
}

function saveChecklistSettings() {
  const mode = ChecklistNumbering.normalizeMode(elements.jiraSettingsModal.querySelector('[name="numberingMode"]:checked')?.value);
  const sectionMode = ChecklistNumbering.normalizeSectionMode(elements.jiraSettingsModal.querySelector('[name="sectionNumberingMode"]:checked')?.value);
  if (draft.numberingMode === mode && draft.sectionNumberingMode === sectionMode) return;
  flushDraftFromDom();
  // Freeze row labels before changing section numbering, so the two settings stay independent.
  ChecklistNumbering.setMode(draft, mode);
  ChecklistNumbering.setSectionMode(draft, sectionMode);
  renderSections();
  saveLocalMutationNow();
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
  fillChecklistSettingsForm();
  fillEnvironmentSettingsForm();
  fillPinnedColumnsForm();
  resetProjectSettingsForm();
  setSettingsSection("checklist");
  setSettingsSavedState(false);
  setReportIdentityState(
    !cloudHistoryEnabled
      ? "Чек-листы сохраняются только локально в этом браузере."
      : reportWorkspaceKey.trim()
        ? `Синхронизация включена. Пространство: ${reportWorkspaceKey.trim()}.`
        : "Синхронизация включена для вашей корпоративной учётной записи.",
  );
  elements.jiraSettingsModal.hidden = false;
  syncBodyModalOverflow();
  loadJiraConnections();
}

function closeJiraSettings() {
  projectSettingsRequestId++;
  elements.jiraSettingsModal.hidden = true;
  syncBodyModalOverflow();
}

function saveJiraSettings() {
  try {
    saveProjectSettings();
    saveEnvironmentSettings();
    saveReportIdentitySettings();
    if (environmentSettingsWorkspace !== reportWorkspaceKey) fillEnvironmentSettingsForm();
    renderEnvironmentOptions();
    saveDefaultColumnsSettings();
    saveChecklistSettings();
    savePinnedColumns();
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
  if (error?.publicationLinkCleared) return error.message;
  if (error?.name === "AbortError") return "Публикация отменена";
  if (error?.code === "ATTACHMENT_LIMIT") return error.message;
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
    if (error.status === 413) {
      if (error.code || error.payload?.error) return error.message;
      return "Прокси QA Report отклонил запрос по размеру (HTTP 413). Файл мог ещё не попасть в Jira. Передайте администратору QA Report: нужно увеличить лимит тела запроса на прокси с учётом размера файлов при передаче.";
    }
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
  const { signal, retries = 0, binary = false } = options;
  let attempt = 0;
  while (true) {
    try {
      const safeBody = { ...(body || {}) };
      for (const field of ["token", "password", "cookie", "authorization", "user", "baseUrl", "authMethod"]) delete safeBody[field];
      const serializedBody = JSON.stringify(safeBody);
      if (path === "/api/jira/attachments") {
        const limitError = window.QaReportAttachmentLimits.requestError(serializedBody, attachmentLimits);
        if (limitError) throw new JiraRequestError(limitError, { status: 413, code: "APP_REQUEST_TOO_LARGE" });
      }
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serializedBody,
        signal,
      });
      if (binary && response.ok) return response.blob();
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
  const retries = path.includes("/attachments") ? 2 : path.endsWith("/comment") ? 0 : 1;
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
  document.getElementById("publishAttachmentSummary").hidden = true;
  elements.publishErrorText.textContent = "";
  elements.publishProgressHint.textContent = "Не закрывайте страницу до завершения публикации.";
  syncBodyModalOverflow();
}

function closePublishProgress() {
  elements.publishProgressModal.hidden = true;
  syncBodyModalOverflow();
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
  const { signal, onProgress = () => {}, sectionIds = null, statuses = null } = options;
  const reuse = window.QaReportJiraReuse;
  const publication = { ...draft, sections: sectionsForPublication(sectionIds, draft, statuses) };
  const assets = reuse.collect(publication);
  const summary = document.getElementById("publishAttachmentSummary"); summary.hidden = true;
  if (!assets.length) return [];
  setPublishProgress({ step: "prepare", percent: 10, status: "Проверяем вложения в Jira…" });
  const manifest = await jiraRequest("/api/jira/attachment-manifest", { ...settings, ...issue }, { signal });
  if (!manifest.attachmentReuse) throw new Error("Обновите подключение Jira: проверка существующих вложений не поддерживается");
  if (reuse.issueIdentity(manifest.issueUrl) !== reuse.issueIdentity(issue.issueUrl)) throw new Error("Список вложений получен для другой задачи. Обновление отчёта остановлено.");
  const plan = await reuse.plan(assets, { issueUrl: manifest.issueUrl, attachments: manifest.attachments, signal,
    links: draft.jiraAttachmentLinks, stopOnUnlinked: Boolean(currentJiraPublication()),
    loadSource: async source => window.QaReportAttachments.dataUrl(await jiraRequest("/api/jira/import-attachment", {
      ...settings, commentUrl: source.issueUrl, attachmentId: source.id,
    }, { binary: true, signal })),
  });
  attachmentLimits = { ...window.QaReportAttachmentLimits.defaults, ...manifest.attachmentLimits };
  showAttachmentLimits(attachmentLimits);
  for (const file of plan.uploads) {
    const limitError = window.QaReportAttachmentLimits.fileError(file, attachmentLimits);
    if (limitError) throw new Error(limitError);
  }
  summary.textContent = `Используем повторно: ${plan.reused.length} · Загрузим: ${plan.uploads.length}`; summary.hidden = false;
  const persist = async entries => {
    const changes = reuse.bindings(entries);
    reuse.apply(draft, changes); reuse.applyRoot(elements.introEditor, changes); reuse.applyRoot(elements.sections, changes);
    // Confirmed uploads are external facts, not an undoable edit. Only patch
    // matching bytes/source keys in snapshots for this report and target task.
    const preserve = serialized => {
      const value = JSON.parse(serialized);
      if (value.reportId !== publication.reportId || reuse.issueIdentity(value.issueUrl) !== reuse.issueIdentity(publication.issueUrl)) return serialized;
      reuse.apply(value, changes);
      return JSON.stringify(value);
    };
    historyCurrent = preserve(historyCurrent);
    undoStack = undoStack.map(preserve); redoStack = redoStack.map(preserve);
    savedContentForHistory = null;
    updateHistoryButtons();
    if (await saveDraft() === false) throw new Error("Не удалось сохранить связь с вложениями. Проверьте текущую версию отчёта");
    await saveReportSnapshot("jira-attachment-links");
  };
  if (plan.reused.length) await persist(plan.reused);
  const uploaded = []; onProgress({done:0,total:plan.uploads.length});
  for (const [index, file] of plan.uploads.entries()) {
    signal?.throwIfAborted?.();
    // Uploads are not retried automatically: a lost response may hide a successful upload.
    const result = await jiraRequest("/api/jira/attachments", {
      ...settings, ...issue,
      files:[{attachmentId:file.attachmentId,name:file.name,type:file.type,dataBase64:file.dataBase64}],
    }, {signal});
    const attachment = result.attachments?.find(item=>item.attachmentId===file.attachmentId);
    if (!attachment?.id) throw new Error(`Jira не подтвердила загрузку «${file.name}»`);
    await persist([{...file,...attachment}]); uploaded.push(attachment);
    onProgress({done:index+1,total:plan.uploads.length,current:attachment.filename});
  }
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
  if (!result.verified || !result.commentId) {
    throw new Error(
      `Backend ${result.appVersion || "неизвестной версии"} не вернул подтверждение комментария`,
    );
  }
  return result;
}

async function publishCommentWithFallback(settings, issue, comment, signal, onPublished = async () => {}) {
  try {
    const result = await postJiraComment(settings, issue, comment, signal);
    await onPublished(result, 1);
    return [result];
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
      const result = await postJiraComment(settings, issue, parts[index], signal);
      results.push(result);
      await onPublished(result, parts.length);
    }
    return results;
  }
}

function updatePublishScopeState() {
  const checkboxes = [...elements.publishScopeList.querySelectorAll("input[type='checkbox']")];
  const selectedCount = checkboxes.filter((checkbox) => checkbox.checked).length;
  const allSelected = selectedCount === checkboxes.length;
  elements.publishScopeSelectAll.checked = allSelected;
  elements.publishScopeSelectAll.indeterminate = selectedCount > 0 && !allSelected;
  const statuses = [...document.querySelectorAll('#publishStatusList input')];
  const selectedStatuses = statuses.filter((input) => input.checked).map((input) => input.value);
  const allStatuses = document.getElementById("publishStatusSelectAll");
  allStatuses.checked = selectedStatuses.length === statuses.length;
  allStatuses.indeterminate = selectedStatuses.length > 0 && !allStatuses.checked;
  const sections = sectionsForPublication(checkboxes.filter((input) => input.checked).map((input) => input.value), draft, selectedStatuses);
  const rowCount = sections.reduce((sum, section) => sum + section.rows.length, 0);
  elements.publishScopeSummary.textContent = `К отправке: разделов — ${sections.length}, строк — ${rowCount}`;
  elements.acceptPublishScopeButton.disabled = rowCount === 0;
}

function askPublishScope(link = null) {
  if (publishScopeResolver) return Promise.resolve(null);
  elements.publishScopeList.replaceChildren();
  const statusList = document.getElementById("publishStatusList");
  statusList.replaceChildren();
  Object.keys(STATUS_META).forEach((status) => {
    const label = document.createElement("label");
    label.className = "publish-scope-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !link || link.statuses.includes(status);
    checkbox.value = status;
    checkbox.addEventListener("change", updatePublishScopeState);
    const text = document.createElement("span");
    text.textContent = status;
    label.append(checkbox, text);
    statusList.append(label);
  });
  draft.sections.forEach((section, index) => {
    const label = document.createElement("label");
    label.className = "publish-scope-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !link || link.sectionIds.includes(section.id);
    checkbox.value = section.id;
    checkbox.dataset.sectionId = section.id;
    checkbox.addEventListener("change", updatePublishScopeState);
    const title = document.createElement("span");
    title.textContent = section.title.trim() || `Раздел ${index + 1}`;
    label.append(checkbox, title);
    elements.publishScopeList.append(label);
  });
  elements.publishScopeSelectAll.checked = true;
  elements.publishScopeSelectAll.indeterminate = false;
  updatePublishScopeState();
  elements.publishScopeModal.hidden = false;
  syncBodyModalOverflow();
  elements.publishScopeSelectAll.focus();
  return new Promise((resolve) => {
    publishScopeResolver = resolve;
  });
}

function resolvePublishScope(accepted) {
  if (!publishScopeResolver) return;
  const resolve = publishScopeResolver;
  publishScopeResolver = null;
  const sectionIds = accepted
    ? new Set(
        [...elements.publishScopeList.querySelectorAll("input[type='checkbox']:checked")]
          .map((checkbox) => checkbox.dataset.sectionId),
      )
    : null;
  elements.publishScopeModal.hidden = true;
  syncBodyModalOverflow();
  resolve(accepted ? {
    sectionIds,
    statuses: new Set([...document.querySelectorAll('#publishStatusList input:checked')].map((input) => input.value)),
  } : null);
}

async function promptJiraSetup() {
  const accepted = await askConfirmation("Чтобы отправлять отчёты, настройте интеграцию с Jira в настройках.", {
    title: "Jira не подключена", confirmText: "Настроить Jira",
  });
  if (accepted) {
    openJiraSettings();
    setSettingsSection("jira");
  } else {
    elements.copyMenuButton.focus();
  }
  return false;
}

async function isJiraReadyToPublish() {
  try {
    const response = await fetch("/api/jira/connections", { cache: "no-store" });
    if (!response.ok) return true; // Let the existing publish flow explain server/auth errors.
    const payload = await response.json();
    const instances = payload.instances || [];
    const target = draft.issueUrl.trim();
    const matching = instances.filter(instance => target.startsWith(instance.baseUrl.replace(/\/$/, "") + "/"));
    if (!(matching.length ? matching : instances).some(instance => instance.connected)) return promptJiraSetup();
  } catch {
    // A failed status check must not block the existing error/retry flow.
  }
  return true;
}

function currentJiraPublication() {
  return window.QaReportJiraPublication.matching(draft.jiraPublication, draft.reportId, draft.issueUrl);
}

function publicationInfoMarkup(value, reportId, history = false) {
  const api = window.QaReportJiraPublication, link = api.normalize(value, reportId);
  if (!link) return "";
  const provider = "Jira";
  const links = link.parts.flatMap((part, index) => part ? [
    `<a${history ? ' class="history-publication-link"' : ""} href="${escapeHtml(api.commentUrl(link.issueUrl, part.commentId))}" target="_blank" rel="noopener noreferrer">${history ? '<svg class="ui-icon" aria-hidden="true"><use href="#icon-external"></use></svg>' : ""}<span>${link.parts.length > 1 ? `${provider}: часть ${index + 1}` : history ? `Комментарий в ${provider}` : `Открыть в ${provider}`}</span></a>`
  ] : []).join(history ? "" : " · ");
  const time = (value, label) => value ? `<span>${label} <time datetime="${escapeHtml(value)}">${escapeHtml(new Date(value).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }))}</time></span>` : "";
  const dates = time(link.firstPublishedAt, "Опубликован")
    + (link.lastPublishedAt !== link.firstPublishedAt ? time(link.lastPublishedAt, "Обновлён") : "")
    + (link.parts.some(part => !part) ? '<span class="publication-incomplete">Опубликован частично</span>' : link.updateIncomplete ? '<span class="publication-incomplete">Обновлён частично</span>' : "");
  return history ? `<div class="history-publication-links">${links}</div><div class="history-publication-dates">${dates}</div>` : links + dates;
}

function historyPublication(report) {
  const api = window.QaReportJiraPublication;
  // The open report already knows a confirmed publication or its removal,
  // even while the cloud's lightweight history response is catching up.
  const value = report.id === draft.reportId && Object.hasOwn(draft, "jiraPublication")
    ? draft.jiraPublication : Object.hasOwn(report, "jiraPublication")
      ? report.jiraPublication : report.document?.jiraPublication;
  return api.normalize(value, report.id);
}

function renderPublicationState() {
  const link = currentJiraPublication();
  const isEva = typeof window.QaReportTrackerLinks !== "undefined" && window.QaReportTrackerLinks.parse(draft.issueUrl, "eva");
  elements.publishButton.querySelector(".primary-action-label").textContent = publishInProgress ? "Отправляем…" : link ? "Обновить отчёт" : "Опубликовать отчёт";
  elements.publishButton.disabled = publishInProgress;
  const exportButton = document.getElementById("publishExportButton");
  if (exportButton) {
    exportButton.querySelector(".primary-action-label").textContent = elements.publishButton.querySelector(".primary-action-label").textContent;
    exportButton.disabled = publishInProgress;
  }
  document.getElementById("publicationMenuButton").disabled = publishInProgress;
  document.getElementById("publishAgainButton").disabled = !link || publishInProgress;
  const info = document.getElementById("publicationInfo");
  info.innerHTML = publicationInfoMarkup(draft.jiraPublication, draft.reportId);
  info.hidden = !info.innerHTML;
}

async function rememberJiraPublication(context, parts, split) {
  const api = window.QaReportJiraPublication;
  const now = context.lastPublishedAt || parts.filter(Boolean).at(-1)?.publishedAt || new Date().toISOString();
  context.firstPublishedAt ||= now;
  const link = api.normalize({ ...context, parts, split,
    firstPublishedAt: context.firstPublishedAt || now, lastPublishedAt: now }, context.reportId);
  if (!link) return;
  await writeJiraPublication(context, link);
}

async function writeJiraPublication(context, link, expected = null) {
  const api = window.QaReportJiraPublication;
  if (draft.reportId === context.reportId) {
    if (expected && !api.sameComments(draft.jiraPublication, expected)) return false;
    draft.jiraPublication = link;
    // Undo changes report content; it must not restore a deleted external comment.
    const preserve = text => { const value = JSON.parse(text); value.jiraPublication = api.normalize(link, value.reportId); return JSON.stringify(value); };
    historyCurrent = preserve(historyCurrent);
    undoStack = undoStack.map(preserve); redoStack = redoStack.map(preserve);
    hasUnsavedLocalChanges = true;
    clearTimeout(saveTimer);
    forceLocalDraftSave = true;
    renderPublicationState();
    if (!await saveDraft({ collect: false })) throw new Error(link ? "Отчёт отправлен в Jira, но связь не удалось сохранить. Ссылка доступна под кнопкой публикации — сохраните её перед закрытием страницы." : "Связь сброшена, но изменение не удалось сохранить. Сохраните отчёт перед закрытием страницы.");
    renderPublicationState();
  } else {
    // A response may arrive after switching reports. Patch only the original's metadata.
    const record = await getReportRecord(context.reportId);
    if (draft.reportId === context.reportId) return writeJiraPublication(context, link, expected);
    if (!record) throw new Error(link ? "Отчёт отправлен в Jira, но исходный отчёт уже недоступен в истории." : "Исходный отчёт уже недоступен в истории.");
    if (expected && !api.sameComments(record.document.jiraPublication, expected)) return false;
    record.document.jiraPublication = link;
    record.document.revision = (Number(record.document.revision) || 0) + 1;
    record.document.updatedAt = record.updatedAt = new Date().toISOString();
    record.document.lastSavedBy = tabId; record.document.lastSavedClientId = reportClientId;
    record.historyContentFingerprint = QaReportHistory.contentFingerprint(record.document);
    await dbTransaction("readwrite", store => store.put(record));
    queueServerReportSave(record);
  }
  return true;
}

async function updatePublishedComment(link, request) {
  try { return await request(); }
  catch (error) {
    if (window.QaReportJiraPublication.missingComment(error)
      && await writeJiraPublication(link, null, link)) {
      error.publicationLinkCleared = true;
      error.message = "Связанный комментарий не найден. Связь и даты публикации удалены. Нажмите «Опубликовать отчёт», чтобы создать новый комментарий.";
    }
    throw error;
  }
}

async function updateLinkedJiraComments(settings, issue, comment, link, signal, context) {
  if (link.format !== comment.format) throw new Error("Формат подключения Jira изменился. Опубликуйте отчёт заново.");
  const comments = link.split ? splitJiraComment(comment) : [comment];
  if (comments.length !== link.parts.length) throw new Error("Изменилось количество частей отчёта. Опубликуйте отчёт заново, чтобы сохранить прежние комментарии.");
  const parts = link.parts.map(part => part && { ...part }), results = [];
  // Check every existing part before changing any of them.
  for (let index = 0; index < comments.length; index++) {
    const part = parts[index];
    if (!part) continue;
    await updatePublishedComment(link, () => publishJiraRequest("/api/jira/update-comment", { ...settings, ...issue,
      token: typeof jiraSecret === "undefined" ? "" : jiraSecret, comment: comments[index],
      commentId: part.commentId, expectedBodyHash: part.bodyHash, checkOnly: true }, { signal }));
  }
  for (let index = 0; index < comments.length; index++) {
    const part = parts[index];
    const result = part ? await updatePublishedComment(link, () => publishJiraRequest("/api/jira/update-comment", { ...settings, ...issue,
      token: typeof jiraSecret === "undefined" ? "" : jiraSecret, comment: comments[index],
      commentId: part.commentId, expectedBodyHash: part.bodyHash }, { signal }))
      : await postJiraComment(settings, issue, comments[index], signal);
    if (!result.verified || !result.commentId) throw new Error("Jira не подтвердила обновление отчёта");
    results.push(result);
    context.lastPublishedAt = result.publishedAt || new Date().toISOString();
    context.updateIncomplete = index < comments.length - 1;
    parts[index] = { commentId: result.commentId, bodyHash: result.bodyHash || "", publishedAt: result.publishedAt || new Date().toISOString() };
    await rememberJiraPublication(context, parts, link.split);
  }
  return results;
}

async function publishToJira(mode = "auto") {
  if (publishInProgress) return;
  publishInProgress = true;
  try {
    closeHeaderDropdowns();
    collectDocumentFields();
    if (!await validateReportPublication()) return;
    const linked = mode === "new" ? null : currentJiraPublication();
    const actionLabel = linked ? "Обновить" : "Опубликовать";
    if (mode === "new" && currentJiraPublication() && !await askConfirmation("В Jira появится новый комментарий. Прежний останется в задаче, а этот отчёт будет связан с новым.", { title: "Опубликовать заново?", confirmText: "Опубликовать заново" })) return;
    if (!await isJiraReadyToPublish()) return;
    document.getElementById("publishScopeTitle").textContent = linked ? "Что обновить в Jira" : "Что опубликовать";
    elements.acceptPublishScopeButton.textContent = actionLabel;
    document.getElementById("publishProgressTitle").textContent = linked ? "Обновление отчёта в Jira" : "Публикация отчёта";
    const scope = await askPublishScope(linked);
    if (!scope) return;
    collectDocumentFields();
    if (!await validateReportPublication()) return;
    const { sectionIds, statuses } = scope;
    const issue = parseIssueUrl(draft.issueUrl);
    if (linked && !window.QaReportJiraPublication.matching(linked, draft.reportId, issue.issueUrl)) throw new Error("Задача изменилась. Повторите публикацию для выбранной задачи.");
    const publicationReportId = draft.reportId;
    const settings = {};
    await checkBackendCompatibility();
    publishAbortController = new AbortController();
    openPublishProgress();
    setPublishProgress({ step: "prepare", percent: 8, status: "Подготовка отчёта" });
    renderPublicationState();
    await uploadPendingImages(settings, issue, {
      signal: publishAbortController.signal,
      sectionIds,
      statuses,
      onProgress: ({ done, total }) => {
        const percent = total ? 15 + Math.round((done / total) * 45) : 55;
        setPublishProgress({
          step: "attachments",
          percent,
          status: total ? `Загрузка вложений: ${done} из ${total}` : "Используем существующие вложения",
        });
      },
    });
    if (draft.reportId !== publicationReportId) throw new Error("Открыт другой отчёт. Повторите публикацию из нужного отчёта.");
    const comment = { format: "wiki", body: generateMarkup({ sectionIds, statuses, forPublication: true }) };
    setPublishProgress({ step: "comment", percent: 68, status: "Публикация комментария" });
    const context = { reportId: publicationReportId, issueUrl: issue.issueUrl, format: comment.format,
      sectionIds: [...(sectionIds || draft.sections.map(section => section.id))],
      statuses: [...(statuses || Object.keys(STATUS_META))], firstPublishedAt: linked?.firstPublishedAt || "" };
    const successfulParts = [];
    const results = linked ? await updateLinkedJiraComments(settings, issue, comment, linked, publishAbortController.signal, context)
      : await publishCommentWithFallback(settings, issue, comment, publishAbortController.signal, async (result, count) => {
        context.lastPublishedAt = result.publishedAt || new Date().toISOString();
        successfulParts.push({ commentId: result.commentId, bodyHash: result.bodyHash || "", publishedAt: result.publishedAt || new Date().toISOString() });
        const parts = [...successfulParts, ...Array.from({ length: count - successfulParts.length }, () => null)];
        await rememberJiraPublication(context, parts, count > 1);
      });
    if (!linked && !successfulParts.length) await rememberJiraPublication(context, results.map(result => ({ commentId: result.commentId, bodyHash: result.bodyHash || "", publishedAt: result.publishedAt || new Date().toISOString() })), results.length > 1);
    setPublishProgress({ step: "verify", percent: 96, status: "Проверка созданного комментария" });
    const result = results.at(-1);
    finishPublishProgress(
      results.length > 1
        ? `Опубликовано комментариев: ${results.length}`
        : linked ? "Отчёт обновлён в Jira" : "Отчёт опубликован",
    );
    showToast(`${linked ? "Обновлено" : "Опубликовано"} в ${issue.issueKey}`);
    if (result?.commentUrl) window.open(result.commentUrl, "_blank", "noopener");
  } catch (error) {
    console.error("Ошибка публикации Jira:", error);
    const message = error.status === 413 && mode !== "new" && currentJiraPublication() ? "Обновлённый отчёт слишком большой для связанного комментария. Выберите «Опубликовать заново»." : friendlyJiraError(error);
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
    if (shouldOpenJiraSettings(error)) { openJiraSettings(); setSettingsSection("jira"); }
  } finally {
    publishInProgress = false;
    publishAbortController = null;
    renderPublicationState();
  }
}

function openPreview() {
  elements.markupPreview.value = generateMarkup();
  elements.visualPreview.innerHTML = generateVisualPreview();
  elements.previewModal.hidden = false;
  syncBodyModalOverflow();
}

function closePreview() {
  elements.previewModal.hidden = true;
  syncBodyModalOverflow();
}

function selectImportSource(source) {
  importSource = source;
  document.querySelectorAll(".import-source-tab").forEach(tab => {
    const active = tab.dataset.importSource === source;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  elements.markupImportPane.hidden = source !== "markup";
  elements.commentImportPane.hidden = source !== "comment";
  document.getElementById("reportImportPane").hidden = source !== "report";
  resetImportPreview();
  reportDragDepth = 0;
  document.getElementById("reportDropZone").classList.remove("is-dragover");
  elements.importModal.querySelector(".import-body").scrollTop = 0;
}

function setSelectedReportFile(file, errorMessage = "") {
  selectedReportFile = file;
  document.getElementById("reportFileInput").value = "";
  document.getElementById("selectedReportFile").hidden = !file;
  document.getElementById("reportFileEmpty").hidden = Boolean(file);
  document.getElementById("reportDropZone").classList.toggle("has-file", Boolean(file));
  document.getElementById("selectedReportFileSize").textContent = file ? formatFileSize(file.size) : "";
  document.getElementById("chooseReportFileButton").textContent = file ? "Выбрать другой файл" : "Выбрать файл";
  const name = document.getElementById("selectedReportFileName");
  name.textContent = file?.name || ""; name.title = file?.name || "";
  document.getElementById("chooseReportFileButton").setAttribute("aria-label", file ? "Выбрать другой файл .report" : "Выбрать файл .report");
  const error = document.getElementById("reportImportError");
  error.textContent = errorMessage; error.hidden = !errorMessage;
  setImportBusy(importBusy);
}

function selectReportFiles(files) {
  if (importBusy || !files.length) return;
  if (files.length !== 1) return setSelectedReportFile(null, "Выберите один файл формата .report");
  const file = files[0];
  if (!/\.report$/i.test(file.name)) return setSelectedReportFile(null, "Выберите файл формата .report");
  setSelectedReportFile(file);
}

async function openSelectedReportFile() {
  if (!selectedReportFile || importBusy) return;
  const error = document.getElementById("reportImportError");
  if (reportFileBusy || pwaPendingOperations || publishInProgress) {
    error.textContent = "Дождитесь завершения текущей операции с отчётом."; error.hidden = false; return;
  }
  setImportBusy(true); reportFileBusy = true; pwaPendingOperations++;
  error.hidden = true;
  setImportProgress("Открываем отчёт…");
  let message;
  try {
    message = await openReportFile(selectedReportFile, ({ completed, total }) => {
      setImportProgress(total ? "Восстанавливаем вложения…" : "Восстанавливаем отчёт…", completed, total);
    });
  } catch (cause) {
    error.textContent = cause.message || "Не удалось прочитать файл .report."; error.hidden = false;
  } finally {
    reportFileBusy = false; pwaPendingOperations--; setImportBusy(false);
  }
  if (message) {
    closeImport(); showToast(message); elements.importButton.focus();
  } else {
    error.scrollIntoView({ block: "nearest" });
    elements.applyImportButton.focus();
  }
}

function openImport(source = "markup") {
  if (importBusy) return;
  setSelectedReportFile(null);
  selectImportSource(source);
  elements.importMarkup.value = "";
  elements.commentImportUrl.value = "";
  elements.importModal.hidden = false;
  syncBodyModalOverflow();
  (source === "report" ? document.getElementById("chooseReportFileButton") : source === "markup" ? elements.importMarkup : elements.commentImportUrl).focus();
}

function closeImport() {
  if (importBusy) return;
  elements.importModal.hidden = true;
  setSelectedReportFile(null);
  syncBodyModalOverflow();
}

function setFocusMode(enabled) {
  document.querySelector(".app-shell").classList.toggle("focus-mode", enabled);
  document.body.classList.toggle("focus-mode-active", enabled);
  elements.focusExitButton.hidden = !enabled;
  elements.focusModeButton.querySelector("span:last-child").textContent = enabled ? "Выйти" : "Фокус";
  requestAnimationFrame(scheduleStickySectionUpdate);
}

function updateHistorySelectionUi() {
  const busy = historyLoading || historyDeleting;
  elements.historySelectionToggle.setAttribute("aria-pressed", String(historySelectionMode));
  elements.historySelectionToggle.disabled = busy;
  elements.historySelectionToolbar.hidden = !historySelectionMode;
  elements.deleteSelectedHistoryButton.hidden = !historySelectionMode;
  elements.deleteSelectedHistoryButton.disabled = busy || !selectedHistoryReportIds.size;
  elements.deleteSelectedHistoryButton.textContent = historyDeleting ? "Удаляем…" : "Удалить выбранные";
  const visibleSelected = historyFilteredReports.filter(report => selectedHistoryReportIds.has(report.id)).length;
  const hiddenSelected = selectedHistoryReportIds.size - visibleSelected;
  elements.historySelectionCount.textContent = `Выбрано: ${selectedHistoryReportIds.size}${hiddenSelected > 0 ? ` · Скрыто фильтром: ${hiddenSelected}` : ""}`;
  elements.historySelectAll.checked = historyFilteredReports.length > 0 && visibleSelected === historyFilteredReports.length;
  elements.historySelectAll.indeterminate = visibleSelected > 0 && visibleSelected < historyFilteredReports.length;
  elements.historySelectAll.disabled = busy || !historyFilteredReports.length;
  elements.historySelectionExit.disabled = historyDeleting;
  elements.historySearch.disabled = historyDeleting;
  elements.historyProjectFilter.disabled = historyDeleting;
  elements.historySort.disabled = historyDeleting;
  elements.closeHistoryButton.disabled = historyDeleting;
  elements.historyList.querySelectorAll("[data-history-select]").forEach(checkbox => {
    checkbox.checked = selectedHistoryReportIds.has(checkbox.dataset.historySelect);
    checkbox.disabled = busy;
    checkbox.closest(".history-item").classList.toggle("selected", checkbox.checked);
  });
  elements.historyList.querySelectorAll(".history-item-actions button, .history-comment-field").forEach(control => {
    control.disabled = historyDeleting;
  });
}

async function setHistorySelectionMode(enabled) {
  if (historyDeleting || historyLoading) return;
  historySelectionMode = enabled;
  if (!enabled) selectedHistoryReportIds.clear();
  updateHistorySelectionUi();
  await flushVisibleHistoryComments();
  await renderHistoryList();
}

async function deleteHistoryReport(report) {
  if (report.id === draft.reportId) clearTimeout(saveTimer);
  await draftWriteQueue.catch(() => {});
  await Promise.allSettled([...(pendingHistoryServerSaves.get(report.id) || [])]);
  if (report.source === "server") await deleteServerReport(report.id);
  // A cloud entry can also have a local copy; remove both so it cannot reappear.
  await deleteReportRecord(report.id);
  selectedHistoryReportIds.delete(report.id);
  if (report.id !== draft.reportId) return;
  clearTimeout(saveTimer);
  clearTimeout(historyTimer);
  draft = normalizeDraft({ ...clone(DEFAULT_DRAFT), draftId: crypto.randomUUID(), reportId: crypto.randomUUID(), publicId: createPublicId() });
  historyCurrent = serializeDraft();
  undoStack = [];
  redoStack = [];
  hasUnsavedLocalChanges = false;
  render();
  updateChecklistUrl(draft.publicId);
  updateHistoryButtons();
  try {
    localStorage.removeItem(DRAFT_LOCATION_KEY);
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
  writeLocalDraftCopy(draft);
}

async function deleteSelectedHistoryReports() {
  if (historyDeleting || historyLoading || !selectedHistoryReportIds.size) return;
  historyDeleting = true;
  updateHistorySelectionUi();
  try {
    await flushVisibleHistoryComments();
    const reports = (await getAllHistoryReports()).filter(report => selectedHistoryReportIds.has(report.id));
    if (!reports.length) {
      selectedHistoryReportIds.clear();
      await renderHistoryList();
      return;
    }
    const visibleIds = new Set(historyFilteredReports.map(report => report.id));
    const hiddenCount = reports.filter(report => !visibleIds.has(report.id)).length;
    const confirmed = await askConfirmation(`Удалить выбранные чек-листы (${reports.length})?${hiddenCount ? ` В том числе скрытых текущим фильтром: ${hiddenCount}.` : ""}`, {
      title: "Удаление чек-листов", confirmText: "Удалить выбранные", danger: true,
    });
    if (!confirmed) return;
    let deleted = 0;
    for (const report of reports) {
      try {
        await deleteHistoryReport(report);
        deleted++;
      } catch {
        // Keep failed entries selected so the user can retry them.
      }
    }
    await renderHistoryList();
    const failed = reports.length - deleted;
    showToast(failed ? `Удалено: ${deleted}. Не удалось удалить: ${failed}. Повторите удаление выбранных.` : `Удалено чек-листов: ${deleted}`, failed ? 9000 : 3500);
  } catch (error) {
    showToast(`Не удалось удалить выбранные чек-листы: ${error.message}`, 9000);
  } finally {
    historyDeleting = false;
    updateHistorySelectionUi();
  }
}

async function openHistory() {
  elements.historyModal.hidden = false;
  syncBodyModalOverflow();
  await renderHistoryList({ showLoading: true, saveSnapshot: true });
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
  const saved = await action;
  if (report.source === "server") {
    await updateLocalReportComment(report.id, value).catch(() => {});
  }
  report.historyComment = value;
  if (saved?.updatedAt) report.updatedAt = saved.updatedAt;
  const dates = commentField.closest(".history-item")?.querySelector(".history-dates");
  if (dates) dates.innerHTML = historyDatesMarkup(report);
  if (report.id === draft.reportId) setSaveStatus("Комментарий сохранён");
}

async function flushVisibleHistoryComments() {
  const fields = [...elements.historyList.querySelectorAll(".history-comment-field")];
  await Promise.allSettled(fields.map((field) => field.__saveHistoryComment?.()));
}

function closeHistory() {
  closeHistoryActionMenus();
  if (historyDeleting) return;
  historySelectionMode = false;
  selectedHistoryReportIds.clear();
  historyFilteredReports = [];
  flushVisibleHistoryComments().catch(() => setSaveStatus("Ошибка комментария"));
  historyRenderRequestId++;
  setHistoryLoading(false);
  elements.historyModal.hidden = true;
  syncBodyModalOverflow();
}

function setHistoryLoading(loading) {
  historyLoading = loading;
  elements.historyList.setAttribute("aria-busy", String(loading));
  if (loading) historyFilteredReports = [];
  updateHistorySelectionUi();
  if (!loading) return;
  elements.historyUsage.textContent = "";
  elements.historyList.scrollTop = 0;
  const card = `<div class="history-item history-skeleton" aria-hidden="true">
    <div class="history-item-info">
      <div class="history-skeleton-bar history-skeleton-title"></div>
      <div class="history-skeleton-bar history-skeleton-meta"></div>
    </div>
    <div class="history-skeleton-bar history-skeleton-comment"></div>
    <div class="history-item-actions">
      <div class="history-skeleton-bar history-skeleton-action"></div>
      <div class="history-skeleton-bar history-skeleton-action history-skeleton-action-wide"></div>
      <div class="history-skeleton-bar history-skeleton-action"></div>
      <div class="history-skeleton-bar history-skeleton-action"></div>
    </div>
  </div>`;
  elements.historyList.innerHTML = `<div class="history-loading-status" role="status">Загружаем историю…</div>${card.repeat(3)}`;
}

async function renderHistoryList({ showLoading = false, saveSnapshot = false } = {}) {
  closeHistoryActionMenus();
  const requestId = ++historyRenderRequestId;
  if (showLoading) setHistoryLoading(true);
  let reports;
  try {
    if (saveSnapshot) {
      // Let the loading cards paint before collecting a potentially large report.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (requestId !== historyRenderRequestId) return;
      await saveReportSnapshot("open-history").catch(() => {});
    }
    if (requestId !== historyRenderRequestId) return;
    reports = await getAllHistoryReports();
  } catch {
    if (requestId !== historyRenderRequestId) return;
    setHistoryLoading(false);
    elements.historyUsage.textContent = "";
    elements.historyList.innerHTML = `<div class="history-empty" role="status"><p>Не удалось загрузить историю</p><button class="button button-secondary" type="button" data-retry-history>Повторить</button></div>`;
    elements.historyList.querySelector("[data-retry-history]")?.addEventListener("click", () => renderHistoryList({ showLoading: true }));
    return;
  }
  if (requestId !== historyRenderRequestId) return;
  setHistoryLoading(false);
  const names = loadProjectNames();
  const colors = loadProjectColors();
  renderHistoryProjectFilter(reports, names);
  const selectedProject = elements.historyProjectFilter.value;
  const query = elements.historySearch.value.trim().toLowerCase();
  const filtered = sortHistoryReports(reports.filter((report) => {
    const projectKey = reportProjectKey(report);
    const matchesProject = !selectedProject || (selectedProject === "none" ? !projectKey : projectKey === selectedProject);
    return matchesProject && `${reportIssueLabel(report)} ${report.title} ${report.issueKey} ${report.document?.issueUrl ?? report.issueUrl} ${report.historyComment || ""} ${names[projectKey] || projectKey}`.toLowerCase().includes(query);
  }), elements.historySort.value);
  const availableIds = new Set(reports.map(report => report.id));
  for (const id of selectedHistoryReportIds) if (!availableIds.has(id)) selectedHistoryReportIds.delete(id);
  historyFilteredReports = filtered;
  const serverCount = reports.filter((report) => report.source === "server").length;
  const localCount = reports.length - serverCount;
  elements.historyUsage.textContent = `${selectedProject || query ? `Показано: ${filtered.length} из ${reports.length}` : `Всего: ${reports.length}`} · Облако: ${serverCount} · Локально: ${localCount}`;
  elements.historyList.innerHTML = "";
  updateHistorySelectionUi();
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
    const issueLabel = reportIssueLabel(report);
    const projectKey = reportProjectKey(report);
    const projectName = names[projectKey] || projectKey || "Без проекта";
    const projectStyle = colors[projectKey] ? ` style="--project-color:${colors[projectKey]}"` : "";
    info.innerHTML = `<div class="history-item-heading"><h3>${escapeHtml(issueLabel)}</h3><span class="history-project-label"${projectStyle} title="${escapeHtml(projectKey || "Без проекта")}">${escapeHtml(projectName)}</span></div><p class="history-item-meta"><code>${escapeHtml(publicId)}</code><span class="history-dates">${historyDatesMarkup(report)}</span></p>`;
    if (historySelectionMode) {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "history-select-checkbox";
      checkbox.dataset.historySelect = report.id;
      checkbox.checked = selectedHistoryReportIds.has(report.id);
      checkbox.setAttribute("aria-label", `Выбрать чек-лист ${issueLabel}, ${publicId}`);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectedHistoryReportIds.add(report.id);
        else selectedHistoryReportIds.delete(report.id);
        updateHistorySelectionUi();
      });
      info.querySelector(".history-item-heading").prepend(checkbox);
      item.classList.toggle("selected", checkbox.checked);
    }
    const publication = publicationInfoMarkup(historyPublication(report), report.id, true);
    let publicationInfo;
    if (publication) {
      item.classList.toggle("published", true);
      publicationInfo = document.createElement("div");
      publicationInfo.className = "publication-info history-publication-info";
      publicationInfo.innerHTML = publication;
    }
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
      await flushVisibleHistoryComments();
      await saveReportSnapshot("before-open-history");
      const fullReport = report.source === "server" ? await getServerReport(report.id) : report;
      if (report.source === "server") await cacheOpenedServerReport(fullReport).catch(() => {});
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
    }, false, "eye");
    const copyButton = createSmallButton("Копия", async () => {
      await flushVisibleHistoryComments();
      await saveReportSnapshot("before-copy-history");
      const fullReport = report.source === "server" ? await getServerReport(report.id) : report;
      draft = normalizeDraft(clone(fullReport.document));
      draft.draftId = crypto.randomUUID();
      draft.reportId = crypto.randomUUID();
      draft.jiraPublication = null;
      draft.publicId = createPublicId();
      historyCurrent = serializeDraft();
      undoStack = [];
      redoStack = [];
      render();
      updateChecklistUrl(draft.publicId);
      saveDraft();
      closeHistory();
      showToast("Создана копия отчёта");
    }, false, "copy");
    const deleteButton = createSmallButton("Удалить", async () => {
      const confirmed = await askConfirmation(`Удалить отчёт «${report.title}»?`, {
        title: "Удаление отчёта",
        confirmText: "Удалить",
        danger: true,
      });
      if (!confirmed) return;
      try {
        await flushVisibleHistoryComments();
        await deleteHistoryReport(report);
      } catch (error) {
        showToast(`Не удалось удалить чек-лист: ${error.message}`, 9000);
      }
      await renderHistoryList();
    }, true, "trash");
    const linkButton = createSmallButton("Копировать ссылку", async () => {
      const id = normalizePublicId(report.publicId || report.document?.publicId);
      if (!id) { showToast("У отчёта пока нет ссылки"); return; }
      await writeClipboardText(new URL(`/report/${id}`, window.location.origin).href,
        report.source === "local" ? "Ссылка скопирована — локальный отчёт доступен в этом браузере" : "Ссылка на отчёт скопирована");
    }, false, "link");
    linkButton.title = report.source === "local" ? "Локальный отчёт: ссылка работает в этом браузере" : "Скопировать ссылку на этот отчёт";
    actions.append(openButton, linkButton, copyButton, createHistoryMoreMenu(report, deleteButton));
    item.append(info, commentField, actions);
    if (publicationInfo) item.append(publicationInfo);
    elements.historyList.append(item);
  });
  updateHistorySelectionUi();
}

function createSmallButton(label, action, danger = false, icon = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `button button-ghost history-action${danger ? " danger-text" : ""}`;
  button.innerHTML = `${icon ? `<svg class="ui-icon" aria-hidden="true"><use href="#icon-${icon}"></use></svg>` : ""}<span>${escapeHtml(label)}</span>`;
  button.addEventListener("click", action);
  return button;
}

function closeHistoryActionMenus({ restoreFocus = false } = {}) {
  const menus = [...document.querySelectorAll(".history-action-menu:popover-open")];
  for (const menu of menus) {
    menu.hidePopover();
    menu.__trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) menu.__trigger.focus();
  }
  return menus.length > 0;
}

function createHistoryMoreMenu(report, deleteButton) {
  const group = document.createElement("div"); group.className = "history-more";
  const trigger = document.createElement("button");
  trigger.type = "button"; trigger.className = "history-more-button";
  trigger.title = "Другие действия";
  trigger.setAttribute("aria-label", `Другие действия с отчётом ${reportIssueLabel(report)}`);
  trigger.setAttribute("aria-haspopup", "menu"); trigger.setAttribute("aria-expanded", "false");
  trigger.innerHTML = '<svg class="ui-icon" aria-hidden="true"><use href="#icon-more"></use></svg>';
  const menu = document.createElement("div");
  menu.className = "history-action-menu"; menu.id = `history-actions-${report.id}`;
  menu.setAttribute("popover", "auto"); menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Действия с отчётом"); menu.__trigger = trigger;
  trigger.setAttribute("aria-controls", menu.id);
  deleteButton.className = "history-menu-item danger-text";
  deleteButton.setAttribute("role", "menuitem");
  deleteButton.addEventListener("click", () => closeHistoryActionMenus(), { capture: true });
  menu.append(deleteButton); group.append(trigger, menu);
  trigger.addEventListener("click", () => {
    if (menu.matches(":popover-open")) { closeHistoryActionMenus(); return; }
    closeHistoryActionMenus(); menu.showPopover();
    const anchor = trigger.getBoundingClientRect(), bounds = menu.getBoundingClientRect();
    menu.__anchorTop = anchor.top;
    menu.style.left = `${Math.max(8, Math.min(innerWidth - bounds.width - 8, anchor.right - bounds.width))}px`;
    menu.style.top = `${anchor.bottom + bounds.height + 6 <= innerHeight - 8 ? anchor.bottom + 6 : Math.max(8, anchor.top - bounds.height - 6)}px`;
    trigger.setAttribute("aria-expanded", "true"); deleteButton.focus();
  });
  trigger.addEventListener("keydown", event => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); trigger.click(); }
  });
  menu.addEventListener("toggle", event => {
    trigger.setAttribute("aria-expanded", String(event.newState === "open"));
  });
  return group;
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
  ensureMediaBoundaries(block);
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
    getSectionTableWidth(context.section),
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
  const html = `${codeSnippetHtml(language, code, snippet.width)}<p><br></p>`;
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
  syncBodyModalOverflow();
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
  syncBodyModalOverflow();
  editingCodeBlock = null;
  codeEditorInitialValue = "";
  return true;
}

function openMediaViewer(image) {
  elements.mediaViewerImage.src = image.src;
  elements.mediaViewerImage.alt = image.dataset.fileName || "Вложение";
  elements.mediaViewerModal.hidden = false;
  syncBodyModalOverflow();
}

function closeMediaViewer() {
  elements.mediaViewerModal.hidden = true;
  elements.mediaViewerImage.removeAttribute("src");
  syncBodyModalOverflow();
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
  const html = `<pre class="cell-code-block" data-new-code="${marker}" data-language="${language}"><code>${escapeHtml(code)}</code></pre><p><br></p>`;
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
  syncBodyModalOverflow();
  requestAnimationFrame(() => elements.cancelFeedbackButton.focus());
}

function closeFeedback() {
  elements.feedbackModal.hidden = true;
  syncBodyModalOverflow();
}

let attachmentLimits = { ...window.QaReportAttachmentLimits.defaults };

function showAttachmentLimits(limits) {
  const hint = document.getElementById("attachmentLimitsHint");
  hint.textContent = window.QaReportAttachmentLimits.describe(limits);
  hint.hidden = false;
  elements.imageButton.title = `Добавить вложение. ${hint.textContent}`;
}

// Local insertion uses an advisory cache; publication still fetches fresh limits.
let localAttachmentLimitCache = null;
let localAppAttachmentLimits = { ...window.QaReportAttachmentLimits.defaults };

function attachmentLimitContext() {
  const issueUrl = elements.issueUrl.value.trim();
  let request = null;
  try {
    const issue = parseIssueUrl(issueUrl);
    const settings = {};
    request = { ...settings, ...issue, limitsOnly: true };
  } catch { /* A local report does not need a Jira connection. */ }
  return {
    key: JSON.stringify([draft.reportId, issueUrl, request?.baseUrl, request?.transport]),
    request,
  };
}

function getLocalAttachmentLimits() {
  const context = attachmentLimitContext();
  if (localAttachmentLimitCache?.key !== context.key) {
    localAttachmentLimitCache = {
      key: context.key, limits: { ...localAppAttachmentLimits }, checkedAt: 0, pending: null,
    };
    showAttachmentLimits(localAttachmentLimitCache.limits);
  }
  const entry = localAttachmentLimitCache;
  if (!entry.pending && (!entry.checkedAt || Date.now() - entry.checkedAt >= 60000)) {
    entry.pending = refreshAttachmentLimits(context, entry)
      .catch(() => {})
      .finally(() => { entry.pending = null; });
  }
  return { ...entry.limits };
}

async function refreshAttachmentLimits(context, entry) {
  const isCurrent = () => localAttachmentLimitCache === entry && attachmentLimitContext().key === context.key;
  await Promise.all([
    (async () => {
      try {
        const response = await fetch("/api/health", { cache: "no-store", signal: AbortSignal.timeout(8000) });
        if (!response.ok) return;
        const limits = (await response.json()).attachmentLimits || {};
        // Only app-wide limits can carry over to a different report or Jira.
        for (const key of ["appMaxFileBytes", "requestMaxBytes"]) {
          if (Number.isSafeInteger(limits[key]) && limits[key] >= 0) {
            localAppAttachmentLimits[key] = limits[key];
            entry.limits[key] = limits[key];
          }
        }
      } catch { /* Offline editing retains the last known local limits. */ }
    })(),
    (async () => {
      if (!context.request) return;
      try {
        const result = await jiraRequest("/api/jira/attachment-manifest", context.request,
          { signal: AbortSignal.timeout(10000) });
        entry.limits = { ...entry.limits, ...result.attachmentLimits };
      } catch { /* Unknown Jira limits are checked again before publication. */ }
    })(),
  ]);
  entry.checkedAt = Date.now();
  if (isCurrent()) showAttachmentLimits(entry.limits);
  return entry.limits;
}

async function insertImages(files) {
  pwaPendingOperations++;
  try { return await insertImagesForPwa(files); }
  finally { pwaPendingOperations--; }
}

async function insertImagesForPwa(files) {
  if (!activeEditor?.matches(".cell-editor, .intro-editor")) return;
  const targetEditor = activeEditor;
  const limits = getLocalAttachmentLimits();
  if (activeEditor !== targetEditor || !targetEditor.isConnected) {
    showToast("Выбранная ячейка изменилась. Выберите файлы ещё раз.");
    return;
  }
  for (const file of [...files]) {
    if (!isImageLikeFile(file)) continue;
    const limitError = window.QaReportAttachmentLimits.fileError(file, limits);
    if (limitError) {
      showToast(limitError, 9000);
      continue;
    }
    const dataUrl = await readFileAsDataUrl(file);
    if (activeEditor !== targetEditor || !targetEditor.isConnected) {
      showToast("Выбранная ячейка изменилась. Выберите файлы ещё раз.");
      return;
    }
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
  pwaPendingOperations++;
  try { return await insertFilesForPwa(files); }
  finally { pwaPendingOperations--; }
}

async function insertFilesForPwa(files) {
  if (!activeEditor?.matches(".cell-editor, .intro-editor")) return;
  const targetEditor = activeEditor;
  const limits = getLocalAttachmentLimits();
  if (activeEditor !== targetEditor || !targetEditor.isConnected) {
    showToast("Выбранная ячейка изменилась. Выберите файлы ещё раз.");
    return;
  }
  for (const file of [...files]) {
    if (isImageLikeFile(file)) continue;
    const limitError = window.QaReportAttachmentLimits.fileError(file, limits);
    if (limitError) {
      showToast(limitError, 9000);
      continue;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      if (activeEditor !== targetEditor || !targetEditor.isConnected) {
        showToast("Выбранная ячейка изменилась. Выберите файлы ещё раз.");
        return;
      }
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
  const targetEditor = activeEditor;
  const list = [...files];
  const images = list.filter(isImageLikeFile);
  const ordinaryFiles = list.filter((file) => !isImageLikeFile(file));
  if (images.length) await insertImages(images);
  if (activeEditor !== targetEditor || !targetEditor?.isConnected) return;
  if (ordinaryFiles.length) await insertFiles(ordinaryFiles);
}

function fileCardToWiki(card) {
  const name = card.dataset.jiraName || card.dataset.fileName || "file";
  const storageUrl = isStoredObjectUrl(card.dataset.dataUrl) ? card.dataset.dataUrl : "";
  const url = card.dataset.jiraUrl || storageUrl;
  if (card.dataset.jiraKind === "image") return `!${card.dataset.jiraExactUrl === "true" && url ? url : name}|thumbnail!`;
  if (card.dataset.jiraExactUrl === "true" && url) return `[${name}|${url}]`;
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

async function loadJiraReference(card) {
  if (card.classList.contains("is-loading")) return;
  const reportId = draft.reportId;
  const source = { issueUrl: card.dataset.jiraSourceIssue, id: card.dataset.jiraId,
    name: card.dataset.jiraName || card.dataset.fileName, url: card.dataset.jiraUrl, kind: card.dataset.jiraKind };
  const meta = card.querySelector(".file-card-meta");
  card.classList.add("is-loading"); if (meta) meta.textContent = "Скачиваем из Jira…"; pwaPendingOperations++;
  try {
    const blob = await jiraRequest("/api/jira/import-attachment", {
      commentUrl: source.issueUrl, attachmentId: source.id,
    }, {binary:true});
    if (blob.size > 50 * 1048576) throw new Error("Вложение больше 50 МБ");
    const file = {id:card.dataset.attachmentId,name:source.name,type:blob.type || "application/octet-stream",size:blob.size,
      dataUrl:await window.QaReportAttachments.dataUrl(blob),source:{...source,hash:await window.QaReportAttachments.hashBlob(blob)}};
    if (draft.reportId !== reportId || !card.isConnected) throw new Error("Открыт другой отчёт. Повторите загрузку");
    const template = document.createElement("template"); template.innerHTML = window.QaReportAttachments.render(file);
    card.replaceWith(template.content);
    if (await saveDraft() === false) throw new Error("Не удалось сохранить файл в текущем отчёте");
    await saveReportSnapshot("jira-reference-download"); render(); showToast("Файл сохранён в браузере");
  } catch(error) {showToast(`Не удалось скачать вложение: ${error.message}`,9000);}
  finally {pwaPendingOperations--;card.classList.remove("is-loading");if(meta)meta.textContent="В Jira · не скачан в браузер";}
}

async function downloadFileCard(card) {
  if (card.classList.contains("jira-attachment-reference")) return loadJiraReference(card);
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
  pwaPendingOperations++;
  try { return await uploadEditorObjectToStorageForPwa(object, kind); }
  finally { pwaPendingOperations--; }
}

async function uploadEditorObjectToStorageForPwa(object, kind) {
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

let viewingFileCard = null;
let fileViewerTextContent = "";
const fileViewer = Object.fromEntries([
  "Dialog", "Title", "Meta", "Encoding", "Wrap", "Readable", "ReadableHint", "Message", "Text", "State",
].map(name => [name, document.getElementById(`fileViewer${name}`)]));
const copyFileViewerButton = document.getElementById("copyFileViewerButton");

function updateFileViewer() {
  fileViewer.Text.value = "";
  fileViewerTextContent = "";
  fileViewer.Message.hidden = true;
  fileViewer.ReadableHint.hidden = true;
  fileViewer.Readable.disabled = true;
  fileViewer.Text.hidden = true;
  copyFileViewerButton.disabled = true;
  copyFileViewerButton.textContent = "Копировать текст";
  fileViewer.State.textContent = "Только просмотр";
  const name = viewingFileCard.dataset.fileName || viewingFileCard.dataset.jiraName || "Файл";
  fileViewer.Meta.textContent = `${getFileExtension(name, viewingFileCard.dataset.mimeType)} · ${formatFileSize(viewingFileCard.dataset.fileSize)}`;
  try {
    const preview = window.QaReportFilePreview.decode({
      name, type: viewingFileCard.dataset.mimeType || "",
      dataUrl: viewingFileCard.dataset.dataUrl || "",
    }, fileViewer.Encoding.value);
    const readable = window.QaReportFilePreview.formatJson(window.QaReportFilePreview.readableText(preview.text));
    const hasReadableText = readable !== preview.text;
    fileViewer.Readable.disabled = !hasReadableText;
    fileViewer.ReadableHint.hidden = !hasReadableText;
    fileViewerTextContent = fileViewer.Readable.checked ? readable : preview.text;
    fileViewer.Text.value = fileViewerTextContent;
    fileViewer.Text.hidden = false;
    fileViewer.Text.scrollTop = 0; fileViewer.Text.scrollLeft = 0;
    copyFileViewerButton.disabled = !preview.text;
    fileViewer.Meta.textContent = `${getFileExtension(name, viewingFileCard.dataset.mimeType)} · ${formatFileSize(preview.size)} · ${preview.encoding.toUpperCase()}`;
    const lineCount = fileViewerTextContent.split(/\r\n|\r|\n/).length;
    const viewMode = hasReadableText ? (fileViewer.Readable.checked ? " · Читаемый текст" : " · Исходный текст") : "";
    fileViewer.State.textContent = fileViewerTextContent ? `${lineCount} ${pluralizeLines(lineCount)} · Только просмотр${viewMode}` : "Пустой файл";
  } catch (error) {
    fileViewer.Message.textContent = error.message;
    fileViewer.Message.hidden = false;
  }
}

function openFileViewer(card) {
  if (card.classList.contains("jira-attachment-reference")) {
    showToast("Сначала сохраните файл в браузере через меню «Ещё действия».");
    return;
  }
  closeFloatingMenu();
  viewingFileCard = card;
  fileViewer.Title.textContent = card.dataset.fileName || card.dataset.jiraName || "Файл";
  fileViewer.Title.title = fileViewer.Title.textContent;
  fileViewer.Meta.textContent = `${getFileExtension(fileViewer.Title.textContent, card.dataset.mimeType)} · ${formatFileSize(card.dataset.fileSize)}`;
  fileViewer.Encoding.value = "auto";
  fileViewer.Wrap.checked = true;
  fileViewer.Readable.checked = true;
  fileViewer.Text.setAttribute("wrap", "soft");
  fileViewer.Encoding.disabled = !window.QaReportFilePreview.isText(fileViewer.Title.textContent, card.dataset.mimeType);
  updateFileViewer();
  fileViewer.Dialog.showModal();
  syncBodyModalOverflow();
  if (!fileViewer.Text.hidden) fileViewer.Text.focus();
}

function closeFileViewer() {
  fileViewer.Dialog.close();
}

fileViewer.Dialog.addEventListener("close", () => {
  const card = viewingFileCard;
  viewingFileCard = null;
  fileViewerTextContent = "";
  fileViewer.Text.value = "";
  fileViewer.Message.textContent = "";
  syncBodyModalOverflow();
  if (card?.isConnected) card.focus({ preventScroll: true });
});
fileViewer.Dialog.addEventListener("cancel", event => {
  event.preventDefault(); closeFileViewer();
});
fileViewer.Dialog.addEventListener("keydown", event => {
  event.stopPropagation();
  if (event.key !== "Tab") return;
  const targets = [...fileViewer.Dialog.querySelectorAll("button:not(:disabled), select:not(:disabled), input:not(:disabled), textarea:not(:disabled)")]
    .filter(node => node.getClientRects().length);
  const first = targets[0], last = targets.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
fileViewer.Dialog.addEventListener("click", event => {
  if (event.target !== fileViewer.Dialog) return;
  const rect = fileViewer.Dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeFileViewer();
});
document.getElementById("closeFileViewerButton").addEventListener("click", closeFileViewer);
fileViewer.Encoding.addEventListener("change", updateFileViewer);
fileViewer.Readable.addEventListener("change", updateFileViewer);
fileViewer.Wrap.addEventListener("change", () => fileViewer.Text.setAttribute("wrap", fileViewer.Wrap.checked ? "soft" : "off"));
document.getElementById("downloadFileViewerButton").addEventListener("click", () => {
  if (viewingFileCard) downloadFileCard(viewingFileCard);
});
copyFileViewerButton.addEventListener("click", async () => {
  const card = viewingFileCard;
  const text = fileViewerTextContent;
  if (!text) return;
  try {
    try { await navigator.clipboard.writeText(text); }
    catch {
      // The fallback must be inside the modal: the rest of the page is inert.
      const textarea = document.createElement("textarea");
      textarea.value = text;
      fileViewer.Dialog.append(textarea);
      textarea.select();
      try { if (!document.execCommand("copy")) throw new Error("copy"); }
      finally { textarea.remove(); copyFileViewerButton.focus(); }
    }
    if (viewingFileCard === card && fileViewerTextContent === text) copyFileViewerButton.textContent = "Скопировано";
  } catch { fileViewer.State.textContent = "Не удалось скопировать. Выделите текст и нажмите Ctrl/⌘+C."; }
});

function showFileMenu(card, anchor = card) {
  const stored = isStoredObjectUrl(card.dataset.dataUrl);
  const storageAction = stored
      ? { label: "Заменить на ссылку", icon: "link", action: () => replaceStoredObjectWithLink(card, "file") }
      : objectStorageConfigured
        ? { label: "Загрузить в хранилище", icon: "download", action: () => uploadEditorObjectToStorage(card, "file") }
        : null;
  const items = [
    storageAction,
    ...(!card.classList.contains("jira-attachment-reference") ? [{ label: "Просмотреть файл", icon: "eye", action: () => openFileViewer(card) }] : []),
    { label: card.classList.contains("jira-attachment-reference") ? "Скачать в браузер" : "Скачать файл", icon: "download", action: () => downloadFileCard(card) },
  ].filter(Boolean);
  // Focusing a card action may scroll its table; position the menu afterwards.
  requestAnimationFrame(() => {
    if (card.isConnected && anchor.isConnected && !fileViewer.Dialog.open) showFloatingMenu(anchor, items);
  });
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

function focusObjectBoundary(object, side = "before") {
  const editor = object.closest(".cell-editor, .intro-editor");
  if (!editor) return false;
  editor.focus({preventScroll:true});
  const range = document.createRange();
  if (side === "after") range.setStartAfter(object); else range.setStartBefore(object);
  range.collapse(true);
  const selection = window.getSelection();
  selection.removeAllRanges(); selection.addRange(range);
  activeEditor = editor; savedEditorRange = range.cloneRange();
  return true;
}

function objectAtEditorCaret() {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const parent = range.startContainer;
  const editor = document.activeElement?.closest(".cell-editor, .intro-editor");
  if (!editor || parent.nodeType !== Node.ELEMENT_NODE || !editor.contains(parent)) return null;
  const next = parent.childNodes[range.startOffset];
  const previous = parent.childNodes[range.startOffset-1];
  const selector = ".cell-image, .cell-code-block, .cell-file";
  if (next?.matches?.(selector)) return {object:next, side:"before"};
  if (previous?.matches?.(selector)) return {object:previous, side:"after"};
  return null;
}

function insertLineBesideObject(object, side = "before", text = "") {
  const editor = object.closest(".cell-editor, .intro-editor");
  if (!editor) return;
  const line = document.createElement("div");
  if (text) line.textContent = text; else line.append(document.createElement("br"));
  if (side === "after") object.after(line); else object.before(line);
  editor.focus({preventScroll:true});
  const range = document.createRange();
  if (text) { range.selectNodeContents(line); range.collapse(false); }
  else { range.setStart(line,0); range.collapse(true); }
  const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  activeEditor = editor; savedEditorRange = range.cloneRange();
  editor.dispatchEvent(new Event("input",{bubbles:true}));
}

function isObjectLeadingEdge(event, object) {
  const rect = object.getBoundingClientRect();
  return object.closest(".cell-editor, .intro-editor") && event.clientX >= rect.left && event.clientX <= rect.left+12;
}

function ensureMediaBoundaries(figure) {
  const createParagraph = () => {
    const paragraph = document.createElement("p");
    paragraph.innerHTML = "<br>";
    return paragraph;
  };
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

function setImportBusy(busy) {
  importBusy = busy;
  elements.applyImportButton.disabled = busy || (importSource === "report" ? !selectedReportFile : Boolean(preparedImport && !importPlanSummary?.valid));
  elements.applyImportButton.setAttribute("aria-busy", String(busy));
  elements.applyImportButton.querySelector(".button-spinner").hidden = !busy;
  elements.applyImportButton.querySelector(".button-label").textContent = importSource === "report" ? (busy ? "Открываем…" : "Открыть отчёт") : busy ? (preparedImport ? "Импортируем…" : "Проверяем…")
    : preparedImport ? `${importPlanSummary?.mode === "replace" ? "Заменить чек-лист" : `Добавить ${importPlanSummary?.count || 0} ${window.QaReportImportOptions.itemWord(importPlanSummary?.count || 0)}`}` : "Продолжить";
  for (const control of elements.importModal.querySelectorAll(".import-source-tab, .import-pane input, .import-pane textarea, .import-pane button, #importWithAttachments, #closeImportButton, #changeImportSource")) control.disabled = busy;
  importWizard?.setBusy(busy);
  if (!busy) document.getElementById("importProgress").hidden = true;
}

function setImportProgress(label, completed, total) {
  const progress = document.getElementById("importProgress");
  const bar = document.getElementById("importProgressBar");
  const determinate = Number.isFinite(total) && total > 0;
  progress.hidden = false;
  document.getElementById("importProgressLabel").textContent = label;
  document.getElementById("importProgressCount").textContent = determinate ? `${completed} из ${total}` : "";
  bar.classList.toggle("is-indeterminate", !determinate);
  if (determinate) {
    bar.setAttribute("aria-valuemax", String(total));
    bar.setAttribute("aria-valuenow", String(completed));
    bar.firstElementChild.style.width = `${completed / total * 100}%`;
  } else {
    bar.removeAttribute("aria-valuemax");
    bar.removeAttribute("aria-valuenow");
    bar.firstElementChild.style.width = "";
  }
}

function resetImportPreview() {
  preparedImport = null; pendingImportedDraft = null; importWizard = null; importPlanSummary = null; importContext = null; pendingImportErrors = [];
  elements.importModal.querySelector(".modal-footer > span").classList.remove("import-footer-warning");
  elements.importModal.querySelector(".modal-footer > span").textContent = importSource === "report" ? "Текущий отчёт сохранится в истории." : importSource === "comment" ? "Далее — выбор пунктов и вложений." : "Далее — выбор пунктов и настроек.";
  elements.importModal.classList.remove("has-import-preview");
  document.getElementById("importSourceSummary").hidden = true;
  document.getElementById("importTitle").textContent = "Импорт чек-листа";
  const configurator = document.getElementById("importConfigurator"); configurator.hidden = true; configurator.replaceChildren();
  document.getElementById("importPreviewMeta").hidden = true;
  document.getElementById("importWithAttachments").closest("label").hidden = importSource !== "comment";
  elements.importSummary.hidden = true; elements.importWarning.hidden = true;
  if (!importBusy) setImportBusy(false);
}

function renderImportChoices() {
  flushDraftFromDom();
  importContext = { reportId: draft.reportId, snapshot: serializeDraft() };
  elements.importModal.classList.add("has-import-preview");
  document.getElementById("importTitle").textContent = "Настроить импорт";
  document.getElementById("importSourceSummary").hidden = false;
  const sourceTitle = document.getElementById("importSourceTitle");
  sourceTitle.textContent = importSource === "comment" ? `Комментарий Jira · ${preparedImport.document.issueUrl.split("/").pop()}` : "Из вставленной разметки";
  sourceTitle.title = importSource === "comment" ? elements.commentImportUrl.value : "";
  const rows = preparedImport.document.sections.reduce((sum, section) => sum + section.rows.length, 0);
  const meta = document.getElementById("importPreviewMeta"); meta.hidden = false;
  meta.textContent = `Найдено разделов: ${preparedImport.document.sections.length} · Пунктов: ${rows}`;
  const master = document.getElementById("importWithAttachments"); master.closest("label").hidden = true;
  const configurator = document.getElementById("importConfigurator"); configurator.hidden = false;
  importWizard = window.QaReportImportWizard.mount(configurator, preparedImport.document, {
    attachments: preparedImport.attachments, comment: importSource === "comment", download: master.checked, currentMode: draft.numberingMode,
    currentDocument: draft, defaultMode: preparedImport.document.sections.some(section => section.headerless) ? "rows" : hasReportDataToReplace() ? "sections" : "replace",
    onChange: summary => {
      importPlanSummary = summary; pendingImportedDraft = null; pendingImportErrors = [];
      const footer = elements.importModal.querySelector(".modal-footer > span");
      footer.textContent = summary.issue || `${summary.destinationText} · Пунктов: ${summary.count}`;
      footer.classList.toggle("import-footer-warning", !summary.valid);
      footer.title = footer.textContent;
      elements.importWarning.hidden = true;
      setImportBusy(importBusy);
    },
  });
  configurator.closest(".import-body").scrollTop = 0;
}

async function analyzeImport() {
  const reportIdAtStart = draft.reportId;
  setImportBusy(true); pwaPendingOperations++;
  elements.importWarning.hidden = true;
  setImportProgress(importSource === "comment" ? "Разбираем комментарий Jira…" : "Разбираем чек-лист…");
  try {
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const includeAttachments = importSource === "comment" && document.getElementById("importWithAttachments").checked;
    let attachmentRequest = {}, imported, importFiles = [];
    if (importSource === "markup") {
      imported = parseJiraMarkup(elements.importMarkup.value, [], { allowHeaderlessRows: true });
    } else {
      const commentUrl = validateJiraCommentUrl(elements.commentImportUrl.value);
      attachmentRequest = { commentUrl };
      const result = await jiraRequest("/api/jira/import-comment", attachmentRequest);
      imported = parseJiraMarkup(result.body, result.attachments || []);
      imported.issueUrl = result.issueUrl || "";
      importFiles = result.attachments || [];
    }
    if (draft.reportId !== reportIdAtStart) throw new Error("Открыт другой отчёт. Повторите импорт в нужном отчёте.");
    preparedImport = {document:imported,attachments:importFiles,attachmentRequest};
    renderImportChoices();
  } catch(error) {
    elements.importWarning.textContent = friendlyJiraError(error); elements.importWarning.hidden = false;
    preparedImport = null;
  } finally {
    setImportBusy(false); pwaPendingOperations--;
    if (preparedImport) document.getElementById("importTab-rows")?.focus();
  }
}

async function prepareImport() {
  const {attachments,attachmentRequest} = preparedImport;
  const source = importWizard.getDocument();
  const localized = await window.QaReportAttachments.localize(source, {
    attachments, policy:importWizard.getPolicy(), sourceIssueUrl:source.issueUrl || "",
    load:attachment=>jiraRequest("/api/jira/import-attachment",{...attachmentRequest,attachmentId:attachment.id},{binary:true}),
    onProgress:({completed,total})=>setImportProgress("Загрузка вложений",completed,total),
  });
  pendingImportedDraft = localized.document; pendingImportErrors = localized.errors;
  elements.importWarning.hidden = !localized.errors.length; elements.importWarning.textContent = localized.errors.join("\n");
  return localized.document;
}

function hasReportDataToReplace() {
  const hasHtml = (html) => {
    const root = document.createElement("div");
    root.innerHTML = html || "";
    return Boolean(root.textContent.replace(/\u00a0/g, " ").trim() ||
      root.querySelector("img, a, pre, table, video, audio, iframe, [data-file-id], .cell-file, .file-attachment"));
  };
  if (hasHtml(draft.intro) || draft.issueUrl || draft.environment !== DEFAULT_DRAFT.environment ||
      draft.overallStatus !== DEFAULT_DRAFT.overallStatus) return true;
  if (!draft.sections.length) return false;
  if (draft.sections.length !== 1) return true;
  const section = draft.sections[0];
  if (section.title !== "Основные проверки" || section.rows.length !== 2 ||
      section.columns.length !== loadDefaultColumns().length || section.columns.some((column, index) =>
        column.title !== loadDefaultColumns()[index].title)) return true;
  return section.rows.some((row) => row.status !== "НЕ ПРОВЕРЕНО" || Object.values(row.cells || {}).some(hasHtml));
}

async function confirmImportReplacement() {
  flushDraftFromDom();
  return !hasReportDataToReplace() || await askConfirmation(
    "Существующие данные этого чек-листа будут заменены импортируемыми. Продолжить?", {
      title: "Замена данных чек-листа", confirmText: "Заменить данные", danger: true,
    });
}

function importedDraftInCurrentReport(imported, current = draft) {
  return normalizeDraft({
    ...current, ...imported,
    draftId: current.draftId, reportId: current.reportId, publicId: current.publicId,
    revision: current.revision, updatedAt: current.updatedAt,
    lastSavedBy: current.lastSavedBy, lastSavedClientId: current.lastSavedClientId,
    issueUrl: imported.issueUrl || current.issueUrl,
  });
}

function checkImportContext() {
  if (!importContext) return;
  flushDraftFromDom();
  if (draft.reportId !== importContext.reportId) throw new Error("Открыт другой отчёт. Закройте импорт и повторите его в нужном отчёте.");
  if (serializeDraft() !== importContext.snapshot) {
    importContext.snapshot = serializeDraft();
    importWizard.refreshCurrent(draft);
    throw new Error("Чек-лист изменился. Предпросмотр обновлён — проверьте место вставки, столбцы и номера перед импортом.");
  }
}

function recordImportHistory(before) {
  clearTimeout(historyTimer);
  if (historyCurrent !== before) undoStack.push(historyCurrent);
  undoStack.push(before);
  historyCurrent = serializeDraft();
  redoStack = [];
  updateHistoryButtons();
}

function showImportResult(message, rowIds) {
  const ids = new Set(rowIds);
  const rows = [...elements.sections.querySelectorAll("tr[data-row-id]")].filter(row => ids.has(row.dataset.rowId));
  rows.forEach(row => row.classList.add("import-added"));
  rows[0]?.scrollIntoView({ behavior: "smooth", block: "center" });
  setTimeout(() => rows.forEach(row => row.classList.remove("import-added")), 3500);
  showToast(message, 8000);
  const reportId = draft.reportId, snapshot = serializeDraft();
  const button = document.createElement("button"); button.type = "button"; button.textContent = "Отменить";
  button.addEventListener("click", () => {
    flushDraftFromDom();
    if (draft.reportId !== reportId || serializeDraft() !== snapshot) {
      showToast("После импорта появились изменения. Используйте «Отменить» в хедере, чтобы отменить их по порядку.", 7000); return;
    }
    undo(); showToast("Импорт отменён");
  });
  elements.toast.append(button);
}

async function applyImport() {
  if (elements.applyImportButton.disabled) return;
  if (importSource === "report") return openSelectedReportFile();
  if (!pendingImportedDraft && !preparedImport) return analyzeImport();
  const reportIdAtStart = draft.reportId;
  let applied = false;
  setImportBusy(true);
  elements.importSummary.hidden = true;
  if (!pendingImportedDraft) elements.importWarning.hidden = true;
  setImportProgress("Подготавливаем чек-лист…");
  pwaPendingOperations++;
  try {
    checkImportContext();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const imported = pendingImportedDraft || (await prepareImport());
    document.getElementById("importProgress").hidden = true;
    if (pendingImportErrors.length && !await askConfirmation(
      pendingImportErrors.join("\n") + "\nСсылки на остальные вложения сохранятся без скачивания. Продолжить импорт?", { title: "Часть вложений недоступна", confirmText: "Продолжить" },
    )) return;
    const placement = importWizard.getPlacement();
    if (placement.mode === "replace" && !await confirmImportReplacement()) return;
    checkImportContext();
    if (draft.reportId !== reportIdAtStart) throw new Error("Открыт другой отчёт. Повторите импорт в нужном отчёте");
    setImportProgress("Сохраняем в браузере…");
    await saveReportSnapshot("before-import");
    checkImportContext();
    flushDraftFromDom();
    const before = serializeDraft();
    let candidate, rowIds;
    if (placement.mode === "replace") {
      ChecklistNumbering.configureImport(imported, importWizard.preserveNumbers(), draft.numberingMode, placement.preserveSectionNumbers ?? importWizard.preserveNumbers());
      candidate = importedDraftInCurrentReport(imported);
      rowIds = candidate.sections.flatMap(s => s.rows.map(r => r.id));
    } else {
      const plan = window.QaReportImportOptions.planAddition(draft, imported, placement, () => crypto.randomUUID());
      candidate = plan.document; rowIds = plan.rowIds;
    }
    clearTimeout(saveTimer); clearTimeout(historyTimer);
    draft = candidate; applied = true;
    render();
    flushDraftFromDom();
    draft = normalizeDraft(draft);
    recordImportHistory(before);
    hasUnsavedLocalChanges = true;
    if (await saveDraft() === false) {
      showToast("Чек-лист изменился при сохранении. Проверьте открытую версию перед повторным импортом.", 9000); return;
    }
    await saveReportSnapshot("import-complete");
    renderEnvironmentOptions();
    updateChecklistUrl(draft.publicId);
    showImportResult(placement.mode === "replace" ? `Чек-лист заменён · Пунктов: ${rowIds.length}`
      : `Добавлено пунктов: ${rowIds.length}${placement.mode === "sections" ? ` · Разделов: ${imported.sections.length}` : ""}`, rowIds);
  } catch (error) {
    if (applied) showToast(`Импорт применён, но сохранить его полностью не удалось: ${error.message}. Проверьте сохранение; импорт можно отменить.`, 12000);
    else {
      elements.importWarning.textContent = error.message; elements.importWarning.hidden = false;
    }
  } finally {
    setImportBusy(false);
    if (applied) {
      closeImport();
      pendingImportedDraft = null; preparedImport = null;
    }
    pwaPendingOperations--;
  }
}

async function chooseImportedNumbering(imported) {
  let preserve = true;
  if ((ChecklistNumbering.hasSourceNumbers(imported) || ChecklistNumbering.hasSourceSectionNumbers(imported))) {
    const choice = await askConfirmation("Сохранить номера разделов и пунктов из исходного чек-листа для ретеста? Их можно будет редактировать вручную, удаление строк не изменит остальные номера.", {
      title: "Нумерация импортируемых пунктов", confirmText: "Сохранить номера", alternativeText: "Пересчитать",
    });
    if (choice === false) return false;
    preserve = choice === true;
  }
  ChecklistNumbering.configureImport(imported, preserve, draft.numberingMode);
  return true;
}

async function applyImportedChecklist(imported, metadata = {}) {
  if (!await confirmImportReplacement()) return false;
  if (!await chooseImportedNumbering(imported)) return false;
  await saveReportSnapshot("before-inbound-import");
  const nextDraft = importedDraftInCurrentReport(imported);
  const title = String(metadata.title || "").trim();
  if (title && nextDraft.sections[0]) nextDraft.sections[0].title = stripSectionNumber(title);
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
  await saveReportSnapshot("inbound-import");
  renderEnvironmentOptions();
  return true;
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
    if (!await applyImportedChecklist(imported, payload)) {
      updateChecklistUrl(draft.publicId);
      setSaveStatus("Импорт отменён");
      return;
    }
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
    ChecklistNumbering.configureImport(imported, draft.numberingMode === "manual", draft.numberingMode);
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

let htmlCopyScopeSession = null;

function htmlCopyScopeOptions() {
  return {
    sectionIds: [...document.querySelectorAll('#htmlCopySectionList input:checked')].map((input) => input.value),
    statuses: [...document.querySelectorAll('#htmlCopyStatusList input:checked')].map((input) => input.value),
  };
}

function updateHtmlCopyScopeState(resetFeedback = true) {
  for (const type of ["Status", "Section"]) {
    const inputs = [...document.querySelectorAll(`#htmlCopy${type}List input`)];
    const count = inputs.filter((input) => input.checked).length;
    const all = document.getElementById(`htmlCopy${type}SelectAll`);
    all.checked = inputs.length > 0 && count === inputs.length;
    all.indeterminate = count > 0 && count < inputs.length;
  }
  const { sectionIds, statuses } = htmlCopyScopeOptions();
  const sections = sectionsForPublication(sectionIds, draft, statuses);
  const count = sections.reduce((sum, section) => sum + section.rows.length, 0);
  document.getElementById("htmlCopyScopeSummary").textContent = `К копированию: разделов — ${sections.length}, пунктов — ${count}`;
  document.getElementById("acceptHtmlCopyScopeButton").disabled = !count || Boolean(htmlCopyScopeSession?.busy);
  if (resetFeedback) {
    document.getElementById("acceptHtmlCopyScopeButton").textContent = "Копировать HTML";
    document.getElementById("htmlCopyScopeFeedback").hidden = true;
  }
}

function openHtmlCopyScope(event) {
  if (htmlCopyScopeSession) return;
  flushDraftFromDom();
  if (!draft.sections.some((section) => section.rows.some(hasRowContent))) {
    showToast("Добавьте хотя бы одну заполненную строку");
    return;
  }
  htmlCopyScopeSession = { documentId: draft.draftId, busy: false, trigger: event?.currentTarget || elements.copyVisualButton };
  closeHeaderDropdowns();
  const populate = (type, options) => {
    const list = document.getElementById(`htmlCopy${type}List`);
    list.replaceChildren();
    for (const [value, title] of options) {
      const label = document.createElement("label");
      label.className = "publish-scope-option";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = true;
      input.value = value;
      input.addEventListener("change", updateHtmlCopyScopeState);
      const text = document.createElement("span");
      text.textContent = title;
      label.append(input, text);
      list.append(label);
    }
  };
  populate("Status", Object.keys(STATUS_META).map((status) => [status, status]));
  populate("Section", draft.sections.map((section, index) => [section.id, section.title.trim() || `Раздел ${index + 1}`]));
  document.querySelectorAll('#htmlCopyScopeModal input').forEach((input) => { input.disabled = false; });
  updateHtmlCopyScopeState();
  document.getElementById("htmlCopyScopeModal").hidden = false;
  syncBodyModalOverflow();
  document.getElementById("htmlCopyStatusSelectAll").focus();
}

function closeHtmlCopyScope() {
  if (!htmlCopyScopeSession) return;
  const trigger = htmlCopyScopeSession.trigger;
  htmlCopyScopeSession = null;
  document.getElementById("htmlCopyScopeModal").hidden = true;
  syncBodyModalOverflow();
  (trigger === elements.copyVisualButton ? elements.copyMenuButton : trigger).focus();
}

async function copyVisualReport() {
  const session = htmlCopyScopeSession;
  if (!session || session.busy) return;
  flushDraftFromDom();
  if (draft.draftId !== session.documentId) {
    closeHtmlCopyScope();
    showToast("Отчёт изменился. Откройте копирование HTML заново.");
    return;
  }
  const options = htmlCopyScopeOptions();
  if (!sectionsForPublication(options.sectionIds, draft, options.statuses).length) return;
  session.busy = true;
  updateHtmlCopyScopeState();
  document.getElementById("acceptHtmlCopyScopeButton").textContent = "Копирование…";
  document.querySelectorAll('#htmlCopyScopeModal input').forEach((input) => { input.disabled = true; });
  try {
    const html = generatePortableHtml(options);
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
        throw new Error("Расширенный буфер обмена недоступен");
      }
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([html], { type: "text/plain" }),
        }),
      ]);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = html;
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.append(textarea);
      textarea.select();
      try {
        if (!document.execCommand("copy")) throw new Error("Не удалось скопировать HTML. Разрешите доступ к буферу обмена и повторите.");
      } finally { textarea.remove(); }
    }
    if (htmlCopyScopeSession === session) {
      document.getElementById("acceptHtmlCopyScopeButton").textContent = "Скопировано в буфер обмена";
      document.getElementById("htmlCopyScopeFeedback").hidden = true;
    }
  } catch (error) {
    if (htmlCopyScopeSession === session) {
      document.getElementById("acceptHtmlCopyScopeButton").textContent = "Копировать HTML";
      document.getElementById("htmlCopyScopeFeedback").textContent = error.message || "Не удалось скопировать HTML";
      document.getElementById("htmlCopyScopeFeedback").hidden = false;
    }
  } finally {
    if (htmlCopyScopeSession === session) {
      session.busy = false;
      document.querySelectorAll('#htmlCopyScopeModal input').forEach((input) => { input.disabled = false; });
      updateHtmlCopyScopeState(false);
      document.getElementById("acceptHtmlCopyScopeButton").focus();
    }
  }
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
    { width: Math.max(7, Math.ceil(ChecklistNumbering.columnWidth(draft) / 7)) },
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
        xlsxCell(`F${rowIndex}`, draft.overallStatus || "Не указан", draft.overallStatus ? getXlsxStatusStyle(draft.overallStatus) : 13, sharedStrings),
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

  const rowNumbers = ChecklistNumbering.rowNumbers(draft);
  draft.sections.forEach((section) => {
    const contentRows = section.rows.filter(hasRowContent);
    if (!contentRows.length) return;
    rowIndex += 2;
    rows.push(xlsxRow(rowIndex, [xlsxCell(`A${rowIndex}`, ChecklistNumbering.sectionTitle(draft, section), 4, sharedStrings)], { height: 24 }));
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

    contentRows.forEach((row) => {
      const cellContent = Array.from({ length: exportDynamicColumns }, (_, columnIndex) => {
        const column = section.columns[columnIndex];
        const html = column ? row.cells[column.id] || "" : "";
        return {
          value: column ? htmlToSpreadsheetText(html) : "",
          code: /<pre[\s>]/i.test(html),
        };
      });
      const values = [
        rowNumbers.get(row.id),
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

// Portable report files only read existing attachment transports; opening is local.
let reportFileBusy = false;
const REPORT_FILE_DISMISS_KEY = "qa-report-hide-export-success-v1";
let reportFileSuccessHidden = false;
try { reportFileSuccessHidden = localStorage.getItem(REPORT_FILE_DISMISS_KEY) === "true"; } catch {}
function closeReportFileDialog() {
  if (reportFileBusy) return;
  const modal = document.getElementById("reportFileModal");
  if (modal.classList.contains("is-success")) {
    reportFileSuccessHidden = document.getElementById("reportFileDismissCheckbox").checked;
    try { localStorage.setItem(REPORT_FILE_DISMISS_KEY, String(reportFileSuccessHidden)); } catch {}
  }
  modal.hidden = true;
  syncBodyModalOverflow(); elements.copyMenuButton.focus();
}
async function runReportFileOperation(title, action) {
  if (reportFileBusy) return;
  if (pwaPendingOperations || publishInProgress || importBusy) {
    showToast("Дождитесь завершения текущей операции с отчётом."); return;
  }
  reportFileBusy = true; pwaPendingOperations++;
  const modal = document.getElementById("reportFileModal");
  const status = document.getElementById("reportFileStatus");
  const error = document.getElementById("reportFileError");
  const close = document.getElementById("closeReportFileButton");
  const progress = document.getElementById("reportFileProgress");
  modal.classList.remove("is-success");
  document.getElementById("reportFileSuccessIcon").hidden = true;
  document.getElementById("reportFileDismissOption").hidden = true;
  document.getElementById("reportFileDismissCheckbox").checked = reportFileSuccessHidden;
  const closeIcon = document.getElementById("closeReportFileIcon");
  closeIcon.hidden = true;
  progress.hidden = false;
  document.getElementById("reportFileTitle").textContent = title;
  status.textContent = "Подготовка отчёта…"; error.hidden = true; error.textContent = "";
  close.disabled = true; progress.removeAttribute("value"); modal.hidden = false;
  closeHeaderDropdowns(); syncBodyModalOverflow(); status.focus();
  const onProgress = ({ completed, total }) => {
    progress.max = Math.max(1, total); progress.value = completed;
    status.textContent = total ? `Обработано вложений: ${completed} из ${total}` : "Подготовка отчёта без вложений…";
  };
  try {
    status.textContent = await action(onProgress);
    progress.hidden = true;
    if (reportFileSuccessHidden) {
      modal.hidden = true;
      syncBodyModalOverflow();
    } else {
      modal.classList.add("is-success");
      document.getElementById("reportFileTitle").textContent = "Копия отчёта скачана";
      document.getElementById("reportFileSuccessIcon").hidden = false;
      document.getElementById("reportFileDismissOption").hidden = false;
    }
  }
  catch (cause) {
    status.textContent = "Операция не завершена";
    error.textContent = cause.message || "Не удалось обработать файл .report."; error.hidden = false;
  } finally {
    reportFileBusy = false; pwaPendingOperations--; close.disabled = false;
    closeIcon.hidden = false;
    if (modal.hidden) elements.copyMenuButton.focus(); else close.focus();
  }
}
function reportAttachmentLoader() {
  const manifests = new Map();
  return async item => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    const signal = controller.signal;
    try {
      let url;
      try { if (item.url) url = new URL(item.url, location.origin); } catch {}
      if (url?.origin === location.origin && url.pathname.startsWith("/api/storage/object/")) {
        const response = await fetch(url.href, { headers: reportIdentityHeaders(), credentials: "same-origin", redirect: "error", signal });
        if (!response.ok) throw new Error(`Хранилище: HTTP ${response.status}`);
        if (Number(response.headers.get("content-length")) > window.QaReportFile.MAX_BYTES) throw new Error("Файл больше 250 МиБ");
        const blob = await response.blob();
        if (blob.type.includes("text/html") && item.type !== "text/html") throw new Error("Хранилище вернуло страницу вместо файла");
        return blob;
      }
      if (item.jiraId || item.jiraName || (!item.url && item.issueUrl)) {
        if (!item.issueUrl) throw new Error("Не указана исходная задача Jira");
        let attachmentId = item.jiraId;
        if (!attachmentId) {
          if (!manifests.has(item.issueUrl)) manifests.set(item.issueUrl, jiraRequest("/api/jira/attachment-manifest", {
            issueUrl: item.issueUrl,
          }, { signal }));
          const manifest = await manifests.get(item.issueUrl);
          const matches = (manifest.attachments || []).filter(file => file.filename === (item.jiraName || item.name));
          if (matches.length !== 1) throw new Error(matches.length ? "В Jira несколько файлов с таким именем" : "Вложение не найдено в Jira");
          attachmentId = matches[0].id;
        }
        return await jiraRequest("/api/jira/import-attachment", {
          commentUrl: item.issueUrl, attachmentId,
        }, { binary: true, signal });
      }
      if (!url || !["https:", "http:", "blob:"].includes(url.protocol) || url.username || url.password) throw new Error("Нет доступной локальной копии вложения");
      const response = await fetch(url.href, { credentials: "omit", redirect: "error", signal });
      if (!response.ok) throw new Error(`Не удалось скачать файл: HTTP ${response.status}`);
      if (Number(response.headers.get("content-length")) > window.QaReportFile.MAX_BYTES) throw new Error("Файл больше 250 МиБ");
      return await response.blob();
    } finally { clearTimeout(timeout); }
  };
}
async function exportReportFile() {
  await runReportFileOperation("Сохранить полную копию", async onProgress => {
    flushDraftFromDom();
    const snapshot = clone(draft);
    const result = await window.QaReportFile.pack(snapshot, { load: reportAttachmentLoader(), onProgress });
    const url = URL.createObjectURL(result.blob), link = document.createElement("a");
    const stamp = new Date().toLocaleString("sv-SE").replace(/[ :]/g, "-");
    link.href = url; link.download = `${issueKeyFromUrl(snapshot.issueUrl) || "report"}_${stamp}.report`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return "Файл .report содержит отчёт и все вложения.\nПозже его можно открыть через «Импорт» →\n«Файл .report».";
  });
}
function portableHistoryRecord(value, reason, existing = {}) {
  const now = new Date().toISOString();
  return { ...existing, id: value.reportId, publicId: value.publicId,
    title: `${reportIssueLabel(value)} — ${value.environment}`, issueUrl: value.issueUrl,
    issueKey: issueKeyFromUrl(value.issueUrl), environment: value.environment, overallStatus: value.overallStatus,
    createdAt: existing.createdAt || now, updatedAt: now, lastOpenedAt: now,
    reason, historyComment: existing.historyComment || "", document: clone(value), schemaVersion: 3 };
}
async function openReportFile(file, onProgress) {
  if (!file) return;
  const imported = await window.QaReportFile.unpack(file, { onProgress });
  const next = normalizeDraft({ ...imported.document, draftId: crypto.randomUUID(), reportId: crypto.randomUUID(),
    publicId: createPublicId(), jiraPublication: null, revision: 1, updatedAt: new Date().toISOString(), lastSavedBy: tabId, lastSavedClientId: reportClientId });
  const db = await openDatabase();
  clearTimeout(saveTimer); clearTimeout(historyTimer); flushDraftFromDom();
  const before = clone(draft), beforeContent = serializeDraft();
  // Save both documents atomically before changing the editor or localStorage.
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(REPORT_STORE, "readwrite"), store = transaction.objectStore(REPORT_STORE);
    const request = store.get(before.reportId);
    request.onsuccess = () => {
      try {
        store.put(portableHistoryRecord(before, "before-file-import", request.result));
        store.put(portableHistoryRecord(next, "file-import"));
      } catch { transaction.abort(); }
    };
    transaction.oncomplete = resolve;
    transaction.onerror = transaction.onabort = () => reject(new Error("Не удалось сохранить копию в браузере. Возможно, недостаточно места. Текущий отчёт остаётся открытым; исходный файл .report сохранён у вас."));
  });
  flushDraftFromDom();
  if (draft.reportId !== before.reportId || serializeDraft() !== beforeContent) {
    throw new Error("Текущий отчёт изменился во время открытия. Импортированная копия сохранена в истории; текущий отчёт остаётся открытым.");
  }
  applyDraftLocally(next); broadcastDraftUpdate();
  return `Открыта отдельная копия: ${imported.count} вложений. Предыдущий отчёт сохранён в истории. Новые правки сохраняются в браузере; для обновления резервного файла скачайте полную копию ещё раз.`;
}
document.getElementById("exportReportButton").addEventListener("click", exportReportFile);
document.getElementById("reportFileInput").addEventListener("change", event => selectReportFiles(event.target.files));
document.getElementById("chooseReportFileButton").addEventListener("click", () => {
  if (!importBusy) document.getElementById("reportFileInput").click();
});
document.getElementById("removeReportFileButton").addEventListener("click", () => {
  if (importBusy) return;
  setSelectedReportFile(null); document.getElementById("chooseReportFileButton").focus();
});
const reportDropZone = document.getElementById("reportDropZone");
reportDropZone.addEventListener("click", event => {
  if (!importBusy && event.target === reportDropZone) document.getElementById("reportFileInput").click();
});
for (const type of ["dragenter", "dragover", "dragleave", "drop"]) {
  reportDropZone.addEventListener(type, event => {
    event.preventDefault(); event.stopPropagation();
    if (importBusy) return;
    if (type === "dragenter") reportDragDepth++;
    if (type === "dragover" && event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    if (type === "dragleave") reportDragDepth = Math.max(0, reportDragDepth - 1);
    if (type === "drop") { reportDragDepth = 0; selectReportFiles(event.dataTransfer?.files || []); }
    reportDropZone.classList.toggle("is-dragover", type === "dragover" || reportDragDepth > 0);
  });
}
document.getElementById("closeReportFileButton").addEventListener("click", closeReportFileDialog);
document.getElementById("closeReportFileIcon").addEventListener("click", closeReportFileDialog);
document.getElementById("reportFileModal").addEventListener("keydown", event => {
  if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeReportFileDialog(); }
  if (event.key === "Tab") {
    if (reportFileBusy) { event.preventDefault(); document.getElementById("reportFileStatus").focus(); return; }
    const controls = [...event.currentTarget.querySelectorAll("button, input")].filter(node => !node.disabled && node.getClientRects().length);
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});

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
    [elements.reportMenuButton, elements.reportMenu],
    [elements.copyMenuButton, elements.copyMenu],
    [document.getElementById("publicationMenuButton"), document.getElementById("publicationMenu")],
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
  elements.cancelConfirmButton.textContent = options.cancelText || "Отмена";
  elements.alternativeConfirmButton.hidden = !options.alternativeText;
  elements.alternativeConfirmButton.textContent = options.alternativeText || "";
  elements.acceptConfirmButton.className =
    `button ${options.danger ? "button-danger" : "button-primary"}`;
  elements.confirmModal.hidden = false;
  syncBodyModalOverflow();
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
  syncBodyModalOverflow();
  resolve(value);
}

async function resetDraft() {
  try {
    await saveReportSnapshot("before-new");
  } catch (error) {
    showToast(`Не удалось сохранить текущий отчёт: ${error.message}`, 9000);
    return;
  }
  hideDraftSyncBanner();
  hideSyncRecovery();
  draft = normalizeDraft(clone(DEFAULT_DRAFT));
  draft.draftId = crypto.randomUUID();
  draft.reportId = crypto.randomUUID();
  draft.jiraPublication = null;
  draft.publicId = createPublicId();
  draft.sections = [createSection("Основные проверки", loadDefaultColumns(), 2)];
  historyCurrent = serializeDraft();
  undoStack = [];
  redoStack = [];
  render();
  updateHistoryButtons();
  forceLocalDraftSave = true;
  await saveDraft();
  updateChecklistUrl(draft.publicId);
  showToast("Создан новый отчёт");
}

selectionUi.Toggle.addEventListener("click", () => setSelectionMode(!selectionMode));
selectionUi.Exit.addEventListener("click", () => setSelectionMode(false));
selectionUi.All.addEventListener("change", () => {
  selectedRowIds = selectionUi.All.checked ? new Set(draft.sections.flatMap((section) => section.rows.map((row) => row.id))) : new Set();
  updateSelectionUi();
});
for (const status of Object.keys(STATUS_META)) {
  const label = document.createElement("label");
  const checkbox = createSelectionCheckbox(status);
  checkbox.value = status;
  checkbox.checked = false;
  checkbox.addEventListener("change", updateSelectionStatusCount);
  label.append(checkbox, document.createTextNode(status));
  selectionUi.StatusOptions.append(label);
}
function updateSelectionStatusCount() {
  selectionUi.StatusCount.textContent = `Статусов: ${selectionUi.StatusOptions.querySelectorAll("input:checked").length}`;
}
updateSelectionStatusCount();
selectionUi.StatusButton.addEventListener("click", () => openSelectionMenu("Status"));
selectionUi.MoveButton.addEventListener("click", () => openSelectionMenu("Move"));
selectionUi.StatusApply.addEventListener("click", () => {
  flushDraftFromDom();
  const statuses = new Set([...selectionUi.StatusOptions.querySelectorAll("input:checked")].map((input) => input.value));
  selectedRowIds = window.QaReportSelection.selectByStatus(draft.sections, statuses);
  updateSelectionUi();
  closeSelectionMenus();
  selectionUi.StatusButton.focus();
});
selectionUi.Search.addEventListener("input", renderSelectionDestinations);
document.querySelectorAll('[name="selectionTransferAction"]').forEach(input => input.addEventListener("change", updateSelectionTransferAction));
function setSelectionCreateExpanded(expanded) {
  selectionUi.CreateForm.hidden = !expanded;
  selectionUi.NewSection.setAttribute("aria-expanded", String(expanded));
  selectionUi.NewSection.textContent = `${expanded ? "−" : "＋"} Создать новый раздел`;
  scheduleStickySectionUpdate();
}
selectionUi.NewSection.addEventListener("click", () => {
  const expanded = selectionUi.CreateForm.hidden;
  setSelectionCreateExpanded(expanded);
  if (!expanded) return;
  if (!selectionUi.NewTitle.value) {
    selectionUi.NewTitle.value = selectionUi.Search.value.trim() || `Новый раздел ${draft.sections.length + 1}`;
  }
  selectionUi.NewTitle.focus({ preventScroll: true });
  selectionUi.NewTitle.select();
});
selectionUi.CreateForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const title = selectionUi.NewTitle.value.trim();
  if (title) transferSelectedRows(null, title);
  else selectionUi.NewTitle.focus();
});
selectionUi.CopyButton.addEventListener("click", copySelectedRowsToNewChecklist);
document.querySelectorAll('[name="selectionCopyGrouping"]').forEach(input => input.addEventListener("change", updateSelectionCopyOptions));
document.getElementById("closeSelectionCopyOptions").addEventListener("click", () => resolveSelectionCopyOptions(false));
document.getElementById("cancelSelectionCopyOptions").addEventListener("click", () => resolveSelectionCopyOptions(false));
document.getElementById("acceptSelectionCopyOptions").addEventListener("click", () => resolveSelectionCopyOptions(true));
selectionUi.Delete.addEventListener("click", deleteSelectedRows);
// Dismiss on the start of an outside interaction, not the click produced when
// a text-selection gesture starts inside an input and ends outside the popover.
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".selection-menu-wrap")) closeSelectionMenus();
});
selectionUi.Toolbar.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.stopPropagation();
  const openName = ["Status", "Move"].find((name) => !selectionUi[`${name}Menu`].hidden);
  if (openName) {
    closeSelectionMenus();
    selectionUi[`${openName}Button`].focus();
  } else setSelectionMode(false);
});
new ResizeObserver(scheduleStickySectionUpdate).observe(selectionUi.Toolbar);
new ResizeObserver(scheduleStickySectionUpdate).observe(document.querySelector(".editor-toolbar"));

elements.addSectionButton.addEventListener("click", () => {
  flushDraftFromDom();
  const previous = draft.sections[draft.sections.length - 1];
  const section = createSection(`Новый раздел ${draft.sections.length + 1}`, loadDefaultColumns());
  draft.sections.push(section);
  renderSections();
  saveLocalMutationNow();
});

const DEFAULT_ENVIRONMENTS = ["DEV", "STAGE", "PROD"];
let environmentSettingsDraft = [];
let environmentSettingsWorkspace = "";

function environmentSettingsKey() {
  return "qa-report-environment-settings-v1:" + (reportWorkspaceKey || "local");
}

function normalizeEnvironments(values) {
  if (!Array.isArray(values)) return [];
  return values.filter(value => typeof value === "string").map(value => value.trim())
    .filter((value, index, all) => value && all.findIndex(other => other.toLocaleLowerCase() === value.toLocaleLowerCase()) === index);
}

function loadEnvironments() {
  try {
    const saved = JSON.parse(localStorage.getItem(environmentSettingsKey()));
    if (Array.isArray(saved)) return normalizeEnvironments(saved);
  } catch {}
  let previous = [];
  try { previous = normalizeEnvironments(JSON.parse(localStorage.getItem("qa-report-environments-v1:" + (reportWorkspaceKey || "local")))); } catch {}
  return normalizeEnvironments([...DEFAULT_ENVIRONMENTS, ...previous]);
}

const environmentPicker = (() => {
  const input = elements.environment, toggle = document.getElementById("environmentToggle");
  const menu = document.getElementById("environmentOptions"), field = input.closest(".environment-field");
  let query = "", values = [], activeIndex = -1, selecting = false;
  const isOpen = () => !menu.hidden;
  function position() {
    const rect = input.getBoundingClientRect(), below = innerHeight - rect.bottom - 12, above = rect.top - 12;
    menu.style.width = rect.width + "px";
    const upward = below < Math.min(menu.scrollHeight, 240) && above > below;
    menu.style.left = Math.max(8, Math.min(rect.left, innerWidth - rect.width - 8)) + "px";
    menu.style.maxHeight = Math.max(48, Math.min(240, upward ? above : below)) + "px";
    menu.style.top = upward ? "auto" : rect.bottom + 6 + "px";
    menu.style.bottom = upward ? innerHeight - rect.top + 6 + "px" : "auto";
  }
  function activate(index, scroll = true) {
    activeIndex = index;
    menu.querySelectorAll("[data-value]").forEach((option, i) => option.classList.toggle("is-active", i === index));
    const option = menu.querySelectorAll("[data-value]")[index];
    if (option && isOpen()) {
      input.setAttribute("aria-activedescendant", option.id);
      if (scroll) option.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  }
  function refresh() {
    values = loadEnvironments().filter(value => value.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    menu.replaceChildren();
    values.forEach((value, index) => {
      const option = document.createElement("div"); option.className = "environment-option";
      option.id = "environment-option-" + index; option.dataset.value = value; option.setAttribute("role", "option");
      const selected = value.toLocaleLowerCase() === input.value.trim().toLocaleLowerCase();
      option.setAttribute("aria-selected", String(selected));
      const label = document.createElement("div"); label.className = "environment-option-label"; label.textContent = value;
      option.append(label); if (selected) option.append(createUiIcon("check"));
      option.addEventListener("pointerdown", event => event.preventDefault());
      option.addEventListener("pointermove", event => { if (event.pointerType === "mouse") activate(index, false); });
      option.addEventListener("click", () => choose(index));
      menu.append(option);
    });
    if (!values.length) {
      const empty = document.createElement("div"); empty.className = "environment-options-empty";
      empty.textContent = query ? "Нет совпадений. Можно оставить свой текст." : "Список пуст. Добавьте окружения в настройках.";
      empty.setAttribute("role", "option"); empty.setAttribute("aria-disabled", "true"); menu.append(empty);
    }
    const selected = values.findIndex(value => value.toLocaleLowerCase() === input.value.trim().toLocaleLowerCase());
    activate(selected, false);
    if (isOpen()) { position(); activate(selected); }
  }
  function close() {
    const filtered = Boolean(query); query = ""; menu.hidden = true; activeIndex = -1;
    input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant");
    toggle.setAttribute("aria-expanded", "false");
    if (filtered) refresh();
  }
  function open(all = true) {
    query = all ? "" : input.value.trim(); menu.hidden = false;
    input.setAttribute("aria-expanded", "true"); toggle.setAttribute("aria-expanded", "true"); refresh();
  }
  function choose(index) {
    if (index < 0 || index >= values.length) return;
    input.value = values[index]; close(); input.focus({ preventScroll: true });
    selecting = true;
    try {
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } finally { selecting = false; }
  }
  toggle.addEventListener("pointerdown", event => { if (event.pointerType === "mouse") event.preventDefault(); });
  toggle.addEventListener("click", () => {
    input.focus({ preventScroll: true });
    if (isOpen() && !query) close(); else open();
  });
  input.addEventListener("input", event => { if (!selecting && !event.isComposing) open(false); });
  input.addEventListener("compositionend", () => { if (!selecting) open(false); });
  input.addEventListener("keydown", event => {
    if (event.isComposing) return;
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      if (!isOpen()) { open(); if (activeIndex < 0 && values.length) activate(event.key === "ArrowDown" ? 0 : values.length - 1); }
      else if (values.length) activate(activeIndex < 0 ? (event.key === "ArrowDown" ? 0 : values.length - 1) : (activeIndex + (event.key === "ArrowDown" ? 1 : -1) + values.length) % values.length);
    } else if (isOpen() && ["Home", "End"].includes(event.key)) {
      event.preventDefault(); activate(event.key === "Home" ? 0 : values.length - 1);
    } else if (isOpen() && event.key === "Enter") {
      event.preventDefault(); if (activeIndex >= 0) choose(activeIndex); else close();
    } else if (isOpen() && event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); close();
    } else if (event.key === "Tab") close();
  });
  field.addEventListener("focusout", () => queueMicrotask(() => { if (!field.contains(document.activeElement)) close(); }));
  document.addEventListener("pointerdown", event => { if (!field.contains(event.target)) close(); });
  window.addEventListener("resize", close);
  window.addEventListener("scroll", event => { if (isOpen() && !menu.contains(event.target)) close(); }, true);
  return { refresh, close };
})();

function renderEnvironmentOptions() {
  environmentPicker.refresh();
}

function setEnvironmentSettingsError(message = "", input) {
  const error = document.getElementById("environmentSettingsError");
  error.textContent = message;
  error.hidden = !message;
  document.querySelectorAll("#environmentSettingsList input, #newEnvironmentName").forEach(node => node.removeAttribute("aria-invalid"));
  if (message && input) { input.setAttribute("aria-invalid", "true"); input.focus(); }
}

function renderEnvironmentSettings() {
  const list = document.getElementById("environmentSettingsList");
  list.replaceChildren();
  if (!environmentSettingsDraft.length) {
    const empty = document.createElement("p");
    empty.className = "settings-note environment-empty";
    empty.textContent = "Список пуст. Добавьте окружение ниже.";
    list.append(empty);
  }
  environmentSettingsDraft.forEach((value, index) => {
    const row = document.createElement("div"); row.className = "environment-settings-row";
    const input = document.createElement("input"); input.type = "text"; input.value = value;
    input.setAttribute("aria-label", "Окружение " + (index + 1));
    input.setAttribute("aria-describedby", "environmentSettingsError");
    const remove = document.createElement("button"); remove.type = "button";
    remove.className = "environment-remove"; remove.append(createUiIcon("trash"));
    const describeRemove = () => { remove.title = "Удалить " + (input.value.trim() || "окружение"); remove.setAttribute("aria-label", remove.title); };
    describeRemove();
    input.addEventListener("input", () => { environmentSettingsDraft[index] = input.value; describeRemove(); setEnvironmentSettingsError(); markSettingsDirty(); });
    remove.addEventListener("click", () => {
      environmentSettingsDraft.splice(index, 1); renderEnvironmentSettings(); setEnvironmentSettingsError(); markSettingsDirty();
      const remaining = list.querySelectorAll("input");
      (remaining[Math.min(index, remaining.length - 1)] || document.getElementById("newEnvironmentName")).focus();
    });
    row.append(input, remove); list.append(row);
  });
}

function fillEnvironmentSettingsForm() {
  environmentSettingsDraft = loadEnvironments();
  environmentSettingsWorkspace = reportWorkspaceKey;
  document.getElementById("newEnvironmentName").value = "";
  setEnvironmentSettingsError(); renderEnvironmentSettings();
}

function addEnvironmentSetting() {
  const input = document.getElementById("newEnvironmentName"), value = input.value.trim();
  if (!value) { setEnvironmentSettingsError("Введите название окружения.", input); return; }
  if (environmentSettingsDraft.some(other => other.trim().toLocaleLowerCase() === value.toLocaleLowerCase())) {
    setEnvironmentSettingsError("Такое окружение уже есть в списке.", input); return;
  }
  environmentSettingsDraft.push(value); input.value = "";
  setEnvironmentSettingsError(); renderEnvironmentSettings(); markSettingsDirty(); input.focus();
}

function saveEnvironmentSettings() {
  const pending = document.getElementById("newEnvironmentName");
  if (pending.value.trim()) {
    addEnvironmentSetting();
    if (pending.value.trim()) { setSettingsSection("environments"); throw new Error("Такое окружение уже есть в списке."); }
  }
  const values = environmentSettingsDraft.map(value => value.trim());
  const invalid = values.findIndex((value, index) => !value || values.findIndex(other => other.toLocaleLowerCase() === value.toLocaleLowerCase()) !== index);
  if (invalid >= 0) {
    setSettingsSection("environments");
    const message = values[invalid] ? "Названия окружений не должны повторяться." : "Введите название окружения или удалите пустую строку.";
    setEnvironmentSettingsError(message, document.querySelectorAll("#environmentSettingsList input")[invalid]);
    throw new Error(message);
  }
  localStorage.setItem(environmentSettingsKey(), JSON.stringify(values));
  environmentSettingsDraft = values; renderEnvironmentSettings(); renderEnvironmentOptions(); setEnvironmentSettingsError();
}

document.getElementById("addEnvironment").addEventListener("click", addEnvironmentSetting);
document.getElementById("newEnvironmentName").addEventListener("input", () => { setEnvironmentSettingsError(); markSettingsDirty(); });
document.getElementById("newEnvironmentName").addEventListener("keydown", event => {
  if (event.key === "Enter") { event.preventDefault(); addEnvironmentSetting(); }
});

elements.issueUrl.addEventListener("change", () => getLocalAttachmentLimits());
elements.environment.addEventListener("change", () => renderEnvironmentOptions());
elements.environment.addEventListener("focus", () => renderEnvironmentOptions());
renderEnvironmentOptions();

["input", "change"].forEach((eventName) => {
  [elements.issueUrl, elements.environment, elements.overallStatus].forEach((control) => {
    control.addEventListener(eventName, () => {
      draft.issueUrl = elements.issueUrl.value;
      renderPublicationState();
      draft.environment = elements.environment.value.trim();
      draft.overallStatus = elements.overallStatus.value;
      if (control === elements.overallStatus) setStatusClass(control, draft.overallStatus);
      if (control.hasAttribute("aria-invalid")) setReportMetadataError(control, reportMetadataError(control));
      scheduleSave({ collect: false });
    });
  });
});

elements.introEditor.addEventListener("input", () => {
  draft.intro = cleanEditorHtml(elements.introEditor);
  scheduleSave({ collect: false });
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
  if (!range || !activeEditor?.contains(range.startContainer) || !activeEditor.contains(range.endContainer)) return null;
  const parentAnchor = (node) =>
    (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest?.("a") || null;
  const start = parentAnchor(range.startContainer);
  const end = parentAnchor(range.endContainer);
  if (start && start === end) return start;
  // Selecting a whole anchor can put both range boundaries in its parent.
  const anchors = [...activeEditor.querySelectorAll("a")].filter(anchor => range.intersectsNode(anchor));
  return anchors.length === 1 && range.toString() === anchors[0].textContent ? anchors[0] : null;
}

function validLinkUrl(value) {
  const url = normalizeLinkUrl(value);
  if (!/^https?:\/\/\S+$/i.test(url)) return "";
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) && parsed.hostname ? url : "";
  } catch { return ""; }
}

function positionLinkPopover() {
  const anchor = linkPopoverAnchor?.isConnected ? linkPopoverAnchor : elements.linkButton;
  const anchorRect = anchor.getBoundingClientRect();
  const popoverWidth = Math.min(300, window.innerWidth - 24);
  const left = Math.max(12, Math.min(anchorRect.left, window.innerWidth - popoverWidth - 12));
  elements.linkPopover.style.width = `${popoverWidth}px`;
  elements.linkPopover.style.left = `${left}px`;
  const height = elements.linkPopover.getBoundingClientRect().height;
  const below = anchorRect.bottom + 8;
  const top = below + height <= window.innerHeight - 12 ? below : anchorRect.top - height - 8;
  elements.linkPopover.style.top = `${Math.max(12, Math.min(top, window.innerHeight - height - 12))}px`;
}

function closeLinkPopover(restoreFocus = false) {
  const range = linkEditorRange?.cloneRange();
  elements.linkPopover.hidden = true;
  elements.linkPopoverError.hidden = true;
  elements.linkButton.setAttribute("aria-expanded", "false");
  linkEditorRange = null;
  editingLink = null;
  linkPopoverAnchor = null;
  if (restoreFocus && activeEditor?.isConnected) {
    activeEditor.focus({ preventScroll: true });
    if (range && activeEditor.contains(range.commonAncestorContainer)) {
      const selection = window.getSelection();
      selection.removeAllRanges(); selection.addRange(range);
      savedEditorRange = range.cloneRange();
    }
  }
}

function openLinkPopover(anchor = null, focusInputs = true) {
  if (anchor) {
    const editor = anchor.closest(".cell-editor, .intro-editor");
    if (!editor || !anchor.isConnected) return;
    activeEditor = editor;
    linkEditorRange = document.createRange();
    linkEditorRange.selectNode(anchor);
    editingLink = anchor;
  } else {
    const selection = window.getSelection();
    const range = selection?.rangeCount && activeEditor?.contains(selection.anchorNode)
      ? selection.getRangeAt(0) : savedEditorRange;
    linkEditorRange = range && activeEditor?.isConnected && activeEditor.contains(range.startContainer) && activeEditor.contains(range.endContainer)
      ? range.cloneRange() : null;
    editingLink = anchorFromRange(linkEditorRange);
  }
  linkPopoverAnchor = anchor || elements.linkButton;
  const selectedText = linkEditorRange?.toString().trim() || "";
  const selectedUrl = isPlainUrl(selectedText) ? normalizeLinkUrl(selectedText) : "";
  elements.linkPopoverTitle.textContent = editingLink ? "Изменить ссылку" : "Добавить ссылку";
  elements.linkTextInput.value = editingLink?.textContent || selectedText || "";
  elements.linkUrlInput.value = editingLink?.getAttribute("href") || selectedUrl;
  elements.showLinkUrlButton.hidden = !editingLink;
  elements.openLinkButton.hidden = !editingLink && !selectedUrl;
  elements.openLinkButton.disabled = !validLinkUrl(elements.linkUrlInput.value);
  elements.linkPopoverError.hidden = true;
  elements.linkPopover.hidden = false;
  elements.linkButton.setAttribute("aria-expanded", "true");
  positionLinkPopover();
  // A click keeps the caret available for a second click or text selection.
  if (focusInputs) requestAnimationFrame(() => {
    if (!elements.linkPopover.hidden) (elements.linkTextInput.value ? elements.linkUrlInput : elements.linkTextInput).focus();
  });
}

function linkEditContextIsCurrent() {
  return activeEditor?.isConnected && (!editingLink || (editingLink.isConnected && activeEditor.contains(editingLink))) &&
    (!linkEditorRange || (activeEditor.contains(linkEditorRange.startContainer) && activeEditor.contains(linkEditorRange.endContainer)));
}

function openLinkFromPopover() {
  if (!linkEditContextIsCurrent()) return closeLinkPopover();
  const url = validLinkUrl(elements.linkUrlInput.value);
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

function applyLinkFromPopover() {
  if (!linkEditContextIsCurrent()) return closeLinkPopover();
  const url = normalizeLinkUrl(elements.linkUrlInput.value);
  const title = elements.linkTextInput.value.trim() || url;
  if (!validLinkUrl(url)) {
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

function showEditedLinkUrl() {
  if (!editingLink || !linkEditContextIsCurrent()) return closeLinkPopover();
  elements.linkTextInput.value = "";
  applyLinkFromPopover();
}

elements.linkButton.addEventListener("click", () => openLinkPopover());
elements.applyLinkButton.addEventListener("click", applyLinkFromPopover);
elements.showLinkUrlButton.addEventListener("click", showEditedLinkUrl);
elements.openLinkButton.addEventListener("click", openLinkFromPopover);
elements.closeLinkPopoverButton.addEventListener("click", () => closeLinkPopover(true));
elements.linkUrlInput.addEventListener("input", () => {
  elements.openLinkButton.disabled = !validLinkUrl(elements.linkUrlInput.value);
  elements.linkPopoverError.hidden = true;
});
[elements.linkTextInput, elements.linkUrlInput].forEach((input) => {
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyLinkFromPopover();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeLinkPopover(true);
    }
  });
});
function editorLinkFromTarget(target) {
  const anchor = target?.closest?.("a[href]");
  return anchor?.closest(".cell-editor, .intro-editor") && !anchor.closest(".cell-file, .cell-image, .cell-code-block, [data-editor-ui]") ? anchor : null;
}

document.addEventListener("pointerdown", event => {
  const anchor = editorLinkFromTarget(event.target);
  pointerLinkGesture = anchor ? { anchor, x: event.clientX, y: event.clientY, moved: false } : null;
}, true);
document.addEventListener("pointermove", event => {
  if (pointerLinkGesture && Math.hypot(event.clientX - pointerLinkGesture.x, event.clientY - pointerLinkGesture.y) > 5) pointerLinkGesture.moved = true;
}, true);
document.addEventListener("pointercancel", () => { pointerLinkGesture = null; }, true);
document.addEventListener("dragstart", () => { if (pointerLinkGesture) pointerLinkGesture.moved = true; }, true);
document.addEventListener("click", event => {
  const anchor = editorLinkFromTarget(event.target);
  const dragged = pointerLinkGesture?.moved;
  pointerLinkGesture = null;
  if (!anchor) return;
  // Every editor-link click is handled here; navigation requires the open button.
  event.preventDefault();
  if (dragged || event.detail > 1 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || !window.getSelection()?.isCollapsed) return;
  openLinkPopover(anchor, false);
}, true);
document.addEventListener("auxclick", event => {
  if (editorLinkFromTarget(event.target)) event.preventDefault();
}, true);
document.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k" && event.target.closest?.(".cell-editor, .intro-editor")) {
    event.preventDefault();
    activeEditor = event.target.closest(".cell-editor, .intro-editor");
    openLinkPopover();
  }
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
  showAttachmentLimits(getLocalAttachmentLimits());
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
document.addEventListener("beforeinput", (event) => {
  if (event.inputType !== "insertText" || !event.data || event.isComposing || !event.cancelable) return;
  const boundary = objectAtEditorCaret();
  if (!boundary) return;
  // Chromium otherwise relocates direct typing across a noneditable figure.
  event.preventDefault(); insertLineBesideObject(boundary.object,boundary.side,event.data);
});
document.addEventListener("compositionstart", () => {
  const boundary = objectAtEditorCaret();
  if (boundary) insertLineBesideObject(boundary.object,boundary.side);
});
document.addEventListener("focusin", (event) => {
  if (event.target.matches(".intro-editor, .cell-editor")) {
    activeEditor = event.target;
    savedEditorRange = null;
    getLocalAttachmentLimits();
  }
});
document.addEventListener("selectionchange", () => {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !activeEditor?.contains(selection.anchorNode)) return;
  savedEditorRange = selection.getRangeAt(0).cloneRange();
});
document.addEventListener("pointerdown", (event) => {
  const edgeObject = event.target.closest(".cell-image, .cell-code-block");
  if (edgeObject && !event.target.closest("[data-editor-ui]") && isObjectLeadingEdge(event,edgeObject)) {
    event.preventDefault(); pointerObjectGesture = null;
    focusObjectBoundary(edgeObject);
    return;
  }
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
  const edgeObject = event.target.closest(".cell-image, .cell-code-block");
  if (edgeObject && !event.target.closest("[data-editor-ui]") && isObjectLeadingEdge(event,edgeObject)) {
    event.preventDefault(); focusObjectBoundary(edgeObject); return;
  }
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
    if ((suppressObjectOpenUntil.get(fileCard) || 0) <= Date.now() && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) openFileViewer(fileCard);
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

// External files use the same local insertion path as clipboard attachments.
let attachmentDropTarget = null;
let attachmentDragScroll = null;
let attachmentDragScrollElement = null;

function isAttachmentFileDrag(event) {
  return !draggedCodeBlock && !draggedImageFigure && hasDragType(event, "Files");
}

function attachmentEditorFromTarget(target) {
  if (document.querySelector('.modal-backdrop:not([hidden]), #fileViewerDialog[open]')) return null;
  return target?.closest?.(".cell-editor, .intro-editor") ||
    target?.closest?.(".editor-cell")?.querySelector(".cell-editor") || null;
}

function setAttachmentDropTarget(editor) {
  const target = editor?.closest(".editor-cell") || editor;
  if (attachmentDropTarget === target) return;
  attachmentDropTarget?.classList.remove("attachment-drop-target");
  attachmentDropTarget = target;
  attachmentDropTarget?.classList.add("attachment-drop-target");
}

function stopAttachmentDragScroll() {
  if (!attachmentDragScroll) return;
  cancelAnimationFrame(attachmentDragScroll.frame);
  attachmentDragScroll = null;
}

function setAttachmentDragScrollElement(scroll) {
  if (attachmentDragScrollElement === scroll) return;
  attachmentDragScrollElement?.classList.remove("attachment-drag-active");
  attachmentDragScrollElement = scroll;
  attachmentDragScrollElement?.classList.add("attachment-drag-active");
}

function clearAttachmentFileDrag() {
  stopAttachmentDragScroll();
  setAttachmentDropTarget(null);
  setAttachmentDragScrollElement(null);
}

function attachmentDragScrollSpeed(scroll, x, y) {
  const rect = scroll.getBoundingClientRect();
  const left = Math.max(0, rect.left);
  const right = Math.min(window.innerWidth, rect.right);
  if (x < left || x > right || y < Math.max(0, rect.top) ||
      y > Math.min(window.innerHeight, rect.bottom) || right <= left) return 0;
  const edge = Math.min(64, (right - left) / 3);
  // Pixels per second, independent of display refresh rate.
  if (x < left + edge) return -240 * (1 - (x - left) / edge);
  if (x > right - edge) return 240 * (1 - (right - x) / edge);
  return 0;
}

function updateAttachmentDragScroll(scroll, event) {
  if (!scroll || !attachmentDragScrollSpeed(scroll, event.clientX, event.clientY)) {
    stopAttachmentDragScroll();
    return;
  }
  if (attachmentDragScroll?.scroll === scroll) {
    attachmentDragScroll.x = event.clientX;
    attachmentDragScroll.y = event.clientY;
    return;
  }
  stopAttachmentDragScroll();
  const state = { scroll, x: event.clientX, y: event.clientY, time: performance.now(), frame: 0 };
  attachmentDragScroll = state;
  const tick = (time) => {
    if (attachmentDragScroll !== state) return;
    const speed = scroll.isConnected && attachmentDragScrollSpeed(scroll, state.x, state.y);
    if (!speed) { stopAttachmentDragScroll(); return; }
    scroll.scrollLeft += speed * Math.min(50, Math.max(0, time - state.time)) / 1000;
    state.time = time;
    // The pointer can stay still while different cells pass beneath it.
    setAttachmentDropTarget(attachmentEditorFromTarget(document.elementFromPoint(state.x, state.y)));
    if ((speed < 0 && scroll.scrollLeft <= 0) ||
        (speed > 0 && scroll.scrollLeft >= scroll.scrollWidth - scroll.clientWidth)) {
      stopAttachmentDragScroll();
      return;
    }
    state.frame = requestAnimationFrame(tick);
  };
  state.frame = requestAnimationFrame(tick);
}

function updateAttachmentFileDrag(event) {
  if (!isAttachmentFileDrag(event)) return;
  const editor = attachmentEditorFromTarget(event.target);
  const scroll = !document.querySelector('.modal-backdrop:not([hidden]), #fileViewerDialog[open]')
    ? event.target.closest?.(".table-scroll") : null;
  setAttachmentDragScrollElement(scroll);
  setAttachmentDropTarget(editor);
  updateAttachmentDragScroll(scroll, event);
  if (editor || scroll) {
    event.preventDefault();
    event.dataTransfer.dropEffect = editor ? "copy" : "none";
  }
}
for (const type of ["dragenter", "dragover"]) {
  document.addEventListener(type, updateAttachmentFileDrag, true);
}

document.addEventListener("drop", async (event) => {
  clearAttachmentFileDrag();
  if (!isAttachmentFileDrag(event)) return;
  const editor = attachmentEditorFromTarget(event.target);
  if (!editor && !event.target.closest?.(".check-section")) return;
  event.preventDefault();
  event.stopPropagation();
  const files = [...(event.dataTransfer?.files || [])];
  if (!editor || !files.length) return;
  let range = rangeFromPoint(event.clientX, event.clientY, editor);
  if (!range) {
    range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
  }
  const node = range.startContainer;
  const object = (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)
    ?.closest(".cell-image, .cell-file, .cell-code-block");
  if (object && editor.contains(object)) range.setStartAfter(object);
  range.collapse(true);
  activeEditor = editor;
  editor.focus({ preventScroll: true });
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  savedEditorRange = range.cloneRange();
  try {
    await insertAttachments(files);
  } catch {
    showToast("Не удалось прочитать перетаскиваемый файл. Попробуйте ещё раз.");
  }
}, true);

document.addEventListener("dragleave", (event) => {
  if (!event.relatedTarget) clearAttachmentFileDrag();
}, true);
document.addEventListener("dragend", clearAttachmentFileDrag, true);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") clearAttachmentFileDrag();
}, true);
window.addEventListener("blur", clearAttachmentFileDrag);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearAttachmentFileDrag();
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

elements.reportMenuButton.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleHeaderDropdown(elements.reportMenuButton, elements.reportMenu);
});
elements.copyMenuButton.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleHeaderDropdown(elements.copyMenuButton, elements.copyMenu);
});
elements.reportMenu.addEventListener("click", () => closeHeaderDropdowns());
elements.copyMenu.addEventListener("click", () => closeHeaderDropdowns());
elements.previewButton.addEventListener("click", openPreview);
elements.feedbackButton.addEventListener("click", openFeedback);
elements.closeFeedbackButton.addEventListener("click", closeFeedback);
elements.cancelFeedbackButton.addEventListener("click", closeFeedback);
elements.copyButton.addEventListener("click", copyMarkup);
elements.copyVisualButton.addEventListener("click", openHtmlCopyScope);
elements.exportXlsxButton.addEventListener("click", exportChecklistXlsx);
elements.modalCopyButton.addEventListener("click", copyPreviewMarkup);
elements.modalCopyVisualButton.addEventListener("click", openHtmlCopyScope);
elements.modalSaveMarkupButton.addEventListener("click", savePreviewMarkupToDraft);
elements.closePreviewButton.addEventListener("click", closePreview);
elements.clearButton.addEventListener("click", resetDraft);
elements.importButton.addEventListener("click", () => openImport("markup"));
elements.closeImportButton.addEventListener("click", closeImport);
elements.applyImportButton.addEventListener("click", () => applyImport());
elements.closeMediaViewerButton.addEventListener("click", closeMediaViewer);
elements.closeCodeEditorButton.addEventListener("click", () => closeCodeEditor());
elements.saveCodeButton.addEventListener("click", saveCodeChanges);
elements.acceptConfirmButton.addEventListener("click", () => resolveConfirmation(true));
elements.alternativeConfirmButton.addEventListener("click", () => resolveConfirmation("alternative"));
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
document.getElementById("changeImportSource").addEventListener("click", () => {
  resetImportPreview();
  (importSource === "comment" ? elements.commentImportUrl : elements.importMarkup).focus();
});
document.querySelectorAll(".import-source-tab").forEach((tab, index, tabs) => {
  tab.addEventListener("click", () => {
    if (!importBusy) selectImportSource(tab.dataset.importSource);
  });
  tab.addEventListener("keydown", event => {
    if (importBusy || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].click(); tabs[next].focus();
  });
});
elements.undoButton.addEventListener("click", undo);
elements.redoButton.addEventListener("click", redo);
elements.historyButton.addEventListener("click", openHistory);
elements.closeHistoryButton.addEventListener("click", closeHistory);
elements.historyList.addEventListener("scroll", () => {
  const menu = document.querySelector(".history-action-menu:popover-open");
  // A queued scroll event can arrive just after a visible trigger opens its menu.
  if (menu && Math.abs(menu.__trigger.getBoundingClientRect().top - menu.__anchorTop) >= 1) closeHistoryActionMenus();
});
window.addEventListener("resize", () => closeHistoryActionMenus());
elements.historySearch.addEventListener("input", () => {
  if (!historyLoading) renderHistoryList().catch(() => {});
});
elements.historyProjectFilter.addEventListener("change", () => {
  if (!historyLoading) flushVisibleHistoryComments().then(() => renderHistoryList()).catch(() => {});
});
elements.historySort.addEventListener("change", () => {
  if (!historyLoading) flushVisibleHistoryComments().then(() => renderHistoryList()).catch(() => {});
});
elements.historySelectionToggle.addEventListener("click", () => {
  setHistorySelectionMode(!historySelectionMode).catch(() => {});
});
elements.historySelectionExit.addEventListener("click", () => {
  setHistorySelectionMode(false).catch(() => {});
});
elements.historySelectAll.addEventListener("change", () => {
  for (const report of historyFilteredReports) {
    if (elements.historySelectAll.checked) selectedHistoryReportIds.add(report.id);
    else selectedHistoryReportIds.delete(report.id);
  }
  updateHistorySelectionUi();
});
elements.deleteSelectedHistoryButton.addEventListener("click", deleteSelectedHistoryReports);
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
elements.publishButton.addEventListener("click", () => publishToJira());
document.getElementById("publishExportButton").addEventListener("click", () => publishToJira());
    document.getElementById("publishAgainButton").addEventListener("click", () => publishToJira("new"));
    document.getElementById("publicationMenuButton").addEventListener("click", event => {
      event.stopPropagation(); toggleHeaderDropdown(event.currentTarget, document.getElementById("publicationMenu"));
    });
elements.publishCancelButton.addEventListener("click", cancelPublishProgress);
document.getElementById("publishStatusSelectAll").addEventListener("change", (event) => {
  document.querySelectorAll('#publishStatusList input').forEach((input) => { input.checked = event.target.checked; });
  updatePublishScopeState();
});
elements.publishScopeSelectAll.addEventListener("change", () => {
  elements.publishScopeList.querySelectorAll("input[type='checkbox']").forEach((checkbox) => {
    checkbox.checked = elements.publishScopeSelectAll.checked;
  });
  updatePublishScopeState();
});
for (const type of ["Status", "Section"]) {
  document.getElementById(`htmlCopy${type}SelectAll`).addEventListener("change", (event) => {
    document.querySelectorAll(`#htmlCopy${type}List input`).forEach((input) => { input.checked = event.target.checked; });
    updateHtmlCopyScopeState();
  });
}
document.getElementById("closeHtmlCopyScopeButton").addEventListener("click", closeHtmlCopyScope);
document.getElementById("acceptHtmlCopyScopeButton").addEventListener("click", copyVisualReport);
elements.closePublishScopeButton.addEventListener("click", () => resolvePublishScope(false));
elements.cancelPublishScopeButton.addEventListener("click", () => resolvePublishScope(false));
elements.acceptPublishScopeButton.addEventListener("click", () => resolvePublishScope(true));
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
document.querySelectorAll('.settings-sidebar [data-settings-section]').forEach((button) => {
  button.addEventListener("click", () => setSettingsSection(button.dataset.settingsSection));
});

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
  handleDraftSyncMessage(event.data).catch(() => {});
});
window.addEventListener("storage", (event) => {
  if (event.key === PINNED_COLUMNS_KEY || event.key === null) {
    pinnedColumns = loadPinnedColumns();
    applyPinnedColumns();
    // Keep an open settings form in sync with the shared browser preference.
    fillPinnedColumnsForm();
  }
  if (event.key === DRAFT_LOCATION_KEY && event.newValue) {
    try {
      handleDraftSyncMessage({ ...JSON.parse(event.newValue), type: "draft-updated", storageKey: STORAGE_KEY }).catch(() => {});
    } catch {}
    return;
  }
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
window.addEventListener("scroll", (event) => {
  // Scrolling an options list does not move its anchor or change the sticky stack.
  if (event.target === selectionUi.Destinations || event.target === selectionUi.StatusOptions) return;
  closeFloatingMenu();
  if (!elements.linkPopover.hidden && !elements.linkPopover.contains(event.target)) positionLinkPopover();
  scheduleStickySectionUpdate();
}, true);
document.addEventListener("keydown", (event) => {
  const focusedObject = document.activeElement;
  const editorObject = focusedObject?.matches?.(".cell-image, .cell-code-block, .cell-file") && focusedObject.closest(".cell-editor, .intro-editor");
  if (!event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey) {
    if (event.key === "Enter" && event.shiftKey) {
      const boundary = editorObject ? {object:focusedObject,side:"before"} : objectAtEditorCaret();
      if (boundary) {
        event.preventDefault(); insertLineBesideObject(boundary.object,boundary.side); return;
      }
    }
    if (editorObject && !event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault(); focusObjectBoundary(focusedObject,event.key === "ArrowLeft" ? "before" : "after"); return;
    }
  }
  if (
    (event.key === "Enter" || event.key === " ") &&
    focusedObject?.matches?.(".cell-code-block, .cell-image, .cell-file") &&
    event.target === focusedObject
  ) {
    event.preventDefault();
    if (focusedObject.matches(".cell-code-block")) openCodeEditor(focusedObject);
    else if (focusedObject.matches(".cell-image")) openMediaViewer(focusedObject.querySelector("img"));
    else openFileViewer(focusedObject);
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
    if (closeHistoryActionMenus({ restoreFocus: true })) { event.preventDefault(); return; }
    if (!document.getElementById("selectionCopyOptionsModal").hidden) {
      resolveSelectionCopyOptions(false);
      return;
    }
    if (!document.getElementById("htmlCopyScopeModal").hidden) {
      closeHtmlCopyScope();
      return;
    }
    if (!elements.publishScopeModal.hidden) {
      resolvePublishScope(false);
      return;
    }
    if (!elements.confirmModal.hidden) {
      resolveConfirmation(false);
      return;
    }
    if (!elements.linkPopover.hidden) {
      closeLinkPopover(true);
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
getLocalAttachmentLimits();
refreshObjectStorageUi();
if (!routeChecklistPublicId() && !isNewerDraft(readDraftLocation())) updateChecklistUrl(draft.publicId);
updateHistoryButtons();
if (new URL(window.location.href).searchParams.has("importToken")) {
  handleInboundChecklistImport();
} else {
  openReportFromRoute().catch(() => {}).finally(() => checkStoredDraftFreshness());
}


// Release notes are presentation data, independent of report documents.
const whatsNewButton = document.getElementById("whatsNewButton");
const whatsNewModal = document.getElementById("whatsNewModal");
const whatsNewClose = document.getElementById("closeWhatsNewButton");
const RELEASE_SEEN_KEY = "qa-report-release-seen-v1";
let seenRelease = "";
try { seenRelease = localStorage.getItem(RELEASE_SEEN_KEY) || ""; } catch {}

function latestReleaseReceipt() {
  const latest = window.QaReportReleases?.[0];
  return latest ? `${latest.version}:${shortHashFromString(JSON.stringify(latest))}` : "";
}

function updateReleaseIndicator() {
  const latest = window.QaReportReleases?.[0];
  const unread = Boolean(latest && seenRelease !== latestReleaseReceipt());
  document.getElementById("whatsNewDot").hidden = !unread;
  whatsNewButton.setAttribute("aria-label", unread ? "Что нового — есть непросмотренные изменения" : "Что нового");
}

function renderReleaseNotes() {
  const content = document.getElementById("whatsNewContent");
  content.replaceChildren();
  (window.QaReportReleases || []).forEach((release, index) => {
    const container = document.createElement(index === 0 ? "article" : "details");
    container.className = "release-entry";
    const heading = document.createElement(index === 0 ? "h3" : "summary");
    const version = document.createElement("span");
    version.textContent = `Версия ${release.version}`;
    const date = document.createElement("time");
    date.dateTime = release.date;
    date.textContent = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${release.date}T00:00:00Z`));
    heading.append(version, date);
    container.append(heading);
    for (const [key, label] of [["new", "Новое"], ["improvements", "Улучшения"], ["fixes", "Исправления"]]) {
      const changes = release.changes[key] || [];
      if (!changes.length) continue;
      const title = document.createElement("h4");
      title.textContent = label;
      const list = document.createElement("ul");
      changes.forEach((change) => {
        const item = document.createElement("li");
        item.textContent = change;
        list.append(item);
      });
      container.append(title, list);
    }
    content.append(container);
  });
}

function closeWhatsNew() {
  whatsNewModal.hidden = true;
  syncBodyModalOverflow();
  whatsNewButton.focus();
}

whatsNewButton.addEventListener("click", () => {
  closeHeaderDropdowns();
  renderReleaseNotes();
  whatsNewModal.hidden = false;
  document.getElementById("whatsNewContent").scrollTop = 0;
  syncBodyModalOverflow();
  whatsNewClose.focus();
  seenRelease = latestReleaseReceipt();
  try { localStorage.setItem(RELEASE_SEEN_KEY, seenRelease); } catch {}
  updateReleaseIndicator();
});
whatsNewClose.addEventListener("click", closeWhatsNew);
whatsNewModal.addEventListener("click", (event) => {
  if (event.target === whatsNewModal) closeWhatsNew();
});
whatsNewModal.addEventListener("keydown", (event) => {
  event.stopPropagation();
  if (event.key === "Escape") { event.preventDefault(); closeWhatsNew(); }
  if (event.key === "Tab") {
    const targets = [...whatsNewModal.querySelectorAll("button, summary")];
    const first = targets[0];
    const last = targets.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
window.addEventListener("storage", (event) => {
  if (event.key === RELEASE_SEEN_KEY || event.key === null) {
    seenRelease = event.newValue || "";
    updateReleaseIndicator();
  }
});
updateReleaseIndicator();

// PWA reload is allowed only after a durable local snapshot succeeds.
let pwaPendingOperations = 0;
window.preparePwaUpdate = async function () {
  if (publishInProgress || pwaPendingOperations || codeEditorIsDirty() ||
      document.querySelector('.modal-backdrop:not([hidden]), #fileViewerDialog[open]')) {
    throw new Error('Завершите текущую операцию и закройте диалог перед обновлением.');
  }
  clearTimeout(saveTimer);
  if (await saveDraft() === false) throw new Error('Сначала разрешите конфликт версий чек-листа.');
  await saveReportSnapshot('before-update');
};




document.getElementById("addDefaultColumn").addEventListener("click", () => {
  defaultColumnsDraft.push({ id: `column-${crypto.randomUUID()}`, title: "Новый столбец" });
  renderDefaultColumnsSettings(); setSettingsSavedState(false);
  [...document.querySelectorAll("#defaultColumnsList input")].at(-1)?.focus();
});
document.getElementById("resetDefaultColumns").addEventListener("click", () => {
  defaultColumnsDraft = DEFAULT_COLUMNS.map(column => ({ ...column }));
  renderDefaultColumnsSettings(); setSettingsSavedState(false);
});

for (const input of [elements.importMarkup, elements.commentImportUrl]) {
  input.addEventListener("input", resetImportPreview);
}

// Header menus share keyboard navigation and close when focus leaves the menu.
document.querySelectorAll('.header-dropdown').forEach(dropdown => {
  const trigger = dropdown.querySelector('.header-dropdown-trigger');
  const menu = dropdown.querySelector('[role="menu"]');
  dropdown.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...menu.querySelectorAll('[role^="menuitem"]:not(:disabled)')];
    if (menu.hidden) { toggleHeaderDropdown(trigger, menu); if (event.key === 'ArrowUp') items.at(-1)?.focus(); return; }
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
    items[next]?.focus();
  });
  dropdown.addEventListener('keydown', event => {
    if (event.key === 'Tab') setTimeout(() => {
      if (!dropdown.contains(document.activeElement)) closeHeaderDropdowns();
    }, 0);
  });
});

// Freeze the caret and content at recording start, independently of later focus.
function captureDictationTarget() {
  const editor = document.activeElement;
  if (!editor?.matches(".cell-editor, .intro-editor, .section-title") || !editor.isConnected || selectionMode) return null;
  const isInput = editor.matches("input"), target = { editor, reportId: draft.reportId, value: isInput ? editor.value : editor.innerHTML };
  if (isInput) { target.start = editor.selectionStart; target.end = editor.selectionEnd; target.label = "Название раздела"; return target; }
  const selection = window.getSelection();
  if (selection?.rangeCount && editor.contains(selection.anchorNode) && editor.contains(selection.focusNode)) target.range = selection.getRangeAt(0).cloneRange();
  else { target.range = document.createRange(); target.range.selectNodeContents(editor); target.range.collapse(false); }
  const section = draft.sections.find(item => item.id === editor.closest("[data-section-id]")?.dataset.sectionId);
  const row = editor.closest("tr[data-row-id]");
  const column = section?.columns.find(item => item.id === editor.dataset.columnId);
  target.label = editor.matches(".intro-editor") ? "Вводный текст" : `${section?.title || "Раздел"} · строка ${row?.querySelector(".row-number-input")?.value || (section?.rows.findIndex(item => item.id === row?.dataset.rowId) ?? 0) + 1} · ${column?.title || "Текст"}`;
  return target;
}
function insertDictationText(target, text) {
  const { editor } = target, isInput = editor.matches("input");
  if (!editor.isConnected || target.reportId !== draft.reportId || (isInput ? editor.value : editor.innerHTML) !== target.value) return false;
  if (!isInput && (!target.range.startContainer.isConnected || !editor.contains(target.range.startContainer) || !editor.contains(target.range.endContainer))) return false;
  const left = isInput ? editor.value.slice(0, target.start) : (() => { const range = document.createRange(); range.selectNodeContents(editor); range.setEnd(target.range.startContainer, target.range.startOffset); return range.toString(); })();
  const right = isInput ? editor.value.slice(target.end) : (() => { const range = document.createRange(); range.selectNodeContents(editor); range.setStart(target.range.endContainer, target.range.endOffset); return range.toString(); })();
  if (/[\p{L}\p{N}]$/u.test(left) && /^[\p{L}\p{N}]/u.test(text)) text = " " + text;
  if (/\S$/.test(text) && /^[\p{L}\p{N}]/u.test(right)) text += " ";
  // Commit previous typing first, so a complete dictation fragment has its own undo step.
  clearTimeout(historyTimer);
  const before = serializeDraft();
  if (before !== historyCurrent) { undoStack.push(historyCurrent); historyCurrent = before; }
  if (isInput) { editor.focus(); editor.setRangeText(text, target.start, target.end, "end"); editor.dispatchEvent(new Event("input", { bubbles:true })); }
  else { activeEditor = editor; editor.focus(); insertHtmlAtSelection(escapeHtml(text).replace(/\r?\n/g, "<br>"), target.range); }
  clearTimeout(historyTimer);
  const after = serializeDraft();
  if (after !== before) { undoStack.push(before); historyCurrent = after; redoStack = []; updateHistoryButtons(); }
  return true;
}
window.QaReportDictation.init({ api: dictationConnectApi, capture: captureDictationTarget, insert: insertDictationText, setup: openDictationConnectSetup });

async function dictationConnectApi(path, options = {}) {
  if (options.method === "POST") {
    const { csrfToken } = await reportApi("/api/auth/csrf");
    options = { ...options, body: JSON.stringify({ ...JSON.parse(options.body || "{}"), csrfToken }) };
  }
  return reportApi(path, options);
}
function openDictationConnectSetup() { openJiraSettings(); setSettingsSection("connect"); }
async function refreshDictationConnect() {
  const output = document.getElementById("dictationConnectState");
  try {
    const value = await reportApi("/api/agent/status");
    output.textContent = value.connected ? "QA Report Connect подключён" : "QA Report Connect не подключён. Откройте приложение на компьютере.";
    if (value.connected) { document.getElementById("dictationConnectLaunch").hidden = true; document.getElementById("dictationConnectPair").hidden = true; }
    else document.getElementById("dictationConnectPair").hidden = false;
  } catch (error) { output.textContent = error.message; }
}
let dictationConnectExpiry;
document.getElementById("dictationConnectPair").addEventListener("click", async event => {
  const button = event.currentTarget, link = document.getElementById("dictationConnectLaunch"), hint = document.getElementById("dictationConnectHint");
  button.disabled = true;
  try {
    const value = await dictationConnectApi("/api/agent/pairings", { method:"POST", body:"{}" });
    const url = new URL("qareport-agent://connect"); url.searchParams.set("server", value.serverUrl); url.searchParams.set("code", value.code); url.searchParams.set("theme", document.documentElement.dataset.theme || "light");
    link.href = url.href; link.hidden = false; hint.textContent = "Откройте Connect и подтвердите подключение. Затем нажмите «Проверить подключение».";
    clearTimeout(dictationConnectExpiry);
    dictationConnectExpiry = setTimeout(() => { link.hidden = true; link.removeAttribute("href"); hint.textContent = "Ссылка истекла. Подключите Connect заново."; }, Math.max(0, Date.parse(value.expiresAt) - Date.now()));
  } catch (error) { hint.textContent = error.message; }
  finally { button.disabled = false; }
});
document.getElementById("dictationConnectCheck").addEventListener("click", refreshDictationConnect);

// The shared wizard uses corporate Jira directly and Connect only for AI/speech.
window.QaReportBugUI.init({
  getDraft: () => draft, flush: flushDraftFromDom,
  changed: () => { renderSections(); saveLocalMutationNow(); },
  reportApi: dictationConnectApi,
  jiraRequest: async (path, body, options = {}) => {
    if (path !== "/api/jira/import-attachment") return jiraRequest(path, body, options);
    const blob = await jiraRequest(path, body, { ...options, binary: true });
    const dataUrl = await window.QaReportAttachments.dataUrl(blob);
    return { file: { type: blob.type, dataBase64: dataUrl.slice(dataUrl.indexOf(",") + 1) } };
  },
  jiraSettings: () => ({}),
  bugRequest: async (path, body) => {
    const { instances } = await reportApi("/api/jira/connections");
    const reference = body.baseUrl || "";
    const connection = instances.find(item => item.connected && item.baseUrl.replace(/\/$/, "") === reference.replace(/\/$/, ""));
    if (!connection) throw new Error("Подключите выбранную Jira в настройках приложения.");
    const { csrfToken } = await reportApi("/api/auth/csrf");
    try { return await reportApi(path, { method: "POST", body: JSON.stringify({ ...body, instanceId: connection.id, csrfToken }) }); }
    catch (error) { error.fieldErrors = error.payload?.fieldErrors || {}; throw error; }
  },
  bugStatus: async () => {
    const { instances } = await reportApi("/api/jira/connections");
    const urls = instances.filter(item => item.connected).map(item => item.baseUrl);
    return { connected: Boolean(urls.length), devices: urls.length ? [{ online: true, version: "0.6.12", lastSeenAt: new Date().toISOString(), jiraBaseUrls: urls }] : [] };
  },
  modalOverflow: syncBodyModalOverflow, settingsDirty: markSettingsDirty,
});
document.getElementById("openStandaloneBugReport").addEventListener("click", () => {
  closeHeaderDropdowns(); window.QaReportBugUI.openStandalone(elements.reportMenuButton);
});
