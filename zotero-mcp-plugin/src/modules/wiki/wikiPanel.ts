import { config } from "../../../package.json";
import { getVectorStore } from "../semantic/vectorStore";
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

function button(doc: Document, text: string, title: string): HTMLButtonElement {
  const node = element(doc, "button", "zmp-wiki-command", text);
  node.type = "button";
  node.title = title;
  return node;
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
  header.append(element(doc, "h1", "", TAB_TITLE));
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
  const header = element(doc, "header", "zmp-wiki-header");
  header.append(element(doc, "h1", "", TAB_TITLE));
  const statusText = element(
    doc,
    "span",
    "zmp-wiki-status",
    `${status.pages} 个页面 / ${status.claims} 条论断 / ${status.evidence} 条证据 / ${status.pendingRelink} 条等待重连`,
  );
  header.append(statusText);
  const headerActions = element(doc, "div", "zmp-wiki-header-actions");
  const refresh = button(doc, "刷新", "重新加载 Wiki 数据");
  refresh.addEventListener("click", () => void openWikiPanel(win));
  const exportButton = button(doc, "导出", "导出 Markdown 文档");
  exportButton.addEventListener(
    "click",
    () => void exportMarkdown(win, libraryID),
  );
  const graphButton = button(doc, "知识图谱", "显示文献知识图谱");
  headerActions.append(refresh, exportButton, graphButton);
  header.append(headerActions);
  panel.append(header);

  const body = element(doc, "div", "zmp-wiki-body");
  const pageList = element(doc, "nav", "zmp-wiki-pages");
  pageList.id = "zotero-mcp-wiki-pages";
  const claimsPane = element(doc, "main", "zmp-wiki-claims");
  claimsPane.id = "zotero-mcp-wiki-claims";
  const evidencePane = element(doc, "aside", "zmp-wiki-evidence");
  evidencePane.id = "zotero-mcp-wiki-evidence";
  body.append(pageList, claimsPane, evidencePane);
  panel.append(body);

  const graphPane = element(doc, "div", "zmp-wiki-graph-pane");
  graphPane.hidden = true;
  const canvas = element(doc, "canvas", "zmp-wiki-graph");
  canvas.id = "zotero-mcp-wiki-graph";
  canvas.width = 1100;
  canvas.height = 620;
  const graphDetails = element(doc, "div", "zmp-wiki-graph-details");
  graphPane.append(canvas, graphDetails);
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

  const showEvidence = (claim: any) => {
    evidencePane.replaceChildren();
    evidencePane.append(element(doc, "h2", "", `证据 / 论断 ${claim.claimId}`));
    evidencePane.append(
      element(doc, "p", "zmp-wiki-claim-text", claim.claimText),
    );
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
          "",
          labelFor(EVIDENCE_ROLE_LABELS, evidence.evidenceRole),
        ),
        element(
          doc,
          "span",
          "zmp-wiki-evidence-meta",
          `${labelFor(READ_DEPTH_LABELS, evidence.readDepth)} / ${labelFor(LINK_STATE_LABELS, evidence.linkState)}`,
        ),
        element(doc, "blockquote", "", evidence.excerpt),
      );
      const actions = element(doc, "div", "zmp-wiki-row-actions");
      const jump = button(doc, "打开文献", "在 Zotero 中选中来源文献");
      jump.addEventListener(
        "click",
        () => void jumpToItem(win, evidence.libraryID, evidence.itemKey),
      );
      const chunk = button(doc, "查看片段", "加载当前索引中的证据片段");
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
      evidencePane.append(row);
    }
  };

  const showPage = (page: any) => {
    claimsPane.replaceChildren();
    const titleRow = element(doc, "div", "zmp-wiki-page-title");
    titleRow.append(element(doc, "h2", "", page.canonicalTitle));
    const concept = concepts.get(page.primaryConceptId);
    if (concept) {
      const editTerm = button(doc, "编辑术语", "修改规范概念名称");
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
      const addAlias = button(doc, "添加别名", "添加中文、英文或缩写别名");
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
      titleRow.append(editTerm, addAlias);
    }
    const merge = button(doc, "合并页面", "将当前页面合并到另一个 Wiki 页面");
    merge.addEventListener("click", async () => {
      const target = Number(win.prompt("目标 Wiki 页面 ID", ""));
      if (!Number.isInteger(target) || target <= 0) return;
      await store.mergePages(page.pageId, target, libraryID);
      await openWikiPanel(win);
    });
    titleRow.append(merge);
    claimsPane.append(titleRow);
    if (page.summary)
      claimsPane.append(element(doc, "p", "zmp-wiki-summary", page.summary));
    if (concept) {
      const aliasBar = element(doc, "div", "zmp-wiki-aliases");
      aliasBar.append(
        element(doc, "span", "", `规范术语：${concept.canonical_name}`),
      );
      for (const alias of aliasesByConcept.get(page.primaryConceptId) ?? []) {
        const aliasButton = button(doc, String(alias.alias), "删除此别名");
        aliasButton.addEventListener("click", async () => {
          if (!win.confirm(`确定删除别名“${alias.alias}”吗？`)) return;
          await store.updateConcept({
            libraryID,
            conceptId: page.primaryConceptId,
            removeAliasIds: [Number(alias.alias_id)],
          });
          await openWikiPanel(win);
        });
        aliasBar.append(aliasButton);
      }
      claimsPane.append(aliasBar);
    }
    for (const claim of page.claims) {
      const row = element(doc, "article", "zmp-wiki-claim");
      const heading = element(doc, "button", "zmp-wiki-claim-open");
      heading.type = "button";
      heading.append(
        element(
          doc,
          "strong",
          "",
          labelFor(CLAIM_TYPE_LABELS, claim.claimType),
        ),
        element(doc, "span", "", claim.claimText),
        element(doc, "small", "", claimStatus(claim)),
      );
      heading.addEventListener("click", () => showEvidence(claim));
      const remove = button(doc, "删除论断", "删除不正确的论断");
      remove.classList.add("danger");
      remove.addEventListener("click", async () => {
        if (!win.confirm(`确定删除论断 ${claim.claimId} 吗？`)) return;
        await store.deleteClaim(claim.claimId, libraryID);
        await openWikiPanel(win);
      });
      row.append(heading, remove);
      claimsPane.append(row);
    }
  };

  for (const page of pages) {
    const entry = element(doc, "button", "zmp-wiki-page-entry");
    entry.type = "button";
    entry.append(
      element(doc, "strong", "", page.canonicalTitle),
      element(
        doc,
        "small",
        "",
        `${page.claims.length} 条论断 / 版本 ${page.version}`,
      ),
    );
    entry.addEventListener("click", () => showPage(page));
    pageList.append(entry);
  }
  if (pages[0]) showPage(pages[0]);
  else
    claimsPane.append(
      element(doc, "p", "zmp-wiki-empty", "暂无已保存的长期 Wiki 知识。"),
    );

  const drawGraph = async () => {
    const graph = await store.getDocumentGraph(libraryID);
    const context = canvas.getContext("2d") as CanvasRenderingContext2D | null;
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const radius = Math.min(canvas.width, canvas.height) * 0.36;
    const nodes = graph.nodes.map((node, index) => ({
      ...node,
      x:
        centerX +
        radius *
          Math.cos((index / Math.max(1, graph.nodes.length)) * Math.PI * 2),
      y:
        centerY +
        radius *
          Math.sin((index / Math.max(1, graph.nodes.length)) * Math.PI * 2),
      radius: Math.max(9, Math.min(22, 8 + node.claimCount * 2)),
    }));
    const byKey = new Map(nodes.map((node) => [node.itemKey, node]));
    context.lineCap = "round";
    for (const edge of graph.edges) {
      const source = byKey.get(edge.source);
      const target = byKey.get(edge.target);
      if (!source || !target) continue;
      context.beginPath();
      context.strokeStyle = edge.relations.includes("CONTRADICTS")
        ? "#c2413b"
        : "#73808f";
      context.lineWidth = Math.min(7, 1 + edge.strength);
      context.moveTo(source.x, source.y);
      context.lineTo(target.x, target.y);
      context.stroke();
    }
    for (const node of nodes) {
      context.beginPath();
      context.fillStyle = "#2f6f61";
      context.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "#20252b";
      context.font = "12px sans-serif";
      context.textAlign = "center";
      context.fillText(node.itemKey, node.x, node.y + node.radius + 16);
    }
    canvas.onclick = (rawEvent) => {
      const event = rawEvent as MouseEvent;
      const bounds = canvas.getBoundingClientRect();
      const x = ((event.clientX - bounds.left) / bounds.width) * canvas.width;
      const y = ((event.clientY - bounds.top) / bounds.height) * canvas.height;
      const node = nodes.find(
        (candidate) =>
          Math.hypot(candidate.x - x, candidate.y - y) <= candidate.radius + 5,
      );
      graphDetails.replaceChildren();
      if (node) {
        graphDetails.append(element(doc, "h2", "", node.itemKey));
        const relatedClaims = pages.flatMap((page) =>
          page.claims
            .filter((claim) =>
              claim.evidence.some(
                (evidence: any) => evidence.itemKey === node.itemKey,
              ),
            )
            .map((claim) => ({ page, claim })),
        );
        for (const { page, claim } of relatedClaims) {
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
          claimButton.addEventListener("click", () => showEvidence(claim));
          graphDetails.append(claimButton);
        }
        const open = button(doc, "打开文献", "在 Zotero 中选中此文献");
        open.addEventListener(
          "click",
          () => void jumpToItem(win, libraryID, node.itemKey),
        );
        graphDetails.append(open);
        return;
      }
      const edge = graph.edges.find((candidate) => {
        const source = byKey.get(candidate.source);
        const target = byKey.get(candidate.target);
        if (!source || !target) return false;
        const lengthSquared =
          (target.x - source.x) ** 2 + (target.y - source.y) ** 2;
        const t = Math.max(
          0,
          Math.min(
            1,
            ((x - source.x) * (target.x - source.x) +
              (y - source.y) * (target.y - source.y)) /
              lengthSquared,
          ),
        );
        return (
          Math.hypot(
            x - (source.x + t * (target.x - source.x)),
            y - (source.y + t * (target.y - source.y)),
          ) < 8
        );
      });
      if (edge) {
        graphDetails.append(
          element(doc, "h2", "", `${edge.source} 与 ${edge.target}`),
          element(
            doc,
            "p",
            "",
            `关联强度 ${edge.strength}；证据关系：${edge.relations.map(evidenceRelationLabel).join("、") || "共享论断"}`,
          ),
        );
        const sharedClaims = pages.flatMap((page) =>
          page.claims.filter((claim) => edge.claimIds.includes(claim.claimId)),
        );
        for (const claim of sharedClaims) {
          const claimButton = button(
            doc,
            claim.claimText,
            `查看论断 ${claim.claimId} 的跨论文证据`,
          );
          claimButton.addEventListener("click", () => showEvidence(claim));
          graphDetails.append(claimButton);
        }
      }
    };
  };

  graphButton.addEventListener("click", () => {
    const showing = !graphPane.hidden;
    graphPane.hidden = showing;
    body.hidden = !showing;
    if (showing) return;
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
