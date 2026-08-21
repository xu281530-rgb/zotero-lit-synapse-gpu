import { config } from "../../../package.json";
import { getVectorStore } from "../semantic/vectorStore";
import {
  createGraph3D,
  type GraphData,
  type GraphLinkInput,
  type GraphLinkStyle,
  type GraphMode,
  type GraphNodeInput,
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

/**
 * Both kinds of relation the knowledge space draws between two documents.
 *
 * A solid link is the strong one: some claim cites both papers as evidence.
 * A dashed link is the weak one: they only appear under the same knowledge
 * entry. They are toggled separately because the dashed set is much larger
 * and is context rather than argument.
 */
const GRAPH_LINK_FILTERS: Array<{
  style: GraphLinkStyle;
  label: string;
  title: string;
}> = [
  {
    style: "solid",
    label: "共享论断",
    title: "显示或隐藏共享同一条论断的连线",
  },
  {
    style: "dashed",
    label: "同一条目",
    title: "显示或隐藏同属一个知识条目的连线",
  },
];

/** A page cited by more documents than this contributes no dashed clique. */
const SAME_PAGE_CLIQUE_LIMIT = 40;

const GRAPH_HINT =
  "拖动旋转、滚轮缩放、Shift 拖动平移；点击文献查看它的全部知识点，点击连线查看两篇文献的共同结论。";

function labelFor<T extends string>(
  labels: Readonly<Record<T, string>>,
  value: unknown,
): string {
  return labels[value as T] ?? String(value);
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
  // The legend explains the links, because the nodes are all one thing now:
  // every sphere is a document, and its colour is the knowledge entry it
  // contributes most to.
  graphLegend.append(
    element(doc, "span", "legend-solid", "共享论断"),
    element(doc, "span", "legend-dashed", "同一条目"),
    element(doc, "span", "legend-conflict", "存在分歧"),
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
      // The stack lives in a wrapper, never on the button itself: Gecko does
      // not honour display:grid on <button>, and drops the children into the
      // button's own anonymous box, where they lay out side by side and spill
      // out of the border box - the overlap this card was built to avoid.
      const openBody = element(doc, "span", "zmp-wiki-claim-body");
      openBody.append(
        head,
        element(doc, "p", "zmp-wiki-claim-text", claim.claimText),
        meta,
      );
      open.append(openBody);
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
    // Same wrapper rule as the claim card: the two rows stack inside a span,
    // because a <button> is not a grid container in Gecko.
    const entryBody = element(doc, "span", "zmp-wiki-entry-body");
    entryBody.append(
      element(doc, "strong", "zmp-wiki-page-entry-title", page.canonicalTitle),
      element(
        doc,
        "small",
        "zmp-wiki-page-entry-meta",
        `${page.claims.length} 条论断 · 版本 ${page.version}`,
      ),
    );
    entry.append(entryBody);
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
  // ---- Knowledge space: documents, relations, interaction ----------------

  /**
   * One node is one document; one link is a knowledge relation between two.
   *
   * Nothing new is read from the Wiki store: `getDocumentGraph` already
   * returns exactly this shape - a node per Zotero item and an edge carrying
   * the claim ids two items share - and the Page and Claim records the panel
   * has already loaded supply the titles, roles and grouping. This is a
   * projection of existing records, not a new query.
   */
  interface DocumentFacts {
    itemKey: string;
    title: string;
    detail: string;
    /** Every claim citing this document, with the role it plays there. */
    claims: Array<{ page: any; claim: any; roles: string[] }>;
    /** Wiki page this document contributes most claims to; drives its colour. */
    group: number;
    degree: number;
  }

  const documents = new Map<string, DocumentFacts>();
  const pageIndex = new Map<number, number>();
  pages.forEach((page: any, index: number) =>
    pageIndex.set(page.pageId, index),
  );

  /** Collect, per document, every claim that cites it and the role it plays. */
  const collectDocuments = (): void => {
    documents.clear();
    const groupVotes = new Map<string, Map<number, number>>();
    for (const page of pages) {
      for (const claim of page.claims) {
        const roleByItem = new Map<string, Set<string>>();
        for (const evidence of claim.evidence) {
          const key = String(evidence.itemKey);
          const roles = roleByItem.get(key) ?? new Set<string>();
          roles.add(String(evidence.evidenceRole));
          roleByItem.set(key, roles);
        }
        for (const [itemKey, roles] of roleByItem) {
          const facts =
            documents.get(itemKey) ??
            documents
              .set(itemKey, {
                itemKey,
                title: itemKey,
                detail: "",
                claims: [],
                group: 0,
                degree: 0,
              })
              .get(itemKey)!;
          facts.claims.push({ page, claim, roles: Array.from(roles) });
          const votes =
            groupVotes.get(itemKey) ??
            groupVotes.set(itemKey, new Map()).get(itemKey)!;
          votes.set(page.pageId, (votes.get(page.pageId) ?? 0) + 1);
        }
      }
    }
    for (const [itemKey, votes] of groupVotes) {
      let bestPage = -1;
      let bestCount = -1;
      for (const [pageId, count] of votes) {
        if (count > bestCount) {
          bestCount = count;
          bestPage = pageId;
        }
      }
      documents.get(itemKey)!.group = pageIndex.get(bestPage) ?? 0;
    }
  };

  /**
   * Name the documents from the Zotero library.
   *
   * An item key is not a name a reader recognises, so each node is labelled
   * with its title and described by its creator and year. The lookup is a
   * read; a key whose item has been deleted simply keeps the key as its label.
   */
  const nameDocuments = async (): Promise<void> => {
    await Promise.all(
      Array.from(documents.values()).map(async (facts) => {
        try {
          const item = await Zotero.Items.getByLibraryAndKeyAsync(
            libraryID,
            facts.itemKey,
          );
          if (!item) return;
          const title =
            item.getDisplayTitle?.() || item.getField?.("title") || "";
          if (title) facts.title = String(title);
          const creator = String(item.getField?.("firstCreator") ?? "");
          const year = String(item.getField?.("date") ?? "").slice(0, 4);
          facts.detail = [creator, year].filter(Boolean).join(" · ");
        } catch (error) {
          // The item is gone from the library; the key remains a usable label.
          ztoolkit.log("[wiki] could not name a graph document", error);
        }
      }),
    );
  };

  /** A link the reader can open: which two documents, and what they share. */
  interface LinkFacts {
    kind: "shared-claim" | "same-page";
    a: string;
    b: string;
    claimIds: number[];
    pageId?: number;
  }

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
    const links: GraphLinkInput[] = [];
    const pairKey = (a: string, b: string) =>
      a < b ? `${a} ${b}` : `${b} ${a}`;
    const solidPairs = new Set<string>();

    // Solid: the two documents are cited by the same claim.
    for (const edge of documentGraph.edges) {
      if (!documents.has(edge.source) || !documents.has(edge.target)) continue;
      solidPairs.add(pairKey(edge.source, edge.target));
      links.push({
        source: `item:${edge.source}`,
        target: `item:${edge.target}`,
        style: "solid",
        tone: edge.relations.some((relation) =>
          relation.includes("CONTRADICTS"),
        )
          ? "conflict"
          : "neutral",
        strength: Math.max(1, edge.claimIds.length || edge.strength),
        payload: {
          kind: "shared-claim",
          a: edge.source,
          b: edge.target,
          claimIds: edge.claimIds,
        } satisfies LinkFacts,
      });
    }

    // Dashed: the two documents sit under the same knowledge entry without
    // sharing a claim. A page contributes one clique, so a page cited by very
    // many documents is skipped rather than burying the picture in hairlines.
    const dashedSeen = new Set<string>();
    for (const page of pages) {
      const keys = new Set<string>();
      for (const claim of page.claims) {
        for (const evidence of claim.evidence)
          keys.add(String(evidence.itemKey));
      }
      const ordered = Array.from(keys).filter((key) => documents.has(key));
      if (ordered.length > SAME_PAGE_CLIQUE_LIMIT) continue;
      for (let left = 0; left < ordered.length; left += 1) {
        for (let right = left + 1; right < ordered.length; right += 1) {
          const key = pairKey(ordered[left], ordered[right]);
          if (solidPairs.has(key) || dashedSeen.has(key)) continue;
          dashedSeen.add(key);
          links.push({
            source: `item:${ordered[left]}`,
            target: `item:${ordered[right]}`,
            style: "dashed",
            tone: "neutral",
            strength: 1,
            payload: {
              kind: "same-page",
              a: ordered[left],
              b: ordered[right],
              claimIds: [],
              pageId: page.pageId,
            } satisfies LinkFacts,
          });
        }
      }
    }

    for (const facts of documents.values()) facts.degree = 0;
    for (const link of links) {
      const a = String(link.source).slice(5);
      const b = String(link.target).slice(5);
      const factsA = documents.get(a);
      const factsB = documents.get(b);
      if (factsA) factsA.degree += 1;
      if (factsB) factsB.degree += 1;
    }
    let maxDegree = 0;
    for (const facts of documents.values()) {
      maxDegree = Math.max(maxDegree, facts.degree);
    }

    const nodes: GraphNodeInput[] = Array.from(documents.values()).map(
      (facts) => ({
        id: `item:${facts.itemKey}`,
        label: facts.title,
        detail: [facts.detail, `${facts.claims.length} 条论断引用`]
          .filter(Boolean)
          .join(" · "),
        weight: Math.max(1, facts.claims.length),
        // The best-connected literature sits in the core, the loneliest at
        // the rim: depth carries how central a document is to the library.
        depth: maxDegree ? 1 - facts.degree / maxDegree : 1,
        group: facts.group,
        dim: facts.degree === 0,
        payload: { kind: "document", itemKey: facts.itemKey },
      }),
    );
    return { nodes, links };
  };

  let graph: Graph3DController | null = null;
  let graphMode: GraphMode = "3d";
  const linkStyles = new Set<GraphLinkStyle>(["solid", "dashed"]);
  let showIsolated = true;
  let documentGraph: Awaited<ReturnType<typeof store.getDocumentGraph>> | null =
    null;

  const claimsById = new Map<number, { page: any; claim: any }>();
  for (const page of pages) {
    for (const claim of page.claims) {
      claimsById.set(claim.claimId, { page, claim });
    }
  }

  const graphHint = (text: string) => {
    graphDetails.replaceChildren(
      element(doc, "p", "zmp-wiki-graph-hint", text),
    );
  };

  /** Reveal the reading columns again, focused on whatever the reader picked. */
  const returnToReading = () => {
    graphPane.hidden = true;
    body.hidden = false;
  };

  /** Open a claim in the Wiki reading view, evidence rail and all. */
  const openClaimInReader = (page: any, claim: any) => {
    showPage(page, pageEntries.get(page.pageId));
    showEvidence(claim);
    returnToReading();
  };

  const roleChip = (roles: string[]): HTMLElement => {
    const contested = roles.includes("CONTRADICTS");
    const chip = element(
      doc,
      "span",
      `zmp-wiki-role-chip${contested ? " is-conflict" : ""}`,
      roles.map((role) => labelFor(EVIDENCE_ROLE_LABELS, role)).join(" / "),
    );
    return chip;
  };

  /** Every knowledge point this document carries, grouped by knowledge entry. */
  const describeDocument = (itemKey: string) => {
    const facts = documents.get(itemKey);
    graphDetails.replaceChildren();
    if (!facts) {
      graphHint("该文献已不在知识库中。");
      return;
    }
    graphDetails.append(element(doc, "h2", "", facts.title));
    if (facts.detail) {
      graphDetails.append(
        element(doc, "small", "zmp-wiki-graph-context", facts.detail),
      );
    }
    const byPage = new Map<number, Array<(typeof facts.claims)[number]>>();
    for (const entry of facts.claims) {
      const list = byPage.get(entry.page.pageId) ?? [];
      list.push(entry);
      byPage.set(entry.page.pageId, list);
    }
    for (const [pageId, entries] of byPage) {
      const page = pagesById.get(pageId);
      graphDetails.append(
        element(
          doc,
          "small",
          "zmp-wiki-graph-context",
          `${page?.canonicalTitle ?? "未知条目"} · ${entries.length} 条`,
        ),
      );
      for (const entry of entries) {
        const row = element(doc, "div", "zmp-wiki-graph-claim");
        const head = element(doc, "div", "zmp-wiki-graph-claim-head");
        head.append(
          element(
            doc,
            "span",
            "zmp-wiki-claim-type",
            labelFor(CLAIM_TYPE_LABELS, entry.claim.claimType),
          ),
          roleChip(entry.roles),
        );
        const open = button(
          doc,
          entry.claim.claimText,
          `打开论断 ${entry.claim.claimId}`,
        );
        open.addEventListener("click", () =>
          openClaimInReader(entry.page, entry.claim),
        );
        row.append(head, open);
        graphDetails.append(row);
      }
    }
    const jump = button(doc, "打开文献", "在 Zotero 中选中此文献");
    jump.addEventListener(
      "click",
      () => void jumpToItem(win, libraryID, itemKey),
    );
    graphDetails.append(jump);
  };

  /** What two documents conclude in common - and where they disagree. */
  const describeLink = (facts: LinkFacts) => {
    const a = documents.get(facts.a);
    const b = documents.get(facts.b);
    graphDetails.replaceChildren();
    graphDetails.append(
      element(
        doc,
        "h2",
        "",
        `${a?.title ?? facts.a} ↔ ${b?.title ?? facts.b}`,
      ),
    );
    if (facts.kind === "same-page") {
      const page =
        facts.pageId == null ? undefined : pagesById.get(facts.pageId);
      graphDetails.append(
        element(
          doc,
          "p",
          "",
          `两篇文献同属知识条目「${page?.canonicalTitle ?? "未知"}」，但没有共享同一条论断。`,
        ),
      );
      return;
    }
    const rows = facts.claimIds
      .map((claimId) => {
        const found = claimsById.get(claimId);
        if (!found) return null;
        const rolesFor = (itemKey: string) =>
          Array.from(
            new Set(
              found.claim.evidence
                .filter((evidence: any) => evidence.itemKey === itemKey)
                .map((evidence: any) => String(evidence.evidenceRole)),
            ),
          ) as string[];
        const rolesA = rolesFor(facts.a);
        const rolesB = rolesFor(facts.b);
        const disputed =
          rolesA.includes("CONTRADICTS") !== rolesB.includes("CONTRADICTS");
        return { ...found, rolesA, rolesB, disputed };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
      // Where the two papers disagree is the interesting part; put it first.
      .sort((left, right) => Number(right.disputed) - Number(left.disputed));

    graphDetails.append(
      element(
        doc,
        "p",
        "",
        `共享 ${rows.length} 条论断，其中 ${rows.filter((row) => row.disputed).length} 条存在分歧。`,
      ),
    );
    for (const row of rows) {
      const card = element(
        doc,
        "div",
        `zmp-wiki-graph-claim${row.disputed ? " is-conflict" : ""}`,
      );
      const head = element(doc, "div", "zmp-wiki-graph-claim-head");
      head.append(
        element(
          doc,
          "span",
          "zmp-wiki-claim-type",
          labelFor(CLAIM_TYPE_LABELS, row.claim.claimType),
        ),
        element(
          doc,
          "small",
          "zmp-wiki-graph-context",
          row.page.canonicalTitle,
        ),
      );
      const open = button(
        doc,
        row.claim.claimText,
        `打开论断 ${row.claim.claimId}`,
      );
      open.addEventListener("click", () =>
        openClaimInReader(row.page, row.claim),
      );
      const stances = element(doc, "div", "zmp-wiki-graph-stances");
      const stanceRow = (title: string, roles: string[]) => {
        const line = element(doc, "div", "zmp-wiki-graph-stance");
        line.append(
          element(
            doc,
            "span",
            "zmp-wiki-graph-stance-name",
            shorten(title, 22),
          ),
          roleChip(roles.length ? roles : ["EXAMPLE"]),
        );
        return line;
      };
      stances.append(
        stanceRow(a?.title ?? facts.a, row.rolesA),
        stanceRow(b?.title ?? facts.b, row.rolesB),
      );
      card.append(head, open, stances);
      graphDetails.append(card);
    }
  };

  const onGraphNode = (node: GraphNodeInput | null) => {
    if (!node) {
      graphHint(GRAPH_HINT);
      return;
    }
    const payload = node.payload as any;
    if (payload?.kind === "document") describeDocument(String(payload.itemKey));
  };

  const onGraphLink = (link: GraphLinkInput) => {
    describeLink(link.payload as LinkFacts);
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
  for (const filter of GRAPH_LINK_FILTERS) {
    const toggle = button(doc, filter.label, filter.title, "is-on");
    toggle.addEventListener("click", () => {
      if (linkStyles.has(filter.style)) linkStyles.delete(filter.style);
      else linkStyles.add(filter.style);
      toggle.className = `zmp-wiki-command ${linkStyles.has(filter.style) ? "is-on" : "is-off"}`;
      graph?.setVisibleLinkStyles(Array.from(linkStyles));
    });
    graphToolbar.append(toggle);
  }
  const isolatedButton = button(
    doc,
    "孤立文献",
    "显示或隐藏没有任何关联的文献",
    "is-on",
  );
  isolatedButton.addEventListener("click", () => {
    showIsolated = !showIsolated;
    isolatedButton.className = `zmp-wiki-command ${showIsolated ? "is-on" : "is-off"}`;
    graph?.setShowIsolated(showIsolated);
  });
  graphToolbar.append(isolatedButton);

  const drawGraph = async () => {
    documentGraph = await store.getDocumentGraph(libraryID);
    collectDocuments();
    await nameDocuments();
    if (!graph) {
      graph = createGraph3D({
        win,
        canvas,
        tooltip: graphTooltip,
        onSelectNode: onGraphNode,
        onSelectLink: onGraphLink,
      });
    }
    graph.setMode(graphMode);
    graph.setVisibleLinkStyles(Array.from(linkStyles));
    graph.setShowIsolated(showIsolated);
    graph.setData(buildGraphData(documentGraph));
    graphHint(GRAPH_HINT);
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
