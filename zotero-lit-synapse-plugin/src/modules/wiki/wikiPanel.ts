import { config } from "../../../package.json";
import { evidenceOverviewLabel } from "./wikiEvidenceOverview";
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
import {
  button,
  clickable,
  commandBlock,
  describeError,
  element,
  jumpToItem,
  labelFor,
  section,
  shorten,
} from "./wikiDom";
import {
  buildConceptEdges,
  conceptEdgeLabel,
  conceptEdgeStrength,
} from "./wikiConceptEdges";
import { assignDocumentGroups } from "./wikiGraphGroups";
import { aggregateDocumentLinks } from "./wikiGraphLinks";
import { renderGraphLinkDetails, type LinkFacts } from "./wikiGraphDetails";
import { rowColumn } from "./wikiRow";
import { createWikiTermsView } from "./wikiTermsView";
import type { WikiTermRecord } from "./wikiConceptTerms";
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
declare const ChromeUtils: any;
declare let ztoolkit: ZToolkit;

const BUTTON_ID = "zotero-lit-synapse-wiki-button";
const PANEL_ID = "zotero-lit-synapse-wiki-panel";
const STYLE_ID = "zotero-lit-synapse-wiki-style";
const TAB_TYPE = "zotero-lit-synapse-wiki";
const TAB_TITLE = "LLM 知识库";
/**
 * Zotero paints every tab icon as `.icon-item-type[data-item-type=…]`, filled
 * in from `tab.data.icon`. Claiming an item type of our own lets wikiPanel.css
 * paint the plugin icon there instead of the blank document Zotero falls back
 * to for tab types it does not know.
 */
const TAB_ICON = "zotero-lit-synapse-wiki";

/** The three panes the header switches between. */
type WikiView = "entries" | "graph" | "terms";

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
 * The three kinds of relation the knowledge space draws between two documents.
 *
 * A solid link is the strong one: some claim cites both papers as evidence.
 * A dashed link is weaker: they only appear under the same knowledge entry.
 * A dot-dash link is weaker still and comes from somewhere else entirely -
 * both papers were read to use the same concept, recorded in
 * `wiki_concept_term_sources` while reading rather than derived from any
 * claim. It is the only one of the three that can exist before a claim spans
 * two papers, which is exactly the state a young Wiki is in.
 *
 * They are toggled separately because the weaker sets are much larger and are
 * context rather than argument.
 */
const GRAPH_LINK_FILTERS: Array<{
  style: GraphLinkStyle;
  label: string;
  title: string;
}> = [
  {
    style: "solid",
    label: "共享论断",
    title: "显示或隐藏以共享论断为主的连线（包括存在分歧）",
  },
  { style: "comparison", label: "论断关系", title: "方法扩展、适用限制和可比较差异" },
  {
    style: "dashed",
    label: "同一条目",
    title: "显示或隐藏同属一个知识条目的连线",
  },
  {
    style: "dotdash",
    label: "共享概念",
    title: "显示或隐藏两篇文献都用到同一概念的连线",
  },
  {
    style: "dotted",
    label: "候选连接",
    title: "显示或隐藏尚未结算的跨文献候选连接",
  },
];

/** A page cited by more documents than this contributes no dashed clique. */
const SAME_PAGE_CLIQUE_LIMIT = 40;

/**
 * A concept read out of more documents than this draws no dot-dash edges.
 *
 * Not a rarity judgement - IDF already handles that, and a common concept
 * still deserves a faint edge. This is the combinatorial guard: a concept
 * behind n documents proposes n(n-1)/2 pairs, so one term every paper in a
 * metallurgy library mentions turns the whole graph into a complete one at
 * around forty papers and there is nothing left to read. Above the limit the
 * concept still counts toward every document frequency and still appears in
 * the link detail; it just stops proposing pairs of its own.
 */
const CONCEPT_CLIQUE_LIMIT = 40;

/** Concepts named on a shared-concept edge before the rest become a count. */
const CONCEPT_EDGE_LABELS = 3;

/**
 * How many unsettled candidates one document may draw.
 *
 * The design's 6-8, at the top of the range. A candidate edge is the weakest
 * thing on the canvas and there can be one for every paper in the library, so
 * without a per-document cap the picture the strong edges make would be buried
 * under suggestions - which is the failure this whole feature is supposed to
 * avoid, arriving from the other direction.
 */
const CANDIDATE_NEIGHBOURS = 8;

/**
 * How many never-read papers may surface as ghosts at once.
 *
 * Ghosts are invitations to read, and an invitation list of ninety is not one.
 * Whatever does not fit is reported as a count in the graph hint rather than
 * drawn, so nothing is hidden - it is just not competing for the same pixels.
 */
const GHOST_NODES = 12;

/**
 * One unsettled cross-paper candidate, as the panel needs it.
 *
 * Flattened from the link store deliberately: the panel should not have to
 * know the difference between a candidate row, its signals and its
 * resolutions to draw one line.
 */
export interface GraphCandidate {
  linkId: number;
  aItemKey: string;
  bItemKey: string;
  scoreSymmetric: number | null;
  mustResolve: boolean;
  signals: Array<{
    signalId: number;
    signalType: string;
    score: number;
    termSnapshot: string;
    thisExcerpt: string;
    otherExcerpt: string;
    mustResolve: boolean;
  }>;
}

/**
 * What a candidate edge says on the canvas.
 *
 * A candidate with no readable label is not drawn at all, which is why this
 * may return the empty string. "Cosine 0.62" is not something a reader can
 * act on; neither is the bare word "candidate". A lexical or concept signal
 * carries its term, and a purely semantic one is described by its two
 * excerpts - truncated hard, because this is a tooltip, not the detail pane.
 */
function candidateLabel(candidate: GraphCandidate): string {
  const terms = Array.from(
    new Set(
      candidate.signals
        .map((signal) => signal.termSnapshot)
        .filter((term) => Boolean(term)),
    ),
  );
  if (terms.length) {
    return `候选连接：${terms.slice(0, CONCEPT_EDGE_LABELS).join("、")}`;
  }
  const excerpt = candidate.signals
    .map((signal) => signal.thisExcerpt || signal.otherExcerpt)
    .find((text) => Boolean(text));
  if (!excerpt) return "";
  const trimmed = excerpt.length > 40 ? `${excerpt.slice(0, 39)}…` : excerpt;
  return `候选连接：${trimmed}`;
}



