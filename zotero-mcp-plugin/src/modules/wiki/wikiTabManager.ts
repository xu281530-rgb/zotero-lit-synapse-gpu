export interface WikiTabState {
  id: string;
  container: XUL.Box;
  renderVersion: number;
  closed: boolean;
}

export interface WikiTabRender {
  tab: WikiTabState;
  version: number;
}

interface WikiTabOptions {
  type: string;
  title: string;
}

const wikiTabs = new WeakMap<_ZoteroTypes.MainWindow, WikiTabState>();

export function openWikiTab(
  win: _ZoteroTypes.MainWindow,
  options: WikiTabOptions,
): WikiTabRender {
  let tab = wikiTabs.get(win);
  if (!tab) {
    let tabID = "";
    const created = win.Zotero_Tabs.add({
      type: options.type,
      title: options.title,
      data: {},
      select: true,
      onClose: () => {
        const active = wikiTabs.get(win);
        if (active?.id !== tabID) return;
        active.closed = true;
        wikiTabs.delete(win);
      },
    });
    tabID = created.id;
    created.container.classList.add("zotero-mcp-wiki-tab-container");
    created.container.setAttribute("flex", "1");
    tab = {
      ...created,
      renderVersion: 0,
      closed: false,
    };
    wikiTabs.set(win, tab);
  } else {
    win.Zotero_Tabs.select(tab.id);
  }

  tab.renderVersion += 1;
  return { tab, version: tab.renderVersion };
}

export function isCurrentWikiTabRender(render: WikiTabRender): boolean {
  return !render.tab.closed && render.tab.renderVersion === render.version;
}

export function closeWikiTab(win: _ZoteroTypes.MainWindow): void {
  const tab = wikiTabs.get(win);
  if (!tab) return;
  tab.closed = true;
  wikiTabs.delete(win);
  win.Zotero_Tabs.close(tab.id);
}
