/**
 * The terminology view: the concept library as a reader sees it.
 *
 * Two columns, the same shape as the knowledge-entry view next to it. On the
 * left, one row per concept, titled with the concept's primary term - Chinese
 * full name if there is one, otherwise the English full name. Never the
 * abbreviation: an index reading "DRX / CET / EBSD" tells a reader nothing,
 * and an abbreviation as a title is exactly the ambiguity the storage rule
 * exists to keep out. On the right, every term of the selected concept in one
 * table - 序号 / 中文术语 / 英文术语 / 简称, the primary term first - and under
 * it the source documents, keyed back to those numbers.
 *
 * The source rows are the SAME rows the evidence rail builds: document title,
 * 打开文献, and 查看片段 where a verified excerpt exists. That reuse is
 * deliberate - a second, subtly different source list would be a second thing
 * to maintain and a second thing for a reader to learn.
 *
 * Every CELL of the table is tinted by where its own value came from: the
 * paper, the model, or a person. A reader has to be able to tell at a glance
 * which half of a row a paper actually vouches for, and that question is
 * answered per field - the source rail underneath says which documents the
 * term appeared in, but not which of its three names they contained.
 */

import { getVectorStore } from "../semantic/vectorStore";
import {
  button,
  clickable,
  describeError,
  element,
  jumpToItem,
} from "./wikiDom";
import {
  termDisplayName,
  type WikiConceptEntity,
  type WikiTermOrigin,
  type WikiTermRecord,
  type WikiTermSourceRecord,
} from "./wikiConceptTerms";
import type { WikiStore } from "./wikiStore";

declare let Zotero: any;
declare let ztoolkit: ZToolkit;

export interface WikiTermsView {
  /** The pane to mount in the panel. Hidden until the view is selected. */
  root: HTMLElement;
  /** Load or reload the concept list. Safe to call repeatedly. */
  refresh(): Promise<void>;
  /** Open one concept, loading the list first if it has not been loaded. */
  select(conceptId: number): Promise<void>;
  /** The concept currently open, if any. Drives the export button. */
  selectedConceptId(): number | null;
}

/** A term with no full name at all: only possible for migrated 2.4.2 data. */
function needsFullName(term: WikiTermRecord): boolean {
  return !term.zh && !term.en;
}

/**
 * What each provenance looks like, and what it is called.
 *
 * Tinting is per CELL rather than per row because one row routinely mixes all
 * three: the paper gave the English name, the model translated it, a reader
 * fixed the abbreviation. A row-level colour would have to pick one of those
 * and would therefore be wrong about the other two.
 *
 * The label is carried as a tooltip as well as a colour, because colour alone
 * is not a legible distinction for every reader and the difference between
 * "the paper said this" and "a model believes this" is exactly the kind of
 * thing nobody should have to infer from a shade of green.
 */
const ORIGIN_LABELS: Record<WikiTermOrigin, string> = {
  literature: "文献原文",
  ai: "AI 补全",
  user: "人工修改",
  "": "未标注（旧数据）",
};

function originClass(origin: WikiTermOrigin): string {
  return origin ? ` origin-${origin}` : "";
}

/** Does anything match this search box? Full names and abbreviations alike. */
function conceptMatches(concept: WikiConceptEntity, query: string): boolean {
  if (!query) return true;
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [concept.primaryTerm, ...concept.aliasTerms].some((term) =>
    term
      ? [term.zh, term.en, term.abbr].some(
          (name) => name && name.toLowerCase().includes(needle),
        )
      : false,
  );
}

