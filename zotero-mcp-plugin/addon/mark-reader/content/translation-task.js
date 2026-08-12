var { FilePicker } = ChromeUtils.importESModule(
  "chrome://zotero/content/modules/filePicker.mjs",
);

var ZMRTranslationTaskWindow = {
  task: null,
  snapshot: null,
  unsubscribe: null,
  allowClose: false,
  glossaryDirty: false,
  renderedGlossaryKey: "",
  renderedGlossaryQuery: "",
  renderedGlossarySources: new Set(),
  activityTimer: null,
  renderError: "",
  renderStage: "",

  init() {
    try {
      this.task = window.arguments?.[0]?.task;
      if (!this.task) {
        throw new Error("未收到翻译任务数据。");
      }
      this.bindControls();
      this.unsubscribe = this.task.subscribe((snapshot) => this.safeRender(snapshot));
      this.activityTimer = window.setInterval(() => this.renderActivity(), 1000);
    } catch (error) {
      if (typeof Zotero !== "undefined") {
        Zotero.logError(error);
      }
      this.showFatalError(error);
    }
  },

  showFatalError(error) {
    const status = document.getElementById("zmr-task-status");
    if (status) {
      status.textContent = xmlSafeText(`任务窗口加载失败：${error.message || String(error)}`);
      status.dataset.state = "error";
    }
    for (const button of document.querySelectorAll("button")) {
      button.disabled = true;
    }
  },

  destroy() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    window.clearInterval(this.activityTimer);
    this.activityTimer = null;
  },

  bindControls() {
    document.getElementById("zmr-task-start").addEventListener("click", () => {
      if (this.glossaryDirty) {
        this.saveGlossary();
      }
      this.task.start();
    });
    document.getElementById("zmr-task-pause").addEventListener("click", () => {
      if (this.snapshot?.status === "paused") {
        this.task.resume();
      } else {
        this.task.pause();
      }
    });
    document.getElementById("zmr-task-cancel").addEventListener("click", () => {
      this.task.cancel();
    });
    document.getElementById("zmr-task-retry").addEventListener("click", () => {
      this.task.retryFailures();
    });
    document.getElementById("zmr-glossary-document").addEventListener("change", () => {
      const select = document.getElementById("zmr-glossary-document");
      const nextKey = select.value;
      if (this.glossaryDirty && this.renderedGlossaryKey) {
        select.value = this.renderedGlossaryKey;
        this.saveGlossary();
        select.value = nextKey;
      }
      this.glossaryDirty = false;
      this.renderGlossary(true);
    });
    document.getElementById("zmr-glossary-search").addEventListener("input", () => {
      if (this.glossaryDirty) {
        this.saveGlossary();
      }
      this.renderGlossary(true);
    });
    document.getElementById("zmr-glossary-add").addEventListener("click", () => {
      this.addGlossaryRow();
    });
    document.getElementById("zmr-glossary-save").addEventListener("click", () => {
      this.saveGlossary();
    });
    document.getElementById("zmr-glossary-import").addEventListener("click", () => {
      this.importGlossary();
    });
    document.getElementById("zmr-glossary-export").addEventListener("click", () => {
      this.exportGlossary();
    });
    document.getElementById("zmr-glossary-body").addEventListener("input", () => {
      this.glossaryDirty = true;
    });
  },

  safeRender(snapshot) {
    this.renderError = "";
    try {
      this.render(snapshot);
    } catch (error) {
      if (typeof Zotero !== "undefined") {
        Zotero.logError(error);
      }
      const activity = document.getElementById("zmr-task-activity");
      this.renderError = `${this.renderStage ? `${this.renderStage}：` : ""}${
        error.message || String(error)
      }`;
      if (activity) {
        activity.textContent = xmlSafeText(
          `进度窗口刷新失败，但后台任务仍会继续：${this.renderError}`,
        );
        activity.dataset.state = "error";
      }
    }
  },

  render(snapshot) {
    this.snapshot = snapshot;
    const { stats } = snapshot;
    const inProgress = Number(stats.inProgress) || 0;
    this.renderStage = "任务状态";
    const statusLabels = {
      preparing: "正在准备任务...",
      ready: "分析完成，等待开始",
      running: "正在翻译",
      paused: "已暂停",
      completed: "翻译完成",
      cancelled: "已取消，已完成译文已保存",
      failed: "任务失败",
    };
    document.getElementById("zmr-task-status").textContent =
      statusLabels[snapshot.status] || snapshot.status;
    const progress = document.getElementById("zmr-task-progress");
    progress.max = Math.max(1, stats.total);
    if (
      ["starting", "analyzing", "scanning", "translating"].includes(snapshot.phase) &&
      stats.completed === 0
    ) {
      progress.removeAttribute("value");
    } else {
      progress.value = stats.completed;
    }
    progress.setAttribute(
      "aria-label",
      `全文翻译进度：${stats.completed} / ${stats.total}`,
    );
    document.getElementById("zmr-task-counts").textContent =
      `${stats.completed} / ${stats.total} 个内容块${
        inProgress ? `（${inProgress} 个处理中）` : ""
      }`;
    this.renderActivity();
    document.getElementById("zmr-task-current").textContent = xmlSafeText(
      snapshot.currentDocument ? `当前文档：${snapshot.currentDocument}` : "",
    );
    document.getElementById("zmr-stat-pending").textContent = Math.max(
      0,
      stats.total - stats.completed - inProgress,
    );
    document.getElementById("zmr-stat-active").textContent = inProgress;
    document.getElementById("zmr-stat-cached").textContent = stats.cached;
    document.getElementById("zmr-stat-stale").textContent = stats.stale;
    document.getElementById("zmr-stat-translated").textContent = stats.translated;
    document.getElementById("zmr-stat-failed").textContent = stats.failed;
    document.getElementById("zmr-stat-skipped").textContent = stats.skippedDocuments;

    const start = document.getElementById("zmr-task-start");
    start.disabled =
      snapshot.status !== "ready" || !snapshot.analysisReady || !stats.total;
    const pause = document.getElementById("zmr-task-pause");
    pause.textContent = snapshot.status === "paused" ? "继续" : "暂停";
    pause.disabled = !["running", "paused"].includes(snapshot.status);
    document.getElementById("zmr-task-cancel").disabled = this.task.isFinished();
    document.getElementById("zmr-task-retry").hidden =
      !(this.task.isFinished() && stats.failed);
    this.renderStage = "文档列表";
    this.renderDocuments();
    this.renderStage = "单篇术语表";
    this.renderGlossary();
    this.renderStage = "任务日志";
    this.renderLogs();
    this.renderStage = "";
  },

  renderActivity() {
    const activity = document.getElementById("zmr-task-activity");
    if (!activity || !this.snapshot) {
      return;
    }
    if (this.renderError) {
      activity.textContent = xmlSafeText(
        `进度窗口刷新失败，但后台任务仍会继续：${this.renderError}`,
      );
      activity.dataset.state = "error";
      return;
    }
    const startedAt = Number(this.snapshot.activityStartedAt || 0);
    const elapsed = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;
    activity.textContent = xmlSafeText(
      `${this.snapshot.activity || ""}${
        ["running", "paused"].includes(this.snapshot.status) && startedAt
          ? `（已等待 ${elapsed} 秒）`
          : ""
      }`,
    );
    activity.removeAttribute("data-state");
  },

  renderDocuments() {
    const select = document.getElementById("zmr-glossary-document");
    const selected = select.value;
    select.replaceChildren();
    for (const item of this.snapshot?.documents || []) {
      const option = htmlElement("option");
      option.value = item.attachmentKey;
      option.textContent = xmlSafeText(item.title);
      select.appendChild(option);
    }
    if ([...select.options].some((option) => option.value === selected)) {
      select.value = selected;
    }
  },

  selectedDocument() {
    const key = document.getElementById("zmr-glossary-document").value;
    return this.snapshot?.documents.find((item) => item.attachmentKey === key);
  },

  renderGlossary(force = false) {
    const body = document.getElementById("zmr-glossary-body");
    const documentItem = this.selectedDocument();
    if (
      !force &&
      this.glossaryDirty &&
      this.renderedGlossaryKey === documentItem?.attachmentKey
    ) {
      return;
    }
    body.replaceChildren();
    if (!documentItem) {
      return;
    }
    this.renderedGlossaryKey = documentItem.attachmentKey;
    const query = document
      .getElementById("zmr-glossary-search")
      .value.trim()
      .toLocaleLowerCase();
    this.renderedGlossaryQuery = query;
    const entries = editableGlossaryEntries(documentItem).filter((entry) =>
      !query
        ? true
        : `${entry.source} ${entry.target} ${entry.note}`
            .toLocaleLowerCase()
            .includes(query),
    );
    this.renderedGlossarySources = new Set(entries.map((entry) => entry.source));
    for (const entry of entries) {
      body.appendChild(this.createGlossaryRow(entry));
    }
  },

  createGlossaryRow(entry = {}) {
    const row = htmlElement("tr");
    const origin = entry.origin || "document-manual";
    row._zmrOrigin = origin;
    row._zmrOriginalSource = String(entry.source || "");
    row.classList.toggle("zmr-glossary-ai", origin === "document-ai");
    const fields = ["enabled", "source", "target", "targetLanguage", "note"];
    for (const field of fields) {
      const cell = htmlElement("td");
      const input = htmlElement("input");
      input._zmrField = field;
      if (field === "enabled") {
        input.type = "checkbox";
        input.checked = entry.enabled !== false;
      } else {
        input.type = "text";
        input.value = xmlSafeText(entry[field]);
      }
      cell.appendChild(input);
      row.appendChild(cell);
    }
    if (origin === "document-ai") {
      row.title = "AI 生成术语；编辑并保存后将转为单篇人工术语";
    }
    const actionCell = htmlElement("td");
    const deleteButton = htmlElement("button");
    deleteButton.type = "button";
    deleteButton.setAttribute("aria-label", "删除术语");
    deleteButton.textContent = "删除";
    deleteButton.addEventListener("click", () => {
      row.remove();
      this.glossaryDirty = true;
    });
    actionCell.appendChild(deleteButton);
    row.appendChild(actionCell);
    return row;
  },

  addGlossaryRow() {
    this.glossaryDirty = true;
    document.getElementById("zmr-glossary-body").prepend(this.createGlossaryRow());
  },

  readManualGlossary() {
    return [...document.querySelectorAll("#zmr-glossary-body tr")]
      .map((row) => {
        const value = (field) => glossaryInput(row, field)?.value || "";
        return {
          source: value("source").trim(),
          target: value("target").trim(),
          targetLanguage: value("targetLanguage").trim(),
          note: value("note").trim(),
          enabled: glossaryInput(row, "enabled")?.checked !== false,
          origin: "document-manual",
        };
      })
      .filter((entry) => entry.source && entry.target);
  },

  saveGlossary() {
    const item = this.selectedDocument();
    if (!item) {
      return;
    }
    const visible = this.readManualGlossary();
    const visibleSources = new Set(
      this.renderedGlossarySources,
    );
    const existing = editableGlossaryEntries(item);
    const manual = this.renderedGlossaryQuery
      ? [
          ...existing.filter(
            (entry) => !visibleSources.has(entry.source),
          ),
          ...visible,
        ]
      : visible;
    this.glossaryDirty = false;
    this.task.setDocumentGlossary(item.attachmentKey, manual, { replaceAI: true });
  },

  async importGlossary() {
    const picker = new FilePicker();
    picker.init(window, "导入术语表", picker.modeOpen);
    picker.appendFilter("术语表", "*.json; *.csv; *.tsv");
    picker.appendFilters(picker.filterAll);
    if ((await picker.show()) !== picker.returnOK) {
      return;
    }
    try {
      const text = await IOUtils.readUTF8(picker.file);
      const entries = normalizeGlossaryEntries(parseGlossaryText(text, picker.file));
      for (const entry of entries.reverse()) {
        document.getElementById("zmr-glossary-body").prepend(this.createGlossaryRow(entry));
      }
      this.glossaryDirty = true;
      this.saveGlossary();
    } catch (error) {
      Services.prompt.alert(window, "导入术语表失败", error.message || String(error));
    }
  },

  async exportGlossary() {
    const item = this.selectedDocument();
    if (!item) {
      return;
    }
    const picker = new FilePicker();
    picker.init(window, "导出术语表", picker.modeSave);
    picker.appendFilter("术语表", "*.json; *.csv; *.tsv");
    picker.defaultString = `${item.attachmentKey}-glossary.json`;
    const result = await picker.show();
    if (result !== picker.returnOK && result !== picker.returnReplace) {
      return;
    }
    const entries = [
      ...this.readManualGlossary(),
      ...(item.glossary?.ai || []),
    ];
    await IOUtils.writeUTF8(picker.file, serializeGlossaryEntries(entries, picker.file));
  },

  renderLogs() {
    const list = document.getElementById("zmr-task-log");
    list.replaceChildren();
    for (const entry of this.snapshot?.logs || []) {
      const item = htmlElement("li");
      item.dataset.level = entry.level;
      item.textContent = xmlSafeText(
        `${new Date(entry.at).toLocaleTimeString()} ${entry.message}`,
      );
      list.appendChild(item);
    }
  },

  onClose(event) {
    if (this.glossaryDirty) {
      this.saveGlossary();
    }
    if (this.allowClose || !this.task || this.task.isFinished()) {
      return true;
    }
    const choice = Services.prompt.confirmEx(
      window,
      "全文翻译仍在运行",
      "关闭窗口后可让任务在后台继续，也可以取消任务。已完成的译文都会保留。",
      Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING +
        Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_CANCEL +
        Services.prompt.BUTTON_POS_2 * Services.prompt.BUTTON_TITLE_IS_STRING,
      "后台继续",
      null,
      "取消任务",
      null,
      {},
    );
    if (choice === 0) {
      this.allowClose = true;
      return true;
    }
    if (choice === 2) {
      this.task.cancel();
      this.allowClose = true;
      return true;
    }
    event.preventDefault();
    return false;
  },
};

