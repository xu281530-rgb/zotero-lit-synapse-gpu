import { config } from "../../../package.json";
import { getVectorStore } from "../semantic/vectorStore";
import { getWikiService } from "./wikiService";

declare let Zotero: any;
declare let IOUtils: any;

const BUTTON_ID = "zotero-mcp-wiki-button";
const PANEL_ID = "zotero-mcp-wiki-panel";
const STYLE_ID = "zotero-mcp-wiki-style";

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
  if (!item)
    throw new Error(`Zotero item ${libraryID}:${itemKey} no longer exists`);
  await win.ZoteroPane.selectItem(item.id);
}

async function exportMarkdown(win: any, libraryID: number): Promise<void> {
  const markdown = await getWikiService().exportMarkdown(libraryID);
  try {
    const picker = new Zotero.FilePicker();
    picker.init(win, "Export Zotero LLM Wiki", picker.modeSave);
    picker.defaultString = "zotero-llm-wiki.md";
    picker.appendFilter("Markdown", "*.md");
    if ((await picker.show()) === picker.returnOK) {
      const target =
        typeof picker.file === "string" ? picker.file : picker.file?.path;
      if (!target) throw new Error("The file picker returned no writable path");
      await IOUtils.writeUTF8(target, markdown);
      return;
    }
  } catch {
    // Older Zotero builds expose no FilePicker in plugin sandboxes. The panel
    // remains useful by opening the derived Markdown for manual saving.
  }
  Zotero.Utilities.Internal.copyTextToClipboard(markdown);
  win.alert(
    "Wiki Markdown was copied to the clipboard because the save dialog was unavailable.",
  );
}

function claimStatus(claim: any): string {
  return `${claim.epistemicStatus} / ${claim.coverageLevel} / ${Math.round(claim.confidence * 100)}%`;
}

export function registerWikiPanel(win: _ZoteroTypes.MainWindow): void {
  unregisterWikiPanel(win as unknown as Window);
  const doc = win.document;
  const style = doc.createElement("link");
  style.id = STYLE_ID;
  style.rel = "stylesheet";
  style.href = `chrome://${config.addonRef}/content/wikiPanel.css`;
  doc.documentElement!.appendChild(style);

  const toolbar =
    doc.getElementById("zotero-toolbar") ||
    doc.getElementById("zotero-items-toolbar") ||
    doc.getElementById("zotero-tb-advanced-search")?.parentElement;
  if (!toolbar) return;
  const entry = doc.createXULElement("toolbarbutton");
  entry.id = BUTTON_ID;
  entry.setAttribute("class", "zotero-mcp-wiki-toolbarbutton");
  entry.setAttribute(
    "image",
    `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`,
  );
  entry.setAttribute("tooltiptext", "LLM Wiki");
  entry.addEventListener("command", () => void openWikiPanel(win));
  toolbar.insertBefore(entry, toolbar.firstChild);
}

export function unregisterWikiPanel(win: Window): void {
  const doc = win.document;
  doc.getElementById(BUTTON_ID)?.remove();
  doc.getElementById(PANEL_ID)?.remove();
  doc.getElementById(STYLE_ID)?.remove();
}

