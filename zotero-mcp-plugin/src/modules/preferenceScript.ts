import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { ClientConfigGenerator } from "./clientConfigGenerator";
import { generateSecureIdentifier } from "../utils/security";
import {
  resumeSemanticAutoUpdates,
  suspendSemanticAutoUpdates,
  trackedSetTimeout,
} from "../hooks";
import {
  HYBRID_SETTING_RECOMMENDATIONS,
  getChunkingSignature,
  getHybridSearchSettings,
  getStoredChunkingSignature,
  hasIncompleteFullLibraryRebuild,
  hasUntrustedLegacyChunkingSignature,
  clearStoredChunkingSignatures,
  shouldShowChunkingWarning,
  setKeywordSearchTimeoutMs,
  setVectorScanTimeoutMs,
} from "./hybridSearchSettings";
import { recommendTimeoutMs } from "./semantic/vectorScanBenchmark";
import {
  buildKeywordProfiles,
  runKeywordSearchBenchmark,
  sampleLibraryTerms,
} from "./keywordSearchBenchmark";
import { runLexicalSearch } from "./lexicalSearch";
import {
  cancelIndexRefreshQueueReset,
  clearIndexRefreshQueue,
  markIndexRefreshQueueDatabaseCleared,
  prepareIndexRefreshQueueReset,
  resumeIndexRefreshQueue,
  suspendIndexRefreshQueue,
} from "./semantic/indexRefreshQueue";
import { clearSemanticDatabase } from "./semantic/semanticDatabaseReset";
import {
  resumePDFSemanticIndexRefreshes,
  suspendPDFSemanticIndexRefreshes,
} from "./pdfTextSource";
import {
  deriveEmbeddingPreferenceLocks,
  getDataCompatibilityState,
} from "./dataCompatibilityLocks";

export async function registerPrefsScripts(_window: Window) {
  // This function is called when the prefs window is opened
  // See addon/content/preferences.xhtml onpaneload
  ztoolkit.log(`[PreferenceScript] [DIAGNOSTIC] Registering preference scripts...`);
  
  addon.data.prefs = { window: _window };
  
  // 诊断当前偏好设置状态
  try {
    const currentEnabled = Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.mcp.server.enabled", true);
    const currentPort = Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.mcp.server.port", true);
    ztoolkit.log(`[PreferenceScript] [DIAGNOSTIC] Current preferences - enabled: ${currentEnabled}, port: ${currentPort}`);
    
    // 检查是否是环境兼容性问题
    const doc = _window.document;
    ztoolkit.log(`[PreferenceScript] [DIAGNOSTIC] Document available: ${!!doc}`);
    
    if (doc) {
      const prefElements = doc.querySelectorAll('[preference]');
      ztoolkit.log(`[PreferenceScript] [DIAGNOSTIC] Found ${prefElements.length} preference-bound elements`);
      
      // 特别检查服务器启用元素
      const serverEnabledElement = doc.querySelector('#zotero-prefpane-zotero-mcp-plugin-mcp-server-enabled');
      if (serverEnabledElement) {
        ztoolkit.log(`[PreferenceScript] [DIAGNOSTIC] Server enabled element found, initial checked state: ${serverEnabledElement.hasAttribute('checked')}`);
      } else {
        ztoolkit.log(`[PreferenceScript] [DIAGNOSTIC] WARNING: Server enabled element NOT found`);
      }
    }
  } catch (error) {
    ztoolkit.log(`[PreferenceScript] [DIAGNOSTIC] Error in preference diagnostic: ${error}`, 'error');
  }
  
  bindPrefEvents();
}

/**
 * Bind an HTML checkbox to a Zotero preference (init + sync on change)
 */
function bindHtmlCheckbox(doc: Document, selector: string, prefKey: string) {
  const el = doc?.querySelector(selector) as HTMLInputElement;
  if (!el) return;
  const val = Zotero.Prefs.get(prefKey, true);
  el.checked = val !== false && val !== undefined;
  el.addEventListener("change", () => {
    Zotero.Prefs.set(prefKey, el.checked, true);
  });
}

/**
 * Bind an HTML text/number input to a Zotero preference
 */
function bindHtmlInput(doc: Document, selector: string, prefKey: string, isNumber = false) {
  const el = doc?.querySelector(selector) as HTMLInputElement;
  if (!el) return;
  const val = Zotero.Prefs.get(prefKey, true);
  if (val !== undefined && val !== null) el.value = String(val);
  el.addEventListener("change", () => {
    const v = isNumber ? parseInt(el.value, 10) : el.value;
    if (isNumber && isNaN(v as number)) return;
    Zotero.Prefs.set(prefKey, v, true);
  });
}

/**
 * Bind an HTML select to a Zotero preference
 */
function bindHtmlSelect(doc: Document, selector: string, prefKey: string) {
  const el = doc?.querySelector(selector) as HTMLSelectElement;
  if (!el) return;
  const val = Zotero.Prefs.get(prefKey, true);
  if (val !== undefined && val !== null) el.value = String(val);
  el.addEventListener("change", () => {
    Zotero.Prefs.set(prefKey, el.value, true);
  });
}

