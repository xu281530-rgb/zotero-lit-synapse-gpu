import { config } from "../../package.json";

/**
 * Styling for Zotero's settings window that lives outside our own preference
 * pane — currently just the size of the LitSynapse icon in the pane sidebar.
 *
 * The sidebar is Zotero's markup, not ours, so a stylesheet has to reach the
 * whole settings document. `Zotero.PreferencePanes.register({ stylesheets })`
 * would do that, but only once the pane is *opened*: the icon would sit at
 * Zotero's 24px and jump to 36px the moment the user first clicks our row.
 * Watching for the window instead gets the size right from the moment the
 * settings window appears.
 */

const STYLE_ID = `${config.addonRef}-prefs-nav-style`;
const PREFS_WINDOW_TYPE = "zotero:pref";

let windowListener: any = null;

function stylesheetHref(): string {
  return `chrome://${config.addonRef}/content/preferencesNav.css?version=${config.addonVersion}`;
}

function isPrefsWindow(win: any): boolean {
  try {
    return (
      win?.document?.documentElement?.getAttribute("windowtype") ===
      PREFS_WINDOW_TYPE
    );
  } catch (error) {
    return false;
  }
}

function injectStyle(win: any): void {
  try {
    const doc = win?.document;
    if (!doc?.documentElement || doc.getElementById(STYLE_ID)) return;
    const link = doc.createElement("link");
    link.id = STYLE_ID;
    link.rel = "stylesheet";
    link.href = stylesheetHref();
    doc.documentElement.appendChild(link);
  } catch (error) {
    Zotero.debug(`[MCP Plugin] Failed to style settings window: ${error}`);
  }
}

function removeStyle(win: any): void {
  try {
    win?.document?.getElementById(STYLE_ID)?.remove();
  } catch (error) {
    // window may already be gone
  }
}

function forEachPrefsWindow(fn: (win: any) => void): void {
  try {
    const windows = Services.wm.getEnumerator(PREFS_WINDOW_TYPE);
    while (windows.hasMoreElements()) {
      fn(windows.getNext());
    }
  } catch (error) {
    Zotero.debug(`[MCP Plugin] Failed to enumerate settings windows: ${error}`);
  }
}

export function registerPrefsWindowStyle(): void {
  unregisterPrefsWindowStyle();

  // Settings windows already open when the plugin starts
  forEachPrefsWindow(injectStyle);

  windowListener = {
    onOpenWindow(xulWindow: any) {
      let win: any;
      try {
        win = xulWindow.docShell.domWindow;
      } catch (error) {
        return;
      }
      // The window type is only readable once the document exists
      win.addEventListener(
        "load",
        () => {
          if (isPrefsWindow(win)) injectStyle(win);
        },
        { once: true },
      );
    },
    onCloseWindow() {},
    onWindowTitleChange() {},
  };
  Services.wm.addListener(windowListener);
}

/**
 * Must run on disable/uninstall: a listener left behind holds a closure into
 * the destroyed plugin sandbox, the same way orphaned menu elements did (#69).
 */
export function unregisterPrefsWindowStyle(): void {
  if (windowListener) {
    try {
      Services.wm.removeListener(windowListener);
    } catch (error) {
      Zotero.debug(`[MCP Plugin] Failed to drop settings window listener: ${error}`);
    }
    windowListener = null;
  }
  forEachPrefsWindow(removeStyle);
}
