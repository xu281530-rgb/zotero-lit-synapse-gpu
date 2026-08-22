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
  /** Item type the tab bar renders its icon from; styled in wikiPanel.css. */
  icon: string;
}

interface ZoteroTabRecord {
  id: string;
  type: string;
  data?: unknown;
}

const wikiTabs = new WeakMap<_ZoteroTypes.MainWindow, WikiTabState>();

function closeOrphanedWikiTabs(
  win: _ZoteroTypes.MainWindow,
  type: string,
): void {
  const tabManager = win.Zotero_Tabs as typeof win.Zotero_Tabs & {
    _tabs?: ZoteroTabRecord[];
  };
  const orphaned = tabManager._tabs?.filter((tab) => tab.type === type) ?? [];
  if (!orphaned.length) return;

  for (const tab of orphaned) {
    if (!tab.data || typeof tab.data !== "object") tab.data = {};
  }
  tabManager.close(orphaned.map((tab) => tab.id));
}

export function openWikiTab(
  win: _ZoteroTypes.MainWindow,
  options: WikiTabOptions,
): WikiTabRender {
  let tab = wikiTabs.get(win);
  if (!tab) {
    closeOrphanedWikiTabs(win, options.type);
    let tabID = "";
    const created = win.Zotero_Tabs.add({
      type: options.type,
      title: options.title,
      // Zotero fills `data.icon` in itself for tabs it recognises, and leaves
      // it blank otherwise; seeding it keeps the plugin icon on the tab.
      data: { icon: options.icon },
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