export async function openWikiPanel(
  win: _ZoteroTypes.MainWindow,
): Promise<void> {
  const doc = win.document;
  doc.getElementById(PANEL_ID)?.remove();
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

  const panel = element(doc, "section", "zmp-wiki-panel");
  panel.id = PANEL_ID;
  const header = element(doc, "header", "zmp-wiki-header");
  header.append(element(doc, "h1", "", "LLM Wiki"));
  const statusText = element(
    doc,
    "span",
    "zmp-wiki-status",
    `${status.pages} pages / ${status.claims} claims / ${status.evidence} evidence / ${status.pendingRelink} pending`,
  );
  header.append(statusText);
  const headerActions = element(doc, "div", "zmp-wiki-header-actions");
  const refresh = button(doc, "Refresh", "Reload Wiki data");
  refresh.addEventListener("click", () => void openWikiPanel(win));
  const exportButton = button(doc, "Export", "Export Markdown");
  exportButton.addEventListener(
    "click",
    () => void exportMarkdown(win, libraryID),
  );
  const graphButton = button(doc, "Graph", "Show document knowledge graph");
  const close = button(doc, "x", "Close Wiki");
  close.classList.add("zmp-wiki-close");
  close.addEventListener("click", () => panel.remove());
  headerActions.append(refresh, exportButton, graphButton, close);
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
  doc.documentElement!.appendChild(panel);

  const aliasesByConcept = new Map<number, any[]>();
  for (const alias of snapshot.aliases) {
    const conceptId = Number(alias.concept_id ?? alias.conceptId);
    const list = aliasesByConcept.get(conceptId) ?? [];
    list.push(alias);
    aliasesByConcept.set(conceptId, list);
  }
  const concepts = new Map(
    snapshot.concepts.map((concept) => [
      Number(concept.concept_id ?? concept.conceptId),
      concept,
    ]),
  );

  const showEvidence = (claim: any) => {
    evidencePane.replaceChildren();
    evidencePane.append(
      element(doc, "h2", "", `Evidence / Claim ${claim.claimId}`),
    );
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
        element(doc, "strong", "", evidence.evidenceRole),
        element(
          doc,
          "span",
          "zmp-wiki-evidence-meta",
          `${evidence.readDepth} / ${evidence.linkState}`,
        ),
        element(doc, "blockquote", "", evidence.excerpt),
      );
      const actions = element(doc, "div", "zmp-wiki-row-actions");
      const jump = button(
        doc,
        "Open paper",
        "Select the source document in Zotero",
      );
      jump.addEventListener(
        "click",
        () => void jumpToItem(win, evidence.libraryID, evidence.itemKey),
      );
      const chunk = button(
        doc,
        "View chunk",
        "Load the current indexed evidence chunk",
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
          current?.text ||
            "Chunk is not currently available; run Wiki reverify after rebuilding the index.",
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
      const editTerm = button(
        doc,
        "Edit term",
        "Change the canonical concept name",
      );
      editTerm.addEventListener("click", async () => {
        const next = win.prompt(
          "Canonical concept name",
          concept.canonical_name,
        );
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
        "Add alias",
        "Add a Chinese, English, or abbreviation alias",
      );
      addAlias.addEventListener("click", async () => {
        const alias = win.prompt("Alias", "");
        if (!alias) return;
        const language = win.prompt("Language code", "und") || "und";
        await store.updateConcept({
          libraryID,
          conceptId: page.primaryConceptId,
          addAliases: [{ alias, language, source: "user", confidence: 1 }],
        });
        await openWikiPanel(win);
      });
      titleRow.append(editTerm, addAlias);
    }
    const merge = button(
      doc,
      "Merge",
      "Merge this page into another Wiki page",
    );
    merge.addEventListener("click", async () => {
      const target = Number(win.prompt("Target Wiki page ID", ""));
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
        element(doc, "span", "", `Canonical: ${concept.canonical_name}`),
      );
      for (const alias of aliasesByConcept.get(page.primaryConceptId) ?? []) {
        const aliasButton = button(
          doc,
          String(alias.alias),
          "Remove this alias",
        );
        aliasButton.addEventListener("click", async () => {
          if (!win.confirm(`Remove alias "${alias.alias}"?`)) return;
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
        element(doc, "strong", "", claim.claimType),
        element(doc, "span", "", claim.claimText),
        element(doc, "small", "", claimStatus(claim)),
      );
      heading.addEventListener("click", () => showEvidence(claim));
      const remove = button(doc, "Delete", "Delete an incorrect Claim");
      remove.classList.add("danger");
      remove.addEventListener("click", async () => {
        if (!win.confirm(`Delete Claim ${claim.claimId}?`)) return;
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
        `${page.claims.length} claims / v${page.version}`,
      ),
    );
    entry.addEventListener("click", () => showPage(page));
    pageList.append(entry);
  }
  if (pages[0]) showPage(pages[0]);
  else
    claimsPane.append(
      element(
        doc,
        "p",
        "zmp-wiki-empty",
        "No durable Wiki knowledge has been committed for this library.",
      ),
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
            `Open Claim ${claim.claimId}`,
          );
          claimButton.addEventListener("click", () => showEvidence(claim));
          graphDetails.append(claimButton);
        }
        const open = button(
          doc,
          "Open paper",
          "Select this document in Zotero",
        );
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
          element(doc, "h2", "", `${edge.source} - ${edge.target}`),
          element(
            doc,
            "p",
            "",
            `Strength ${edge.strength}; Evidence relations: ${edge.relations.join(", ") || "shared Claim"}`,
          ),
        );
        const sharedClaims = pages.flatMap((page) =>
          page.claims.filter((claim) => edge.claimIds.includes(claim.claimId)),
        );
        for (const claim of sharedClaims) {
          const claimButton = button(
            doc,
            claim.claimText,
            `View cross-paper Evidence for Claim ${claim.claimId}`,
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
    if (!showing) void drawGraph();
  });
}