export function createWikiTermsView(options: {
  win: any;
  doc: Document;
  libraryID: number;
  store: WikiStore;
  /** Re-render the whole panel, after an edit that changes the index. */
  reload: () => Promise<void>;
}): WikiTermsView {
  const { win, doc, libraryID, store } = options;

  const root = element(doc, "div", "zmp-wiki-terms-pane");
  root.hidden = true;
  const list = element(doc, "nav", "zmp-wiki-terms-list");
  list.id = "zotero-mcp-wiki-terms-list";
  const detail = element(doc, "main", "zmp-wiki-terms-detail");
  detail.id = "zotero-mcp-wiki-terms-detail";
  root.append(list, detail);

  let concepts: WikiConceptEntity[] = [];
  let query = "";
  let selected: number | null = null;
  const entries = new Map<number, HTMLElement>();
  let activeEntry: HTMLElement | null = null;

  /** Titles for the documents a concept cites, resolved once per render. */
  const titles = new Map<string, string>();

  const nameItem = async (
    sourceLibraryID: number,
    itemKey: string,
  ): Promise<string> => {
    const key = `${sourceLibraryID}:${itemKey}`;
    const cached = titles.get(key);
    if (cached !== undefined) return cached;
    let label = itemKey;
    try {
      const item = await Zotero.Items.getByLibraryAndKeyAsync(
        sourceLibraryID,
        itemKey,
      );
      if (item) {
        const title =
          item.getDisplayTitle?.() || item.getField?.("title") || "";
        const creator = String(item.getField?.("firstCreator") ?? "");
        const year = String(item.getField?.("date") ?? "").slice(0, 4);
        const detailLine = [creator, year].filter(Boolean).join(" · ");
        label = [String(title || itemKey), detailLine].filter(Boolean).join(" · ");
      }
    } catch (error) {
      ztoolkit.log("[wiki] could not name a concept source", error);
    }
    titles.set(key, label);
    return label;
  };

  /**
   * One source row, built the way the evidence rail builds one.
   *
   * 查看片段 only appears when the source actually carries a verified excerpt
   * and chunk index. A concept source may legitimately be no more than "this
   * paper uses this term", and offering a locator button that cannot locate
   * anything would be worse than not offering it.
   */
  const sourceRow = (
    index: number,
    source: WikiTermSourceRecord,
  ): HTMLElement => {
    const row = element(doc, "article", "zmp-wiki-evidence-row");
    row.append(
      element(doc, "strong", "zmp-wiki-evidence-role", `#${index}`),
      element(doc, "span", "zmp-wiki-evidence-meta", source.itemKey),
    );
    const name = element(doc, "span", "zmp-wiki-term-source-title", source.itemKey);
    row.append(name);
    void nameItem(source.libraryID, source.itemKey).then((label) => {
      name.textContent = label;
    });
    if (source.excerpt) {
      row.append(element(doc, "blockquote", "", source.excerpt));
    }
    const actions = element(doc, "div", "zmp-wiki-row-actions");
    const jump = button(doc, "打开文献", "在 Zotero 中选中来源文献", "quiet");
    jump.addEventListener("click", () => {
      void jumpToItem(win, source.libraryID, source.itemKey).catch(
        (error: unknown) => {
          win.alert(`无法打开文献：${describeError(error).message}`);
        },
      );
    });
    actions.append(jump);
    if (source.chunkIdSnapshot != null) {
      const chunk = button(
        doc,
        "查看片段",
        "加载当前索引中的来源片段",
        "quiet",
      );
      chunk.addEventListener("click", async () => {
        try {
          const chunks = await getVectorStore().getChunksForItem(
            source.itemKey,
            source.libraryID,
          );
          const current = chunks.find(
            (candidate) => candidate.chunkId === source.chunkIdSnapshot,
          );
          row.append(
            element(
              doc,
              "pre",
              "zmp-wiki-chunk",
              current?.text ||
                "当前无法获取该片段。请在重建索引后重新验证 Wiki。",
            ),
          );
        } catch (error) {
          row.append(
            element(
              doc,
              "pre",
              "zmp-wiki-chunk",
              `无法读取片段：${describeError(error).message}`,
            ),
          );
        }
      });
      actions.append(chunk);
    }
    row.append(actions);
    return row;
  };

  const editTerm = async (
    concept: WikiConceptEntity,
    term: WikiTermRecord,
  ): Promise<void> => {
    const zh = win.prompt("中文全称（可留空）", term.zh);
    if (zh === null) return;
    const en = win.prompt("英文全称（可留空）", term.en);
    if (en === null) return;
    const abbr = win.prompt("简称（可留空；不能单独存在）", term.abbr);
    if (abbr === null) return;
    try {
      const library = await store.concepts();
      await library.updateTerm({
        libraryID,
        conceptId: concept.conceptId,
        termId: term.termId,
        fields: { zh, en, abbr },
      });
    } catch (error) {
      win.alert(`保存失败：${describeError(error).message}`);
      return;
    }
    await options.reload();
  };

  const addTerm = async (concept: WikiConceptEntity): Promise<void> => {
    const zh = win.prompt("中文全称（可留空）", "");
    if (zh === null) return;
    const en = win.prompt("英文全称（可留空）", "");
    if (en === null) return;
    const abbr = win.prompt("简称（可留空；不能单独存在）", "");
    if (abbr === null) return;
    try {
      const library = await store.concepts();
      await library.addTerm({
        libraryID,
        conceptId: concept.conceptId,
        fields: { zh, en, abbr },
      });
    } catch (error) {
      win.alert(`添加失败：${describeError(error).message}`);
      return;
    }
    await options.reload();
  };

  const removeTerm = async (
    concept: WikiConceptEntity,
    term: WikiTermRecord,
  ): Promise<void> => {
    const name = termDisplayName(term) || term.abbr;
    if (!win.confirm(`确定删除术语「${name}」及其来源记录吗？`)) return;
    try {
      const library = await store.concepts();
      await library.removeTerm({
        libraryID,
        conceptId: concept.conceptId,
        termId: term.termId,
      });
    } catch (error) {
      win.alert(`删除失败：${describeError(error).message}`);
      return;
    }
    await options.reload();
  };

  const promoteTerm = async (
    concept: WikiConceptEntity,
    term: WikiTermRecord,
  ): Promise<void> => {
    try {
      const library = await store.concepts();
      await library.setPrimaryTerm({
        libraryID,
        conceptId: concept.conceptId,
        termId: term.termId,
      });
    } catch (error) {
      win.alert(`设置主术语失败：${describeError(error).message}`);
      return;
    }
    await options.reload();
  };

  const unlockPrimary = async (concept: WikiConceptEntity): Promise<void> => {
    try {
      const library = await store.concepts();
      await library.clearPrimaryLock({
        libraryID,
        conceptId: concept.conceptId,
      });
    } catch (error) {
      win.alert(`解除锁定失败：${describeError(error).message}`);
      return;
    }
    await options.reload();
  };

  const showConcept = (concept: WikiConceptEntity, entry?: HTMLElement) => {
    if (activeEntry && activeEntry !== entry) {
      activeEntry.classList.remove("is-active");
      activeEntry.setAttribute("aria-current", "false");
    }
    if (entry) {
      entry.classList.add("is-active");
      entry.setAttribute("aria-current", "true");
      activeEntry = entry;
    }
    selected = concept.conceptId;
    detail.replaceChildren();

    const head = element(doc, "div", "zmp-wiki-terms-head");
    head.append(element(doc, "h2", "", conceptTitle(concept)));
    const tools = element(doc, "div", "zmp-wiki-page-tools");
    const add = button(doc, "添加术语", "为该概念添加一组别名术语", "quiet");
    add.addEventListener("click", () => void addTerm(concept));
    tools.append(add);
    head.append(tools);
    detail.append(head);

    if (concept.description) {
      detail.append(
        element(doc, "p", "zmp-wiki-summary", concept.description),
      );
    }
    if (concept.pageIds.length) {
      detail.append(
        element(
          doc,
          "small",
          "zmp-wiki-graph-context",
          `已有知识条目 · 页面 ${concept.pageIds.join(", ")}`,
        ),
      );
    }

    const terms = [concept.primaryTerm, ...concept.aliasTerms].filter(
      (term): term is WikiTermRecord => Boolean(term),
    );

    // ---- The term table -------------------------------------------------
    const legend = element(doc, "div", "zmp-wiki-term-legend");
    for (const origin of ["literature", "ai", "user"] as WikiTermOrigin[]) {
      legend.append(
        element(
          doc,
          "span",
          `zmp-wiki-term-legend-key${originClass(origin)}`,
          ORIGIN_LABELS[origin],
        ),
      );
    }
    detail.append(legend);

    const table = element(doc, "table", "zmp-wiki-term-table");
    const header = element(doc, "tr", "zmp-wiki-term-table-head");
    for (const column of ["序号", "中文术语", "英文术语", "简称", ""]) {
      header.append(element(doc, "th", "", column));
    }
    table.append(header);
    // One cell, tinted by where ITS value came from - not the row's.
    const cell = (
      value: string,
      origin: WikiTermOrigin,
    ): HTMLTableCellElement => {
      const node = element(
        doc,
        "td",
        `zmp-wiki-term-cell${value ? originClass(origin) : ""}`,
        value || "—",
      );
      if (value) node.title = `来源：${ORIGIN_LABELS[origin]}`;
      return node;
    };
    terms.forEach((term, index) => {
      const row = element(
        doc,
        "tr",
        `zmp-wiki-term-row-cells${term.role === "primary" ? " is-primary" : ""}`,
      );
      const number = element(doc, "td", "zmp-wiki-term-index", String(index + 1));
      if (term.role === "primary") {
        number.append(element(doc, "span", "zmp-wiki-term-badge", "主"));
        if (concept.primaryLocked) {
          number.append(
            element(doc, "span", "zmp-wiki-term-lock", "已锁定"),
          );
        }
      }
      row.append(number);
      row.append(cell(term.zh, term.origins.zh));
      row.append(cell(term.en, term.origins.en));
      const abbrCell = cell(term.abbr, term.origins.abbr);
      if (needsFullName(term)) {
        abbrCell.append(
          element(doc, "span", "zmp-wiki-term-warning", "待补全全称"),
        );
      }
      row.append(abbrCell);
      const actions = element(doc, "td", "zmp-wiki-term-actions");
      const edit = button(doc, "编辑", "修改这一组术语", "quiet");
      edit.addEventListener("click", () => void editTerm(concept, term));
      actions.append(edit);
      if (term.role === "primary") {
        if (concept.primaryLocked) {
          const unlock = button(
            doc,
            "解除锁定",
            "交还给自动选举：以后信息最完整的一组会成为主术语",
            "quiet",
          );
          unlock.addEventListener("click", () => void unlockPrimary(concept));
          actions.append(unlock);
        }
      } else {
        const promote = button(
          doc,
          "设为主术语",
          "以这一组作为主术语，并锁定，AI 之后不再改动",
          "quiet",
        );
        promote.addEventListener("click", () => void promoteTerm(concept, term));
        const remove = button(doc, "删除", "删除这一组术语", "quiet");
        remove.addEventListener("click", () => void removeTerm(concept, term));
        actions.append(promote, remove);
      }
      row.append(actions);
      table.append(row);
    });
    detail.append(table);

    // ---- Sources, numbered to match the table ---------------------------
    const sources = element(doc, "div", "zmp-wiki-term-sources");
    sources.append(element(doc, "h3", "zmp-wiki-section-title", "来源文献"));
    detail.append(sources);
    let any = false;
    terms.forEach((term, index) => {
      if (!term.sources.length) return;
      any = true;
      const group = element(doc, "div", "zmp-wiki-term-source-group");
      group.append(
        element(
          doc,
          "h4",
          "zmp-wiki-term-source-heading",
          `${index + 1}. ${termDisplayName(term) || term.abbr}`,
        ),
      );
      for (const source of term.sources) {
        group.append(sourceRow(index + 1, source));
      }
      sources.append(group);
    });
    if (!any) {
      sources.append(
        element(
          doc,
          "p",
          "zmp-wiki-evidence-empty",
          "该概念暂无来源文献记录。AI 在阅读文献时识别到它，就会补充来源。",
        ),
      );
    }
  };

  const conceptTitle = (concept: WikiConceptEntity): string =>
    concept.displayName ||
    (concept.primaryTerm ? termDisplayName(concept.primaryTerm) : "") ||
    concept.primaryTerm?.abbr ||
    `概念 ${concept.conceptId}`;

  const renderList = () => {
    list.replaceChildren();
    entries.clear();
    activeEntry = null;
    const shown = concepts.filter((concept) => conceptMatches(concept, query));
    list.append(
      element(
        doc,
        "span",
        "zmp-wiki-column-title",
        query
          ? `术语库（${shown.length} / ${concepts.length}）`
          : `术语库（${concepts.length}）`,
      ),
    );
    // The search box searches all three columns, which is the reason an
    // abbreviation is stored in a column of its own rather than as another
    // loose alias string: typing DRX finds 动态再结晶.
    const search = element(doc, "input", "zmp-wiki-terms-search");
    search.id = "zotero-mcp-wiki-terms-search";
    search.setAttribute("type", "search");
    search.setAttribute("placeholder", "搜索中文 / 英文 / 简称");
    search.value = query;
    search.addEventListener("input", () => {
      query = search.value;
      renderList();
      // Re-rendering replaces the node, so the caret has to be put back or
      // typing a second character silently goes nowhere.
      const next = list.querySelector<HTMLInputElement>(
        "#zotero-mcp-wiki-terms-search",
      );
      if (next) {
        next.focus();
        next.setSelectionRange(next.value.length, next.value.length);
      }
    });
    list.append(search);
    if (!concepts.length) {
      list.append(
        element(
          doc,
          "p",
          "zmp-wiki-empty",
          "还没有概念。让 AI 阅读文献时会自动积累专业术语。",
        ),
      );
      detail.replaceChildren(
        element(
          doc,
          "p",
          "zmp-wiki-empty",
          "术语库为空。使用 wiki_build_from_paper 阅读文献后，AI 会记录识别到的概念。",
        ),
      );
      return;
    }
    if (!shown.length) {
      list.append(
        element(doc, "p", "zmp-wiki-empty", `没有匹配「${query}」的术语。`),
      );
      return;
    }
    for (const concept of shown) {
      const entry = clickable(doc, "zmp-wiki-page-entry", conceptTitle(concept));
      entry.setAttribute("aria-current", "false");
      const termCount = 1 + concept.aliasTerms.length;
      const sourceCount = new Set(
        [concept.primaryTerm, ...concept.aliasTerms]
          .filter(Boolean)
          .flatMap((term) =>
            (term as WikiTermRecord).sources.map(
              (source) => `${source.libraryID}:${source.itemKey}`,
            ),
          ),
      ).size;
      entry.append(
        element(doc, "strong", "zmp-wiki-page-entry-title", conceptTitle(concept)),
        element(
          doc,
          "small",
          "zmp-wiki-page-entry-meta",
          `${termCount} 组术语 · ${sourceCount} 篇来源`,
        ),
      );
      entry.addEventListener("click", () => showConcept(concept, entry));
      list.append(entry);
      entries.set(concept.conceptId, entry);
    }
    const opening =
      shown.find((concept) => concept.conceptId === selected) ?? shown[0];
    showConcept(opening, entries.get(opening.conceptId));
  };

  return {
    root,
    async refresh() {
      const library = await store.concepts();
      concepts = await library.list(libraryID);
      titles.clear();
      renderList();
    },
    async select(conceptId: number) {
      if (!concepts.length) await this.refresh();
      const concept = concepts.find(
        (candidate) => candidate.conceptId === conceptId,
      );
      if (!concept) return;
      selected = conceptId;
      // Opening a concept from elsewhere in the panel must not land on an
      // empty pane because a leftover search happens to exclude it.
      if (!conceptMatches(concept, query)) {
        query = "";
        renderList();
        return;
      }
      showConcept(concept, entries.get(conceptId));
    },
    selectedConceptId: () => selected,
  };
}
