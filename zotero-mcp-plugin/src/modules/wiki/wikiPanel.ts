import { config } from "../../../package.json";
import { getVectorStore } from "../semantic/vectorStore";
import {
  createGraph3D,
  type GraphData,
  type GraphEdgeInput,
  type GraphMode,
  type GraphNodeInput,
  type GraphNodeKind,
  type Graph3DController,
} from "./graph3D";
import { rowColumn } from "./wikiRow";
import { getWikiService } from "./wikiService";
import {
  closeWikiTab,
  isCurrentWikiTabRender,
  openWikiTab,
  type WikiTabRender,
} from "./wikiTabManager";
import type {
  WikiClaimType,
  WikiCoverageLevel,
  WikiEpistemicStatus,
  WikiEvidenceRole,
  WikiLinkState,
  WikiReadDepth,
} from "./wikiTypes";

declare let Zotero: any;
declare let IOUtils: any;
declare let ztoolkit: ZToolkit;

const BUTTON_ID = "zotero-mcp-wiki-button";
const PANEL_ID = "zotero-mcp-wiki-panel";
const STYLE_ID = "zotero-mcp-wiki-style";
const TAB_TYPE = "zotero-mcp-wiki";
const TAB_TITLE = "LLM 知识库";

const CLAIM_TYPE_LABELS: Record<WikiClaimType, string> = {
  definition: "定义",
  mechanism: "机制",
  model: "模型",
  condition: "条件",
  comparison: "比较",
  limitation: "局限",
  consensus: "共识",
  conflict: "冲突",
};

const EPISTEMIC_STATUS_LABELS: Record<WikiEpistemicStatus, string> = {
  provisional: "暂定",
  supported: "已支持",
  corroborated: "已交叉印证",
  disputed: "有争议",
  unsupported: "未支持",
};

const READ_DEPTH_LABELS: Record<WikiReadDepth, string> = {
  chunk_local: "局部片段",
  section_read: "已读章节",
  paper_reviewed: "已审阅全文",
  cross_paper: "跨论文",
};

const COVERAGE_LEVEL_LABELS: Record<WikiCoverageLevel, string> = {
  ...READ_DEPTH_LABELS,
  partial: "部分",
  incomplete: "不完整",
};

const EVIDENCE_ROLE_LABELS: Record<WikiEvidenceRole, string> = {
  SUPPORTS: "支持",
  CONTRADICTS: "反驳",
  QUALIFIES: "限定",
  EXAMPLE: "示例",
};

const LINK_STATE_LABELS: Record<WikiLinkState, string> = {
  valid: "有效",
  pending_relink: "等待重连",
  stale: "已失效",
  source_deleted: "源文献已删除",
};

/** Evidence role -> the relation colour the knowledge space draws it in. */
const ROLE_EDGE_KIND: Record<WikiEvidenceRole, GraphEdgeInput["kind"]> = {
  SUPPORTS: "supports",
  CONTRADICTS: "contradicts",
  QUALIFIES: "related",
  EXAMPLE: "related",
};

const GRAPH_FILTERS: Array<{ kind: GraphNodeKind; label: string }> = [
  { kind: "page", label: "页面" },
  { kind: "claim", label: "论断" },
  { kind: "evidence", label: "证据" },
];

function labelFor<T extends string>(
  labels: Readonly<Record<T, string>>,
  value: unknown,
): string {
  return labels[value as T] ?? String(value);
}

function evidenceRelationLabel(relation: string): string {
  return relation
    .split("<->")
    .map((role) => labelFor(EVIDENCE_ROLE_LABELS, role))
    .join(" ↔ ");
}

function element<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(
  doc: Document,
  text: string,
  title: string,
  variant?: string,
): HTMLButtonElement {
  const node = element(
    doc,
    "button",
    variant ? `zmp-wiki-command ${variant}` : "zmp-wiki-command",
    text,
  );
  node.type = "button";
  node.title = title;
  return node;
}

/**
 * A section of the reading column: a labelled heading plus its body.
 *
 * The middle column used to be one undivided stack, which is why the summary,
 * the terms and the claims ran into each other. Every block now announces what
 * it is before its content starts.
 */
function section(
  doc: Document,
  title: string,
  count?: string,
): { root: HTMLElement; heading: HTMLElement } {
  const root = element(doc, "section", "zmp-wiki-section");
  const heading = element(doc, "h3", "zmp-wiki-section-title", title);
  if (count !== undefined) {
    heading.append(element(doc, "span", "zmp-wiki-section-count", count));
  }
  root.append(heading);
  return { root, heading };
}