function bindPrefEvents() {
  const doc = addon.data.prefs!.window.document;

  // Server enabled toggle (HTML checkbox in toggle switch)
  const serverEnabledCheckbox = doc?.querySelector(
    `#zotero-prefpane-${config.addonRef}-mcp-server-enabled`,
  ) as HTMLInputElement;

  if (serverEnabledCheckbox) {
    // Initialize checkbox state
    const currentEnabled = Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.mcp.server.enabled", true);
    serverEnabledCheckbox.checked = currentEnabled !== false;
    ztoolkit.log(`[PreferenceScript] Initialized checkbox state: ${currentEnabled}`);

    // Add change listener (HTML checkbox uses 'change' event)
    serverEnabledCheckbox.addEventListener("change", () => {
      const checked = serverEnabledCheckbox.checked;
      ztoolkit.log(`[PreferenceScript] Server toggle changed - checked: ${checked}`);

      // Update preference manually
      Zotero.Prefs.set("extensions.zotero.zotero-mcp-plugin.mcp.server.enabled", checked, true);

      // Update cascade visibility
      updateServerDependentUI(doc, checked);

      // Directly control server
      try {
        const httpServer = addon.data.httpServer;
        if (httpServer) {
          if (checked) {
            if (!httpServer.isServerRunning()) {
              const portPref = Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.mcp.server.port", true);
              const port = typeof portPref === 'number' ? portPref : 23120;
              httpServer.start(port);
              ztoolkit.log(`[PreferenceScript] Server started on port ${port}`);
            }
          } else {
            if (httpServer.isServerRunning()) {
              httpServer.stop();
              ztoolkit.log(`[PreferenceScript] Server stopped`);
            }
          }
        }
      } catch (error) {
        ztoolkit.log(`[PreferenceScript] Error controlling server: ${error}`, 'error');
      }
    });

    // Initialize cascade visibility
    updateServerDependentUI(doc, currentEnabled !== false);
  }
  
  // Port input validation
  const portInput = doc?.querySelector(
    `#zotero-prefpane-${config.addonRef}-mcp-server-port`,
  ) as HTMLInputElement;

  // Initialize port value from pref
  if (portInput) {
    const savedPort = Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.mcp.server.port", true);
    if (savedPort) portInput.value = String(savedPort);
  }

  portInput?.addEventListener("change", () => {
    if (portInput) {
      const port = parseInt(portInput.value, 10);
      if (isNaN(port) || port < 1024 || port > 65535) {
        addon.data.prefs!.window.alert(
          getString("pref-server-port-invalid" as any),
        );
        const originalPort = Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.mcp.server.port", true) || 23120;
        portInput.value = originalPort.toString();
      } else {
        Zotero.Prefs.set("extensions.zotero.zotero-mcp-plugin.mcp.server.port", port, true);
      }
    }
  });

  // Bind HTML toggle switches (these need manual pref sync since they're not XUL checkboxes)
  bindHtmlCheckbox(doc, `#zotero-prefpane-${config.addonRef}-mcp-server-allow-remote`, "extensions.zotero.zotero-mcp-plugin.mcp.server.allowRemote");
  bindHtmlInput(doc, `#zotero-prefpane-${config.addonRef}-mcp-server-auth-token`, "extensions.zotero.zotero-mcp-plugin.mcp.server.authToken");
  bindHtmlCheckbox(doc, `#zotero-prefpane-${config.addonRef}-write-confirm`, "extensions.zotero.zotero-mcp-plugin.write.confirmBeforeMutation");
  bindHtmlCheckbox(doc, `#zotero-prefpane-${config.addonRef}-file-import-enabled`, "extensions.zotero.zotero-mcp-plugin.write.allowFileImport");
  bindHtmlCheckbox(doc, `#zotero-prefpane-${config.addonRef}-expose-file-paths`, "extensions.zotero.zotero-mcp-plugin.privacy.exposeFilePaths");

  const remoteToggle = doc?.querySelector(`#zotero-prefpane-${config.addonRef}-mcp-server-allow-remote`) as HTMLInputElement;
  const tokenInput = doc?.querySelector(`#zotero-prefpane-${config.addonRef}-mcp-server-auth-token`) as HTMLInputElement;
  const regenerateTokenButton = doc?.querySelector('#regenerate-mcp-token-button') as HTMLButtonElement;

  regenerateTokenButton?.addEventListener('click', () => {
    const token = generateSecureIdentifier("");
    Zotero.Prefs.set("extensions.zotero.zotero-mcp-plugin.mcp.server.authToken", token, true);
    if (tokenInput) tokenInput.value = token;
  });

  remoteToggle?.addEventListener('change', () => {
    try {
      if (remoteToggle.checked) {
        let token = String(Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.mcp.server.authToken", true) || '').trim();
        if (token.length < 32) {
          token = generateSecureIdentifier("");
          Zotero.Prefs.set("extensions.zotero.zotero-mcp-plugin.mcp.server.authToken", token, true);
          if (tokenInput) tokenInput.value = token;
        }
      }
      const httpServer = addon.data.httpServer;
      if (httpServer?.isServerRunning()) {
        const portPref = Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.mcp.server.port", true);
        const port = typeof portPref === 'number' ? portPref : 23120;
        httpServer.stop();
        httpServer.start(port);
        ztoolkit.log(`[PreferenceScript] Server rebound after remote-access change on port ${port}`);
      }
    } catch (error) {
      ztoolkit.log(`[PreferenceScript] Failed to apply remote-access change: ${error}`, "error");
      addon.data.prefs!.window.alert(`Failed to apply MCP remote-access setting: ${error}`);
    }
  });
  bindHtmlCheckbox(doc, `#zotero-prefpane-${config.addonRef}-semantic-auto-update`, "extensions.zotero.zotero-mcp-plugin.semantic.autoUpdate");

  // Client config generation
  const clientSelect = doc?.querySelector("#client-type-select") as HTMLSelectElement;
  const serverNameInput = doc?.querySelector("#server-name-input") as HTMLInputElement;
  const generateButton = doc?.querySelector("#generate-config-button") as HTMLButtonElement;
  const copyConfigButton = doc?.querySelector("#copy-config-button") as HTMLButtonElement;
  const copyInstrButton = doc?.querySelector("#copy-instr-button") as HTMLButtonElement;
  const configOutput = doc?.querySelector("#config-output") as HTMLElement;
  const configGuide = doc?.querySelector("#config-guide") as HTMLElement;

  let currentConfig = "";
  let currentGuide = "";

  generateButton?.addEventListener("click", () => {
    try {
      const clientType = clientSelect?.value || "claude-desktop";
      const serverName = serverNameInput?.value?.trim() || "zotero-mcp";
      const port = parseInt(portInput?.value || "23120", 10);

      // Generate configuration
      currentConfig = ClientConfigGenerator.generateConfig(clientType, port, serverName);
      currentGuide = ClientConfigGenerator.generateFullGuide(clientType, port, serverName);

      // Display configuration in div panel
      if (configOutput) {
        configOutput.textContent = currentConfig;
      }

      // Display guide in separate area
      if (configGuide) {
        configGuide.textContent = currentGuide;
      }

      // Enable copy button
      copyConfigButton.disabled = false;
      copyInstrButton.disabled = false;

      ztoolkit.log(`[PreferenceScript] Generated config for ${clientType}`);
    } catch (error) {
      addon.data.prefs!.window.alert(`配置生成失败: ${error}`);
      ztoolkit.log(`[PreferenceScript] Config generation failed: ${error}`, "error");
    }
  });

  copyConfigButton?.addEventListener("click", async () => {
    try {
      const success = await ClientConfigGenerator.copyToClipboard(currentConfig);
      if (success) {
        const originalText = copyConfigButton.textContent;
        copyConfigButton.textContent = "已复制!";
        copyConfigButton.style.backgroundColor = "var(--copy-ok-bg)";
        copyConfigButton.style.color = "var(--tog-knob)";
        setTimeout(() => {
          copyConfigButton.textContent = originalText;
          copyConfigButton.style.backgroundColor = "";
          copyConfigButton.style.color = "";
        }, 2000);
      } else {
        addon.data.prefs!.window.alert("自动复制失败，请手动复制配置内容");
      }
    } catch (error) {
      addon.data.prefs!.window.alert(`复制失败: ${error}`);
      ztoolkit.log(`[PreferenceScript] Copy failed: ${error}`, "error");
    }
  });

  copyInstrButton?.addEventListener("click", async () => {
    try {
      const success = await ClientConfigGenerator.copyToClipboard(currentGuide);
      if (success) {
        const originalText = copyInstrButton.textContent;
        copyInstrButton.textContent = "已复制!";
        copyInstrButton.style.backgroundColor = "var(--copy-ok-bg)";
        copyInstrButton.style.color = "var(--tog-knob)";
        setTimeout(() => {
          copyInstrButton.textContent = originalText;
          copyInstrButton.style.backgroundColor = "";
          copyInstrButton.style.color = "";
        }, 2000);
      } else {
        addon.data.prefs!.window.alert("自动复制失败，请手动复制说明内容");
      }
    } catch (error) {
      addon.data.prefs!.window.alert(`复制失败: ${error}`);
      ztoolkit.log(`[PreferenceScript] Copy instructions failed: ${error}`, "error");
    }
  });

  // Auto-generate config when client type changes
  clientSelect?.addEventListener("change", () => {
    if (currentConfig) {
      generateButton?.click();
    }
  });

  // Auto-generate config when server name changes
  serverNameInput?.addEventListener("input", () => {
    if (currentConfig) {
      generateButton?.click();
    }
  });

  // ============ Collapsible Panels ============
  bindCollapsiblePanels(doc);

  // ============ Embedding API Settings ============
  bindEmbeddingSettings(doc);

  // ============ API Usage Stats ============
  bindApiUsageStats(doc);

// ============ Search Index Stats ============
  bindSemanticStatsSettings(doc);

  // ============ Hybrid Search ============
  bindHybridSearchSettings(doc);

  // ============ LLM Wiki ============
  bindWikiSettings(doc);

  // ============ MinerU PDF Parsing ============
  bindMinerUSettings(doc);

  // ============ Integrated PDF Translation ============
  bindTranslationSettings(doc);
  initIntegratedTranslationPreferences(addon.data.prefs!.window);

  // ============ Rate Limit Summary ============
  updateRateLimitSummary(doc);
}

/**
 * 混合检索设置
 *
 * 这些值是检索的硬上限：AI 只能要得更少、更严。这里在写入 preference 前先夹取
 * 到允许区间，读取侧（hybridSearchSettings）也会再夹一次，两边都不信任脏值。
 * 分块相关的两项只影响新建的索引，所以顺带对比索引里记录的分块签名，不一致时
 * 提示用户重建，而不是偷偷替他重建。
 */
async function refreshWikiDataStatistics(doc: Document): Promise<void> {
  const element = doc.querySelector("#wiki-data-statistics") as HTMLElement;
  if (!element) return;
  try {
    const { getWikiStore } = await import("./wiki/wikiStore");
    const status = await getWikiStore().getStatus();
    element.textContent = getString("pref-wiki-data-statistics" as any, {
      args: {
        pages: status.pages,
        claims: status.claims,
        evidence: status.evidence,
        embeddings: status.claimEmbeddings,
      },
    });
  } catch (error) {
    element.textContent = `${getString("pref-wiki-data-statistics-error" as any) || "Wiki statistics unavailable"}: ${error}`;
  }
}

async function refreshDataCompatibilityLockUI(doc: Document): Promise<void> {
  try {
    const state = await getDataCompatibilityState();
    const chunkInputs = [
      doc.querySelector(
        `#zotero-prefpane-${config.addonRef}-hybrid-chunk-target`,
      ) as HTMLInputElement | null,
      doc.querySelector(
        `#zotero-prefpane-${config.addonRef}-hybrid-chunk-tolerance`,
      ) as HTMLInputElement | null,
    ];
    for (const input of chunkInputs) {
      if (input) input.disabled = state.chunkLocked;
    }
    const chunkMessage = doc.querySelector(
      "#hybrid-chunk-lock-message",
    ) as HTMLElement | null;
    if (chunkMessage) chunkMessage.hidden = !state.chunkLocked;

    const modelInput = doc.querySelector(
      `#zotero-prefpane-${config.addonRef}-embedding-model`,
    ) as HTMLInputElement | null;
    const dimensionsInput = doc.querySelector(
      `#zotero-prefpane-${config.addonRef}-embedding-dimensions`,
    ) as HTMLInputElement | null;
    const embeddingLocks = deriveEmbeddingPreferenceLocks(
      state.embeddingIdentityLocked,
    );
    if (modelInput) {
      modelInput.dataset.compatibilityLocked = String(
        embeddingLocks.model,
      );
      modelInput.disabled = embeddingLocks.model;
    }
    if (dimensionsInput) {
      dimensionsInput.dataset.compatibilityLocked = String(
        embeddingLocks.dimensions,
      );
      dimensionsInput.disabled =
        embeddingLocks.dimensions ||
        dimensionsInput.dataset.modelSupportsCustom !== "true";
    }
    const embeddingMessage = doc.querySelector(
      "#embedding-identity-lock-message",
    ) as HTMLElement | null;
    if (embeddingMessage)
      embeddingMessage.hidden = !state.embeddingIdentityLocked;
  } catch (error) {
    ztoolkit.log(
      `[PreferenceScript] Failed to refresh data compatibility locks: ${error}`,
      "warn",
    );
  }
}

function bindWikiSettings(doc: Document) {
  const prefix = "extensions.zotero.zotero-mcp-plugin.wiki.";
  const ref = config.addonRef;
  bindHtmlCheckbox(
    doc,
    `#zotero-prefpane-${ref}-wiki-enabled`,
    prefix + "enabled",
  );
  bindHtmlCheckbox(
    doc,
    `#zotero-prefpane-${ref}-wiki-auto-write`,
    prefix + "autoWrite",
  );
  bindHtmlSelect(
    doc,
    `#zotero-prefpane-${ref}-wiki-write-mode`,
    prefix + "writeMode",
  );
  bindHtmlCheckbox(
    doc,
    `#zotero-prefpane-${ref}-wiki-shadow-mode`,
    prefix + "shadowMode",
  );

  const bindNumber = (
    selector: string,
    key: string,
    min: number,
    max: number,
    fallback: number,
    storeAsString = false,
  ) => {
    const element = doc.querySelector(selector) as HTMLInputElement | null;
    if (!element) return;
    const stored = Zotero.Prefs.get(prefix + key, true);
    const parsed = Number(stored);
    element.value = String(Number.isFinite(parsed) ? parsed : fallback);
    element.addEventListener("change", () => {
      const input = Number(element.value);
      const value = Number.isFinite(input)
        ? Math.max(min, Math.min(max, input))
        : fallback;
      element.value = String(value);
      Zotero.Prefs.set(
        prefix + key,
        storeAsString ? String(value) : Math.round(value),
        true,
      );
    });
  };

  bindNumber(
    `#zotero-prefpane-${ref}-wiki-min-score`,
    "minScore",
    0,
    1,
    0,
    true,
  );
  bindNumber(
    `#zotero-prefpane-${ref}-wiki-rrf-weight`,
    "rrfWeight",
    0,
    10,
    0,
    true,
  );
  bindNumber(
    `#zotero-prefpane-${ref}-wiki-timeout`,
    "searchTimeoutMs",
    100,
    60000,
    5000,
  );

  const clearButton = doc.querySelector(
    "#clear-wiki-data-button",
  ) as HTMLButtonElement | null;
  clearButton?.addEventListener("click", async () => {
    const message =
      getString("pref-wiki-clear-confirm" as any) ||
      "This permanently deletes all Wiki data. Search indexes are not deleted. Continue?";
    if (!addon.data.prefs!.window.confirm(message)) return;
    clearButton.disabled = true;
    try {
      const { getWikiStore } = await import("./wiki/wikiStore");
      await getWikiStore().clearAll();
      await refreshWikiDataStatistics(doc);
      await refreshDataCompatibilityLockUI(doc);
    } catch (error) {
      addon.data.prefs!.window.alert(
        `${getString("pref-wiki-clear-error" as any) || "Failed to delete Wiki data"}: ${error}`,
      );
    } finally {
      clearButton.disabled = false;
    }
  });
  void refreshWikiDataStatistics(doc);
  void refreshDataCompatibilityLockUI(doc);
}

function bindHybridSearchSettings(doc: Document) {
  const P = "extensions.zotero.zotero-mcp-plugin.hybrid.";
  const ref = config.addonRef;

  const gpuToggle = doc?.querySelector(
    `#zotero-prefpane-${ref}-hybrid-gpu-enabled`,
  ) as HTMLInputElement;
  const gpuStatus = doc?.querySelector("#hybrid-gpu-status") as HTMLElement;
  const gpuPrecision = doc?.querySelector(
    `#zotero-prefpane-${ref}-hybrid-gpu-precision`,
  ) as HTMLSelectElement;
  if (gpuToggle && gpuStatus) {
    const { getGpuVectorService } = require("./semantic/gpuVectorService");
    const { getVectorStore } = require("./semantic/vectorStore");
    const gpuService = getGpuVectorService();
    gpuToggle.checked = Zotero.Prefs.get(P + "gpuAccelerationEnabled", true) === true;
    const storedPrecision = String(
      Zotero.Prefs.get(P + "gpuPrecision", true) || "auto",
    );
    if (gpuPrecision) {
      gpuPrecision.value =
        storedPrecision === "float32" || storedPrecision === "int8"
          ? storedPrecision
          : "auto";
      gpuPrecision.disabled = !gpuToggle.checked;
    }
    const renderGpuStatus = (status: any) => {
      gpuStatus.style.color = "";
      const backend =
        status.phase === "fallback" || status.phase === "disabled"
          ? "CPU"
          : "GPU";
      const precision = status.precision === "float32" ? "Float32" : "Int8";
      if (status.phase === "preparing") {
        gpuStatus.textContent = getString(
          "pref-hybrid-gpu-status-preparing" as any,
          { args: { backend, precision } },
        );
      } else if (status.phase === "loading") {
        gpuStatus.textContent = getString(
          "pref-hybrid-gpu-status-loading" as any,
          {
            args: {
              backend,
              precision,
              loaded: status.loaded,
              total: status.total,
            },
          },
        );
      } else if (status.phase === "available") {
        // The resident-vector count only tells the user what is on the GPU
        // right now; the sync suffix tells them it got there because of the
        // index update they just ran, which is the thing they came to check.
        const synced =
          typeof status.lastSyncedAt === "number"
            ? " " +
              getString("pref-hybrid-gpu-status-synced" as any, {
                args: {
                  time: new Date(status.lastSyncedAt).toLocaleTimeString(),
                },
              })
            : "";
        gpuStatus.textContent =
          getString("pref-hybrid-gpu-status-available" as any, {
            args: {
              backend,
              precision,
              device: status.device,
              vectors: status.vectors,
            },
          }) + synced;
        gpuStatus.style.color = "var(--color-ok)";
      } else if (status.phase === "fallback") {
        gpuStatus.textContent = getString(
          "pref-hybrid-gpu-status-fallback" as any,
          {
            args: {
              backend,
              precision,
              code: status.code,
              reason: status.reason,
            },
          },
        );
        gpuStatus.style.color = "var(--msg-error-text)";
      } else {
        gpuStatus.textContent = getString(
          "pref-hybrid-gpu-status-disabled" as any,
          { args: { backend, precision } },
        );
      }
    };
    const unsubscribe = gpuService.subscribe(renderGpuStatus);
    doc.defaultView?.addEventListener("unload", unsubscribe, { once: true });

    gpuToggle.addEventListener("change", async () => {
      gpuToggle.disabled = true;
      if (gpuPrecision) gpuPrecision.disabled = true;
      try {
        if (gpuToggle.checked) getVectorStore();
        await gpuService.setEnabled(gpuToggle.checked);
      } catch {
        // The service has already switched to an explicit fallback status.
      } finally {
        gpuToggle.disabled = false;
        if (gpuPrecision) gpuPrecision.disabled = !gpuToggle.checked;
      }
    });

    gpuPrecision?.addEventListener("change", async () => {
      const precision =
        gpuPrecision.value === "float32" || gpuPrecision.value === "int8"
          ? gpuPrecision.value
          : "auto";
      gpuPrecision.disabled = true;
      try {
        await gpuService.setPrecision(precision);
      } catch {
        // The status subscription renders the fallback reason.
      } finally {
        gpuPrecision.disabled = !gpuToggle.checked;
      }
    });

    if (gpuToggle.checked) {
      getVectorStore();
      void gpuService.startIfEnabled().catch(() => {
        // The status subscription renders the fallback reason.
      });
    }
  }

  const bindBoundedNumber = (
    selector: string,
    prefKey: string,
    min: number,
    max: number,
    fallback: number,
    isFloat = false,
  ) => {
    const el = doc?.querySelector(selector) as HTMLInputElement;
    if (!el) return;
    const stored = Zotero.Prefs.get(prefKey, true);
    const parsed =
      typeof stored === "string" ? Number(stored) : (stored as number);
    const initial =
      typeof parsed === "number" && Number.isFinite(parsed) ? parsed : fallback;
    el.value = String(initial);
    el.addEventListener("change", async () => {
      const changesChunkStructure =
        prefKey.endsWith("chunkTargetChars") ||
        prefKey.endsWith("chunkAppendToleranceChars");
      if (
        changesChunkStructure &&
        (await getDataCompatibilityState()).chunkLocked
      ) {
        const storedValue = Zotero.Prefs.get(prefKey, true);
        el.value = String(storedValue ?? initial);
        await refreshDataCompatibilityLockUI(doc);
        return;
      }
      let value = isFloat ? parseFloat(el.value) : parseInt(el.value, 10);
      if (!Number.isFinite(value)) value = fallback;
      value = Math.min(max, Math.max(min, value));
      el.value = String(value);
      // The threshold is stored as a string: Firefox preference files have no
      // float type, so a numeric pref here would not survive the defaults file.
      Zotero.Prefs.set(prefKey, isFloat ? String(value) : value, true);
      if (changesChunkStructure) {
        // Changing a chunk parameter never triggers a rebuild — it only makes
        // the stored index out of date, and says so.
        updateChunkStaleWarning(doc);
        updateHybridAdvancedSummary(doc);
      }
    });
  };

  bindBoundedNumber(`#zotero-prefpane-${ref}-hybrid-max-documents`, P + "maxDocuments", 1, 20, 20);
  bindBoundedNumber(`#zotero-prefpane-${ref}-hybrid-max-chunks`, P + "maxChunksPerItem", 1, 50, 5);
  // The four knobs of the two-branch fusion. Each is bound to its own pref and
  // its own bounds; the pane shows a "推荐值" line under each, sourced from
  // HYBRID_SETTING_RECOMMENDATIONS so the hint cannot drift from the default.
  bindBoundedNumber(`#zotero-prefpane-${ref}-hybrid-keyword-min-score`, P + "keywordMinScore", 0, 1, HYBRID_SETTING_RECOMMENDATIONS.keywordMinScore, true);
  bindBoundedNumber(`#zotero-prefpane-${ref}-hybrid-semantic-min-score`, P + "semanticMinScore", 0, 1, HYBRID_SETTING_RECOMMENDATIONS.semanticMinScore, true);
  bindBoundedNumber(`#zotero-prefpane-${ref}-hybrid-keyword-rrf-weight`, P + "keywordRrfWeight", 0, 10, HYBRID_SETTING_RECOMMENDATIONS.keywordRrfWeight, true);
  bindBoundedNumber(`#zotero-prefpane-${ref}-hybrid-semantic-rrf-weight`, P + "semanticRrfWeight", 0, 10, HYBRID_SETTING_RECOMMENDATIONS.semanticRrfWeight, true);
  bindBoundedNumber(`#zotero-prefpane-${ref}-hybrid-neighbor-radius`, P + "neighborRadius", 0, 10, 1);
  bindBoundedNumber(`#zotero-prefpane-${ref}-hybrid-search-timeout`, P + "searchTimeoutMs", 1, 3600000, 8000);
  bindBoundedNumber(`#zotero-prefpane-${ref}-hybrid-keyword-search-timeout`, P + "keywordSearchTimeoutMs", 1000, 3600000, 30000);
  bindBoundedNumber(`#zotero-prefpane-${ref}-hybrid-chunk-target`, P + "chunkTargetChars", 200, 4000, 1000);
  bindBoundedNumber(`#zotero-prefpane-${ref}-hybrid-chunk-tolerance`, P + "chunkAppendToleranceChars", 0, 2000, 500);
  // Inputs per embedding request. Takes effect on the next request, so
  // changing it never invalidates vectors that were already written — unlike
  // the chunk parameters above, which is why there is no stale-index warning.
  bindBoundedNumber(
    `#zotero-prefpane-${ref}-embedding-max-batch-items`,
    "extensions.zotero.zotero-mcp-plugin.embedding.maxBatchItems",
    1,
    2048,
    20,
  );

  const vectorTimeoutInput = doc?.querySelector(
    `#zotero-prefpane-${ref}-hybrid-search-timeout`,
  ) as HTMLInputElement;
  const keywordTimeoutInput = doc?.querySelector(
    `#zotero-prefpane-${ref}-hybrid-keyword-search-timeout`,
  ) as HTMLInputElement;
  const benchmarkButton = doc?.querySelector(
    "#hybrid-scan-benchmark-button",
  ) as HTMLButtonElement;
  const benchmarkResult = doc?.querySelector(
    "#hybrid-scan-benchmark-result",
  ) as HTMLElement;
  benchmarkButton?.addEventListener("click", async () => {
    benchmarkButton.disabled = true;
    const report = (line: string) => {
      if (benchmarkResult) benchmarkResult.textContent = line;
    };
    try {
      const { getVectorStore } = require("./semantic/vectorStore");
      const vectorStore = getVectorStore();
      const libraryID = Zotero.Libraries.userLibraryID;

      // 1. Vector scan: ten runs over every indexed chunk.
      report(
        getString("pref-hybrid-scan-benchmark-running-vector" as any) ||
          "Running vector scans...",
      );
      const vectorResult = await vectorStore.benchmarkLibraryScan();
      const indexedChunks = await vectorStore.getIndexedChunkTotal();

      // 2. Keyword search: three probe profiles derived from this library,
      //    five runs each. Sampling first so the profiles reflect the real
      //    vocabulary rather than a fixed word that happens to be fast.
      report(
        getString("pref-hybrid-scan-benchmark-running-keyword" as any) ||
          "Running keyword searches...",
      );
      const { documentFrequency, sampledItems } =
        await sampleLibraryTerms(libraryID);
      const profiles = buildKeywordProfiles(documentFrequency, sampledItems);
      const keywordResult = await runKeywordSearchBenchmark(
        profiles,
        async (keywords) => {
          const outcome = await runLexicalSearch({
            keywords: keywords.map((text) => ({
              text,
              weight: 1,
              origin: "provided" as const,
            })),
            libraryID,
          });
          // Body coverage travels with the timing so the recommendation can be
          // read together with how much of the branch was actually exercised.
          return {
            candidateItems: outcome.diagnostics.candidateIDs,
            body: {
              indexedDocuments: outcome.diagnostics.body.indexedDocuments,
              postingsRead: outcome.diagnostics.body.postingsRead,
              ms: outcome.diagnostics.body.ms,
              error: outcome.diagnostics.body.error,
            },
          };
        },
        sampledItems,
      );

      // 3. Recommend and persist. The user can still overwrite either box.
      const vectorTimeout = setVectorScanTimeoutMs(
        recommendTimeoutMs(vectorResult),
      );
      const keywordTimeout = setKeywordSearchTimeoutMs(
        recommendTimeoutMs(keywordResult.worst),
      );
      if (vectorTimeoutInput) vectorTimeoutInput.value = String(vectorTimeout);
      if (keywordTimeoutInput)
        keywordTimeoutInput.value = String(keywordTimeout);

      // The measurement is only as complete as the index behind it. Say so
      // rather than quietly recommending a timeout sized for a partial index.
      const coverageLine =
        getString("pref-hybrid-scan-benchmark-coverage" as any, {
          args: { chunks: indexedChunks, items: sampledItems },
        }) || "";

      // Same numbers, laid out as a borderless table: four summary columns,
      // with the coverage note underneath as a small caption.
      renderScanBenchmarkResult(doc, benchmarkResult, {
        rows: [
          {
            label:
              getString("pref-hybrid-scan-benchmark-row-vector" as any) ||
              "Vector scan",
            minMs: vectorResult.minMs,
            averageMs: vectorResult.averageMs,
            maxMs: vectorResult.maxMs,
          },
          {
            label:
              getString("pref-hybrid-scan-benchmark-row-keyword" as any) ||
              "Keyword search",
            minMs: keywordResult.worst.minMs,
            averageMs: keywordResult.worst.averageMs,
            maxMs: keywordResult.worst.maxMs,
          },
        ],
        scope: coverageLine,
      });
    } catch (error) {
      report(
        getString("pref-hybrid-scan-benchmark-error" as any, {
          args: { message: String((error as any)?.message || error) },
        }) || String((error as any)?.message || error),
      );
    } finally {
      benchmarkButton.disabled = false;
    }
  });

  updateChunkStaleWarning(doc);
  updateHybridAdvancedSummary(doc);
}

/** One measured branch of the scan test, as the result block presents it. */
interface ScanBenchmarkRow {
  label: string;
  minMs: number;
  averageMs: number;
  maxMs: number;
}

interface ScanBenchmarkView {
  rows: ScanBenchmarkRow[];
  /** Coverage note: what the numbers above were actually measured against. */
  scope: string;
}

/**
 * Render the scan-test outcome as a borderless, table-like block.
 *
 * This is presentation only — the measurement, the statistics and the timeout
 * recommendation all happen before we get here and are unchanged. What the
 * layout does is drop the run-by-run prose entirely: four aligned columns
 * (test / shortest / average / longest), with the coverage note underneath as
 * a small left-aligned caption.
 *
 * The grid is drawn with `minmax(0, ...)` columns and no rules or vertical
 * dividers, so a long label wraps inside its own cell instead of pushing the
 * block wider than the setting rows above it.
 */
function renderScanBenchmarkResult(
  doc: Document,
  container: HTMLElement | null,
  view: ScanBenchmarkView,
): void {
  if (!container) return;
  container.textContent = "";

  const table = doc.createElement("div");
  table.className = "zmp-rt";

  const appendRow = (cells: string[], isHeader: boolean) => {
    const row = doc.createElement("div");
    row.className = isHeader ? "zmp-rt-r zmp-rt-h" : "zmp-rt-r";
    cells.forEach((text, column) => {
      const cell = doc.createElement("div");
      // Every cell is centred; the class only picks weight for the label
      // column and tabular digits for the three measurement columns.
      cell.className = isHeader
        ? "zmp-rt-c"
        : `zmp-rt-c ${column === 0 ? "zmp-rt-k" : "zmp-rt-n"}`;
      cell.textContent = text;
      row.appendChild(cell);
    });
    table.appendChild(row);
  };

  appendRow(
    [
      getString("pref-hybrid-scan-benchmark-col-item" as any) || "Test",
      getString("pref-hybrid-scan-benchmark-col-min" as any) || "Shortest (ms)",
      getString("pref-hybrid-scan-benchmark-col-average" as any) ||
        "Average (ms)",
      getString("pref-hybrid-scan-benchmark-col-max" as any) || "Longest (ms)",
    ],
    true,
  );
  for (const row of view.rows) {
    appendRow(
      [
        row.label,
        row.minMs.toFixed(1),
        row.averageMs.toFixed(1),
        row.maxMs.toFixed(1),
      ],
      false,
    );
  }
  container.appendChild(table);

  if (view.scope) {
    const scope = doc.createElement("div");
    scope.className = "zmp-rt-scope";
    const labelText = getString(
      "pref-hybrid-scan-benchmark-scope-label" as any,
    );
    if (labelText) {
      // A separate line rather than "label: text" — the two would need a
      // different separator in CJK than in the Latin locales.
      const label = doc.createElement("div");
      label.className = "zmp-rt-scope-l";
      label.textContent = labelText;
      scope.appendChild(label);
    }
    const body = doc.createElement("div");
    body.textContent = view.scope;
    scope.appendChild(body);
    container.appendChild(scope);
  }
}

/**
 * Collapsed-panel summary: the two chunk values, so the user can see what the
 * index was meant to be built with without opening the panel.
 */
function updateHybridAdvancedSummary(doc: Document) {
  const summary = doc?.querySelector("#hybrid-advanced-summary") as HTMLElement;
  if (!summary) return;
  const settings = getHybridSearchSettings();
  summary.textContent = `${settings.chunkTargetChars} / ${settings.chunkAppendToleranceChars}`;
}

/**
 * Show the "rebuild your index" notice when the stored index was built with a
 * different chunk layout than the current settings would produce.
 */
async function updateChunkStaleWarning(doc: Document): Promise<void> {
  const warning = doc?.querySelector("#hybrid-chunk-stale-warning") as HTMLElement;
  if (!warning) return;
  warning.style.display = "none";
  try {
    const libraryID = Zotero.Libraries.userLibraryID;
    const { getVectorStore } = require("./semantic/vectorStore");
    const vectorStore = getVectorStore();
    await vectorStore.initialize();
    const counts = await vectorStore.getLibraryDataCounts(libraryID);
    const stored = getStoredChunkingSignature(libraryID);
    const stale = shouldShowChunkingWarning({
      ...counts,
      storedSignature: stored,
      currentSignature: getChunkingSignature(),
      incomplete: hasIncompleteFullLibraryRebuild(libraryID),
      legacyUntrusted: hasUntrustedLegacyChunkingSignature(libraryID),
    });
    // Explicitly "flex", not "": the banner's class carries display:none, so
    // clearing the inline style would leave it hidden forever.
    warning.style.display = stale ? "flex" : "none";
    if (stale) {
      // Reveal the settings the warning is about; the banner sits outside the
      // panel so it is visible even while the panel is collapsed.
      const panel = doc?.querySelector("#hybrid-advanced-panel") as HTMLElement;
      panel?.classList.add("open");
    }
  } catch (error) {
    ztoolkit.log(
      `[PreferenceScript] Could not evaluate chunking signature: ${error}`,
      "warn",
    );
    warning.style.display = "none";
  }
}

/**
 * MinerU 高精度 PDF 解析设置
 * - 总开关控制下方配置区显隐
 * - 切换 cloud/local 时自动纠正 base URL 并显隐 Token 输入
 * - 测试连接 / 查看与清空解析缓存
 */
function bindMinerUSettings(doc: Document) {
  const P = "extensions.zotero.zotero-mcp-plugin.mineru.";
  const ref = config.addonRef;

  const modeSelect = doc?.querySelector(`#zotero-prefpane-${ref}-mineru-mode`) as HTMLSelectElement;
  const baseUrlInput = doc?.querySelector(`#zotero-prefpane-${ref}-mineru-base-url`) as HTMLInputElement;
  const tokenRow = doc?.querySelector('#mineru-token-row') as HTMLElement;
  const testButton = doc?.querySelector('#test-mineru-button') as HTMLButtonElement;
  const testResult = doc?.querySelector('#mineru-test-result') as HTMLElement;
  const modelSelect = doc?.querySelector(`#zotero-prefpane-${ref}-mineru-model-version`) as HTMLSelectElement;
  const hybridOption = doc?.querySelector('#mineru-model-hybrid-option') as HTMLOptionElement;
  const ocrRow = doc?.querySelector('#mineru-ocr-row') as HTMLElement;
  const languageRow = doc?.querySelector('#mineru-language-row') as HTMLElement;
  const vlmHint = doc?.querySelector('#mineru-vlm-hint') as HTMLElement;
  const languageInput = doc?.querySelector(`#zotero-prefpane-${ref}-mineru-language`) as HTMLInputElement;
  const cacheSummary = doc?.querySelector('#mineru-cache-summary') as HTMLElement;
  const cacheResult = doc?.querySelector('#mineru-cache-result') as HTMLElement;
  const refreshCacheButton = doc?.querySelector('#refresh-mineru-cache-button') as HTMLButtonElement;
  const clearCacheButton = doc?.querySelector('#clear-mineru-cache-button') as HTMLButtonElement;
  const clearMarkdownButton = doc?.querySelector('#clear-mineru-markdown-button') as HTMLButtonElement;

  const CLOUD_URL = "https://mineru.net";
  const LOCAL_URL = "http://127.0.0.1:8000";

  // VLM 后端整页视觉解析，不吃 parse_method 与 OCR 语言，对应控件置灰
  const applyModelCapabilities = () => {
    const isVLM = (modelSelect?.value || 'vlm') === 'vlm';
    const ocrCheckbox = doc?.querySelector(
      `#zotero-prefpane-${ref}-mineru-enable-ocr`,
    ) as HTMLInputElement;
    if (ocrCheckbox) ocrCheckbox.disabled = isVLM;
    if (languageInput) languageInput.disabled = isVLM;
    ocrRow?.classList.toggle('zmp-inert', isVLM);
    languageRow?.classList.toggle('zmp-inert', isVLM);
    if (vlmHint) vlmHint.style.display = isVLM ? '' : 'none';
  };

  // 模式切换：同步纠正 base URL，并显隐 Token 行
  const applyMode = (mode: string) => {
    if (tokenRow) tokenRow.style.display = mode === 'local' ? 'none' : '';
    // 云端 model_version 只有 pipeline / vlm / MinerU-HTML，没有 hybrid
    if (hybridOption) {
      hybridOption.hidden = mode !== 'local';
      hybridOption.disabled = mode !== 'local';
    }
    if (mode !== 'local' && modelSelect?.value === 'hybrid') {
      modelSelect.value = 'vlm';
      Zotero.Prefs.set(`${P}modelVersion`, 'vlm', true);
    }
    applyModelCapabilities();
    if (baseUrlInput) {
      const current = (baseUrlInput.value || '').trim().replace(/\/+$/, '');
      if (!current || current === CLOUD_URL || current === LOCAL_URL) {
        const next = mode === 'local' ? LOCAL_URL : CLOUD_URL;
        baseUrlInput.value = next;
        Zotero.Prefs.set(`${P}baseURL`, next, true);
      }
      baseUrlInput.placeholder = mode === 'local' ? LOCAL_URL : CLOUD_URL;
    }
  };

  // Restore the persisted URL before applyMode inspects the input. Zotero's
  // preference binding may not have populated HTML controls at panel load time.
  bindHtmlInput(doc, `#zotero-prefpane-${ref}-mineru-base-url`, `${P}baseURL`);

  if (modeSelect) {
    const savedMode = (Zotero.Prefs.get(`${P}mode`, true) as string) || 'cloud';
    modeSelect.value = savedMode;
    applyMode(savedMode);
    modeSelect.addEventListener('change', () => {
      Zotero.Prefs.set(`${P}mode`, modeSelect.value, true);
      applyMode(modeSelect.value);
    });
  }

  bindHtmlInput(doc, `#zotero-prefpane-${ref}-mineru-api-token`, `${P}apiToken`);
  bindHtmlSelect(doc, `#zotero-prefpane-${ref}-mineru-model-version`, `${P}modelVersion`);
  modelSelect?.addEventListener('change', applyModelCapabilities);
  bindHtmlInput(doc, `#zotero-prefpane-${ref}-mineru-language`, `${P}language`);
  bindHtmlCheckbox(doc, `#zotero-prefpane-${ref}-mineru-enable-ocr`, `${P}enableOCR`);
  bindHtmlCheckbox(doc, `#zotero-prefpane-${ref}-mineru-enable-formula`, `${P}enableFormula`);
  bindHtmlCheckbox(doc, `#zotero-prefpane-${ref}-mineru-enable-table`, `${P}enableTable`);
  bindHtmlInput(doc, `#zotero-prefpane-${ref}-mineru-concurrency`, `${P}concurrency`, true);
  bindHtmlInput(doc, `#zotero-prefpane-${ref}-mineru-timeout`, `${P}timeoutSeconds`, true);
  bindHtmlInput(doc, `#zotero-prefpane-${ref}-mineru-max-size`, `${P}maxFileSizeMB`, true);
  bindHtmlCheckbox(doc, `#zotero-prefpane-${ref}-mineru-blocking-on-demand`, `${P}blockingOnDemand`);

  // bindHtmlCheckbox 对未设置过的布尔项默认勾选，OCR 默认应为关闭
  const ocrCheckbox = doc?.querySelector(`#zotero-prefpane-${ref}-mineru-enable-ocr`) as HTMLInputElement;
  if (ocrCheckbox) {
    ocrCheckbox.checked = Zotero.Prefs.get(`${P}enableOCR`, true) === true;
  }
  const blockingCheckbox = doc?.querySelector(`#zotero-prefpane-${ref}-mineru-blocking-on-demand`) as HTMLInputElement;
  if (blockingCheckbox) {
    blockingCheckbox.checked = Zotero.Prefs.get(`${P}blockingOnDemand`, true) === true;
  }

  // bindHtmlSelect 在上面才把偏好值写回 modelSelect，初始化时 applyMode 读到的
  // 还是 DOM 默认值，所以这里再纠正一次「云端 + hybrid」这种不存在的组合。
  if (
    modelSelect?.value === 'hybrid' &&
    ((modeSelect?.value as string) || 'cloud') !== 'local'
  ) {
    modelSelect.value = 'vlm';
    Zotero.Prefs.set(`${P}modelVersion`, 'vlm', true);
  }
  applyModelCapabilities();

  // 测试连接
  if (testButton && testResult) {
    testButton.addEventListener('click', async () => {
      testButton.disabled = true;
      testResult.textContent = getString('pref-mineru-testing');
      testResult.style.color = 'var(--text-2)';
      try {
        const { getMinerUService } = await import('./mineru');
        const result = await getMinerUService().testConnection();
        testResult.textContent = result.message;
        testResult.style.color = result.ok ? 'var(--green)' : 'var(--red)';
      } catch (error) {
        testResult.textContent = String(error);
        testResult.style.color = 'var(--red)';
      } finally {
        testButton.disabled = false;
      }
    });
  }

  // 缓存统计
  const refreshCacheStats = async () => {
    try {
      const { getMinerUService } = await import('./mineru');
      const stats = await getMinerUService().getCacheStats();
      const mb = (stats.bytes / 1024 / 1024).toFixed(1);
      if (cacheSummary) cacheSummary.textContent = `${stats.entries} 篇 · ${mb} MB`;
      if (cacheResult) {
        cacheResult.textContent = `${stats.entries} 篇 · ${mb} MB`;
        cacheResult.style.color = 'var(--text-2)';
      }
    } catch (error) {
      ztoolkit.log(`[PreferenceScript] MinerU cache stats failed: ${error}`, 'warn');
    }
  };
  refreshCacheStats();
  refreshCacheButton?.addEventListener('click', () => { refreshCacheStats(); });

  clearCacheButton?.addEventListener('click', async () => {
    const win = addon.data.prefs?.window;
    if (win && !win.confirm(getString('pref-mineru-cache-clear-confirm'))) {
      return;
    }
    try {
      const { getMinerUService } = await import('./mineru');
      await getMinerUService().clearCache();
      if (cacheResult) {
        cacheResult.textContent = getString('pref-mineru-cache-cleared');
        cacheResult.style.color = 'var(--green)';
      }
      refreshCacheStats();
    } catch (error) {
      if (cacheResult) {
        cacheResult.textContent = String(error);
        cacheResult.style.color = 'var(--red)';
      }
    }
  });

  // Deleting the generated Markdown is deliberately a separate action from
  // clearing the parse cache: the cache is what makes regeneration free, so
  // the two are almost never wanted together.
  clearMarkdownButton?.addEventListener('click', async () => {
    const win = addon.data.prefs?.window;
    if (win && !win.confirm(getString('pref-mineru-markdown-clear-confirm' as any))) {
      return;
    }
    const previousLabel = clearMarkdownButton.textContent;
    clearMarkdownButton.disabled = true;
    try {
      const { getMinerUService } = await import('./mineru');
      const { removed, failed } = await getMinerUService()
        .clearGeneratedMarkdownAttachments();
      if (cacheResult) {
        if (failed > 0) {
          cacheResult.textContent = getString(
            'pref-mineru-markdown-clear-partial' as any,
            { args: { count: removed, failed } },
          );
          cacheResult.style.color = 'var(--red)';
        } else if (removed === 0) {
          cacheResult.textContent = getString(
            'pref-mineru-markdown-clear-none' as any,
          );
          cacheResult.style.color = 'var(--text-2)';
        } else {
          cacheResult.textContent = getString(
            'pref-mineru-markdown-cleared' as any,
            { args: { count: removed } },
          );
          cacheResult.style.color = 'var(--green)';
        }
      }
    } catch (error) {
      if (cacheResult) {
        cacheResult.textContent = String(error);
        cacheResult.style.color = 'var(--red)';
      }
    } finally {
      clearMarkdownButton.disabled = false;
      clearMarkdownButton.textContent = previousLabel;
    }
  });
}

/**
 * 集成版 PDF 翻译设置面板由 mark-reader 子系统提供，
 * 首选项窗口就绪后把它挂到本插件的设置根节点上。
 */
function initIntegratedTranslationPreferences(win: Window) {
  const tryInit = () => {
    try {
      const helper = (win as any)?.Zotero_Preferences?.ZoteroMarkReaderPreferences || (win as any)?.ZoteroMarkReaderPreferences;
      const rootNode = win?.document?.querySelector('#zotero-mcp-plugin-preferences');
      if (!helper?.init || !rootNode) return false;
      helper.init(rootNode);
      ztoolkit.log("[PreferenceScript] Integrated PDF translation settings initialized");
      return true;
    } catch (error) {
      ztoolkit.log(`[PreferenceScript] Translation settings initialization failed: ${error}`, "error");
      return false;
    }
  };

  if (!tryInit()) {
    trackedSetTimeout(tryInit, 0);
    trackedSetTimeout(tryInit, 250);
  }
}

/**
 * LLM / 翻译相关偏好绑定
 */
function bindTranslationSettings(doc: Document) {
  const L = "extensions.zotero.zotero-mcp-plugin.llm.";
  const T = "extensions.zotero.zotero-mcp-plugin.translation.";

  bindHtmlInput(doc, '#zmr-llm-provider', `${L}provider`);
  bindHtmlInput(doc, '#zmr-llm-base-url', `${L}baseURL`);
  bindHtmlInput(doc, '#zmr-llm-api-key', `${L}apiKey`);
  bindHtmlInput(doc, '#zmr-llm-model', `${L}model`);
  bindHtmlSelect(doc, '#zmr-llm-language', `${L}targetLanguage`);
  bindHtmlCheckbox(doc, '#zmr-translation-context-enabled', `${T}contextEnabled`);
  bindHtmlCheckbox(doc, '#zmr-translation-auto-document-glossary', `${T}autoDocumentGlossary`);
  bindHtmlCheckbox(doc, '#zmr-translation-use-global-glossary', `${T}useGlobalGlossary`);
  bindHtmlSelect(doc, '#zmr-translation-expert', `${T}expertMode`);
  bindHtmlInput(doc, '#zmr-translation-expert-custom', `${T}expertCustom`);
  bindHtmlInput(doc, '#zmr-translation-batch-size', `${T}batchSize`, true);
  bindHtmlInput(doc, '#zmr-translation-concurrency', `${T}concurrency`, true);
  bindHtmlInput(doc, '#zmr-translation-retries', `${T}maxRetries`, true);
}

/**
 * Update server-dependent UI visibility (cascade hiding)
 */
function updateServerDependentUI(doc: Document, enabled: boolean) {
  const serverContent = doc?.querySelector('#server-dependent-content') as HTMLElement;
  const serverOffHint = doc?.querySelector('#server-off-hint') as HTMLElement;
  const portRow = doc?.querySelector('#server-port-row') as HTMLElement;
  const remoteRow = doc?.querySelector('#server-remote-row') as HTMLElement;
  const tokenRow = doc?.querySelector('#server-token-row') as HTMLElement;

  if (serverContent) serverContent.style.display = enabled ? '' : 'none';
  if (serverOffHint) serverOffHint.style.display = enabled ? 'none' : 'block';
  if (portRow) portRow.style.display = enabled ? '' : 'none';
  if (remoteRow) remoteRow.style.display = enabled ? '' : 'none';
  if (tokenRow) tokenRow.style.display = enabled ? '' : 'none';
}

/**
 * Bind collapsible panel toggle logic
 */
function bindCollapsiblePanels(doc: Document) {
  const panels = [
    { toggle: '#rate-limit-toggle', panel: '#rate-limit-panel' },
    { toggle: '#detail-stats-toggle', panel: '#detail-stats-panel' },
    { toggle: '#hybrid-advanced-toggle', panel: '#hybrid-advanced-panel' },
    { toggle: '#mineru-advanced-toggle', panel: '#mineru-advanced-panel' },
    { toggle: '#translation-prompt-toggle', panel: '#translation-prompt-panel' },
    { toggle: '#translation-glossary-toggle', panel: '#translation-glossary-panel' },
    { toggle: '#translation-performance-toggle', panel: '#translation-performance-panel' },
  ];

  for (const { toggle, panel } of panels) {
    const toggleEl = doc?.querySelector(toggle) as HTMLElement;
    const panelEl = doc?.querySelector(panel) as HTMLElement;
    if (toggleEl && panelEl) {
      toggleEl.addEventListener('click', () => {
        panelEl.classList.toggle('open');
      });
    }
  }
}

/**
 * Update rate limit summary text in collapsible header
 */
function updateRateLimitSummary(doc: Document) {
  const rpmInput = doc?.querySelector(`#zotero-prefpane-${config.addonRef}-embedding-rpm`) as HTMLInputElement;
  const costInput = doc?.querySelector(`#zotero-prefpane-${config.addonRef}-embedding-cost`) as HTMLInputElement;
  const summaryEl = doc?.querySelector('#rate-limit-summary') as HTMLElement;

  const update = () => {
    if (!summaryEl) return;
    const rpm = rpmInput?.value || '60';
    const cost = costInput?.value || '0.02';
    summaryEl.textContent = `RPM ${rpm} · $${cost}/M`;
  };

  update();
  rpmInput?.addEventListener('change', update);
  costInput?.addEventListener('change', update);
}

const PREF_SERVER_ENABLED = 'extensions.zotero.zotero-mcp-plugin.mcp.server.enabled';

// Module-level flag: suppress logging during auto-refresh
let _silentRefresh = false;

/**
 * Repaint the index statistics, set by the index-stats binder.
 *
 * The API usage panel and the index panel are bound by two separate functions
 * that share no scope, and "Reset stats" lives in the first while both indexes'
 * numbers live in the second. Null until the index panel is bound, which is
 * why every call site uses `?.()`.
 */
let refreshIndexStatsAfterUsageReset: (() => void) | null = null;

// Embedding provider presets - only apiBase and hints, model/dimensions filled by user
const EMBEDDING_PROVIDER_PRESETS: Record<string, { apiBase: string; modelPlaceholder: string; needsApiKey: boolean }> = {
  openai: {
    apiBase: "https://api.openai.com/v1",
    modelPlaceholder: "text-embedding-3-small",
    needsApiKey: true
  },
  google: {
    apiBase: "https://generativelanguage.googleapis.com/v1beta/openai",
    modelPlaceholder: "gemini-embedding-001",
    needsApiKey: true
  },
  alibaba: {
    apiBase: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    modelPlaceholder: "text-embedding-v3",
    needsApiKey: true
  },
  zhipu: {
    apiBase: "https://open.bigmodel.cn/api/paas/v4",
    modelPlaceholder: "embedding-3",
    needsApiKey: true
  },
  openrouter: {
    apiBase: "https://openrouter.ai/api/v1",
    modelPlaceholder: "openai/text-embedding-3-small",
    needsApiKey: true
  },
  siliconflow: {
    apiBase: "https://api.siliconflow.cn/v1",
    modelPlaceholder: "BAAI/bge-m3",
    needsApiKey: true
  },
  voyage: {
    apiBase: "https://api.voyageai.com/v1",
    modelPlaceholder: "voyage-3-lite",
    needsApiKey: true
  },
  ollama: {
    apiBase: "http://localhost:11434/v1",
    modelPlaceholder: "nomic-embed-text",
    needsApiKey: false
  }
};

/**
 * Bind embedding API settings handlers
 */
function bindEmbeddingSettings(doc: Document) {
  const providerSelect = doc?.querySelector(`#zotero-prefpane-${config.addonRef}-embedding-provider`) as HTMLSelectElement;
  const apiBaseInput = doc?.querySelector(`#zotero-prefpane-${config.addonRef}-embedding-api-base`) as HTMLInputElement;
  const apiKeyInput = doc?.querySelector(`#zotero-prefpane-${config.addonRef}-embedding-api-key`) as HTMLInputElement;
  const modelInput = doc?.querySelector(`#zotero-prefpane-${config.addonRef}-embedding-model`) as HTMLInputElement;
  const dimensionsInput = doc?.querySelector(`#zotero-prefpane-${config.addonRef}-embedding-dimensions`) as HTMLInputElement;
  const dimensionsRow = dimensionsInput?.closest('.zmp-fg') || dimensionsInput?.parentElement;
  const timeoutInput = doc?.querySelector(`#zotero-prefpane-${config.addonRef}-embedding-timeout`) as HTMLInputElement;
  const testButton = doc?.querySelector("#test-embedding-button") as HTMLButtonElement;
  const testResult = doc?.querySelector("#embedding-test-result") as HTMLSpanElement;

  // Detect current provider from saved apiBase
  const detectProvider = (apiBase: string): string => {
    for (const [key, preset] of Object.entries(EMBEDDING_PROVIDER_PRESETS)) {
      try {
        if (apiBase && apiBase.includes(new URL(preset.apiBase).hostname)) {
          return key;
        }
      } catch {
        // Invalid URL, continue
      }
    }
    return "custom";
  };

  // Initialize provider select from saved apiBase
  if (providerSelect) {
    const savedApiBase = Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.embedding.apiBase", true) as string;
    providerSelect.value = detectProvider(savedApiBase || "");
  }

  // Initialize input values from preferences
  const initValue = (input: HTMLInputElement, prefKey: string, defaultValue: string) => {
    if (input) {
      const value = Zotero.Prefs.get(prefKey, true);
      input.value = value ? String(value) : defaultValue;
    }
  };

  initValue(apiBaseInput, "extensions.zotero.zotero-mcp-plugin.embedding.apiBase", "https://api.openai.com/v1");
  initValue(apiKeyInput, "extensions.zotero.zotero-mcp-plugin.embedding.apiKey", "");
  initValue(modelInput, "extensions.zotero.zotero-mcp-plugin.embedding.model", "text-embedding-3-small");
  initValue(dimensionsInput, "extensions.zotero.zotero-mcp-plugin.embedding.dimensions", "512");

  // API endpoint preview
  const endpointPreview = doc?.querySelector("#embedding-api-endpoint-preview") as HTMLElement;
  const updateEndpointPreview = () => {
    if (!endpointPreview) return;
    const base = apiBaseInput?.value?.trim() || "";
    if (base) {
      const sep = base.endsWith("/") ? "" : "/";
      endpointPreview.textContent = `→ ${base}${sep}embeddings`;
    } else {
      endpointPreview.textContent = "";
    }
  };
  updateEndpointPreview();
  apiBaseInput?.addEventListener("input", updateEndpointPreview);
  apiBaseInput?.addEventListener("change", updateEndpointPreview);

  // Check if model supports custom dimensions. Must stay aligned with the
  // service-side whitelist in embeddingService.ts (supportsDimensions);
  // Ollama-served MRL models (e.g. qwen3-embedding) accept dimensions via
  // the native /api/embed body, so allow manual entry for them too (#62)
  const supportsCustomDimensions = (model: string) => {
    const m = model.toLowerCase();
    return m.includes('text-embedding-3') || m.includes('text-embedding-v3') ||
      m.includes('text-embedding-v4') || m.includes('qwen3-embedding') ||
      m.includes('embeddinggemma') || m.includes('nomic-embed');
  };

  // Update dimensions input visibility based on model
  const updateDimensionsVisibility = () => {
    const model = modelInput?.value || "";
    const supportsCustom = supportsCustomDimensions(model);

    if (dimensionsInput) {
      dimensionsInput.dataset.modelSupportsCustom = String(supportsCustom);
      dimensionsInput.disabled =
        dimensionsInput.dataset.compatibilityLocked === "true" ||
        !supportsCustom;
      if (!supportsCustom) {
        dimensionsInput.placeholder = getString("pref-embedding-dimensions-auto" as any) || "Auto";
      } else {
        dimensionsInput.placeholder = "";
      }
    }

    // Show hint text about dimensions
    if (dimensionsRow && testResult) {
      if (!supportsCustom) {
        // For non-supporting models, show info about auto-detection
        const detectedDims = Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.embedding.detectedDimensions", true);
        if (detectedDims) {
          testResult.textContent = `${getString("pref-embedding-detected-dims" as any) || "Detected dimensions"}: ${detectedDims}`;
          testResult.style.color = "var(--color-muted)";
        }
      }
    }
  };

  // Initial visibility update
  updateDimensionsVisibility();

  // Handle provider preset selection change
  if (providerSelect) {
    providerSelect.addEventListener("change", () => {
      const provider = providerSelect.value;
      if (provider !== "custom" && EMBEDDING_PROVIDER_PRESETS[provider]) {
        const preset = EMBEDDING_PROVIDER_PRESETS[provider];

        // Only fill in API Base URL
        if (apiBaseInput) {
          apiBaseInput.value = preset.apiBase;
          Zotero.Prefs.set("extensions.zotero.zotero-mcp-plugin.embedding.apiBase", preset.apiBase, true);
        }

        // Update model placeholder hint (don't change the value)
        if (modelInput) {
          modelInput.placeholder = preset.modelPlaceholder;
        }

        // Update API key placeholder hint based on whether it's needed
        if (apiKeyInput) {
          apiKeyInput.placeholder = preset.needsApiKey ? "sk-..." : getString("pref-embedding-api-key-optional" as any) || "(Optional)";
        }

        // Update embedding service config
        updateEmbeddingServiceConfig();

        // Update endpoint preview
        updateEndpointPreview();

        ztoolkit.log(`[PreferenceScript] Applied provider preset: ${provider}`);
      }
    });
  }

  // Save preference on change
  const bindSave = (
    input: HTMLInputElement,
    prefKey: string,
    isNumber = false,
    locksEmbeddingIdentity = false,
  ) => {
    input?.addEventListener("change", async () => {
      if (
        locksEmbeddingIdentity &&
        (await getDataCompatibilityState()).embeddingIdentityLocked
      ) {
        input.value = String(Zotero.Prefs.get(prefKey, true) ?? "");
        await refreshDataCompatibilityLockUI(doc);
        return;
      }
      const value = isNumber ? parseInt(input.value, 10) : input.value;
      Zotero.Prefs.set(prefKey, value, true);
      ztoolkit.log(`[PreferenceScript] Saved embedding pref: ${prefKey} = ${value}`);

      // Update embedding service config
      updateEmbeddingServiceConfig();
    });
  };

  bindSave(apiBaseInput, "extensions.zotero.zotero-mcp-plugin.embedding.apiBase");
  bindSave(apiKeyInput, "extensions.zotero.zotero-mcp-plugin.embedding.apiKey");
  bindSave(
    dimensionsInput,
    "extensions.zotero.zotero-mcp-plugin.embedding.dimensions",
    true,
    true,
  );
  bindSave(timeoutInput, "extensions.zotero.zotero-mcp-plugin.embedding.timeoutSeconds", true);

  // Model change handler - update dimensions visibility and clear detected dimensions
  modelInput?.addEventListener("change", async () => {
    if ((await getDataCompatibilityState()).embeddingIdentityLocked) {
      modelInput.value = String(
        Zotero.Prefs.get(
          "extensions.zotero.zotero-mcp-plugin.embedding.model",
          true,
        ) || "text-embedding-3-small",
      );
      await refreshDataCompatibilityLockUI(doc);
      return;
    }
    const model = modelInput.value;
    Zotero.Prefs.set("extensions.zotero.zotero-mcp-plugin.embedding.model", model, true);
    ztoolkit.log(`[PreferenceScript] Saved embedding pref: model = ${model}`);

    // Clear detected dimensions when model changes
    try {
      const { getEmbeddingService } = require("./semantic/embeddingService");
      const embeddingService = getEmbeddingService();
      embeddingService.clearDetectedDimensions();
    } catch (e) {
      // Ignore
    }

    // Check if there are existing indexed vectors - warn user about potential incompatibility
    try {
      const { getVectorStore } = require("./semantic/vectorStore");
      const vectorStore = getVectorStore();
      await vectorStore.initialize();
      const stats = await vectorStore.getStats();
      if (stats.totalVectors > 0) {
        // Show warning alert
        addon.data.prefs!.window.alert(
          getString("pref-embedding-model-change-warning" as any) ||
          "模型已更改，已有索引可能不兼容。请测试连接后重建索引。\n\nModel changed. Existing index may be incompatible. Please test connection and rebuild index."
        );
      }
    } catch (e) {
      ztoolkit.log(`[PreferenceScript] Failed to check existing index: ${e}`, 'warn');
    }

    // Update visibility
    updateDimensionsVisibility();

    // Update embedding service config
    updateEmbeddingServiceConfig();
  });

  // Test connection button
  testButton?.addEventListener("click", async () => {
    testResult.textContent = getString("pref-embedding-testing" as any) || "Testing...";
    testResult.style.color = "var(--color-muted)";
    testButton.disabled = true;

    try {
      // Get current values from inputs (not saved prefs) for testing
      const apiBase = apiBaseInput?.value?.trim() || "";
      const apiKey = apiKeyInput?.value || "";
      const model = modelInput?.value?.trim() || "";

      if (!apiBase || !model) {
        testResult.textContent = getString("pref-embedding-test-failed" as any) + ": Missing API Base or Model";
        testResult.style.color = "var(--color-error)";
        testButton.disabled = false;
        return;
      }

      // Test the connection using Zotero.HTTP
      const url = `${apiBase}/embeddings`;
      const response = await Zotero.HTTP.request('POST', url, {
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify({
          model: model,
          input: ["test"],
          // Send the same dimensions indexing will use, otherwise detected
          // dims diverge from index dims into a permanent mismatch (#62)
          ...((supportsCustomDimensions(model) && parseInt(dimensionsInput?.value || "", 10) > 0)
            ? { dimensions: parseInt(dimensionsInput.value, 10) } : {})
        }),
        timeout: (getEmbeddingTimeoutSeconds() || 30) * 1000,
        responseType: 'json',
        successCodes: false // Don't throw on non-2xx, let us handle it
      } as any);

      // Check HTTP status
      if (response.status < 200 || response.status >= 300) {
        let responseBody = "";
        try {
          responseBody = typeof response.response === 'object'
            ? JSON.stringify(response.response, null, 2)
            : (response.responseText || String(response.response || ""));
        } catch { responseBody = response.responseText || ""; }

        const code = response.status;
        const hints: Record<number, string> = {
          401: getString("pref-embedding-test-error-401" as any) || "Authentication failed - check your API key",
          403: getString("pref-embedding-test-error-403" as any) || "Access forbidden - check API key permissions",
          404: getString("pref-embedding-test-error-404" as any) || "Endpoint not found - check API base URL",
          429: getString("pref-embedding-test-error-429" as any) || "Rate limited - try again later",
          500: getString("pref-embedding-test-error-5xx" as any) || "Server error - try again later",
          502: getString("pref-embedding-test-error-5xx" as any) || "Server error - try again later",
          503: getString("pref-embedding-test-error-5xx" as any) || "Server error - try again later",
        };
        const hint = `HTTP ${code}: ${hints[code] || "Request failed"}`;

        testResult.innerHTML = "";
        const hintSpan = doc.createElement("span");
        hintSpan.textContent = `${getString("pref-embedding-test-failed" as any)} ${hint}`;
        hintSpan.style.color = "var(--color-error)";
        testResult.appendChild(hintSpan);

        if (responseBody) {
          const detailWrap = doc.createElement("details");
          detailWrap.style.cssText = "margin-top:4px; font-size:11px; color:var(--text-2);";
          const summary = doc.createElement("summary");
          summary.textContent = getString("pref-embedding-test-error-detail" as any) || "Show raw response";
          summary.style.cssText = "cursor:pointer; color:var(--text-3); user-select:none;";
          const pre = doc.createElement("pre");
          pre.textContent = responseBody;
          pre.style.cssText = "margin:4px 0 0; white-space:pre-wrap; word-break:break-all; font-size:11px; font-family:'SF Mono',Consolas,monospace; background:var(--bg-muted); padding:6px 8px; border-radius:4px; max-height:200px; overflow-y:auto; color:var(--text);";
          detailWrap.appendChild(summary);
          detailWrap.appendChild(pre);
          testResult.appendChild(detailWrap);
        }

        testButton.disabled = false;
        ztoolkit.log(`[PreferenceScript] Embedding test failed: HTTP ${code} - ${responseBody}`, "warn");
        return;
      }

      const data = response.response;
      if (data && data.data && data.data.length > 0) {
        const dims = data.data[0].embedding?.length || 0;

        // Check if stored vectors have different dimensions
        let storedDims: number | null = null;
        let hasStoredVectors = false;
        try {
          const { getVectorStore } = require("./semantic/vectorStore");
          const vectorStore = getVectorStore();
          await vectorStore.initialize();
          const stats = await vectorStore.getStats();
          storedDims = stats.storedDimensions || null;
          hasStoredVectors = stats.totalVectors > 0;
        } catch (e) {
          // Ignore errors checking stored dimensions
        }

        // Decide whether to update dimensions based on stored vectors
        const embeddingIdentityLocked = (
          await getDataCompatibilityState()
        ).embeddingIdentityLocked;
        const embeddingLocks = deriveEmbeddingPreferenceLocks(
          embeddingIdentityLocked,
        );
        if (hasStoredVectors && storedDims && storedDims !== dims) {
          // Dimension mismatch with existing index - warn but don't auto-update
          testResult.textContent = `${getString("pref-embedding-test-success" as any)} (${dims} dims) - ⚠️ ${getString("pref-embedding-dimension-mismatch" as any) || `Index has ${storedDims} dims, API returns ${dims} dims. Rebuild index to use new dimensions.`}`;
          testResult.style.color = "var(--color-warn)";

          if (!embeddingLocks.detectedDimensions) {
            Zotero.Prefs.set("extensions.zotero.zotero-mcp-plugin.embedding.detectedDimensions", dims, true);
          }
        } else {
          // No mismatch or no existing vectors - safe to update
          testResult.textContent = getString("pref-embedding-test-success" as any) + ` (${dims} dims)`;
          testResult.style.color = "var(--color-ok)";

          // Update dimensions
          if (dims > 0) {
            if (!embeddingLocks.detectedDimensions) {
              Zotero.Prefs.set("extensions.zotero.zotero-mcp-plugin.embedding.detectedDimensions", dims, true);
            }

            // Only update config dimensions for models that support custom dimensions
            if (
              supportsCustomDimensions(model) &&
              dimensionsInput &&
              !embeddingLocks.dimensions
            ) {
              dimensionsInput.value = String(dims);
              Zotero.Prefs.set("extensions.zotero.zotero-mcp-plugin.embedding.dimensions", dims, true);
            }

            // Update embedding service
            if (!embeddingLocks.dimensions) {
              try {
                const { getEmbeddingService } = require("./semantic/embeddingService");
                const embeddingService = getEmbeddingService();
                embeddingService.updateConfig({ dimensions: dims });
              } catch (e) {
                // Ignore
              }
            }
          }
        }
      } else {
        testResult.textContent = getString("pref-embedding-test-failed" as any) + ": Invalid response";
        testResult.style.color = "var(--color-error)";
      }
    } catch (error: any) {
      // Network / timeout / other non-HTTP errors
      const fullMsg = error.message || error.status || String(error);

      // Try to extract response body if available on the error object
      let responseBody = "";
      try {
        if (error.xmlhttp) {
          responseBody = error.xmlhttp.responseText || "";
        } else if (error.responseText) {
          responseBody = error.responseText;
        }
      } catch { /* ignore */ }

      // Extract HTTP status code from error message
      const statusMatch = fullMsg.match(/status code (\d+)/);
      let hint = "";
      if (statusMatch) {
        const code = parseInt(statusMatch[1], 10);
        const hints: Record<number, string> = {
          401: getString("pref-embedding-test-error-401" as any) || "Authentication failed - check your API key",
          403: getString("pref-embedding-test-error-403" as any) || "Access forbidden - check API key permissions",
          404: getString("pref-embedding-test-error-404" as any) || "Endpoint not found - check API base URL",
          429: getString("pref-embedding-test-error-429" as any) || "Rate limited - try again later",
          500: getString("pref-embedding-test-error-5xx" as any) || "Server error - try again later",
          502: getString("pref-embedding-test-error-5xx" as any) || "Server error - try again later",
          503: getString("pref-embedding-test-error-5xx" as any) || "Server error - try again later",
        };
        hint = `HTTP ${code}: ${hints[code] || "Request failed"}`;
      } else {
        hint = fullMsg.length > 100 ? fullMsg.substring(0, 100) + "..." : fullMsg;
      }

      const rawContent = responseBody || fullMsg;

      testResult.innerHTML = "";
      const hintSpan = doc.createElement("span");
      hintSpan.textContent = `${getString("pref-embedding-test-failed" as any)} ${hint}`;
      hintSpan.style.color = "var(--color-error)";
      testResult.appendChild(hintSpan);

      // Collapsible raw response
      const detailWrap = doc.createElement("details");
      detailWrap.style.cssText = "margin-top:4px; font-size:11px; color:var(--text-2);";
      const summary = doc.createElement("summary");
      summary.textContent = getString("pref-embedding-test-error-detail" as any) || "Show raw response";
      summary.style.cssText = "cursor:pointer; color:var(--text-3); user-select:none;";
      const pre = doc.createElement("pre");
      pre.textContent = rawContent;
      pre.style.cssText = "margin:4px 0 0; white-space:pre-wrap; word-break:break-all; font-size:11px; font-family:'SF Mono',Consolas,monospace; background:var(--bg-muted); padding:6px 8px; border-radius:4px; max-height:200px; overflow-y:auto; color:var(--text);";
      detailWrap.appendChild(summary);
      detailWrap.appendChild(pre);
      testResult.appendChild(detailWrap);

      ztoolkit.log(`[PreferenceScript] Embedding test failed: ${error}`, "warn");
    } finally {
      testButton.disabled = false;
    }
  });
}

/**
 * Update embedding service configuration from preferences
 */
/**
 * Read the user-configured embedding API timeout in seconds (clamped to
 * 5-600), or 0 when unset so callers can keep their own default.
 */
function getEmbeddingTimeoutSeconds(): number {
  try {
    const raw = Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.embedding.timeoutSeconds", true);
    const seconds = parseInt(String(raw ?? ""), 10);
    if (isNaN(seconds) || seconds <= 0) return 0;
    return Math.min(600, Math.max(5, seconds));
  } catch {
    return 0;
  }
}

function updateEmbeddingServiceConfig() {
  try {
    // Import and update embedding service
    const { getEmbeddingService } = require("./semantic/embeddingService");
    const embeddingService = getEmbeddingService();

    const apiBase = Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.embedding.apiBase", true) || "";
    const apiKey = Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.embedding.apiKey", true) || "";
    const model = Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.embedding.model", true) || "";
    const dimensions = Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.embedding.dimensions", true);
    const timeoutSeconds = getEmbeddingTimeoutSeconds();

    embeddingService.updateConfig({
      apiBase: apiBase as string,
      apiKey: apiKey as string,
      model: model as string,
      dimensions: dimensions ? parseInt(String(dimensions), 10) : undefined,
      ...(timeoutSeconds ? { timeout: timeoutSeconds * 1000 } : {})
    });

    ztoolkit.log(`[PreferenceScript] Updated embedding service config`);
  } catch (error) {
    ztoolkit.log(`[PreferenceScript] Failed to update embedding service: ${error}`, "warn");
  }
}

/**
 * Bind API usage stats display handlers
 */
function bindApiUsageStats(doc: Document) {
  // Rate limit inputs
  const rpmInput = doc?.querySelector(`#zotero-prefpane-${config.addonRef}-embedding-rpm`) as HTMLInputElement;
  const tpmInput = doc?.querySelector(`#zotero-prefpane-${config.addonRef}-embedding-tpm`) as HTMLInputElement;
  const costInput = doc?.querySelector(`#zotero-prefpane-${config.addonRef}-embedding-cost`) as HTMLInputElement;

  // Usage stats elements
  const totalTokensEl = doc?.querySelector("#api-usage-total-tokens") as HTMLElement;
  const totalRequestsEl = doc?.querySelector("#api-usage-total-requests") as HTMLElement;
  const totalTextsEl = doc?.querySelector("#api-usage-total-texts") as HTMLElement;
  const estimatedCostEl = doc?.querySelector("#api-usage-estimated-cost") as HTMLElement;
  const sessionTokensEl = doc?.querySelector("#api-usage-session-tokens") as HTMLElement;
  const sessionRequestsEl = doc?.querySelector("#api-usage-session-requests") as HTMLElement;
  const currentRpmEl = doc?.querySelector("#api-usage-current-rpm") as HTMLElement;
  const currentTpmEl = doc?.querySelector("#api-usage-current-tpm") as HTMLElement;
  const rateLimitHitsEl = doc?.querySelector("#api-usage-rate-limit-hits") as HTMLElement;

  // Buttons
  const refreshButton = doc?.querySelector("#refresh-api-usage-button") as HTMLButtonElement;
  const resetButton = doc?.querySelector("#reset-api-usage-button") as HTMLButtonElement;

  // Initialize rate limit inputs from preferences
  const initRateLimitValue = (input: HTMLInputElement, prefKey: string, defaultValue: string) => {
    if (input) {
      const value = Zotero.Prefs.get(prefKey, true);
      input.value = value !== undefined && value !== null ? String(value) : defaultValue;
    }
  };

  initRateLimitValue(rpmInput, "extensions.zotero.zotero-mcp-plugin.embedding.rpm", "60");
  initRateLimitValue(tpmInput, "extensions.zotero.zotero-mcp-plugin.embedding.tpm", "150000");
  initRateLimitValue(costInput, "extensions.zotero.zotero-mcp-plugin.embedding.costPer1M", "0.02");

  // Save rate limit on change
  const bindRateLimitSave = (input: HTMLInputElement, prefKey: string, isFloat = false) => {
    input?.addEventListener("change", () => {
      let value: number;
      if (isFloat) {
        value = parseFloat(input.value) || 0;
      } else {
        value = parseInt(input.value, 10) || 0;
      }
      Zotero.Prefs.set(prefKey, isFloat ? String(value) : value, true);
      ztoolkit.log(`[PreferenceScript] Saved rate limit pref: ${prefKey} = ${value}`);

      // Update embedding service rate limit config
      updateEmbeddingServiceRateLimits();
    });
  };

  bindRateLimitSave(rpmInput, "extensions.zotero.zotero-mcp-plugin.embedding.rpm");
  bindRateLimitSave(tpmInput, "extensions.zotero.zotero-mcp-plugin.embedding.tpm");
  bindRateLimitSave(costInput, "extensions.zotero.zotero-mcp-plugin.embedding.costPer1M", true);

  // Load usage stats on page load
  loadApiUsageStats();

  // Refresh button
  refreshButton?.addEventListener("click", () => {
    loadApiUsageStats();
  });

  // Reset button.
  //
  // Its meaning is unchanged: it zeroes the API usage COUNTERS and nothing
  // else. Neither index has counters of that kind — every keyword and vector
  // figure in this pane is a direct count of rows that really exist — so there
  // is nothing on either side for a reset to clear, and clearing an index here
  // would be data loss disguised as a statistics reset. What it does now do is
  // repaint both index sections afterwards, so the whole panel agrees.
  resetButton?.addEventListener("click", () => {
    const confirmMsg = getString("pref-api-usage-reset-confirm" as any) || "Are you sure you want to reset all API usage statistics?";
    if (addon.data.prefs!.window.confirm(confirmMsg)) {
      resetApiUsageStats();
      refreshIndexStatsAfterUsageReset?.();
    }
  });

  async function loadApiUsageStats() {
    try {
      const { getEmbeddingService } = require("./semantic/embeddingService");
      const embeddingService = getEmbeddingService();

      // Ensure service is initialized to load persisted stats
      await embeddingService.initialize();

      const stats = embeddingService.getUsageStats();

      // Format numbers with thousands separator
      const formatNum = (n: number) => n.toLocaleString();

      // Update UI elements
      if (totalTokensEl) totalTokensEl.textContent = formatNum(stats.totalTokens);
      if (totalRequestsEl) totalRequestsEl.textContent = formatNum(stats.totalRequests);
      if (totalTextsEl) totalTextsEl.textContent = formatNum(stats.totalTexts);
      if (estimatedCostEl) estimatedCostEl.textContent = `$${stats.estimatedCostUsd.toFixed(4)}`;
      if (sessionTokensEl) sessionTokensEl.textContent = formatNum(stats.sessionTokens);
      if (sessionRequestsEl) sessionRequestsEl.textContent = formatNum(stats.sessionRequests);
      if (currentRpmEl) currentRpmEl.textContent = `${stats.currentRpm}`;
      if (currentTpmEl) currentTpmEl.textContent = formatNum(stats.currentTpm);
      if (rateLimitHitsEl) rateLimitHitsEl.textContent = formatNum(stats.rateLimitHits);

      if (!_silentRefresh) {
        ztoolkit.log(`[PreferenceScript] Loaded API usage stats: ${stats.totalTokens} tokens, ${stats.totalRequests} requests`);
      }
    } catch (error) {
      if (!_silentRefresh) {
        ztoolkit.log(`[PreferenceScript] Failed to load API usage stats: ${error}`, "warn");
      }
      // Show error state
      if (totalTokensEl) totalTokensEl.textContent = "-";
      if (totalRequestsEl) totalRequestsEl.textContent = "-";
    }
  }

  async function resetApiUsageStats() {
    try {
      const { getEmbeddingService } = require("./semantic/embeddingService");
      const embeddingService = getEmbeddingService();

      // Ensure service is initialized
      await embeddingService.initialize();

      embeddingService.resetUsageStats(true); // Reset cumulative stats

      // Reload display
      await loadApiUsageStats();

      ztoolkit.log("[PreferenceScript] Reset API usage stats");
    } catch (error) {
      ztoolkit.log(`[PreferenceScript] Failed to reset API usage stats: ${error}`, "warn");
    }
  }
}

/**
 * Update embedding service rate limit configuration from preferences
 */
function updateEmbeddingServiceRateLimits() {
  try {
    const { getEmbeddingService } = require("./semantic/embeddingService");
    const embeddingService = getEmbeddingService();

    const rpm = Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.embedding.rpm", true);
    const tpm = Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.embedding.tpm", true);
    const costPer1M = Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.embedding.costPer1M", true);

    embeddingService.setRateLimitConfig({
      rpm: rpm ? parseInt(String(rpm), 10) : 60,
      tpm: tpm ? parseInt(String(tpm), 10) : 150000,
      costPer1MTokens: costPer1M ? parseFloat(String(costPer1M)) : 0.02
    });

    ztoolkit.log(`[PreferenceScript] Updated embedding service rate limits`);
  } catch (error) {
    ztoolkit.log(`[PreferenceScript] Failed to update rate limits: ${error}`, "warn");
  }
}

/**
 * Bind semantic stats display handlers
 */
function bindSemanticStatsSettings(doc: Document) {
  const loadingEl = doc?.querySelector("#semantic-stats-loading") as HTMLElement;
  const contentEl = doc?.querySelector("#semantic-stats-content") as HTMLElement;
  const refreshButton = doc?.querySelector("#refresh-semantic-stats-button") as HTMLButtonElement;

  // Top row: the COMBINED figure across both indexes.
  const totalItemsEl = doc?.querySelector("#semantic-stats-total-items") as HTMLElement;
  const totalRecordsEl = doc?.querySelector("#semantic-stats-total-records") as HTMLElement;
  // Detail rows: each index's own numbers, never summed.
  const semanticItemsEl = doc?.querySelector("#semantic-stats-indexed-items") as HTMLElement;
  const totalVectorsEl = doc?.querySelector("#semantic-stats-total-vectors") as HTMLElement;
  const keywordDocumentsEl = doc?.querySelector("#keyword-stats-documents") as HTMLElement;
  const keywordChunksEl = doc?.querySelector("#keyword-stats-chunks") as HTMLElement;
  const keywordTermsEl = doc?.querySelector("#keyword-stats-terms") as HTMLElement;
  const keywordPostingsEl = doc?.querySelector("#keyword-stats-postings") as HTMLElement;
  const keywordWithBodyEl = doc?.querySelector("#keyword-stats-with-body") as HTMLElement;
  const keywordMetadataOnlyEl = doc?.querySelector("#keyword-stats-metadata-only") as HTMLElement;
  const keywordDbUsageEl = doc?.querySelector("#keyword-stats-db-usage") as HTMLElement;
  const semanticDbUsageEl = doc?.querySelector("#semantic-stats-db-usage") as HTMLElement;
  const zhVectorsEl = doc?.querySelector("#semantic-stats-zh-vectors") as HTMLElement;
  const enVectorsEl = doc?.querySelector("#semantic-stats-en-vectors") as HTMLElement;
  const cachedItemsEl = doc?.querySelector("#semantic-stats-cached-items") as HTMLElement;
  const cacheSizeEl = doc?.querySelector("#semantic-stats-cache-size") as HTMLElement;
  const dbSizeEl = doc?.querySelector("#semantic-stats-db-size") as HTMLElement;
  const dimensionsEl = doc?.querySelector("#semantic-stats-dimensions") as HTMLElement;
  const int8StatusEl = doc?.querySelector("#semantic-stats-int8-status") as HTMLElement;
  const statusEl = doc?.querySelector("#semantic-stats-status") as HTMLElement;

  // Index control elements
  const buildButton = doc?.querySelector("#build-semantic-index-button") as HTMLButtonElement;
  const rebuildButton = doc?.querySelector("#rebuild-semantic-index-button") as HTMLButtonElement;
  const retryFailedButton = doc?.querySelector("#retry-failed-index-button") as HTMLButtonElement;
  const clearButton = doc?.querySelector("#clear-semantic-index-button") as HTMLButtonElement;
  const pauseButton = doc?.querySelector("#pause-semantic-index-button") as HTMLButtonElement;
  const resumeButton = doc?.querySelector("#resume-semantic-index-button") as HTMLButtonElement;
  const abortButton = doc?.querySelector("#abort-semantic-index-button") as HTMLButtonElement;
  const progressContainer = doc?.querySelector("#semantic-index-progress-container") as HTMLElement;
  const progressText = doc?.querySelector("#semantic-index-progress-text") as HTMLElement;
  const progressPercent = doc?.querySelector("#semantic-index-progress-percent") as HTMLElement;
  const progressBar = doc?.querySelector("#semantic-index-progress-bar") as HTMLElement;
  const currentItemEl = doc?.querySelector("#semantic-index-current-item") as HTMLElement;
  const etaEl = doc?.querySelector("#semantic-index-eta") as HTMLElement;
  const messageEl = doc?.querySelector("#semantic-index-message") as HTMLElement;

  let isIndexing = false;
  let progressUpdateInterval: ReturnType<typeof setInterval> | null = null;
  let lastErrorInfo: { message: string; type: string; retryable: boolean } | null = null;
  let messageTimeout: ReturnType<typeof setTimeout> | null = null;

  // Load stats on page load
  loadSemanticStats();

  // Register error callback for semantic service
  registerErrorCallback();

  // Unified refresh: both indexes' statistics, API usage, and the collapsed
  // summary line. One entry point, so "Refresh" can never update one index's
  // numbers and leave the other's stale.
  function refreshAllStats(silent = false) {
    _silentRefresh = silent;
    loadSemanticStats(silent);
    const apiRefreshBtn = doc?.querySelector("#refresh-api-usage-button") as HTMLButtonElement;
    apiRefreshBtn?.click();
    _silentRefresh = false;
  }

  // Refresh button - both indexes plus API usage
  refreshButton?.addEventListener("click", () => {
    refreshAllStats();
  });

  // Let "Reset stats" (bound in the API usage panel) repaint the index numbers
  // without resetting them; see the comment on that button.
  refreshIndexStatsAfterUsageReset = () => {
    void loadSemanticStats(true);
  };

  // Auto-refresh stats every 5 seconds (silent mode: no loading flash, no log spam).
  // Search is always enabled, so only the MCP server state can pause this UI refresh.
  const autoRefreshInterval = setInterval(() => {
    const serverEnabled = Zotero.Prefs.get(PREF_SERVER_ENABLED, true);
    if (serverEnabled === false) return;
    refreshAllStats(true);
  }, 5000);

  // Cleanup auto-refresh when the prefs window closes
  const prefsWindow = doc?.defaultView;
  prefsWindow?.addEventListener("unload", () => {
    clearInterval(autoRefreshInterval);
    ztoolkit.log("[PreferenceScript] Auto-refresh interval cleared on window unload");
  });

  // Build index button
  buildButton?.addEventListener("click", () => {
    startIndexing(false);
  });

  // Rebuild index button
  rebuildButton?.addEventListener("click", () => {
    const confirmMsg = getString("pref-semantic-index-confirm-rebuild" as any) || "This will rebuild the entire index. Are you sure?";
    if (addon.data.prefs!.window.confirm(confirmMsg)) {
      startIndexing(true);
    }
  });

  // Retry failed items button
  retryFailedButton?.addEventListener("click", async () => {
    if (isIndexing) return;
    isIndexing = true;

    try {
      const { getSemanticSearchService } = require("./semantic");
      const semanticService = getSemanticSearchService();

      await semanticService.initialize();

      if (progressContainer) progressContainer.style.display = "block";
      updateControlButtons('indexing');
      showMessage(getString("pref-semantic-index-started" as any) || "Indexing started...", "info");
      startProgressUpdates();

      const result = await semanticService.retryFailedItems((progress: any) => {
        updateProgress(progress);
      });

      isIndexing = false;
      stopProgressUpdates();
      updateControlButtons('idle');

      if (result.status === 'busy') {
        showMessage(getString("pref-semantic-index-busy" as any) || "An index build is already running, please wait for it to finish", "warning");
      } else if (result.total === 0) {
        showMessage(getString("pref-semantic-index-no-failed-items" as any) || "No failed items to retry", "info");
      } else if ((result.failedCount || 0) > 0) {
        showMessage(
          `${getString("pref-semantic-index-error" as any) || "Indexing failed"} (${result.processed}/${result.total}, ${result.failedCount} ${getString("pref-semantic-index-failed-items" as any) || "items failed"})`,
          "error"
        );
      } else if (!showMinerUFallbackWarning(result)) {
        showMessage(getString("pref-semantic-index-completed" as any) + ` (${result.processed}/${result.total})`, "success");
      }

      loadSemanticStats();
    } catch (error) {
      isIndexing = false;
      stopProgressUpdates();
      updateControlButtons('idle');
      showMessage(getString("pref-semantic-index-error" as any) + `: ${error}`, "error");
      ztoolkit.log(`[PreferenceScript] Retry failed items failed: ${error}`, "error");
    }
  });

  // Pause button
  pauseButton?.addEventListener("click", () => {
    try {
      ztoolkit.log("[PreferenceScript] Pause button clicked");

      // Stop progress updates FIRST to prevent any race conditions
      // (interval callback might be running async and could reset buttons)
      stopProgressUpdates();

      const { getSemanticSearchService } = require("./semantic");
      const semanticService = getSemanticSearchService();

      // Check current status before pausing
      const beforeProgress = semanticService.getIndexProgress();
      ztoolkit.log(`[PreferenceScript] Before pause: status=${beforeProgress.status}`);

      semanticService.pauseIndex();

      // Verify pause took effect
      const afterProgress = semanticService.getIndexProgress();
      ztoolkit.log(`[PreferenceScript] After pause: status=${afterProgress.status}`);

      if (afterProgress.status === 'paused') {
        updateControlButtons('paused');
        showMessage(getString("pref-semantic-index-paused" as any) || "Indexing paused", "warning");
      } else {
        ztoolkit.log(`[PreferenceScript] Pause did not take effect, status is still: ${afterProgress.status}`, "warn");
        // Restart progress updates if pause failed
        startProgressUpdates();
      }
    } catch (error) {
      ztoolkit.log(`[PreferenceScript] Failed to pause indexing: ${error}`, "warn");
    }
  });

  // Resume button
  resumeButton?.addEventListener("click", async () => {
    try {
      const { getSemanticSearchService } = require("./semantic");
      const semanticService = getSemanticSearchService();

      // Check current status
      const progress = semanticService.getIndexProgress();

      // Clear error info since we're resuming
      lastErrorInfo = null;

      // Hide any error message displayed
      if (messageEl) messageEl.style.display = "none";

      // Reset status display color
      if (statusEl) statusEl.style.color = "";

      // Check if this is a resume after restart or error (no active build process)
      // We detect this by checking if isIndexing is false but status is paused/error
      if (!isIndexing && (progress.status === 'paused' || progress.status === 'error')) {
        // Resume after restart/error - need to start a new build process
        ztoolkit.log(`[PreferenceScript] Resuming index after ${progress.status} - starting new build process`);
        isIndexing = true;

        updateControlButtons('indexing');
        showMessage(getString("pref-semantic-index-started" as any) || "Indexing resumed...", "info");

        // Show progress UI
        if (progressContainer) progressContainer.style.display = "block";

        // Start progress updates
        startProgressUpdates();

        const resumeResult = await semanticService.resumeInterruptedBuild(
          (p: any) => {
            updateProgress(p);
            if (p.status === 'completed' || p.status === 'failed' || p.status === 'aborted') {
              stopProgressUpdates();
              updateControlButtons('idle');
              isIndexing = false;
              loadSemanticStats();

              if (p.status === 'completed') {
                if (!showMinerUFallbackWarning(p)) {
                  showMessage(getString("pref-semantic-index-completed" as any) || "Indexing completed!", "success");
                }
              } else if (p.status === 'failed') {
                showMessage(
                  `${getString("pref-semantic-index-error" as any) || "Indexing failed"} (${p.processed}/${p.total}, ${p.failedCount || 0} ${getString("pref-semantic-index-failed-items" as any) || "items failed"})`,
                  "error",
                );
              } else if (p.status === 'aborted') {
                showMessage(getString("pref-semantic-index-aborted" as any) || "Indexing aborted", "warning");
              }
            }
            // Note: error state is handled by the error callback, not here
          },
        );
        if (resumeResult.status === 'busy') {
          // The original build promise (from before the pane was reopened) is
          // still alive and was unparked by resumeIndex() above; our duplicate
          // buildIndex call was rejected by the guard, so its onProgress will
          // never fire. Let the polling interval drive the UI instead of
          // leaving isIndexing stuck true forever.
          ztoolkit.log('[PreferenceScript] Resume unparked an existing build; relying on progress polling');
          isIndexing = false;
        }
      } else {
        // Normal resume during active session
        semanticService.resumeIndex();
        updateControlButtons('indexing');
        showMessage(getString("pref-semantic-index-started" as any) || "Indexing resumed...", "info");
        // Restart progress updates (they were stopped when pausing)
        startProgressUpdates();
      }
    } catch (error) {
      ztoolkit.log(`[PreferenceScript] Failed to resume indexing: ${error}`, "warn");
      isIndexing = false;
      updateControlButtons('idle');
    }
  });

  // Abort button
  abortButton?.addEventListener("click", () => {
    try {
      const { getSemanticSearchService } = require("./semantic");
      const semanticService = getSemanticSearchService();
      semanticService.abortIndex();
      updateControlButtons('idle');
      showMessage(getString("pref-semantic-index-aborted" as any) || "Indexing aborted", "warning");
      stopProgressUpdates();
      isIndexing = false;
    } catch (error) {
      ztoolkit.log(`[PreferenceScript] Failed to abort indexing: ${error}`, "warn");
    }
  });

  // Clear index button
  clearButton?.addEventListener("click", async () => {
  const confirmMsg = getString("pref-semantic-index-confirm-clear" as any) || "This permanently deletes all plugin search index data. Zotero items, PDFs, and Markdown attachments are not deleted. Continue?";
    if (!addon.data.prefs!.window.confirm(confirmMsg)) {
      return;
    }

    clearButton.disabled = true;
    isIndexing = true;
    stopProgressUpdates();
    updateControlButtons('indexing');
    try {
      const { getSemanticSearchService } = require("./semantic");
      const { getVectorStore } = require("./semantic/vectorStore");
      const semanticService = getSemanticSearchService();
      const vectorStore = getVectorStore();
      const report = await clearSemanticDatabase({
        semanticService,
        vectorStore,
        suspendRefreshQueue: suspendIndexRefreshQueue,
        resumeRefreshQueue: resumeIndexRefreshQueue,
        prepareRefreshQueueReset: prepareIndexRefreshQueueReset,
        markRefreshQueueDatabaseCleared:
          markIndexRefreshQueueDatabaseCleared,
        cancelRefreshQueueReset: cancelIndexRefreshQueueReset,
        suspendPDFRefreshes: suspendPDFSemanticIndexRefreshes,
        resumePDFRefreshes: resumePDFSemanticIndexRefreshes,
        clearRefreshQueue: clearIndexRefreshQueue,
        suspendAutoUpdates: suspendSemanticAutoUpdates,
        resumeAutoUpdates: resumeSemanticAutoUpdates,
        clearChunkingSignatures: clearStoredChunkingSignatures,
        clearPaginationState: () =>
          addon.data.httpServer?.clearSemanticState(),
        markWikiEvidencePending: async (generation) => {
          const { getWikiStore } = await import('./wiki/wikiStore');
          await getWikiStore().markResetPending(generation);
        },
      });

      if (progressContainer) progressContainer.style.display = "none";
      if (progressText) progressText.textContent = "0/0";
      if (progressPercent) progressPercent.textContent = "0%";
      if (progressBar) progressBar.style.width = "0%";
      if (currentItemEl) currentItemEl.textContent = "-";
      if (etaEl) etaEl.textContent = "-";
      await updateChunkStaleWarning(doc);
      await loadSemanticStats();
      await refreshDataCompatibilityLockUI(doc);

    showMessage(getString("pref-semantic-index-cleared" as any) || "All search index data deleted", "success");
      ztoolkit.log(
      `[PreferenceScript] Search index database reset verified: ${JSON.stringify(report)}`,
      );
    } catch (error) {
      showMessage(getString("pref-semantic-index-error" as any) + `: ${error}`, "error");
    ztoolkit.log(`[PreferenceScript] Failed to reset search index database: ${error}`, "error");
    } finally {
      isIndexing = false;
      clearButton.disabled = false;
      updateControlButtons('idle');
    }
  });

  async function startIndexing(rebuild: boolean) {
    if (isIndexing) return;
    isIndexing = true;

    try {
      const { getSemanticSearchService } = require("./semantic");
      const semanticService = getSemanticSearchService();

      // Initialize if needed
      await semanticService.initialize();

      // Show progress UI
      if (progressContainer) progressContainer.style.display = "block";
      updateControlButtons('indexing');
      showMessage(getString("pref-semantic-index-started" as any) || "Indexing started...", "info");

      // Start progress updates
      startProgressUpdates();

      // Build index with progress callback
      const result = await semanticService.buildIndex({
        rebuild,
        onProgress: (progress: any) => {
          updateProgress(progress);
        }
      });

      // Indexing completed
      isIndexing = false;
      stopProgressUpdates();
      updateControlButtons('idle');

      if (result.status === 'busy') {
        showMessage(getString("pref-semantic-index-busy" as any) || "An index build is already running, please wait for it to finish", "warning");
      } else if (result.status === 'completed') {
        if (!showMinerUFallbackWarning(result)) {
          if (result.total === 0) {
            showMessage(getString("pref-semantic-index-no-items" as any) || "No items need indexing", "info");
          } else {
            showMessage(getString("pref-semantic-index-completed" as any) + ` (${result.processed}/${result.total})`, "success");
          }
        }
        if (rebuild) updateChunkStaleWarning(doc);
      } else if (result.status === 'incomplete') {
        // Finished, but on purpose missing documents. Report the two numbers
        // separately — "42 indexed, 3 skipped" is actionable in a way that a
        // single failure count is not — and say plainly that the index does
        // not yet cover the whole library.
        const { summarizeRun } = require("./semantic");
        const { indexed, skipped, otherFailures } = summarizeRun(result);
        const parts = [
          `${getString("pref-semantic-index-indexed-items" as any) || "indexed"}: ${indexed}`,
          `${getString("pref-semantic-index-skipped-oversize" as any) || "skipped (chunk too long)"}: ${skipped}`,
        ];
        if (otherFailures > 0) {
          parts.push(
            `${getString("pref-semantic-index-failed-items" as any) || "items failed"}: ${otherFailures}`,
          );
        }
        showMessage(
          `${getString("pref-semantic-index-incomplete" as any) || "Indexing finished but is incomplete"} (${parts.join(", ")})。` +
            `${getString("pref-semantic-index-incomplete-hint" as any) || "Lower the chunk length or switch to a model that accepts longer input, then retry the failed items."}`,
          "warning",
        );
        if (rebuild) updateChunkStaleWarning(doc);
      } else if (result.status === 'failed') {
        showMessage(
          `${getString("pref-semantic-index-error" as any) || "Indexing failed"} (${result.processed}/${result.total}, ${result.failedCount || 0} ${getString("pref-semantic-index-failed-items" as any) || "items failed"})`,
          "error",
        );
        if (rebuild) updateChunkStaleWarning(doc);
      } else if (result.status === 'aborted') {
        showMessage(getString("pref-semantic-index-aborted" as any) || "Indexing aborted", "warning");
      } else if (result.status === 'error') {
        // Error is already shown by the error callback, but show additional info if available
        if (result.error && !lastErrorInfo) {
          showMessage(getString("pref-semantic-index-error" as any) + `: ${result.error}`, "error");
        }
      }

      // Reload stats
      loadSemanticStats();

    } catch (error) {
      isIndexing = false;
      stopProgressUpdates();
      updateControlButtons('idle');
      showMessage(getString("pref-semantic-index-error" as any) + `: ${error}`, "error");
      ztoolkit.log(`[PreferenceScript] Index building failed: ${error}`, "error");
    }
  }

  function updateProgress(progress: any) {
    if (progressText) {
      progressText.textContent = `${progress.processed}/${progress.total}`;
    }

    if (progressPercent && progress.total > 0) {
      const percent = Math.round((progress.processed / progress.total) * 100);
      progressPercent.textContent = `${percent}%`;
    }

    if (progressBar && progress.total > 0) {
      const percent = Math.round((progress.processed / progress.total) * 100);
      progressBar.style.width = `${percent}%`;
    }

    if (currentItemEl && progress.currentItem) {
      currentItemEl.textContent = progress.currentItem;
    }

    if (etaEl && progress.estimatedRemaining) {
      etaEl.textContent = formatTime(progress.estimatedRemaining);
    }
  }

  function formatTime(ms: number): string {
    if (ms < 1000) return "< 1s";
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }

  function updateControlButtons(status: 'idle' | 'indexing' | 'paused') {
    if (buildButton) buildButton.style.display = status === 'idle' ? '' : 'none';
    if (rebuildButton) rebuildButton.style.display = status === 'idle' ? '' : 'none';
    if (retryFailedButton) retryFailedButton.style.display = status === 'idle' ? '' : 'none';
    if (clearButton) clearButton.style.display = status === 'idle' ? '' : 'none';
    if (pauseButton) pauseButton.style.display = status === 'indexing' ? '' : 'none';
    if (resumeButton) resumeButton.style.display = status === 'paused' ? '' : 'none';
    if (abortButton) abortButton.style.display = (status === 'indexing' || status === 'paused') ? '' : 'none';
  }

  function showMessage(text: string, type: 'info' | 'success' | 'warning' | 'error') {
    if (!messageEl) return;

    // Clear any pending timeout to prevent previous messages from hiding this one
    if (messageTimeout) {
      clearTimeout(messageTimeout);
      messageTimeout = null;
    }

    messageEl.textContent = text;
    messageEl.style.display = "block";

    // Set style based on type
    const colors: Record<string, { bg: string; text: string }> = {
      info: { bg: "var(--msg-info-bg)", text: "var(--msg-info-text)" },
      success: { bg: "var(--msg-success-bg)", text: "var(--msg-success-text)" },
      warning: { bg: "var(--msg-warning-bg)", text: "var(--msg-warning-text)" },
      error: { bg: "var(--msg-error-bg)", text: "var(--msg-error-text)" }
    };

    const color = colors[type] || colors.info;
    messageEl.style.backgroundColor = color.bg;
    messageEl.style.color = color.text;

    // Auto-hide after 5 seconds for non-error messages
    // Error messages persist until manually cleared or another message is shown
    if (type !== 'error') {
      messageTimeout = setTimeout(() => {
        if (messageEl) messageEl.style.display = "none";
        messageTimeout = null;
      }, 5000);
    }
  }

  function showMinerUFallbackWarning(result: any): boolean {
    const failures = Number(result?.minerUFailures || 0);
    if (failures <= 0) return false;
    const summary =
      `${getString("notice-mineru-failed" as any) || "High-precision MinerU text unavailable"}: ${failures} — ` +
      `${getString("notice-mineru-fallback" as any) || "built-in PDF extraction was used instead of high-precision MinerU text"}`;
    const detail = result?.minerULastError
      ? `\n${String(result.minerULastError).slice(0, 240)}`
      : "";
    showMessage(summary + detail, "warning");
    return true;
  }

  function startProgressUpdates() {
    if (progressUpdateInterval) {
      ztoolkit.log(`[PreferenceScript] startProgressUpdates: interval already exists, skipping`);
      return;
    }

    ztoolkit.log(`[PreferenceScript] startProgressUpdates: starting progress update interval`);

    progressUpdateInterval = setInterval(() => {
      try {
        const { getSemanticSearchService } = require("./semantic");
        const semanticService = getSemanticSearchService();
        const progress = semanticService.getIndexProgress();

        // Update progress UI
        updateProgress(progress);

        // Update status text
        if (statusEl) {
          statusEl.textContent = getStatusText(progress.status);
        }

        // Update control buttons based on status
        if (progressUpdateInterval) {
          if (progress.status === 'paused' || progress.status === 'error') {
            updateControlButtons('paused');
          } else if (progress.status === 'indexing') {
            updateControlButtons('indexing');
          }
        }

        // Log progress periodically (every 5 seconds) for debugging
        if (progress.processed % 5 === 0 && progress.processed > 0) {
          ztoolkit.log(`[PreferenceScript] Progress update: ${progress.processed}/${progress.total} (${progress.status})`);
        }
      } catch (error) {
        ztoolkit.log(`[PreferenceScript] Progress update error: ${error}`, 'warn');
      }
    }, 500);  // Update every 500ms for smoother progress
  }

  function stopProgressUpdates() {
    if (progressUpdateInterval) {
      ztoolkit.log(`[PreferenceScript] stopProgressUpdates: stopping progress update interval`);
      clearInterval(progressUpdateInterval);
      progressUpdateInterval = null;
    }
  }

  async function loadSemanticStats(silent = false) {
    if (!loadingEl || !contentEl) return;

    // Show loading, hide content (skip in silent mode to avoid flicker)
    if (!silent) {
      loadingEl.style.display = "block";
      contentEl.style.display = "none";
    }

    try {
      // Import semantic search service
      const { getSemanticSearchService } = require("./semantic");
      const semanticService = getSemanticSearchService();

      // Initialize if needed
      await semanticService.initialize();

      // Get stats
      const stats = await semanticService.getStats();

      // Format size nicely
      const formatSize = (bytes: number) => {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
      };

      // Update UI
      const keywordStats = stats.keywordStats;
      const groups = (value: number) => value.toLocaleString();

      /*
       * The top row is the two indexes combined, each in the way its own
       * quantity combines:
       *
       *  - documents: a document can be in one index, the other, or both, so
       *    the total is a UNION. It is computed in SQL over both indexes'
       *    document keys inside one library, not derived from the two counts —
       *    no arithmetic on two totals can recover a union, and the largest of
       *    the two understates it for every state except a fully synchronised
       *    one.
       *  - records: vectors and postings are disjoint rows, so that one really
       *    is a sum.
       *  - database size: ONE file holds both indexes, so the top figure is the
       *    whole file; each index's own share is in its detailed section.
       */
      const combinedDocuments = stats.documentTotals.totalDocuments;
      const combinedRecords = keywordStats
        ? stats.indexStats.totalVectors + keywordStats.postingCount
        : stats.indexStats.totalVectors;

      if (totalItemsEl) totalItemsEl.textContent = groups(combinedDocuments);
      if (totalRecordsEl) totalRecordsEl.textContent = groups(combinedRecords);
      if (semanticItemsEl) semanticItemsEl.textContent = groups(stats.indexStats.totalItems);
      if (totalVectorsEl) totalVectorsEl.textContent = groups(stats.indexStats.totalVectors);

      // "-" rather than 0 when the report could not be read: an unreadable
      // index and an empty index are different facts.
      const keywordCells: Array<[HTMLElement | null, number | undefined]> = [
        [keywordDocumentsEl, keywordStats?.documentCount],
        [keywordChunksEl, keywordStats?.indexedChunks],
        [keywordTermsEl, keywordStats?.termCount],
        [keywordPostingsEl, keywordStats?.postingCount],
        [keywordWithBodyEl, keywordStats?.documentsWithBody],
        [keywordMetadataOnlyEl, keywordStats?.documentsMetadataOnly],
      ];
      for (const [element, value] of keywordCells) {
        if (element) element.textContent = value === undefined ? '-' : groups(value);
      }
      if (zhVectorsEl) zhVectorsEl.textContent = String(stats.indexStats.zhVectors);
      if (enVectorsEl) enVectorsEl.textContent = String(stats.indexStats.enVectors);
      if (cachedItemsEl) cachedItemsEl.textContent = String(stats.indexStats.cachedContentItems || 0);
      if (cacheSizeEl) cacheSizeEl.textContent = formatSize(stats.indexStats.cachedContentSizeBytes || 0);
      if (dbSizeEl) dbSizeEl.textContent = stats.indexStats.dbSizeBytes ? formatSize(stats.indexStats.dbSizeBytes) : '-';
      // Each index's own pages. "-" when this SQLite build cannot report them:
      // repeating the whole file's size under an index's name would be a
      // number that is not this index's, and adding the two would double it.
      const usageCells: Array<[HTMLElement | null, number | undefined]> = [
        [semanticDbUsageEl, stats.storage.semanticBytes],
        [keywordDbUsageEl, stats.storage.keywordBytes],
      ];
      for (const [element, bytes] of usageCells) {
        if (element)
          element.textContent =
            stats.storage.measured && bytes !== undefined
              ? formatSize(bytes)
              : '-';
      }
      if (dimensionsEl) {
        if (stats.indexStats.storedDimensions) {
          // Get configured dimensions from prefs to show comparison
          const configuredDims = Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.embedding.dimensions", true);
          const configuredDimsNum = configuredDims ? parseInt(String(configuredDims), 10) : null;
          if (configuredDimsNum && configuredDimsNum !== stats.indexStats.storedDimensions) {
            dimensionsEl.textContent = `${stats.indexStats.storedDimensions} (${getString("pref-semantic-stats-dimensions-mismatch" as any) || "mismatch"}: ${configuredDims})`;
            dimensionsEl.style.color = "var(--color-error)";
          } else {
            dimensionsEl.textContent = String(stats.indexStats.storedDimensions);
            dimensionsEl.style.color = "var(--color-default)";
          }
        } else {
          dimensionsEl.textContent = '-';
        }
      }
      if (int8StatusEl) {
        if (stats.indexStats.int8MigrationStatus) {
          const { migrated, total, percent } = stats.indexStats.int8MigrationStatus;
          int8StatusEl.textContent = `${migrated}/${total} (${percent}%)`;
          int8StatusEl.style.color = percent === 100 ? "var(--color-ok)" : "var(--color-warn)";
        } else {
          int8StatusEl.textContent = '-';
        }
      }
      if (statusEl) statusEl.textContent = getStatusText(stats.indexProgress.status);

      // Update progress display if indexing is in progress or has error
      if (stats.indexProgress.status === 'indexing' || stats.indexProgress.status === 'paused' || stats.indexProgress.status === 'error') {
        if (progressContainer) progressContainer.style.display = "block";
        updateProgress(stats.indexProgress);

        if (stats.indexProgress.status === 'error') {
          // Show error state - display error message and allow resume
          updateControlButtons('paused');  // Show resume button for retry
          if (statusEl) {
            // Include error message in status if available
            const errorStatus = getStatusText('error');
            if (stats.indexProgress.error) {
              statusEl.textContent = `${errorStatus}: ${stats.indexProgress.error}`;
            } else {
              statusEl.textContent = errorStatus;
            }
            statusEl.style.color = "var(--msg-error-text)";
          }
          // Also show error message in message area if available
          if (stats.indexProgress.error) {
            const retryHint = stats.indexProgress.errorRetryable !== false
              ? ` (${getString("pref-semantic-index-error-retry-hint" as any) || "Click Resume to retry"})`
              : '';
            showMessage(stats.indexProgress.error + retryHint, "error");
          }
        } else {
          updateControlButtons(stats.indexProgress.status as 'indexing' | 'paused');
          if (statusEl) statusEl.style.color = "";
        }

        isIndexing = stats.indexProgress.status === 'indexing';
        if (isIndexing && !progressUpdateInterval) {
          startProgressUpdates();
        }
      } else {
        if (progressContainer) progressContainer.style.display = "none";
        updateControlButtons('idle');
        if (statusEl) statusEl.style.color = "";
        // The build is over (idle/completed/aborted): release the local flag
        // and stop polling so the buttons cannot get stuck disabled when the
        // build finished without this pane's onProgress firing
        if (isIndexing && !semanticService.isBuildActive()) {
          isIndexing = false;
          stopProgressUpdates();
        }
      }

      // Hide loading, show content
      loadingEl.style.display = "none";
      contentEl.style.display = "block";

      // Update detail stats summary in collapsible header
      const detailSummaryEl = doc?.querySelector('#detail-stats-summary') as HTMLElement;
      if (detailSummaryEl) {
        try {
          const { getEmbeddingService } = require("./semantic/embeddingService");
          const embeddingService = getEmbeddingService();
          const usageStats = embeddingService.getUsageStats();
          const tokenStr = usageStats.totalTokens > 1000
            ? `${Math.round(usageStats.totalTokens / 1000)}K`
            : String(usageStats.totalTokens);
          detailSummaryEl.textContent = `${tokenStr} tokens · $${usageStats.estimatedCostUsd.toFixed(2)}`;
        } catch {
          detailSummaryEl.textContent = '';
        }
      }

      if (!silent) {
        ztoolkit.log(`[PreferenceScript] Loaded semantic stats: ${stats.indexStats.totalItems} items, ${stats.indexStats.totalVectors} vectors`);
      }
      await refreshDataCompatibilityLockUI(doc);

    } catch (error) {
      ztoolkit.log(`[PreferenceScript] Failed to load semantic stats: ${error}`, "warn");

      // Check if the error is database corruption
      const errorStr = String(error);
      const isCorruption = errorStr.includes('malformed') || errorStr.includes('corrupt') || errorStr.includes('disk image');

      // Show appropriate error message
      if (isCorruption) {
        loadingEl.textContent = getString("pref-semantic-stats-db-corrupted" as any) || "Index database is corrupted. Please restart Zotero to auto-repair.";
      } else {
        loadingEl.textContent = getString("pref-semantic-stats-not-initialized" as any) || "Semantic search service not initialized";
      }
      loadingEl.style.display = "block";
      contentEl.style.display = "none";
    }
  }

  function getStatusText(status: string): string {
    const statusMap: Record<string, string> = {
      'idle': getString("pref-semantic-stats-status-idle" as any) || 'Idle',
      'indexing': getString("pref-semantic-stats-status-indexing" as any) || 'Indexing',
      'paused': getString("pref-semantic-stats-status-paused" as any) || 'Paused',
      'completed': getString("pref-semantic-stats-status-completed" as any) || 'Completed',
      'incomplete': getString("pref-semantic-stats-status-incomplete" as any) || 'Incomplete',
      'failed': getString("pref-semantic-index-error" as any) || 'Failed',
      'error': getString("pref-semantic-stats-status-error" as any) || 'Error',
      'aborted': 'Aborted'
    };
    return statusMap[status] || status;
  }

  /**
   * Register error callback to receive API errors during indexing
   */
  async function registerErrorCallback() {
    try {
      const { getSemanticSearchService } = require("./semantic");
      const semanticService = getSemanticSearchService();

      // Wait for initialization
      await semanticService.initialize();

      // Register error callback
      semanticService.setOnIndexError((error: any) => {
        ztoolkit.log(`[PreferenceScript] Received indexing error: ${error.type} - ${error.message}`);

        // Get localized error message based on error type, including original error details
        const getLocalizedErrorMessage = (errorType: string, originalMessage: string): string => {
          const errorTypeMap: Record<string, string> = {
            'network': getString("pref-semantic-index-error-network" as any) || 'Network connection failed, please check your network and click Resume',
            'rate_limit': getString("pref-semantic-index-error-rate-limit" as any) || 'API rate limit exceeded, please try again later',
            'auth': getString("pref-semantic-index-error-auth" as any) || 'API authentication failed, please check your API key',
            'invalid_request': getString("pref-semantic-index-error-invalid-request" as any) || 'Invalid API request, please check configuration',
            'server': getString("pref-semantic-index-error-server" as any) || 'API server error, please try again later',
            'chunk_too_large': getString("pref-semantic-index-error-chunk-too-large" as any) || 'A single chunk exceeds the input length allowed by the current embedding model/API. Please reduce the chunk length or switch to an embedding model that supports longer input',
            'config': getString("pref-semantic-index-error-config" as any) || 'Configuration error, please check API settings',
            'unknown': getString("pref-semantic-index-error-unknown" as any) || 'Unknown error'
          };
          const localizedMsg = errorTypeMap[errorType];
          // The chunk-too-large error carries its own instructions; appending
          // the raw message would print the same sentence twice.
          if (errorType === 'chunk_too_large') {
            return localizedMsg;
          }
          // The batch-size error is built from the SERVER's own sentence and
          // the limit it named. That is the whole value of it, so it is shown
          // verbatim rather than replaced by a generic translation.
          if (errorType === 'batch_too_many_inputs') {
            return originalMessage;
          }
          // For known error types, append original message if it provides additional details
          // For unknown errors or when type is not found, always include original message
          if (localizedMsg) {
            // Include original message for all errors to provide more context
            return originalMessage && originalMessage !== errorType
              ? `${localizedMsg}: ${originalMessage}`
              : localizedMsg;
          }
          return originalMessage || 'Unknown error';
        };

        // Store error info for display and potential retry
        lastErrorInfo = {
          message: getLocalizedErrorMessage(error.type || 'unknown', error.message),
          type: error.type || 'unknown',
          retryable: error.retryable !== false
        };

        // Stop progress updates
        stopProgressUpdates();

        // Update UI to show error state
        updateControlButtons('paused');

        // Show error message with retry hint
        const errorMsg = lastErrorInfo.message;
        const retryHint = lastErrorInfo.retryable
          ? ` (${getString("pref-semantic-index-error-retry-hint" as any) || "Click Resume to retry"})`
          : '';
        showMessage(errorMsg + retryHint, "error");

        // Update status display
        if (statusEl) {
          statusEl.textContent = getStatusText('error');
          statusEl.style.color = "var(--msg-error-text)";
        }

        // NOTE: do NOT set isIndexing = false here; the build promise is
        // still alive (parked in waitWhilePaused). Resume must take the
        // resumeIndex() path instead of spawning a second buildIndex run.
      });

      // Ask the user what to do about a chunk that is longer than the
      // embedding endpoint accepts. Asked once per run; the service applies
      // the answer to every later occurrence without coming back here.
      semanticService.setOnChunkTooLargeDecision(async (request: any) => {
        const decision = askChunkTooLarge(request);
        ztoolkit.log(
          `[PreferenceScript] Oversized chunk on ${request.itemKey}: user chose '${decision}'`,
        );
        if (decision === "stop") {
          // The build is ending, so leave the same standing explanation on
          // screen that the stop path would otherwise have to duplicate.
          lastErrorInfo = {
            message:
              getString("pref-semantic-index-error-chunk-too-large" as any) ||
              request.message,
            type: "chunk_too_large",
            retryable: false,
          };
        }
        return decision;
      });

      ztoolkit.log("[PreferenceScript] Registered error callback for semantic service");
    } catch (error) {
      ztoolkit.log(`[PreferenceScript] Failed to register error callback: ${error}`, "warn");
    }
  }

  /**
   * The oversized-chunk dialog: skip these documents, or stop and fix it.
   *
   * Two clearly labelled buttons via Services.prompt.confirmEx, because
   * "OK / Cancel" gives no hint which one drops documents. If confirmEx is
   * unavailable it falls back to the plain confirm the rest of the plugin
   * uses, with the mapping spelled out in the text; if even that fails, the
   * answer is "stop", since being unable to ask is not permission to discard
   * a user's papers.
   */
  function askChunkTooLarge(request: {
    itemKey: string;
    title?: string;
    message: string;
  }): "skip" | "stop" {
    const win = addon.data.prefs?.window as any;
    const which = request.title
      ? `${request.title} (${request.itemKey})`
      : request.itemKey;
    const title =
      getString("pref-semantic-chunk-oversize-title" as any) ||
      "Chunk too long for the embedding model";
    const skipLabel =
      getString("pref-semantic-chunk-oversize-skip" as any) ||
      "Skip and continue";
    const stopLabel =
      getString("pref-semantic-chunk-oversize-stop" as any) || "Stop indexing";
    const body =
      `${request.message}\n\n` +
      `${getString("pref-semantic-chunk-oversize-item" as any) || "Affected item"}: ${which}\n\n` +
      `${getString("pref-semantic-chunk-oversize-explain" as any) || "Skipping leaves these documents out of the index; the rebuild will be marked incomplete. Stopping lets you lower the chunk length or switch model, then rebuild."}`;

    try {
      const prompts = (Services as any)?.prompt;
      if (prompts?.confirmEx) {
        const flags =
          prompts.BUTTON_POS_0 * prompts.BUTTON_TITLE_IS_STRING +
          prompts.BUTTON_POS_1 * prompts.BUTTON_TITLE_IS_STRING;
        const pressed = prompts.confirmEx(
          win ?? null,
          title,
          body,
          flags,
          skipLabel,
          stopLabel,
          null,
          null,
          { value: false },
        );
        return pressed === 0 ? "skip" : "stop";
      }
    } catch (error) {
      ztoolkit.log(
        `[PreferenceScript] confirmEx unavailable, falling back to confirm: ${error}`,
        "warn",
      );
    }

    try {
      if (win?.confirm) {
        const fallback = `${title}\n\n${body}\n\n${skipLabel} (OK) / ${stopLabel} (Cancel)`;
        return win.confirm(fallback) ? "skip" : "stop";
      }
    } catch (error) {
      ztoolkit.log(
        `[PreferenceScript] Could not show the oversized-chunk prompt: ${error}`,
        "warn",
      );
    }
    return "stop";
  }
}