/**
 * The delete drawer, in pixels.
 *
 * `DRAWER_WIDTH` is how far the index entry slides left, and therefore how
 * much of the drawer behind it is uncovered. `DRAG_SLOP` is the travel that
 * separates a click from a drag - below it the pointer is still selecting an
 * entry, not opening anything. `DRAWER_OPEN_THRESHOLD` is the travel that
 * latches the drawer open on release; a shorter drag springs back, so a
 * hesitant gesture never leaves a delete control sitting under the cursor.
 */
const DRAWER_WIDTH = 64;
const DRAG_SLOP = 6;
const DRAWER_OPEN_THRESHOLD = 34;

/**
 * The point of no return, stated before it is passed.
 *
 * Deleting a knowledge entry is physical and permanent, so the dialog reads
 * out what is about to be destroyed - the entry's name and how many claims and
 * evidence records go with it - rather than asking a bare yes/no question. The
 * counts come from the store's own deletion plan, not from what the panel
 * happens to have loaded, so they describe the delete that will actually run.
 *
 * Resolves `true` only when the user picks the destructive button. Escape, the
 * backdrop and the cancel button all resolve `false`, and a failure to read the
 * plan is shown in the dialog rather than swallowed.
 */
async function confirmPageDeletion(
  win: any,
  panel: HTMLElement,
  page: any,
  libraryID: number,
): Promise<boolean> {
  const doc: Document = win.document;
  let plan: {
    canonicalTitle: string;
    claims: number;
    evidence: number;
    concepts: number;
    aliases: number;
    relations: number;
  };
  try {
    plan = await getWikiService()
      .getStore()
      .describePageDeletion(page.pageId, libraryID);
  } catch (error) {
    ztoolkit.log("[wiki] could not describe a page deletion", error);
    win.alert(`无法读取该知识条目的删除范围：${describeError(error).message}`);
    return false;
  }

  const overlay = element(doc, "div", "zmp-wiki-modal-overlay");
  const dialog = element(doc, "div", "zmp-wiki-modal");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.append(
    element(doc, "h2", "zmp-wiki-modal-title", "删除知识条目"),
    element(doc, "p", "zmp-wiki-modal-name", plan.canonicalTitle),
  );

  const facts = element(doc, "div", "zmp-wiki-modal-facts");
  const fact = (label: string, value: string): void => {
    const rowNode = element(doc, "div", "zmp-wiki-modal-fact");
    rowNode.append(
      element(doc, "span", "zmp-wiki-modal-fact-label", label),
      element(doc, "span", "zmp-wiki-modal-fact-value", value),
    );
    facts.append(rowNode);
  };
  fact("论断（Claim）", `${plan.claims} 条`);
  fact("证据（Evidence）", `${plan.evidence} 条`);
  if (plan.concepts) {
    fact("术语与别名", `1 个术语 · ${plan.aliases} 个别名`);
    fact("概念关系", `${plan.relations} 条`);
  } else {
    fact("术语与别名", "保留（其他条目仍在使用该术语）");
  }
  dialog.append(facts);

  dialog.append(
    element(
      doc,
      "p",
      "zmp-wiki-modal-warning",
      "删除后不可恢复：以上内容将从知识库中彻底移除，无法撤销，也无法从回收站找回。其他知识条目不受影响。",
    ),
  );

  let settle: (confirmed: boolean) => void = () => undefined;
  const finish = (confirmed: boolean): void => {
    overlay.remove();
    settle(confirmed);
  };
  const actions = element(doc, "div", "zmp-wiki-modal-actions");
  const cancel = button(doc, "取消", "保留这个知识条目", "quiet");
  cancel.addEventListener("click", () => finish(false));
  const confirm = button(doc, "永久删除", "彻底删除这个知识条目", "danger");
  confirm.addEventListener("click", () => finish(true));
  actions.append(cancel, confirm);
  dialog.append(actions);

  overlay.addEventListener("click", (event: Event) => {
    if (event.target === overlay) finish(false);
  });
  overlay.addEventListener("keydown", (event: Event) => {
    if ((event as KeyboardEvent).key === "Escape") finish(false);
  });
  overlay.append(dialog);
  panel.append(overlay);
  cancel.focus?.();

  return new Promise<boolean>((resolve) => {
    settle = resolve;
  });
}

const GRAPH_HINT =
  "拖动旋转、滚轮缩放、Shift 拖动平移；点击文献查看它的全部知识点，点击连线查看两篇文献的共同结论。";


/**
 * Zotero's file picker.
 *
 * The class lives only in this module - there is no FilePicker hanging off the
 * `Zotero` object in Zotero 9 - and this is how Zotero's own export flows, and
 * this plugin's glossary import/export, reach it. Reaching for one on `Zotero`
 * instead throws "not a constructor" on every call, which is what used to send
 * the Wiki export straight into its clipboard fallback and made
 * "保存对话框不可用" the only outcome this button could produce.
 */
function createFilePicker(): any {
  const { FilePicker } = ChromeUtils.importESModule(
    "chrome://zotero/content/modules/filePicker.mjs",
  );
  return new FilePicker();
}

/**
 * Save the derived Wiki Markdown where the user chooses.
 *
 * Three outcomes, kept distinct because conflating them is what made this
 * unusable:
 *
 *   - the user picks a path, new or existing. `returnReplace` is the code for
 *     "existing file, overwrite confirmed", and it means save, exactly as it
 *     does in every save dialog Zotero itself drives. Treating only
 *     `returnOK` as success silently discards every overwrite.
 *   - the user cancels. Cancelling is an answer, not a fault: nothing is
 *     written, nothing is copied, nothing is announced.
 *   - something actually fails. Only a picker that cannot be loaded falls back
 *     to the clipboard, because then there is no other way to hand the text
 *     over. A write that fails is reported with its reason rather than
 *     papered over with a copy the user did not ask for.
 *
 * Never throws: it is called from a click handler, where a rejection would be
 * swallowed as an unhandled promise and the user would see nothing at all.
 */
