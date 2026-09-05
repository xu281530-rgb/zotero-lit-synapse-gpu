/**
 * Zotero LitSynapse bootstrap entrypoint for Zotero 9.0.x.
 *
 * The MCP core, integrated PDF reader, and preference pane are isolated from
 * one another. A runtime error in one component is logged instead of aborting
 * installation or suppressing the other component.
 */

var chromeHandle = null;
var ZoteroMarkReader;
var mcpModuleLoaded = false;
var mcpStarted = false;
var markReaderLoaded = false;
var markReaderStarted = false;

function install(data, reason) {}

function reportBootstrapError(stage, error) {
  // This is the last-resort reporter, so both catches stay silent on purpose:
  // there is deliberately no logging to add. If Zotero.logError itself throws
  // — which during bootstrap means Zotero is not far enough along to log at
  // all — the only channels available are the two being attempted here, and
  // reporting the reporter's own failure through them would either recurse or
  // throw again. Falling through to the next channel, and then giving up, is
  // the behaviour we want: a startup diagnostic must never be the thing that
  // aborts startup.
  try {
    Zotero.logError(error);
  } catch (_) {
    // Nothing to log to: fall through and try Zotero.debug instead.
  }
  try {
    Zotero.debug(`Zotero LitSynapse: ${stage}: ${error}`);
  } catch (_) {
    // Both channels are gone. Give up silently rather than abort startup.
  }
}

function normalizeRootURI(startupData) {
  let rootURI = startupData && startupData.rootURI;
  let resourceURI = startupData && startupData.resourceURI;

  if (rootURI && typeof rootURI !== "string") {
    rootURI = rootURI.spec || String(rootURI);
  }
  if (!rootURI && resourceURI) {
    rootURI = resourceURI.spec || String(resourceURI);
  }
  if (!rootURI) {
    return null;
  }
  return rootURI.endsWith("/") ? rootURI : `${rootURI}/`;
}

async function startup(startupData, reason) {
  let id = startupData && startupData.id;
  let version = startupData && startupData.version;
  let rootURI = normalizeRootURI(startupData);

  if (!rootURI) {
    reportBootstrapError("startup rejected", new Error("missing plugin root URI"));
    return;
  }

  // Chrome registration is required for localized UI and bundled resources,
  // but an error is kept local so AddonManager does not roll back installation.
  try {
    let aomStartup = Components.classes[
      "@mozilla.org/addons/addon-manager-startup;1"
    ].getService(Components.interfaces.amIAddonManagerStartup);
    let manifestURI = Services.io.newURI(`${rootURI}manifest.json`);
    chromeHandle = aomStartup.registerChrome(manifestURI, [
      ["content", "__addonRef__", `${rootURI}content/`],
      ["content", "zotero-mark-reader", `${rootURI}mark-reader/content/`],
    ]);
  } catch (error) {
    reportBootstrapError("chrome registration failed", error);
  }

  // Start MCP independently. A local server/configuration failure must not
  // prevent the integrated PDF toolbar from loading.
  try {
    let ctx = { rootURI };
    ctx._globalThis = ctx;
    Services.scriptloader.loadSubScript(
      `${rootURI}content/scripts/__addonRef__.js`,
      ctx,
    );
    mcpModuleLoaded = !!Zotero.__addonInstance__;
    if (!mcpModuleLoaded) {
      throw new Error("MCP script did not register Zotero.__addonInstance__");
    }
    await Zotero.__addonInstance__.hooks.onStartup();
    mcpStarted = true;
  } catch (error) {
    mcpStarted = false;
    reportBootstrapError("MCP core failed to start", error);
  }

  // Start the high-precision PDF reader independently from MCP startup.
  try {
    Services.scriptloader.loadSubScript(
      `${rootURI}mark-reader/content/scripts/zotero-mark-reader.js`,
    );
    if (!ZoteroMarkReader) {
      throw new Error("reader script did not expose ZoteroMarkReader");
    }
    ZoteroMarkReader.init({
      id,
      version,
      rootURI: `${rootURI}mark-reader/`,
    });
    markReaderLoaded = true;
    await ZoteroMarkReader.startup();
    markReaderStarted = true;
  } catch (error) {
    markReaderStarted = false;
    reportBootstrapError("integrated PDF reader failed to start", error);
  }

  // PDF parsing, reading, and translation settings are intentionally hosted
  // in the single MCP preference pane. Registering a second pane here would
  // split one workflow into two settings entries and is therefore disabled.
}

async function onMainWindowLoad({ window }, reason) {
  if (mcpStarted) {
    try {
      await Zotero.__addonInstance__?.hooks?.onMainWindowLoad?.(window);
    } catch (error) {
      reportBootstrapError("MCP main-window load failed", error);
    }
  }
  if (markReaderStarted) {
    try {
      await ZoteroMarkReader?.onMainWindowLoad?.(window);
    } catch (error) {
      reportBootstrapError("reader main-window load failed", error);
    }
  }
}

async function onMainWindowUnload({ window }, reason) {
  if (markReaderStarted) {
    try {
      await ZoteroMarkReader?.onMainWindowUnload?.(window);
    } catch (error) {
      reportBootstrapError("reader main-window unload failed", error);
    }
  }
  if (mcpStarted) {
    try {
      await Zotero.__addonInstance__?.hooks?.onMainWindowUnload?.(window);
    } catch (error) {
      reportBootstrapError("MCP main-window unload failed", error);
    }
  }
}

async function shutdown(shutdownData, reason) {
  // Best-effort independent cleanup is important during a live upgrade.
  if (markReaderLoaded || ZoteroMarkReader) {
    try {
      await ZoteroMarkReader?.shutdown?.();
    } catch (error) {
      reportBootstrapError("reader shutdown failed", error);
    }
  }
  markReaderStarted = false;
  markReaderLoaded = false;
  ZoteroMarkReader = undefined;

  if (mcpModuleLoaded || Zotero.__addonInstance__) {
    try {
      await Zotero.__addonInstance__?.hooks?.onShutdown?.();
    } catch (error) {
      reportBootstrapError("MCP shutdown failed", error);
    }
  }
  mcpStarted = false;
  mcpModuleLoaded = false;

  if (reason !== APP_SHUTDOWN && chromeHandle) {
    try {
      chromeHandle.destruct();
    } catch (error) {
      reportBootstrapError("chrome teardown failed", error);
    }
    chromeHandle = null;
  }
}

async function uninstall(data, reason) {}