function parseGlossaryText(text, path = "") {
  const source = String(text || "").trim();
  if (!source) {
    return [];
  }
  if (/\.json$/i.test(path) || source.startsWith("[") || source.startsWith("{")) {
    const parsed = JSON.parse(source);
    return Array.isArray(parsed) ? parsed : parsed.entries || [];
  }
  const separator = /\.tsv$/i.test(path) ? "\t" : ",";
  const rows = parseDelimitedText(source, separator);
  const headers = rows.shift().map((value) => value.trim());
  return rows.map((row) =>
    Object.fromEntries(headers.map((header, index) => [header, row[index] || ""])),
  );
}

function parseDelimitedText(text, separator) {
  const rows = [];
  let values = [];
  let value = "";
  let quoted = false;
  const source = String(text || "");
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        value += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (character === separator && !quoted) {
      values.push(value);
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && source[index + 1] === "\n") {
        index++;
      }
      values.push(value);
      if (values.some((item) => item !== "")) {
        rows.push(values);
      }
      values = [];
      value = "";
    } else {
      value += character;
    }
  }
  values.push(value);
  if (values.some((item) => item !== "")) {
    rows.push(values);
  }
  return rows;
}

function serializeGlossaryEntries(entries, path = "") {
  const fields = ["source", "target", "targetLanguage", "note", "enabled"];
  const normalized = normalizeGlossaryEntries(entries).map((entry) =>
    Object.fromEntries(fields.map((field) => [field, entry[field]])),
  );
  if (/\.csv$/i.test(path) || /\.tsv$/i.test(path)) {
    const separator = /\.tsv$/i.test(path) ? "\t" : ",";
    const escape = (value) => {
      const text = String(value ?? "");
      return text.includes(separator) || /["\r\n]/.test(text)
        ? `"${text.replace(/"/g, '""')}"`
        : text;
    };
    return `${[
      fields.join(separator),
      ...normalized.map((entry) =>
        fields.map((field) => escape(entry[field])).join(separator),
      ),
    ].join("\n")}\n`;
  }
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

function normalizeGlossaryEntries(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => ({
      source: String(entry?.source || "").trim(),
      target: String(entry?.target || "").trim(),
      targetLanguage: String(entry?.targetLanguage || "").trim(),
      note: String(entry?.note || "").trim(),
      enabled: entry?.enabled !== false && String(entry?.enabled) !== "false",
      origin: "document-manual",
    }))
    .filter((entry) => entry.source && entry.target);
}

function htmlElement(tagName) {
  return document.createElementNS("http://www.w3.org/1999/xhtml", tagName);
}

function glossaryInput(row, field) {
  return [...row.querySelectorAll("input")].find((input) => input._zmrField === field);
}

function editableGlossaryEntries(documentItem) {
  const entries = new Map();
  for (const entry of [
    ...(documentItem?.glossary?.ai || []),
    ...(documentItem?.glossary?.manual || []),
  ]) {
    const source = String(entry?.source || "").trim();
    if (source) {
      entries.set(source.toLocaleLowerCase(), entry);
    }
  }
  return [...entries.values()];
}

function xmlSafeText(value) {
  return Array.from(String(value ?? ""))
    .map((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint === 0x9 ||
        codePoint === 0xa ||
        codePoint === 0xd ||
        (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
        (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
        (codePoint >= 0x10000 && codePoint <= 0x10ffff)
        ? character
        : "\ufffd";
    })
    .join("");
}