async function saveMarkdown(
  win: any,
  options: {
    render: () => Promise<string>;
    dialogTitle: string;
    defaultName: string;
    clipboardMessage: string;
  },
): Promise<void> {
  let markdown: string;
  try {
    markdown = await options.render();
  } catch (error) {
    ztoolkit.log("[wiki] could not render the Wiki Markdown", error);
    Zotero.logError?.(error);
    win.alert(`导出失败：无法生成 Markdown（${describeError(error).message}）`);
    return;
  }

  let picker: any;
  try {
    picker = createFilePicker();
    picker.init(win, options.dialogTitle, picker.modeSave);
    picker.appendFilter("Markdown 文档", "*.md");
    // `defaultExtension` is what appends ".md" when the user types a bare
    // name; `defaultString` only seeds the field.
    picker.defaultString = options.defaultName;
    picker.defaultExtension = "md";
  } catch (error) {
    ztoolkit.log("[wiki] the Zotero file picker is unavailable", error);
    Zotero.logError?.(error);
    Zotero.Utilities.Internal.copyTextToClipboard(markdown);
    win.alert(options.clipboardMessage);
    return;
  }

  let target: string;
  try {
    const result = await picker.show();
    if (result !== picker.returnOK && result !== picker.returnReplace) return;
    target = String(picker.file || "");
    if (!target) throw new Error("文件选择器未返回可写路径");
  } catch (error) {
    ztoolkit.log("[wiki] the Wiki export dialog failed", error);
    Zotero.logError?.(error);
    win.alert(`导出失败：${describeError(error).message}`);
    return;
  }

  try {
    await IOUtils.writeUTF8(target, markdown);
  } catch (error) {
    ztoolkit.log("[wiki] could not write the Wiki Markdown", error);
    Zotero.logError?.(error);
    win.alert(
      `导出失败，文件未写入：${describeError(error).message}\n目标路径：${target}`,
    );
  }
}

/** The whole Wiki: pages, claims, evidence, and the concept library appendix. */
async function exportMarkdown(win: any, libraryID: number): Promise<void> {
  await saveMarkdown(win, {
    render: () => getWikiService().exportMarkdown(libraryID),
    dialogTitle: "导出 Zotero LLM 知识库",
    defaultName: "zotero-llm-wiki.md",
    clipboardMessage: "保存对话框不可用，Wiki Markdown 已复制到剪贴板。",
  });
}

/**
 * The concept library on its own.
 *
 * Same save path as the Wiki export, down to the Zotero 9 FilePicker
 * construction and the `returnReplace` handling - there is one implementation
 * of "save this Markdown where the user chooses", and both buttons use it.
 */
async function exportConceptLibrary(
  win: any,
  libraryID: number,
): Promise<void> {
  await saveMarkdown(win, {
    render: () => getWikiService().exportConceptsMarkdown(libraryID),
    dialogTitle: "导出 Zotero LLM 术语库",
    defaultName: "zotero-llm-concepts.md",
    clipboardMessage: "保存对话框不可用，术语库 Markdown 已复制到剪贴板。",
  });
}

function claimStatus(claim: any): string { return evidenceOverviewLabel(claim); }

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
  entry.setAttribute("class", "zotero-tb-button zotero-lit-synapse-wiki-toolbarbutton");
  entry.setAttribute(
    "image",
    `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`,
  );
  entry.setAttribute("tooltiptext", "打开 LLM 知识库");
  entry.addEventListener("click", () => void openWikiPanel(win));
  // Plugin buttons already registered in this toolbar keep their positions;
  // the Wiki entry belongs after them rather than claiming the far-left slot.
  toolbar.appendChild(entry);
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
  const render = openWikiTab(win, {
    type: TAB_TYPE,
    title: TAB_TITLE,
    icon: TAB_ICON,
  });
  await renderWikiPanel(win, render);
}