/** One trimmed line for a graph label or tooltip. */
function shorten(text: string, limit: number): string {
  const flat = String(text).replace(/\s+/gu, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

async function jumpToItem(
  win: any,
  libraryID: number,
  itemKey: string,
): Promise<void> {
  const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, itemKey);
  if (!item) throw new Error(`Zotero 条目 ${libraryID}:${itemKey} 已不存在`);
  await win.ZoteroPane.selectItem(item.id);
}

async function exportMarkdown(win: any, libraryID: number): Promise<void> {
  const markdown = await getWikiService().exportMarkdown(libraryID);
  try {
    const picker = new Zotero.FilePicker();
    picker.init(win, "导出 Zotero LLM 知识库", picker.modeSave);
    picker.defaultString = "zotero-llm-wiki.md";
    picker.appendFilter("Markdown 文档", "*.md");
    if ((await picker.show()) === picker.returnOK) {
      const target =
        typeof picker.file === "string" ? picker.file : picker.file?.path;
      if (!target) throw new Error("文件选择器未返回可写路径");
      await IOUtils.writeUTF8(target, markdown);
      return;
    }
  } catch {
    // Older Zotero builds expose no FilePicker in plugin sandboxes. The panel
    // remains useful by opening the derived Markdown for manual saving.
  }
  Zotero.Utilities.Internal.copyTextToClipboard(markdown);
  win.alert("保存对话框不可用，Wiki Markdown 已复制到剪贴板。");
}

function claimStatus(claim: any): string {
  return `${labelFor(EPISTEMIC_STATUS_LABELS, claim.epistemicStatus)} / ${labelFor(COVERAGE_LEVEL_LABELS, claim.coverageLevel)} / 置信度 ${Math.round(claim.confidence * 100)}%`;
}

export function registerWikiPanel(win: _ZoteroTypes.MainWindow): void {
  unregisterWikiPanel(win as unknown as Window);
  const doc = win.document;
  const style = doc.createElement("link");
  style.id = STYLE_ID;
  style.rel = "stylesheet";
  style.href = `chrome://${config.addonRef}/content/wikiPanel.css?version=${config.addonVersion}`;
  doc.documentElement!.appendChild(style);

  const toolbar =
    doc.getElementById("zotero-toolbar") ||
    doc.getElementById("zotero-items-toolbar") ||
    doc.getElementById("zotero-tb-advanced-search")?.parentElement;
  if (!toolbar) return;
  const entry = doc.createXULElement("toolbarbutton");
  entry.id = BUTTON_ID;
  entry.setAttribute("class", "zotero-tb-button zotero-mcp-wiki-toolbarbutton");
  entry.setAttribute(
    "image",
    `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`,
  );
  entry.setAttribute("tooltiptext", "打开 LLM 知识库");
  entry.addEventListener("click", () => void openWikiPanel(win));
  toolbar.insertBefore(entry, toolbar.firstChild);
}

export function unregisterWikiPanel(win: Window): void {
  const mainWindow = win as _ZoteroTypes.MainWindow;
  closeWikiTab(mainWindow);
  const doc = win.document;
  doc.getElementById(BUTTON_ID)?.remove();
  doc.getElementById(PANEL_ID)?.remove();
  doc.getElementById(STYLE_ID)?.remove();
}

export async function openWikiPanel(
  win: _ZoteroTypes.MainWindow,
): Promise<void> {
  const render = openWikiTab(win, { type: TAB_TYPE, title: TAB_TITLE });
  await renderWikiPanel(win, render);
}

/**
 * Describe a thrown value without losing anything the log needs.
 *
 * The failure card shows the message; the stack goes into it too, because a
 * Wiki load failure is almost always a storage-layer fault whose call chain is
 * the only thing that identifies it.
 */
function describeError(error: unknown): { message: string; detail: string } {
  if (error instanceof Error) {
    return {
      message: error.message || String(error),
      detail: error.stack || `${error.name}: ${error.message}`,
    };
  }
  return { message: String(error), detail: String(error) };
}

/**
 * Replace the tab's contents with a legible failure card.
 *
 * The Wiki tab is opened before its data is loaded, so a load that throws used
 * to leave the tab mounted and empty - a blank page with the real error visible
 * only in the Debug Output. This renders the failure where the user is looking.
 */
function renderWikiPanelFailure(
  win: _ZoteroTypes.MainWindow,
  render: WikiTabRender,
  error: unknown,
): void {
  const doc = win.document;
  const container = render.tab.container;
  const { message, detail } = describeError(error);
  container.querySelector(`#${PANEL_ID}`)?.remove();
  const panel = element(doc, "section", "zmp-wiki-panel zmp-wiki-panel-error");
  panel.id = PANEL_ID;
  const header = element(doc, "header", "zmp-wiki-header");
  const brand = element(doc, "div", "zmp-wiki-brand");
  brand.append(element(doc, "h1", "", TAB_TITLE));
  header.append(brand);
  panel.append(header);
  const card = element(doc, "div", "zmp-wiki-error");
  card.append(
    element(doc, "h2", "", "知识库加载失败"),
    element(
      doc,
      "p",
      "zmp-wiki-error-message",
      `无法读取 Wiki 数据：${message}`,
    ),
    element(
      doc,
      "p",
      "zmp-wiki-error-hint",
      "本次失败发生在读取阶段，尚未写入任何数据；完整堆栈已记录到 Zotero 的调试输出与错误控制台。",
    ),
    element(doc, "pre", "zmp-wiki-error-detail", detail),
  );
  const retry = button(doc, "重试", "重新加载 Wiki 数据");
  retry.addEventListener("click", () => void openWikiPanel(win));
  card.append(retry);
  panel.append(card);
  container.append(panel);
}

/**
 * Render the Wiki tab, surfacing any failure instead of leaving a blank tab.
 *
 * The error is reported, never absorbed: it is logged in full through
 * `Zotero.logError` and `ztoolkit.log` and printed into the tab, so a storage
 * fault stays as visible as it was before this boundary existed.
 */
async function renderWikiPanel(
  win: _ZoteroTypes.MainWindow,
  render: WikiTabRender,
): Promise<void> {
  try {
    await renderWikiPanelContent(win, render);
  } catch (error) {
    ztoolkit.log("[wiki] failed to render the Wiki panel", error);
    Zotero.logError?.(error);
    if (!isCurrentWikiTabRender(render)) return;
    renderWikiPanelFailure(win, render, error);
  }
}

async function renderWikiPanelContent(
  win: _ZoteroTypes.MainWindow,
  render: WikiTabRender,
): Promise<void> {
  const doc = win.document;
  const container = render.tab.container;
  container.querySelector(`#${PANEL_ID}`)?.remove();
  const libraryID =
    (win.ZoteroPane as any).getSelectedLibraryID?.() ??
    Zotero.Libraries.userLibraryID;
  const service = getWikiService();
  const store = service.getStore();
  const [pages, status, snapshot] = await Promise.all([
    store.listPages(libraryID),
    store.getStatus(libraryID),
    store.getRetrievalSnapshot(libraryID),
  ]);
  if (!isCurrentWikiTabRender(render)) return;

  const panel = element(doc, "section", "zmp-wiki-panel");
  panel.id = PANEL_ID;

  // ---- Top bar -----------------------------------------------------------
  const header = element(doc, "header", "zmp-wiki-header");
  const brand = element(doc, "div", "zmp-wiki-brand");
  brand.append(element(doc, "h1", "", TAB_TITLE));
  const statusText = element(
    doc,
    "span",
    "zmp-wiki-status",
    `${status.pages} 个页面 / ${status.claims} 条论断 / ${status.evidence} 条证据 / ${status.pendingRelink} 条等待重连`,
  );
  brand.append(statusText);
  header.append(brand);
  const headerActions = element(doc, "div", "zmp-wiki-header-actions");
  const refresh = button(doc, "刷新", "重新加载 Wiki 数据");
  refresh.addEventListener("click", () => void openWikiPanel(win));
  const exportButton = button(doc, "导出", "导出 Markdown 文档");
  exportButton.addEventListener(
    "click",
    () => void exportMarkdown(win, libraryID),
  );
  const graphButton = button(doc, "知识图谱", "在三维知识空间中查看文献关系");
  headerActions.append(refresh, exportButton, graphButton);
  header.append(headerActions);
  panel.append(header);

  // ---- Three columns -----------------------------------------------------
  const body = element(doc, "div", "zmp-wiki-body");
  const pageList = element(doc, "nav", "zmp-wiki-pages");
  pageList.id = "zotero-mcp-wiki-pages";
  pageList.append(element(doc, "span", "zmp-wiki-column-title", "知识条目"));
  const claimsPane = element(doc, "main", "zmp-wiki-claims");
  claimsPane.id = "zotero-mcp-wiki-claims";
  const evidencePane = element(doc, "aside", "zmp-wiki-evidence");
  evidencePane.id = "zotero-mcp-wiki-evidence";
  body.append(pageList, claimsPane, evidencePane);
  panel.append(body);

  // ---- Knowledge space ---------------------------------------------------
  const graphPane = element(doc, "div", "zmp-wiki-graph-pane");
  graphPane.hidden = true;
  const graphStage = element(doc, "div", "zmp-wiki-graph-stage");
  const canvas = element(doc, "canvas", "zmp-wiki-graph");
  canvas.id = "zotero-mcp-wiki-graph";
  const graphToolbar = element(doc, "div", "zmp-wiki-graph-toolbar");
  const graphTooltip = element(doc, "div", "zmp-wiki-graph-tooltip");
  graphTooltip.hidden = true;
  const graphLegend = element(doc, "div", "zmp-wiki-graph-legend");
  graphLegend.append(
    element(doc, "span", "legend-page", "页面"),
    element(doc, "span", "legend-claim", "论断"),
    element(doc, "span", "legend-evidence", "文献证据"),
  );
  graphStage.append(canvas, graphToolbar, graphLegend, graphTooltip);
  const graphDetails = element(doc, "div", "zmp-wiki-graph-details");
  graphPane.append(graphStage, graphDetails);
  panel.append(graphPane);
  container.querySelector(`#${PANEL_ID}`)?.remove();
  container.append(panel);

  const aliasesByConcept = new Map<number, any[]>();
  for (const alias of snapshot.aliases) {
    const conceptId = Number(rowColumn(alias, "concept_id", "conceptId"));
    const list = aliasesByConcept.get(conceptId) ?? [];
    list.push(alias);
    aliasesByConcept.set(conceptId, list);
  }
  const concepts = new Map(
    snapshot.concepts.map((concept) => [
      Number(rowColumn(concept, "concept_id", "conceptId")),
      concept,
    ]),
  );

  /** The claim card currently mirrored in the evidence rail. */
  let activeClaimCard: HTMLElement | null = null;
  /** The index entry currently open in the reading column. */
  let activePageEntry: HTMLElement | null = null;

  const showEvidence = (claim: any, card?: HTMLElement) => {
    if (activeClaimCard && activeClaimCard !== card) {
      activeClaimCard.classList.remove("is-active");
    }
    if (card) {
      card.classList.add("is-active");
      activeClaimCard = card;
    }
    evidencePane.replaceChildren();
    const head = element(doc, "div", "zmp-wiki-evidence-head");
    head.append(element(doc, "h2", "", `证据 / 论断 ${claim.claimId}`));
    evidencePane.append(head);
    evidencePane.append(
      element(doc, "p", "zmp-wiki-evidence-claim", claim.claimText),
    );
    const list = element(doc, "div", "zmp-wiki-evidence-list");
    evidencePane.append(list);
    if (!claim.evidence.length) {
      list.append(
        element(doc, "p", "zmp-wiki-evidence-empty", "该论断暂无证据记录。"),
      );
      return;
    }
    for (const evidence of claim.evidence) {
      const row = element(
        doc,
        "article",
        `zmp-wiki-evidence-row role-${String(evidence.evidenceRole).toLowerCase()}`,
      );
      row.append(
        element(
          doc,
          "strong",
          "zmp-wiki-evidence-role",
          labelFor(EVIDENCE_ROLE_LABELS, evidence.evidenceRole),
        ),
        element(
          doc,
          "span",
          "zmp-wiki-evidence-meta",
          `${labelFor(READ_DEPTH_LABELS, evidence.readDepth)} · ${labelFor(LINK_STATE_LABELS, evidence.linkState)}`,
        ),
        element(doc, "blockquote", "", evidence.excerpt),
      );
      const actions = element(doc, "div", "zmp-wiki-row-actions");
      const jump = button(doc, "打开文献", "在 Zotero 中选中来源文献", "quiet");
      jump.addEventListener(
        "click",
        () => void jumpToItem(win, evidence.libraryID, evidence.itemKey),
      );
      const chunk = button(
        doc,
        "查看片段",
        "加载当前索引中的证据片段",
        "quiet",
      );
      chunk.addEventListener("click", async () => {
        const chunks = await getVectorStore().getChunksForItem(
          evidence.itemKey,
          evidence.libraryID,
        );
        const current = chunks.find(
          (candidate) => candidate.chunkId === evidence.chunkIdSnapshot,
        );
        const text = element(
          doc,
          "pre",
          "zmp-wiki-chunk",
          current?.text || "当前无法获取该片段。请在重建索引后重新验证 Wiki。",
        );
        row.append(text);
      });
      actions.append(jump, chunk);
      row.append(actions);
      list.append(row);
    }
  };

  const showPage = (page: any, entry?: HTMLElement) => {
    if (activePageEntry && activePageEntry !== entry) {
      activePageEntry.classList.remove("is-active");
      activePageEntry.setAttribute("aria-current", "false");
    }
    if (entry) {
      entry.classList.add("is-active");
      entry.setAttribute("aria-current", "true");
      activePageEntry = entry;
    }
    activeClaimCard = null;
    claimsPane.replaceChildren();
    const article = element(doc, "article", "zmp-wiki-doc");
    claimsPane.append(article);

    const titleRow = element(doc, "div", "zmp-wiki-page-title");
    titleRow.append(element(doc, "h2", "", page.canonicalTitle));
    const tools = element(doc, "div", "zmp-wiki-page-tools");
    const concept = concepts.get(page.primaryConceptId);
    if (concept) {
      const editTerm = button(doc, "编辑术语", "修改规范概念名称", "quiet");
      editTerm.addEventListener("click", async () => {
        const next = win.prompt("规范概念名称", concept.canonical_name);
        if (!next) return;
        await store.updateConcept({
          libraryID,
          conceptId: page.primaryConceptId,
          canonicalName: next,
        });
        await openWikiPanel(win);
      });
      const addAlias = button(
        doc,
        "添加别名",
        "添加中文、英文或缩写别名",
        "quiet",
      );
      addAlias.addEventListener("click", async () => {
        const alias = win.prompt("别名", "");
        if (!alias) return;
        const language = win.prompt("语言代码", "und") || "und";
        await store.updateConcept({
          libraryID,
          conceptId: page.primaryConceptId,
          addAliases: [{ alias, language, source: "user", confidence: 1 }],
        });
        await openWikiPanel(win);
      });
      tools.append(editTerm, addAlias);
    }
    const merge = button(
      doc,
      "合并页面",
      "将当前页面合并到另一个 Wiki 页面",
      "quiet",
    );
    merge.addEventListener("click", async () => {
      const target = Number(win.prompt("目标 Wiki 页面 ID", ""));
      if (!Number.isInteger(target) || target <= 0) return;
      await store.mergePages(page.pageId, target, libraryID);
      await openWikiPanel(win);
    });
    tools.append(merge);
    titleRow.append(tools);
    article.append(titleRow);

    if (page.summary) {
      const summary = section(doc, "知识摘要");
      const card = element(doc, "div", "zmp-wiki-summary-card");
      card.append(element(doc, "p", "zmp-wiki-summary", page.summary));
      summary.root.append(card);
      article.append(summary.root);
    }

    if (concept) {
      const terms = section(doc, "术语与别名");
      const grid = element(doc, "div", "zmp-wiki-terms");
      const canonicalRow = element(doc, "div", "zmp-wiki-term-row");
      canonicalRow.append(
        element(doc, "span", "zmp-wiki-term-label", "规范术语"),
        element(doc, "span", "zmp-wiki-term-value", concept.canonical_name),
      );
      grid.append(canonicalRow);
      const aliasRow = element(doc, "div", "zmp-wiki-term-row");
      aliasRow.append(element(doc, "span", "zmp-wiki-term-label", "别名"));
      const aliases = aliasesByConcept.get(page.primaryConceptId) ?? [];
      if (!aliases.length) {
        aliasRow.append(
          element(doc, "span", "zmp-wiki-alias-empty", "尚未登记别名"),
        );
      }
      for (const alias of aliases) {
        const aliasButton = element(
          doc,
          "button",
          "zmp-wiki-alias-chip",
          String(alias.alias),
        );
        aliasButton.type = "button";
        aliasButton.title = "删除此别名";
        aliasButton.addEventListener("click", async () => {
          if (!win.confirm(`确定删除别名“${alias.alias}”吗？`)) return;
          await store.updateConcept({
            libraryID,
            conceptId: page.primaryConceptId,
            removeAliasIds: [Number(alias.alias_id)],
          });
          await openWikiPanel(win);
        });
        aliasRow.append(aliasButton);
      }
      grid.append(aliasRow);
      terms.root.append(grid);
      article.append(terms.root);
    }

    const core = section(doc, "核心知识", `${page.claims.length} 条`);
    const claimList = element(doc, "div", "zmp-wiki-claim-list");
    core.root.append(claimList);
    article.append(core.root);

    for (const claim of page.claims) {
      // One claim, one self-contained card: its own rounded container, its own
      // spacing, and a height that follows its text. The old layout stacked
      // claims against a shared rule with no gap, which is what made long
      // passages read as one collapsed block.
      const card = element(doc, "article", "zmp-wiki-claim");
      const open = element(doc, "button", "zmp-wiki-claim-open");
      open.type = "button";
      open.title = `查看论断 ${claim.claimId} 的证据`;
      const head = element(doc, "div", "zmp-wiki-claim-head");
      head.append(
        element(
          doc,
          "span",
          "zmp-wiki-claim-type",
          labelFor(CLAIM_TYPE_LABELS, claim.claimType),
        ),
        element(doc, "span", "zmp-wiki-claim-id", `#${claim.claimId}`),
      );
      const meta = element(doc, "div", "zmp-wiki-claim-meta");
      meta.append(
        element(doc, "span", "", claimStatus(claim)),
        element(doc, "span", "", `${claim.evidence.length} 条证据`),
      );
      open.append(
        head,
        element(doc, "p", "zmp-wiki-claim-text", claim.claimText),
        meta,
      );
      open.addEventListener("click", () => showEvidence(claim, card));
      const remove = element(doc, "button", "zmp-wiki-claim-remove", "×");
      remove.type = "button";
      remove.title = "删除论断";
      remove.setAttribute("aria-label", `删除论断 ${claim.claimId}`);
      remove.addEventListener("click", async (event: Event) => {
        event.stopPropagation();
        if (!win.confirm(`确定删除论断 ${claim.claimId} 吗？`)) return;
        await store.deleteClaim(claim.claimId, libraryID);
        await openWikiPanel(win);
      });
      card.append(open, remove);
      claimList.append(card);
    }
    if (!page.claims.length) {
      claimList.append(
        element(doc, "p", "zmp-wiki-empty", "本页面还没有论断。"),
      );
    }
  };

  const pageEntries = new Map<number, HTMLElement>();
  const pagesById = new Map<number, any>();
  for (const page of pages) {
    pagesById.set(page.pageId, page);
    const entry = element(doc, "button", "zmp-wiki-page-entry");
    entry.type = "button";
    entry.setAttribute("aria-current", "false");
    entry.append(
      element(doc, "strong", "zmp-wiki-page-entry-title", page.canonicalTitle),
      element(
        doc,
        "small",
        "zmp-wiki-page-entry-meta",
        `${page.claims.length} 条论断 · 版本 ${page.version}`,
      ),
    );
    entry.addEventListener("click", () => showPage(page, entry));
    pageList.append(entry);
    pageEntries.set(page.pageId, entry);
  }
  if (pages[0]) showPage(pages[0], pageEntries.get(pages[0].pageId));
  else
    claimsPane.append(
      element(doc, "p", "zmp-wiki-empty", "暂无已保存的长期 Wiki 知识。"),
    );
  if (!pages.length) {
    evidencePane.append(
      element(doc, "p", "zmp-wiki-evidence-empty", "选中论断后在此查看证据。"),
    );
  }

  // ---- Knowledge space: data, controls, interaction ----------------------

  /**
   * Compose the three-layer space out of data the panel already holds.
   *
   * `getDocumentGraph` still supplies the cross-paper relations; Page and Claim
   * nodes are derived from the pages that are already loaded. Nothing new is
   * read from the store and no stored shape changes - this is a presentation
   * projection of the same Wiki records.
   *
   * The Evidence layer is one node per source document rather than one per
   * Evidence row: an Evidence record points at a Zotero item, and collapsing
   * them keeps the outer shell readable at library scale while preserving the
   * "open the literature" action each record exists for.
   */
  const buildGraphData = (documentGraph: {
    nodes: Array<{ itemKey: string; claimCount: number; conceptCount: number }>;
    edges: Array<{
      source: string;
      target: string;
      strength: number;
      claimIds: number[];
      relations: string[];
    }>;
  }): GraphData => {
    const nodes: GraphNodeInput[] = [];
    const edges: GraphEdgeInput[] = [];
    const itemWeights = new Map<string, number>();
    for (const node of documentGraph.nodes) {
      itemWeights.set(node.itemKey, node.claimCount);
    }
    for (const page of pages) {
      nodes.push({
        id: `page:${page.pageId}`,
        kind: "page",
        label: shorten(page.canonicalTitle, 40),
        detail: `${page.claims.length} 条论断 · 版本 ${page.version}`,
        weight: Math.max(1, page.claims.length),
        payload: { kind: "page", pageId: page.pageId },
      });
      for (const claim of page.claims) {
        const contested = claim.evidence.some(
          (evidence: any) => String(evidence.evidenceRole) === "CONTRADICTS",
        );
        nodes.push({
          id: `claim:${claim.claimId}`,
          kind: "claim",
          label: shorten(claim.claimText, 40),
          detail: `${labelFor(CLAIM_TYPE_LABELS, claim.claimType)} · ${labelFor(EPISTEMIC_STATUS_LABELS, claim.epistemicStatus)}`,
          weight: Math.max(1, claim.evidence.length),
          contested,
          payload: { kind: "claim", claimId: claim.claimId },
        });
        edges.push({
          source: `page:${page.pageId}`,
          target: `claim:${claim.claimId}`,
          kind: "structure",
          strength: 1,
        });
        const perItem = new Map<string, { role: string; count: number }>();
        for (const evidence of claim.evidence) {
          const key = String(evidence.itemKey);
          const seen = perItem.get(key);
          if (seen) seen.count += 1;
          else
            perItem.set(key, { role: String(evidence.evidenceRole), count: 1 });
          if (!itemWeights.has(key)) itemWeights.set(key, 0);
        }
        for (const [itemKey, info] of perItem) {
          edges.push({
            source: `claim:${claim.claimId}`,
            target: `item:${itemKey}`,
            kind: ROLE_EDGE_KIND[info.role as WikiEvidenceRole] ?? "related",
            strength: info.count,
          });
        }
      }
    }
    for (const [itemKey, weight] of itemWeights) {
      nodes.push({
        id: `item:${itemKey}`,
        kind: "evidence",
        label: itemKey,
        detail: `${weight} 条论断引用此文献`,
        weight: Math.max(1, weight),
        payload: { kind: "item", itemKey },
      });
    }
    for (const edge of documentGraph.edges) {
      edges.push({
        source: `item:${edge.source}`,
        target: `item:${edge.target}`,
        kind: edge.relations.includes("CONTRADICTS")
          ? "contradicts"
          : "related",
        strength: edge.strength,
      });
    }
    return { nodes, edges };
  };

  let graph: Graph3DController | null = null;
  let graphMode: GraphMode = "3d";
  const visibleKinds = new Set<GraphNodeKind>(["page", "claim", "evidence"]);
  let documentGraph: Awaited<ReturnType<typeof store.getDocumentGraph>> | null =
    null;

  const claimsById = new Map<number, { page: any; claim: any }>();
  for (const page of pages) {
    for (const claim of page.claims)
      claimsById.set(claim.claimId, { page, claim });
  }

  const graphHint = (text: string) => {
    graphDetails.replaceChildren(
      element(doc, "p", "zmp-wiki-graph-hint", text),
    );
  };

  /** Reveal the reading columns again, focused on whatever the user picked. */
  const returnToReading = () => {
    graphPane.hidden = true;
    body.hidden = false;
  };

  const describeItemNode = (itemKey: string) => {
    graphDetails.replaceChildren();
    graphDetails.append(element(doc, "h2", "", itemKey));
    const relations = (documentGraph?.edges ?? []).filter(
      (edge) => edge.source === itemKey || edge.target === itemKey,
    );
    if (relations.length) {
      graphDetails.append(
        element(
          doc,
          "p",
          "",
          `与 ${relations.length} 篇文献共享论断：${
            relations
              .map((edge) =>
                edge.relations.map(evidenceRelationLabel).join("、"),
              )
              .filter(Boolean)
              .join("；") || "共享论断"
          }`,
        ),
      );
    }
    const related = pages.flatMap((page) =>
      page.claims
        .filter((claim: any) =>
          claim.evidence.some((evidence: any) => evidence.itemKey === itemKey),
        )
        .map((claim: any) => ({ page, claim })),
    );
    for (const { page, claim } of related) {
      const concept =
        page.primaryConceptId == null
          ? undefined
          : concepts.get(page.primaryConceptId);
      graphDetails.append(
        element(
          doc,
          "small",
          "zmp-wiki-graph-context",
          `${page.canonicalTitle}${concept ? ` / ${concept.canonical_name}` : ""}`,
        ),
      );
      const claimButton = button(
        doc,
        claim.claimText,
        `打开论断 ${claim.claimId}`,
      );
      claimButton.addEventListener("click", () => {
        showPage(page, pageEntries.get(page.pageId));
        showEvidence(claim);
        returnToReading();
      });
      graphDetails.append(claimButton);
    }
    const open = button(doc, "打开文献", "在 Zotero 中选中此文献");
    open.addEventListener(
      "click",
      () => void jumpToItem(win, libraryID, itemKey),
    );
    graphDetails.append(open);
  };

  const onGraphSelect = (node: GraphNodeInput | null) => {
    if (!node) {
      graphHint("拖动旋转、滚轮缩放、Shift 拖动平移；点击节点查看关联知识。");
      return;
    }
    const payload = node.payload as any;
    if (payload?.kind === "page") {
      const page = pagesById.get(payload.pageId);
      if (!page) return;
      showPage(page, pageEntries.get(page.pageId));
      graphDetails.replaceChildren();
      graphDetails.append(element(doc, "h2", "", page.canonicalTitle));
      if (page.summary)
        graphDetails.append(element(doc, "p", "", page.summary));
      const openPage = button(doc, "在知识库中打开", "回到 Wiki 阅读视图");
      openPage.addEventListener("click", returnToReading);
      graphDetails.append(openPage);
      return;
    }
    if (payload?.kind === "claim") {
      const found = claimsById.get(payload.claimId);
      if (!found) return;
      showPage(found.page, pageEntries.get(found.page.pageId));
      showEvidence(found.claim);
      graphDetails.replaceChildren();
      graphDetails.append(
        element(doc, "h2", "", `论断 ${found.claim.claimId}`),
        element(doc, "p", "", found.claim.claimText),
        element(
          doc,
          "small",
          "zmp-wiki-graph-context",
          `${found.page.canonicalTitle} · ${claimStatus(found.claim)}`,
        ),
      );
      const openClaim = button(doc, "在知识库中打开", "回到 Wiki 阅读视图");
      openClaim.addEventListener("click", returnToReading);
      graphDetails.append(openClaim);
      return;
    }
    if (payload?.kind === "item") describeItemNode(String(payload.itemKey));
  };

  // ---- Graph toolbar -----------------------------------------------------
  const modeButton = button(doc, "3D", "在三维与平面视图之间切换", "is-on");
  const resetButton = button(doc, "重置视角", "回到默认视角与缩放");
  const rotateButton = button(doc, "自动旋转", "开启或关闭自动旋转", "is-off");
  graphToolbar.append(modeButton, resetButton, rotateButton);
  modeButton.addEventListener("click", () => {
    graphMode = graphMode === "3d" ? "2d" : "3d";
    modeButton.textContent = graphMode === "3d" ? "3D" : "2D";
    modeButton.className = `zmp-wiki-command ${graphMode === "3d" ? "is-on" : "is-off"}`;
    graph?.setMode(graphMode);
  });
  resetButton.addEventListener("click", () => graph?.resetView());
  rotateButton.addEventListener("click", () => {
    const next = !(graph?.isAutoRotate() ?? false);
    graph?.setAutoRotate(next);
    rotateButton.className = `zmp-wiki-command ${next ? "is-on" : "is-off"}`;
  });
  for (const filter of GRAPH_FILTERS) {
    const toggle = button(
      doc,
      filter.label,
      `显示或隐藏${filter.label}节点`,
      "is-on",
    );
    toggle.addEventListener("click", () => {
      if (visibleKinds.has(filter.kind)) visibleKinds.delete(filter.kind);
      else visibleKinds.add(filter.kind);
      toggle.className = `zmp-wiki-command ${visibleKinds.has(filter.kind) ? "is-on" : "is-off"}`;
      graph?.setVisibleKinds(Array.from(visibleKinds));
    });
    graphToolbar.append(toggle);
  }

  const drawGraph = async () => {
    documentGraph = await store.getDocumentGraph(libraryID);
    if (!graph) {
      graph = createGraph3D({
        win,
        canvas,
        tooltip: graphTooltip,
        onSelect: onGraphSelect,
      });
    }
    graph.setMode(graphMode);
    graph.setVisibleKinds(Array.from(visibleKinds));
    graph.setData(buildGraphData(documentGraph));
    graphHint("拖动旋转、滚轮缩放、Shift 拖动平移；点击节点查看关联知识。");
  };

  graphButton.addEventListener("click", () => {
    const showing = !graphPane.hidden;
    graphPane.hidden = showing;
    body.hidden = !showing;
    if (showing) {
      graph?.setAutoRotate(false);
      rotateButton.className = "zmp-wiki-command is-off";
      return;
    }
    void drawGraph().catch((error: unknown) => {
      ztoolkit.log("[wiki] failed to draw the document graph", error);
      Zotero.logError?.(error);
      graphDetails.replaceChildren(
        element(doc, "h2", "", "知识图谱加载失败"),
        element(
          doc,
          "p",
          "zmp-wiki-error-message",
          describeError(error).message,
        ),
      );
    });
  });
}
