import { config } from "../package.json";
import { ColumnOptions, DialogHelper } from "zotero-plugin-toolkit";
import { HttpServer, httpServer } from "./modules/httpServer";
import { serverPreferences } from "./modules/serverPreferences";
import hooks, { getMinerUService } from "./hooks";
import { getOriginalPDFAttachmentsForItem } from "./modules/mineru";
import { createZToolkit } from "./utils/ztoolkit";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    // Env type, see build.js
    env: "development" | "production";
    initialized?: boolean;
    httpServer?: HttpServer | null;
    ztoolkit: ZToolkit;
    locale?: {
      current: any;
    };
    prefs?: {
      window: Window;
      columns?: Array<ColumnOptions>;
      rows?: Array<{ [dataKey: string]: string }>;
    };
    dialog?: DialogHelper;
  };
  // Lifecycle hooks
  public hooks: typeof hooks;
  // APIs
  public api: object;

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
      ztoolkit: createZToolkit(),
    };
    this.hooks = hooks;
    this.api = {
      HttpServer, // Expose the class for static methods
      testServer: () => {
        Zotero.debug("===MCP=== Manually testing server...");
        HttpServer.testServer();
      },
      startServer: () => {
        Zotero.debug("===MCP=== Manually starting server...");
        addon.data.httpServer?.start(serverPreferences.getPort());
      },
      stopServer: () => {
        Zotero.debug("===MCP=== Manually stopping server...");
        addon.data.httpServer?.stop();
      },
      pdfPrecision: {
        parseAttachment: async (
          attachment: Zotero.Item,
          options: { force?: boolean } = {},
        ) => {
          const service = getMinerUService();
          const result = await service.getRichParseForAttachment(attachment, {
            allowParse: true,
            ignoreFailureCache: true,
            ignoreEnabled: true,
            force: options.force === true,
          });
          if (!result) {
            throw new Error("No reusable Doc2X/MinerU Markdown or new high-precision PDF result was available");
          }
          return result;
        },
        getCachedParse: async (attachment: Zotero.Item) => {
          const service = getMinerUService();
          return service.getRichParseForAttachment(attachment, {
            allowParse: false,
            ignoreEnabled: true,
          });
        },
        selectOriginalPDFAttachments: async (items: Zotero.Item[]) => {
          const selected: Zotero.Item[] = [];
          const seen = new Set<number>();
          for (const item of items || []) {
            let parent = item;
            if (item?.isAttachment?.()) {
              const parentID = item.parentItemID;
              if (!parentID) {
                if (item.isPDFAttachment?.() && !seen.has(item.id)) {
                  seen.add(item.id);
                  selected.push(item);
                }
                continue;
              }
              parent = await Zotero.Items.getAsync(parentID);
            }
            if (!parent?.isRegularItem?.()) continue;
            for (const attachment of await getOriginalPDFAttachmentsForItem(parent)) {
              if (!seen.has(attachment.id)) {
                seen.add(attachment.id);
                selected.push(attachment);
              }
            }
          }
          return selected;
        },
        testConnection: async () => getMinerUService().testConnection(),
        getConfig: () => getMinerUService().getConfig(),
      },
    };
  }
}

export default Addon;
