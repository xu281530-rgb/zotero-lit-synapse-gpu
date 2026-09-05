/**
 * The DOM vocabulary the Wiki tab is built from.
 *
 * These helpers were local to wikiPanel.ts until the terminology view needed
 * the same controls. Sharing them rather than copying is what keeps the two
 * views looking like one panel - the same button, the same section heading,
 * the same source row - and what lets the terminology view reuse the source
 * rail wholesale instead of growing a second, subtly different one.
 */

declare let Zotero: any;

export function labelFor<T extends string>(
  labels: Readonly<Record<T, string>>,
  value: unknown,
): string {
  return labels[value as T] ?? String(value);
}

export function element<K extends keyof HTMLElementTagNameMap>(
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

export function button(
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
 * A clickable block that is deliberately not a `<button>`.
 *
 * Gecko lays a button's children out in an anonymous XUL box that does not
 * grow to fit them: a two-row button renders one row tall and spills its
 * second row over whatever comes next. Wrapping the rows in an inner element
 * does not help, because the wrapper is inside that same box. So every
 * control in this panel that holds more than one line of text is a div with
 * button semantics instead - a normal block box, which grows.
 *
 * The rule that keeps this from coming back: anything built as a `<button>`
 * here stays on one line (`white-space: nowrap`); anything that wraps is
 * built with this helper.
 */
export function clickable(
  doc: Document,
  className: string,
  title?: string,
): HTMLElement {
  const node = element(doc, "div", className);
  node.setAttribute("role", "button");
  node.setAttribute("tabindex", "0");
  if (title !== undefined) node.title = title;
  node.addEventListener("keydown", (event: Event) => {
    const key = (event as KeyboardEvent).key;
    if (key !== "Enter" && key !== " ") return;
    event.preventDefault();
    node.click();
  });
  return node;
}

/** A wrapping, full-width command: the same look, without the button box. */
export function commandBlock(
  doc: Document,
  text: string,
  title: string,
): HTMLElement {
  const node = clickable(doc, "zmp-wiki-command is-block", title);
  node.textContent = text;
  return node;
}

/**
 * A section of the reading column: a labelled heading plus its body.
 *
 * The middle column used to be one undivided stack, which is why the summary,
 * the terms and the claims ran into each other. Every block now announces what
 * it is before its content starts.
 */
export function section(
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
export function shorten(text: string, limit: number): string {
  const flat = String(text).replace(/\s+/gu, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

export async function jumpToItem(
  win: any,
  libraryID: number,
  itemKey: string,
): Promise<void> {
  const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, itemKey);
  if (!item) throw new Error(`Zotero 条目 ${libraryID}:${itemKey} 已不存在`);
  await win.ZoteroPane.selectItem(item.id);
}

export function describeError(error: unknown): {
  message: string;
  detail: string;
} {
  if (error instanceof Error) {
    return {
      message: error.message || String(error),
      detail: error.stack || `${error.name}: ${error.message}`,
    };
  }
  return { message: String(error), detail: String(error) };
}