/**
 * Describe a thrown value without losing anything the log needs.
 *
 * The failure card shows the message; the stack goes into it too, because a
 * Wiki load failure is almost always a storage-layer fault whose call chain is
 * the only thing that identifies it.
 */

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
  const [pages, status, snapshot, conceptList] = await Promise.all([
    store.listPages(libraryID),
    store.getStatus(libraryID),
    store.getRetrievalSnapshot(libraryID, { includeEmbeddings: false }),
    service.listConcepts(libraryID),
  ]);
  const conceptEntities = new Map(
    conceptList.map((concept) => [concept.conceptId, concept]),
  );
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
  // Three views, one bar, in reading order: what the library knows, how it is
  // connected, and what it calls things. The two action buttons come after,
  // because they act on whichever view is open rather than switching to one.
  const entriesButton = button(doc, "知识条目", "查看知识条目与论断", "is-on");
  const graphButton = button(doc, "知识图谱", "在三维知识空间中查看文献关系");
  const termsButton = button(doc, "术语库", "查看独立的专业概念与术语");
  headerActions.append(
    entriesButton,
    graphButton,
    termsButton,
    exportButton,
    refresh,
  );
  header.append(headerActions);
  panel.append(header);

  // ---- Three columns -----------------------------------------------------
  const body = element(doc, "div", "zmp-wiki-body");
  const pageList = element(doc, "nav", "zmp-wiki-pages");
  pageList.id = "zotero-lit-synapse-wiki-pages";
  pageList.append(element(doc, "span", "zmp-wiki-column-title", "知识条目"));
  const claimsPane = element(doc, "main", "zmp-wiki-claims");
  claimsPane.id = "zotero-lit-synapse-wiki-claims";
  const evidencePane = element(doc, "aside", "zmp-wiki-evidence");
  evidencePane.id = "zotero-lit-synapse-wiki-evidence";
  body.append(pageList, claimsPane, evidencePane);
  panel.append(body);

  // ---- Knowledge space ---------------------------------------------------
  const graphPane = element(doc, "div", "zmp-wiki-graph-pane");
  graphPane.hidden = true;
  const graphStage = element(doc, "div", "zmp-wiki-graph-stage");
  const canvas = element(doc, "canvas", "zmp-wiki-graph");
  canvas.id = "zotero-lit-synapse-wiki-graph";
  const graphToolbar = element(doc, "div", "zmp-wiki-graph-toolbar");
  const graphTooltip = element(doc, "div", "zmp-wiki-graph-tooltip");
  graphTooltip.hidden = true;
  const graphLegend = element(doc, "div", "zmp-wiki-graph-legend");
  // The legend explains the links, because the nodes are all one thing now:
  // every sphere is a document, and its colour is the knowledge entry it
  // contributes most to.
  graphLegend.append(
    element(doc, "span", "legend-conflict", "存在分歧"),
    element(doc, "span", "legend-solid", "共享论断"),
    element(doc, "span", "legend-comparison", "方法差异或限定"),
    element(doc, "span", "legend-dashed", "同一条目"),
    element(doc, "span", "legend-dotdash", "共享概念"),
    element(doc, "span", "legend-dotted", "候选连接"),
  );
  graphStage.append(canvas, graphToolbar, graphLegend, graphTooltip);
  const graphDetails = element(doc, "div", "zmp-wiki-graph-details");
  graphPane.append(graphStage, graphDetails);
  panel.append(graphPane);

  // ---- Terminology -------------------------------------------------------
  const termsView = createWikiTermsView({
    win,
    doc,
    libraryID,
    store,
    reload: () => openWikiPanel(win),
  });
  panel.append(termsView.root);
  /** Which of the three panes is showing. Read by the export button. */
  let activeView: WikiView = "entries";

  container.querySelector(`#${PANEL_ID}`)?.remove();
  container.append(panel);

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
    const overview = claim.evidenceOverview;
    if (overview) {
      const assessmentLabels: Record<string,string> = { unverified: "未核验", complete: "完整支持", partial: "部分支持", overstated: "表述过度" };
      const independenceLabels: Record<string,string> = { unknown: "未核验", verified_independent: "已核验独立研究", same_study: "同一研究" };
      evidencePane.append(element(doc, "p", "", claimStatus(claim)),
        element(doc, "p", "", `命题支持：${assessmentLabels[overview.supportCompleteness]}；来源独立性：${independenceLabels[overview.independence]}`),
        element(doc, "p", "", `历史支持来源：${overview.historicalSupportingSources}；当前可访问支持来源：${overview.supportingSources}`));
      const legacy = element(doc, "details", "");
      legacy.append(element(doc, "summary", "", "旧版评分"),
        element(doc, "p", "", `启发式证据评分 ${claim.confidence}，非命题正确概率。规则：${overview.scoreVersion}。`));
      evidencePane.append(legacy);
      if (overview.assessment) evidencePane.append(element(doc, "p", "", `${overview.assessment.validity === "valid" ? "核验依据" : "待重新核验的历史依据"}：${overview.assessment.basis}`));
    }
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
      // Editing terminology lives in ONE place now - the terminology view -
      // rather than in two dialogs here that could only reach the flat name.
      // This button takes the reader there with this page's concept open.
      const openTerms = button(
        doc,
        "在术语库中编辑",
        "在术语库中查看并编辑这个概念的全部术语",
        "quiet",
      );
      openTerms.addEventListener("click", () => {
        openConceptInTerms(Number(page.primaryConceptId));
      });
      tools.append(openTerms);
    }
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
      // The same table the terminology view shows, read-only. Rendering the
      // structured terms here rather than a row of alias chips means the page
      // and the concept library can never describe a concept differently.
      const terms = section(doc, "术语与别名");
      const entity = conceptEntities.get(Number(page.primaryConceptId));
      const rows: WikiTermRecord[] = entity
        ? ([entity.primaryTerm, ...entity.aliasTerms].filter(
            Boolean,
          ) as WikiTermRecord[])
        : [];
      if (!rows.length) {
        terms.root.append(
          element(
            doc,
            "p",
            "zmp-wiki-alias-empty",
            `${String(concept.canonical_name)}（尚未登记结构化术语）`,
          ),
        );
      } else {
        const table = element(doc, "table", "zmp-wiki-term-table");
        const header = element(doc, "tr", "zmp-wiki-term-table-head");
        for (const column of ["序号", "中文术语", "英文术语", "简称"]) {
          header.append(element(doc, "th", "", column));
        }
        table.append(header);
        rows.forEach((term, index) => {
          const row = element(
            doc,
            "tr",
            `zmp-wiki-term-row-cells${term.role === "primary" ? " is-primary" : ""}`,
          );
          const number = element(
            doc,
            "td",
            "zmp-wiki-term-index",
            String(index + 1),
          );
          if (term.role === "primary") {
            number.append(element(doc, "span", "zmp-wiki-term-badge", "主"));
          }
          // Same per-field tints as the terminology view. A reader looking at
          // an entry should not have to switch views to find out which of its
          // names the papers themselves vouch for.
          const cell = (value: string, origin: string) =>
            element(
              doc,
              "td",
              `zmp-wiki-term-cell${value && origin ? ` origin-${origin}` : ""}`,
              value || "—",
            );
          row.append(
            number,
            cell(term.zh, term.origins.zh),
            cell(term.en, term.origins.en),
            cell(term.abbr, term.origins.abbr),
          );
          table.append(row);
        });
        terms.root.append(table);
      }
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
      const open = clickable(
        doc,
        "zmp-wiki-claim-open",
        `查看论断 ${claim.claimId} 的证据`,
      );
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
  /** The one index row whose delete drawer is currently open, if any. */
  let openDrawerRow: HTMLElement | null = null;
  let openDrawerEntry: HTMLElement | null = null;

  /** Slide every open drawer shut. Called whenever attention moves away. */
  const closeDrawers = (except?: HTMLElement): void => {
    if (!openDrawerRow || openDrawerRow === except) return;
    openDrawerRow.classList.remove("is-drawer-open");
    if (openDrawerEntry) openDrawerEntry.style.transform = "";
    openDrawerRow = null;
    openDrawerEntry = null;
  };

  // A click anywhere else in the panel puts the drawer back. Listening on the
  // panel rather than the document keeps this from outliving the render: the
  // panel is replaced wholesale on every refresh, and its listeners go with it.
  panel.addEventListener("mousedown", (event: Event) => {
    if (!openDrawerRow) return;
    const target = event.target as Node | null;
    if (target && openDrawerRow.contains?.(target)) return;
    closeDrawers();
  });
  panel.addEventListener("keydown", (event: Event) => {
    if ((event as KeyboardEvent).key === "Escape") closeDrawers();
  });

  for (const page of pages) {
    pagesById.set(page.pageId, page);
    // The row is the clipping frame: the drawer sits underneath it on the
    // right, and the entry slides left to uncover it. Nothing about the
    // delete action is visible - or reachable - until the user drags.
    const row = element(doc, "div", "zmp-wiki-page-row");
    const drawer = element(doc, "div", "zmp-wiki-page-drawer");
    const remove = element(doc, "button", "zmp-wiki-page-delete", "🗑");
    remove.type = "button";
    remove.title = "删除知识条目";
    remove.setAttribute("aria-label", `删除知识条目：${page.canonicalTitle}`);
    drawer.append(remove);

    const entry = clickable(doc, "zmp-wiki-page-entry", page.canonicalTitle);
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

    // ---- Drag left to reveal, anything else to put it back ---------------
    //
    // The gesture is tracked on the entry itself rather than on the document,
    // so the listeners die with the render and there is nothing to unhook.
    // `mouseleave` settles a drag that walks out of the row, which is easy to
    // do in a column this narrow.
    let dragOriginX: number | null = null;
    let dragOffset = 0;
    let dragged = false;
    const settle = (): void => {
      if (dragOriginX === null) return;
      dragOriginX = null;
      if (dragOffset <= -DRAWER_OPEN_THRESHOLD) {
        closeDrawers(row);
        row.classList.add("is-drawer-open");
        entry.style.transform = `translateX(${-DRAWER_WIDTH}px)`;
        openDrawerRow = row;
        openDrawerEntry = entry;
      } else {
        entry.style.transform = row.classList.contains("is-drawer-open")
          ? `translateX(${-DRAWER_WIDTH}px)`
          : "";
      }
      dragOffset = 0;
    };
    entry.addEventListener("mousedown", (event: Event) => {
      const mouse = event as MouseEvent;
      if (mouse.button !== 0) return;
      dragOriginX = mouse.clientX;
      dragOffset = 0;
      dragged = false;
    });
    entry.addEventListener("mousemove", (event: Event) => {
      if (dragOriginX === null) return;
      const mouse = event as MouseEvent;
      const delta = mouse.clientX - dragOriginX;
      if (!dragged && delta > -DRAG_SLOP) return;
      // Past the slop this is a drag, not a click: suppress the text selection
      // Gecko would otherwise start, and remember to swallow the click.
      dragged = true;
      event.preventDefault?.();
      dragOffset = Math.min(0, Math.max(-DRAWER_WIDTH, delta));
      entry.style.transform = `translateX(${dragOffset}px)`;
    });
    entry.addEventListener("mouseup", () => settle());
    entry.addEventListener("mouseleave", () => settle());
    // The same drawer, without a mouse. Delete opens it and puts focus on the
    // icon; it does not delete, so the gesture keeps both of its steps.
    entry.addEventListener("keydown", (event: Event) => {
      const key = (event as KeyboardEvent).key;
      if (key !== "Delete" && key !== "Backspace") return;
      event.preventDefault?.();
      closeDrawers(row);
      row.classList.add("is-drawer-open");
      entry.style.transform = `translateX(${-DRAWER_WIDTH}px)`;
      openDrawerRow = row;
      openDrawerEntry = entry;
      remove.focus?.();
    });
    entry.addEventListener("click", (event: Event) => {
      // The click that ends a drag must not also open the page, or every
      // reveal would double as a navigation.
      if (dragged) {
        dragged = false;
        event.stopPropagation?.();
        return;
      }
      if (openDrawerRow) {
        closeDrawers();
        return;
      }
      showPage(page, entry);
    });

    remove.addEventListener("click", async (event: Event) => {
      event.stopPropagation?.();
      const confirmed = await confirmPageDeletion(win, panel, page, libraryID);
      if (!confirmed) {
        closeDrawers();
        return;
      }
      try {
        await store.deletePage(page.pageId, libraryID);
      } catch (error) {
        // A delete that fails has rolled itself back, so the entry is still
        // there - and the user has to be told, or the drawer just springs shut
        // and the page looks deleted until the next refresh.
        ztoolkit.log("[wiki] deleting a knowledge entry failed", error);
        Zotero.logError?.(error);
        closeDrawers();
        win.alert(
          `删除失败，知识库未发生任何改动：${describeError(error).message}`,
        );
        return;
      }
      await openWikiPanel(win);
    });

    row.append(drawer, entry);
    pageList.append(row);
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
    /**
     * How much of it has been read.
     *
     * `ghost` is a document with no Wiki content at all, drawn only because a
     * candidate reached it. It is the one node kind that is NOT evidence of
     * anything the Wiki believes.
     */
    shade: "solid" | "half" | "ghost";
  }

  const documents = new Map<string, DocumentFacts>();

  /** Collect, per document, every claim that cites it and the role it plays. */
  const collectDocuments = (): void => {
    documents.clear();
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
                shade: "half",
              })
              .get(itemKey)!;
          facts.claims.push({ page, claim, roles: Array.from(roles) });
        }
      }
    }
    /*
     * Colour says which Claim this document distinctively carries.
     *
     * It used to say which Page the document contributed most Claims to, which
     * worked while a Wiki had five or six Pages - and one of this system's own
     * goals is to stop writers opening a Page per paper. Once that succeeded
     * the library held a single topic Page, every node took group 0, and the
     * colour channel collapsed to a constant. Fixing that by going back to a
     * Page per paper would be fixing the wrong thing; the answer is to let
     * colour describe the structure INSIDE the page. See wikiGraphGroups.
     */
    const grouped = assignDocumentGroups(
      Array.from(documents.values(), (facts) => ({
        itemKey: facts.itemKey,
        claimIds: facts.claims.map((entry) => Number(entry.claim.claimId)),
      })),
    );
    for (const [itemKey, group] of grouped) {
      const facts = documents.get(itemKey);
      if (facts) facts.group = group;
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


  const buildGraphData = (
    documentGraph: {
      nodes: Array<{
        itemKey: string;
        claimCount: number;
        conceptCount: number;
      }>;
      edges: Array<{
        source: string;
        target: string;
        strength: number;
        claimIds: number[];
        relations: string[];
      }>;
    },
    conceptSources: {
      documentCount: number;
      concepts: Array<{
        conceptId: number;
        name: string;
        df: number;
        idf: number;
        itemKeys: string[];
      }>;
    } | null,
    candidates: GraphCandidate[],
    claimRelations: any[] = [],
  ): GraphData => {
    const links: GraphLinkInput[] = [];
    const pairKey = (a: string, b: string) =>
      a < b ? `${a} ${b}` : `${b} ${a}`;

    // Solid: the two documents are cited by the same claim.
    for (const edge of documentGraph.edges) {
      if (!documents.has(edge.source) || !documents.has(edge.target)) continue;
      for (const claimId of edge.claimIds) {
      const claim = claimsById.get(claimId)?.claim;
      const has = (key: string, role: string) => claim?.evidence.some((e: any) => e.linkState === "valid" && e.itemKey === key && e.evidenceRole === role);
      const stances: Array<"support" | "conflict" | "context"> = [];
      if (has(edge.source, "SUPPORTS") && has(edge.target, "SUPPORTS")) stances.push("support");
      if ((has(edge.source, "SUPPORTS") && has(edge.target, "CONTRADICTS")) || (has(edge.target, "SUPPORTS") && has(edge.source, "CONTRADICTS"))) stances.push("conflict");
      if (!stances.length) stances.push("context");
      for (const stance of stances) {
      const conflict = stance === "conflict";
      links.push({
        source: `item:${edge.source}`,
        target: `item:${edge.target}`,
        style: "solid",
        tone: conflict
          ? "conflict"
          : "neutral",
        strength: 1,
        label: `${conflict ? "冲突" : stance === "support" ? "共同支持" : "共同引用"} · Claim ${claimId}`,
        payload: {
          kind: "shared-claim",
          stance,
          a: edge.source,
          b: edge.target,
          claimIds: [claimId],
        } satisfies LinkFacts,
      });
      }
      }
    }

    // Preserve shared entries in the details even when a stronger relation exists.
    // A page contributes one clique, so a page cited by very
    // many documents is skipped rather than burying the picture in hairlines.
    const dashedSeen = new Set<string>();
    for (const page of pages) {
      const keys = new Set<string>();
      for (const claim of page.claims) {
        for (const evidence of claim.evidence)
          if (evidence.linkState === "valid") keys.add(String(evidence.itemKey));
      }
      const ordered = Array.from(keys).filter((key) => documents.has(key));
      if (ordered.length > SAME_PAGE_CLIQUE_LIMIT) continue;
      for (let left = 0; left < ordered.length; left += 1) {
        for (let right = left + 1; right < ordered.length; right += 1) {
          const key = pairKey(ordered[left], ordered[right]);
          const membershipKey = `${key} ${page.pageId}`;
          if (dashedSeen.has(membershipKey)) continue;
          dashedSeen.add(membershipKey);
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
              claimIds: page.claims.filter((c: any) => c.evidence.some((e: any) => e.linkState === "valid" && [ordered[left], ordered[right]].includes(e.itemKey))).map((c: any) => c.claimId),
              pageId: page.pageId,
            } satisfies LinkFacts,
          });
        }
      }
    }

    /*
     * Dot-dash: both documents were read to use the same concept.
     *
     * The one edge kind that does not come from a claim. `wiki_relations`
     * joins concepts to concepts and `wiki_evidence` joins claims to sources,
     * so neither can produce a document-to-document edge from shared
     * terminology - but the source table has been recording, for every term,
     * which paper and which passage it was read out of, and two papers behind
     * one concept is a connection with the quotations already stored. Five
     * papers all discussing 不连续动态再结晶 drew five isolated nodes purely
     * because nothing read the table that way.
     *
     * The pairing, the rarity weighting and the combinatorial guard live in
     * wikiConceptEdges as pure functions, so the rule that one ubiquitous term
     * must not draw a complete graph is testable without a window.
     */
    for (const edge of buildConceptEdges(conceptSources?.concepts ?? [], {
      visibleDocuments: new Set(documents.keys()),
      // Keep concepts for the aggregate's details, including weaker relations.
      excludedPairs: new Set(),
      cliqueLimit: CONCEPT_CLIQUE_LIMIT,
    })) {
      const label = conceptEdgeLabel(edge, CONCEPT_EDGE_LABELS);
      // An unlabelled edge is a line the reader cannot act on. Every concept
      // has a name, so this only fires on a library whose names are blank.
      if (!label) continue;
      for (const concept of edge.concepts) {
      links.push({
        source: `item:${edge.a}`,
        target: `item:${edge.b}`,
        style: "dotdash",
        tone: "neutral",
        strength: conceptEdgeStrength(edge.score),
        label: concept.name,
        payload: {
          kind: "shared-concept",
          a: edge.a,
          b: edge.b,
          claimIds: [],
          concepts: [concept],
          conceptScore: edge.score,
        } satisfies LinkFacts,
      });
      }
    }

    /*
     * Dotted: a candidate nobody has settled yet.
     *
     * The weakest thing on the canvas, and the only kind that is not a
     * statement about what the Wiki believes. It says the server noticed a
     * resemblance - through representative passages, a shared rare term or a
     * shared concept - and that nobody has yet decided whether it means
     * anything. Drawn faint, drawn last, and capped per document, because a
     * library of five hundred papers can produce a candidate for almost every
     * pair and burying the settled edges under suggestions would be a worse
     * failure than the islands this feature exists to fix.
     *
     * Two rules keep it honest. A pair that already has a settled edge gets no
     * dotted line - one pair, one line, strongest wins. And a candidate with
     * no label is not drawn at all: "cosine 0.62" is not something a reader
     * can act on, so an edge that cannot say what it is about earns no pixels.
     */
    const drawnCandidates = new Map<string, number>();
    for (const candidate of candidates) {
      const aDrawn = drawnCandidates.get(candidate.aItemKey) ?? 0;
      const bDrawn = drawnCandidates.get(candidate.bItemKey) ?? 0;
      if (aDrawn >= CANDIDATE_NEIGHBOURS || bDrawn >= CANDIDATE_NEIGHBOURS) {
        continue;
      }
      if (!documents.has(candidate.aItemKey) || !documents.has(candidate.bItemKey)) {
        continue;
      }
      const label = candidateLabel(candidate);
      if (!label) continue;
      drawnCandidates.set(candidate.aItemKey, aDrawn + 1);
      drawnCandidates.set(candidate.bItemKey, bDrawn + 1);
      links.push({
        source: `item:${candidate.aItemKey}`,
        target: `item:${candidate.bItemKey}`,
        style: "dotted",
        tone: "neutral",
        // Width carries the symmetric score, which is what the pair's own
        // ranking is built on. Kept under 2 so no candidate outdraws a claim.
        strength: 1 + Math.min(1, Math.max(0, candidate.scoreSymmetric ?? 0)),
        label,
        payload: {
          kind: "candidate",
          a: candidate.aItemKey,
          b: candidate.bItemKey,
          claimIds: [],
          signals: candidate.signals,
          candidateScore: candidate.scoreSymmetric ?? undefined,
          mustResolve: candidate.mustResolve,
        } satisfies LinkFacts,
      });
    }

    for (const relation of claimRelations.filter((r: any) => r.validity === "valid")) {
      const left = relation.evidenceBindings.filter((e: any) => e.claimId === relation.sourceClaimId);
      const right = relation.evidenceBindings.filter((e: any) => e.claimId === relation.targetClaimId);
      const seen = new Set<string>();
      for (const a of left) for (const b of right) {
        const key = pairKey(a.itemKey, b.itemKey);
        if (a.itemKey === b.itemKey || seen.has(key) || !documents.has(a.itemKey) || !documents.has(b.itemKey)) continue;
        seen.add(key);
        const labels: Record<string,string> = { compares_with: "方法差异", qualifies_scope: "适用限制", extends_method: "方法扩展" };
        links.push({ source: `item:${a.itemKey}`, target: `item:${b.itemKey}`, style: "comparison", strength: 1,
          label: `${labels[relation.relationType]} · Claim ${relation.sourceClaimId} / ${relation.targetClaimId}`,
          payload: { kind: "claim-relation", a: a.itemKey, b: b.itemKey,
            claimIds: [relation.sourceClaimId, relation.targetClaimId], relation } satisfies LinkFacts });
      }
    }
    const aggregatedLinks = aggregateDocumentLinks(links, { pages, concepts: conceptSources?.concepts ?? [] });
    for (const facts of documents.values()) facts.degree = 0;
    for (const link of aggregatedLinks) {
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
        // Isolation and unreadness are now separate signals. A paper read in
        // full with no edges is a finding; a paper nobody opened is not.
        dim: facts.degree === 0 && facts.shade !== "ghost",
        shade: facts.shade,
        payload: { kind: "document", itemKey: facts.itemKey },
      }),
    );
    return { nodes, links: aggregatedLinks };
  };

  let graph: Graph3DController | null = null;
  let graphMode: GraphMode = "3d";
  let graphAutoRotate = false;
  /*
   * Seeded FROM the filter list, not from a second literal beside it.
   *
   * The two drifted the moment a third and fourth style were added: every
   * filter button is built `is-on`, but this set still held only solid and
   * dashed, so 共享概念 and 候选连接 rendered as enabled while
   * setVisibleLinkStyles hid them. The first click then ADDED the style, which
   * is why the lines appeared only after clicking a button that already
   * claimed to be on. Deriving the set from the same list the buttons come
   * from makes that class of drift impossible rather than fixed once.
   */
  const linkStyles = new Set<GraphLinkStyle>(
    GRAPH_LINK_FILTERS.map((filter) => filter.style),
  );
  let showIsolated = true;
  let documentGraph: Awaited<ReturnType<typeof store.getDocumentGraph>> | null =
    null;
  let conceptSources: Awaited<
    ReturnType<typeof store.getConceptDocumentSources>
  > | null = null;
  let graphCandidates: GraphCandidate[] = [];
  /** Never-read papers a candidate reached but that did not fit the canvas. */
  let hiddenGhosts = 0;

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
    showView("entries");
  };

  /** Open one concept in the terminology view, from anywhere in the panel. */
  const openConceptInTerms = (conceptId: number): void => {
    showView("terms");
    void termsView
      .refresh()
      .then(() => termsView.select(conceptId))
      .catch((error: unknown) => {
        ztoolkit.log("[wiki] could not open the concept library", error);
        Zotero.logError?.(error);
        win.alert(`术语库加载失败：${describeError(error).message}`);
      });
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
        const open = commandBlock(
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


  const onGraphNode = (node: GraphNodeInput | null) => {
    if (!node) {
      graphHint(GRAPH_HINT);
      return;
    }
    const payload = node.payload as any;
    if (payload?.kind === "document") describeDocument(String(payload.itemKey));
  };

  const onGraphLink = (link: GraphLinkInput) => {
    void renderGraphLinkDetails(graphDetails, link, {
      doc,
      documentTitle: key => documents.get(key)?.title ?? key,
      claim: id => claimsById.get(id),
      page: id => pagesById.get(id),
      openClaim: openClaimInReader,
      openConcept: openConceptInTerms,
      getConcept: async id => (await store.concepts()).get(id),
    }).catch(error => ztoolkit.log("[wiki] graph relationship details failed", error));
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
    graphAutoRotate = !graphAutoRotate;
    graph?.setAutoRotate(graphAutoRotate);
    rotateButton.className = `zmp-wiki-command ${graphAutoRotate ? "is-on" : "is-off"}`;
  });
  for (const filter of GRAPH_LINK_FILTERS) {
    const toggle = button(
      doc,
      filter.label,
      filter.title,
      linkStyles.has(filter.style) ? "is-on" : "is-off",
    );
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
  const reviewsButton = button(doc, "核验记录", "查看待核验、暂缓和历史关系记录");
  reviewsButton.addEventListener("click", () => {
    void (async () => {
      const reviewStore = await store.crossPaperReviews();
      let offset = 0;
      const render = async () => {
        const result = await reviewStore.list({ libraryID, offset, limit: 10 });
        graphDetails.replaceChildren(element(doc, "h2", "", "关系核验记录"));
        const labels: Record<string,string> = { pending: "待核验", reviewed: "已核验", deferred: "等待补充知识", superseded: "已被替代" };
        for (const task of result.items) {
          const section = element(doc, "section", "");
          section.append(element(doc, "h3", "", `${task.currentItemKey} / ${task.relatedItemKey}`),
            element(doc, "p", "", `${labels[task.state]} · 任务 ${task.taskId}${task.validity === "needs_revalidation" ? " · 依据已变化" : ""}`));
          for (const outcome of task.latestReview?.outcomes ?? []) {
            section.append(element(doc, "p", "", outcome.relation?.statement ?? outcome.gap ?? outcome.basis));
            for (const id of outcome.resultRefs?.claimIds ?? outcome.targetClaimIds ?? []) {
              const found = claimsById.get(Number(id));
              if (!found) continue;
              const open = commandBlock(doc, `Claim ${id}：${found.claim.claimText}`, `打开论断 ${id}`);
              open.addEventListener("click", () => openClaimInReader(found.page, found.claim));
              section.append(open);
            }
          }
          if (task.historyReviewIds.length) {
            const history = element(doc, "details", "");
            history.append(element(doc, "summary", "", `历史核验 ${task.historyReviewIds.length} 次`));
            for (const reviewId of task.historyReviewIds) {
              const previous = await reviewStore.review(reviewId);
              history.append(element(doc, "p", "", `记录 ${reviewId}：${previous?.outcomes.map((o:any) => o.basis).join("；")}`));
            }
            section.append(history);
          }
          graphDetails.append(section);
        }
        const previous = button(doc, "上一页", "上一页核验记录");
        previous.disabled = offset === 0;
        previous.addEventListener("click", () => { offset = Math.max(0, offset - 10); void render().catch(e => graphHint(describeError(e).message)); });
        const next = button(doc, "下一页", "下一页核验记录");
        next.disabled = result.nextOffset == null;
        next.addEventListener("click", () => { offset = result.nextOffset; void render().catch(e => graphHint(describeError(e).message)); });
        graphDetails.append(previous, next);
        if (offset === 0) for (const legacy of await reviewStore.auditLegacy(libraryID)) {
          if (legacy.validity !== "needs_revalidation") continue;
          graphDetails.append(element(doc, "h3", "", `历史异常 #${legacy.resolutionId}`),
            element(doc, "p", "", `${legacy.aItemKey} / ${legacy.bItemKey}：${legacy.reasons.join("；")}`),
            element(doc, "p", "", legacy.originalNote));
        }
      };
      await render();
    })().catch(error => graphHint(describeError(error).message));
  });
  graphToolbar.append(reviewsButton);

  /**
   * Unsettled candidates, flattened for the canvas.
   *
   * Best-effort by design. Candidates are suggestions ABOUT the Wiki; a link
   * table that cannot be read must cost the reader those suggestions and
   * nothing else, so a failure here draws the settled graph rather than an
   * error card.
   */
  const loadCandidates = async (): Promise<GraphCandidate[]> => {
    try {
      const links = await store.links();
      const candidates = await links.listCandidates(libraryID, ["open"]);
      // One query for every pair's signals, grouped and capped PER PAIR. The
      // previous version asked per paper with a shared budget, which silently
      // dropped most pairs and reduced the rest to their top-scoring type.
      const byLink = await links.pendingSignalsByLink(
        candidates.map((candidate) => candidate.linkId),
      );
      const flattened: GraphCandidate[] = [];
      for (const candidate of candidates) {
        const mine = byLink.get(candidate.linkId) ?? [];
        if (!mine.length) continue;
        flattened.push({
          linkId: candidate.linkId,
          aItemKey: candidate.aItemKey,
          bItemKey: candidate.bItemKey,
          scoreSymmetric: candidate.scoreSymmetric,
          // The panel does not recompute mustResolve: that rule reads the
          // reading ledger and belongs to WikiLinkService, and a second
          // implementation of it would eventually disagree with the first.
          mustResolve: false,
          signals: mine.map((signal) => ({
            signalId: signal.signalId,
            signalType: signal.signalType,
            score: signal.score,
            termSnapshot: signal.termSnapshot,
            thisExcerpt: signal.a.excerpt,
            otherExcerpt: signal.b.excerpt,
            mustResolve: false,
          })),
        });
      }
      return flattened;
    } catch (error) {
      ztoolkit.log("[wiki] link candidates unavailable for the graph", error);
      return [];
    }
  };

  const drawGraph = async () => {
    const [freshGraph, sources, readDepths, candidates, claimRelations] = await Promise.all([
      store.getDocumentGraph(libraryID),
      store.getConceptDocumentSources(libraryID),
      store.getDocumentReadDepths(libraryID),
      loadCandidates(),
      store.crossPaperReviews().then(reviews => reviews.relations(libraryID)),
    ]);
    documentGraph = freshGraph;
    conceptSources = sources;
    graphCandidates = candidates;
    collectDocuments();
    /*
     * Reading state, then ghosts.
     *
     * A node's shade says how much of the paper has been read, which is a
     * different question from how many edges it has. The two used to be
     * conflated into one grey: a paper read in full that genuinely connects to
     * nothing looked exactly like a paper nobody had opened, and those are
     * opposite findings.
     *
     * Ghosts are papers with no Wiki content at all, drawn only because a
     * candidate reached them. They are invitations to read - never evidence -
     * so they are capped hard and whatever does not fit is reported as a
     * count rather than silently dropped.
     */
    for (const facts of documents.values()) {
      facts.shade =
        readDepths.get(facts.itemKey) === "paper_reviewed" ? "solid" : "half";
    }
    /*
     * Ghosts follow the candidates that will actually be DRAWN.
     *
     * Adding one per candidate pair was wrong: the edge pass then drops edges
     * for three separate reasons - the per-document cap, the pair already
     * having a stronger edge, an unlabelable candidate - and every ghost whose
     * only edge was dropped became a node with no connections at all. A ghost
     * is an invitation to read a paper BECAUSE something reaches it; one that
     * nothing reaches is just an unexplained dot.
     *
     * So the set is capped first, then the edge pass is told which ghosts
     * exist, and it refuses to draw an edge to a ghost that did not make the
     * cut. The two now agree by construction rather than by coincidence.
     */
    hiddenGhosts = 0;
    const reachable = new Map<string, number>();
    for (const candidate of graphCandidates) {
      for (const itemKey of [candidate.aItemKey, candidate.bItemKey]) {
        if (documents.has(itemKey)) continue;
        const best = reachable.get(itemKey) ?? 0;
        reachable.set(
          itemKey,
          Math.max(best, candidate.scoreSymmetric ?? 0),
        );
      }
    }
    // Strongest first, so the ghosts that survive the cap are the ones most
    // worth reading rather than whichever the scan happened to write first.
    const ranked = Array.from(reachable.entries()).sort(
      (left, right) => right[1] - left[1],
    );
    for (const [itemKey] of ranked.slice(0, GHOST_NODES)) {
      documents.set(itemKey, {
        itemKey,
        title: itemKey,
        detail: "",
        claims: [],
        group: 0,
        degree: 0,
        shade: "ghost",
      });
    }
    hiddenGhosts = Math.max(0, ranked.length - GHOST_NODES);
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
    graph.setAutoRotate(graphAutoRotate);
    graph.setVisibleLinkStyles(Array.from(linkStyles));
    graph.setShowIsolated(showIsolated);
    graph.setData(
      buildGraphData(
        documentGraph ?? { nodes: [], edges: [] },
        conceptSources,
        graphCandidates,
        claimRelations,
      ),
    );
    graphHint(
      hiddenGhosts > 0
        ? `${GRAPH_HINT} 另有 ${hiddenGhosts} 篇尚未阅读的低相关候选文献未画出。`
        : GRAPH_HINT,
    );
  };

  // ---- One view at a time ------------------------------------------------
  //
  // The three views are mutually exclusive panes over one panel rather than
  // three tabs, so switching keeps everything each view had loaded: the graph
  // is not rebuilt, the open concept is still open, and the claim whose
  // evidence is showing is still showing.
  const showView = (next: WikiView): void => {
    body.hidden = next !== "entries";
    graphPane.hidden = next !== "graph";
    termsView.root.hidden = next !== "terms";
    activeView = next;
    for (const [view, control] of [
      ["entries", entriesButton],
      ["graph", graphButton],
      ["terms", termsButton],
    ] as Array<[WikiView, HTMLButtonElement]>) {
      control.className = `zmp-wiki-command ${view === next ? "is-on" : ""}`.trim();
    }
    graphAutoRotate = next === "graph";
    graph?.setAutoRotate(graphAutoRotate);
    rotateButton.className = `zmp-wiki-command ${graphAutoRotate ? "is-on" : "is-off"}`;
  };

  entriesButton.addEventListener("click", () => showView("entries"));
  graphButton.addEventListener("click", () => {
    showView("graph");
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
  termsButton.addEventListener("click", () => {
    showView("terms");
    void termsView.refresh().catch((error: unknown) => {
      ztoolkit.log("[wiki] failed to load the concept library", error);
      Zotero.logError?.(error);
      termsView.root.replaceChildren(
        element(doc, "h2", "", "术语库加载失败"),
        element(
          doc,
          "p",
          "zmp-wiki-error-message",
          describeError(error).message,
        ),
      );
    });
  });

  // The export button acts on whatever is open: the concept library in the
  // terminology view, the whole Wiki document anywhere else. One button, and
  // it always exports the thing the user is looking at.
  exportButton.addEventListener("click", () => {
    void (activeView === "terms"
      ? exportConceptLibrary(win, libraryID)
      : exportMarkdown(win, libraryID));
  });
}
