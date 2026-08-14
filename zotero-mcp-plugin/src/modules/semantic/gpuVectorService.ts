import type {
  GpuVectorDataProvider,
  GpuVectorMutation,
  GpuVectorSearchBackend,
  GpuVectorSearchRequest,
  GpuVectorSearchResult,
  GpuVectorSnapshotRow,
} from "./gpuVectorBackend";
import {
  GpuVectorStatusController,
  type GpuVectorFailureCode,
  type GpuVectorStatus,
  type GpuVectorStatusListener,
} from "./gpuVectorStatus";
import {
  assertSupportedGpuPlatform,
  extractGpuAssets,
  type ExtractedGpuAssets,
} from "./gpuVectorAssets";
import { GpuVectorProcess } from "./gpuVectorProcess";
import type { GpuFrame } from "./gpuVectorProtocol";

declare const Zotero: any;
declare let ztoolkit: ZToolkit;

export const GPU_ACCELERATION_PREF =
  "extensions.zotero.zotero-mcp-plugin.hybrid.gpuAccelerationEnabled";

interface GpuVectorProcessLike {
  request(
    type: string,
    fields?: Record<string, unknown>,
    payload?: Uint8Array,
    timeoutMs?: number,
  ): Promise<GpuFrame>;
  stop(): Promise<void>;
}

export interface GpuVectorServiceDependencies {
  readPreference(): boolean;
  writePreference(enabled: boolean): void;
  assertPlatform(): void;
  extractAssets(): Promise<ExtractedGpuAssets>;
  launchProcess(
    assets: ExtractedGpuAssets,
    onExit: (exitCode: number) => void,
  ): Promise<GpuVectorProcessLike>;
  notifyFallback(code: GpuVectorFailureCode, reason: string): void;
}

const FAILURE_CODES = new Set<GpuVectorFailureCode>([
  "NO_CUDA_DEVICE",
  "DRIVER_INCOMPATIBLE",
  "OUT_OF_MEMORY",
  "DIMENSION_MISMATCH",
  "RESOURCE_CORRUPT",
  "PROCESS_START_FAILED",
  "PROCESS_EXITED",
  "INVALID_FRAME",
  "TIMEOUT",
  "UNSUPPORTED_PLATFORM",
  "INDEX_UNSUPPORTED",
  "UNKNOWN",
]);

function defaultDependencies(): GpuVectorServiceDependencies {
  return {
    readPreference: () => {
      try {
        return Zotero.Prefs.get(GPU_ACCELERATION_PREF, true) === true;
      } catch {
        return false;
      }
    },
    writePreference: (enabled) =>
      Zotero.Prefs.set(GPU_ACCELERATION_PREF, enabled, true),
    assertPlatform: assertSupportedGpuPlatform,
    extractAssets: extractGpuAssets,
    launchProcess: (assets, onExit) =>
      GpuVectorProcess.launch({
        executable: assets.executable,
        workdir: assets.directory,
        onExit,
      }),
    notifyFallback: (code, reason) => {
      try {
        new ztoolkit.ProgressWindow("Zotero MCP Plugin", {
          closeOtherProgressWindows: false,
        })
          .createLine({
            text: `GPU 向量加速不可用，已回退 CPU（${code}）：${reason}`,
            type: "default",
          })
          .show();
      } catch {
        // A notification failure must never affect retrieval.
      }
    },
  };
}

function errorCode(error: unknown): GpuVectorFailureCode {
  const candidate = String((error as any)?.code || "UNKNOWN");
  return FAILURE_CODES.has(candidate as GpuVectorFailureCode)
    ? (candidate as GpuVectorFailureCode)
    : "UNKNOWN";
}

function errorMessage(error: unknown): string {
  return String((error as any)?.message || error || "Unknown GPU error");
}

function encodeRows(rows: GpuVectorSnapshotRow[]): {
  fields: Record<string, unknown>;
  payload: Uint8Array;
} {
  const dimensions = rows[0]?.dimensions ?? 0;
  const payload = new Uint8Array(rows.length * dimensions);
  const metadata = rows.map((row, index) => {
    if (
      row.dimensions !== dimensions ||
      row.vector.byteLength !== dimensions
    ) {
      throw Object.assign(new Error("GPU index contains mixed dimensions"), {
        code: "DIMENSION_MISMATCH",
      });
    }
    payload.set(
      new Uint8Array(
        row.vector.buffer,
        row.vector.byteOffset,
        row.vector.byteLength,
      ),
      index * dimensions,
    );
    return {
      rowId: row.rowId,
      libraryID: row.libraryID,
      itemKey: row.itemKey,
      chunkId: row.chunkId,
      language: row.language,
      norm: row.norm,
    };
  });
  return { fields: { dimensions, rows: metadata }, payload };
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error("Vector scan cancelled"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("Vector scan cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() =>
      signal.removeEventListener("abort", abort),
    );
  });
}

export class GpuVectorService implements GpuVectorSearchBackend {
  private readonly status = new GpuVectorStatusController();
  private provider: GpuVectorDataProvider | null = null;
  private process: GpuVectorProcessLike | null = null;
  private startPromise: Promise<void> | null = null;
  private sessionFailed = false;
  private stopping = false;
  private queuedMutations: GpuVectorMutation[] = [];
  private syncQueue: Promise<void> = Promise.resolve();
  private readonly dependencies: GpuVectorServiceDependencies;

  constructor(
    dependencies: GpuVectorServiceDependencies = defaultDependencies(),
  ) {
    this.dependencies = dependencies;
  }

  isEnabled(): boolean {
    return !this.sessionFailed && this.dependencies.readPreference();
  }

  getStatus(): GpuVectorStatus {
    return this.status.get();
  }

  subscribe(listener: GpuVectorStatusListener): () => void {
    return this.status.subscribe(listener);
  }

  registerProvider(provider: GpuVectorDataProvider): void {
    this.provider = provider;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.dependencies.writePreference(enabled);
    if (!enabled) {
      this.sessionFailed = false;
      this.queuedMutations = [];
      await this.stopProcess();
      this.status.set({ phase: "disabled" });
      return;
    }
    if (this.sessionFailed) return;
    await this.startIfEnabled();
  }

  async startIfEnabled(): Promise<void> {
    if (!this.isEnabled() || this.process) return;
    if (!this.provider) {
      throw new Error("GPU vector data provider is not registered");
    }
    if (!this.startPromise) {
      this.startPromise = this.start().finally(() => {
        this.startPromise = null;
      });
    }
    return this.startPromise;
  }

  private async start(): Promise<void> {
    try {
      this.status.set({ phase: "preparing" });
      this.dependencies.assertPlatform();
      const assets = await this.dependencies.extractAssets();
      this.process = await this.dependencies.launchProcess(assets, (exitCode) =>
        this.fallback(
          Object.assign(
            new Error(`vector-gpu.exe exited unexpectedly (${exitCode})`),
            { code: "PROCESS_EXITED" },
          ),
        ),
      );
      const hello = await this.process.request(
        "hello",
        { expectedProtocol: "vector-gpu/1" },
        new Uint8Array(0),
        10000,
      );
      const device = String(hello.header.device || "NVIDIA CUDA GPU");
      await this.loadSnapshot(device);
    } catch (error) {
      this.fallback(error);
      throw error;
    }
  }

  private async loadSnapshot(device: string): Promise<void> {
    if (!this.provider || !this.process) {
      throw new Error("GPU snapshot prerequisites are unavailable");
    }
    const info = await this.provider.getSnapshotInfo();
    await this.process.request(
      "snapshot.begin",
      { total: info.total, dimensions: info.dimensions },
      new Uint8Array(0),
      10000,
    );
    let afterRowId = 0;
    let loaded = 0;
    this.status.set({ phase: "loading", loaded, total: info.total });
    for (;;) {
      const rows = await this.provider.readSnapshotBatch(afterRowId, 2048);
      if (rows.length === 0) break;
      const encoded = encodeRows(rows);
      await this.process.request(
        "snapshot.batch",
        encoded.fields,
        encoded.payload,
        30000,
      );
      loaded += rows.length;
      afterRowId = rows[rows.length - 1].rowId;
      this.status.set({ phase: "loading", loaded, total: info.total });
    }
    const committed = await this.process.request(
      "snapshot.commit",
      {},
      new Uint8Array(0),
      30000,
    );

    while (this.queuedMutations.length > 0) {
      const pending = this.queuedMutations.splice(0);
      for (const mutation of pending) await this.syncMutation(mutation);
    }
    const vectors = Number(committed.header.vectors ?? loaded);
    this.status.set({ phase: "available", vectors, device });
  }

  async search(
    request: GpuVectorSearchRequest,
  ): Promise<GpuVectorSearchResult[]> {
    const operation = (async () => {
      await this.startIfEnabled();
      if (!this.process || this.status.get().phase !== "available") {
        throw Object.assign(new Error("GPU vector backend is unavailable"), {
          code: "PROCESS_START_FAILED",
        });
      }
      const response = await this.process.request(
        "search",
        {
          dimensions: request.query.byteLength,
          queryNorm: request.queryNorm,
          topK: request.topK,
          groupByItem: request.groupByItem,
          documentLimit: request.documentLimit,
          maxChunksPerItem: request.maxChunksPerItem,
          language: request.language,
          itemKeys: request.itemKeys,
          libraryID: request.libraryID,
          minScore: request.minScore,
        },
        new Uint8Array(
          request.query.buffer,
          request.query.byteOffset,
          request.query.byteLength,
        ),
        request.timeoutMs ?? 30000,
      );
      const raw = response.header.results;
      if (!Array.isArray(raw)) {
        throw Object.assign(new Error("GPU search response has no results"), {
          code: "INVALID_FRAME",
        });
      }
      if (request.stats) {
        request.stats.scanned = Number(response.header.scanned ?? 0);
      }
      return raw.map((value: any) => {
        if (
          !value ||
          typeof value.libraryID !== "number" ||
          typeof value.itemKey !== "string" ||
          typeof value.chunkId !== "number" ||
          typeof value.score !== "number" ||
          typeof value.rowId !== "number" ||
          typeof value.language !== "string"
        ) {
          throw Object.assign(
            new Error("GPU search response contains an invalid result"),
            { code: "INVALID_FRAME" },
          );
        }
        return {
          libraryID: value.libraryID,
          itemKey: value.itemKey,
          chunkId: value.chunkId,
          score: value.score,
          rowId: value.rowId,
          language: value.language,
          chunkText: "",
        };
      });
    })();
    return raceAbort(operation, request.signal);
  }

  async publishMutation(mutation: GpuVectorMutation): Promise<void> {
    if (!this.dependencies.readPreference() || this.sessionFailed) return;
    const phase = this.status.get().phase;
    if (phase === "preparing" || phase === "loading") {
      this.queuedMutations.push(mutation);
      return;
    }
    if (phase === "disabled") {
      this.queuedMutations.push(mutation);
      try {
        await this.startIfEnabled();
      } catch {
        // start() already transitions to fallback.
      }
      return;
    }
    if (phase !== "available") return;

    const operation = this.syncQueue.then(() => this.syncMutation(mutation));
    this.syncQueue = operation.catch(() => undefined);
    try {
      await operation;
    } catch (error) {
      this.fallback(error);
    }
  }

  private async syncMutation(mutation: GpuVectorMutation): Promise<void> {
    if (!this.process || !this.provider) return;
    if (mutation.kind === "itemChanged") {
      const rows = await this.provider.readItems([mutation]);
      const encoded = encodeRows(rows);
      await this.process.request(
        "index.upsert",
        {
          ...encoded.fields,
          item: {
            libraryID: mutation.libraryID,
            itemKey: mutation.itemKey,
          },
        },
        encoded.payload,
        30000,
      );
      return;
    }
    if (mutation.kind === "itemsDeleted") {
      await this.process.request("index.delete", { items: mutation.items });
      return;
    }
    if (mutation.kind === "libraryCleared") {
      await this.process.request("index.clear", {
        libraryID: mutation.libraryID,
      });
      return;
    }
    await this.process.request("index.clear", { all: true });
  }

  fallback(error: unknown): void {
    if (this.sessionFailed) return;
    this.sessionFailed = true;
    const code = errorCode(error);
    const reason = errorMessage(error);
    this.status.fallback(code, reason, this.dependencies.readPreference());
    try {
      ztoolkit.log(
        `[GpuVectorService] ${code}: ${reason}; falling back to CPU`,
        "error",
      );
    } catch {}
    this.dependencies.notifyFallback(code, reason);
    void this.stopProcess(true);
  }

  async shutdown(): Promise<void> {
    await this.stopProcess();
    this.status.set({ phase: "disabled" });
  }

  private async stopProcess(preserveFallback = false): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const process = this.process;
    this.process = null;
    try {
      await process?.stop();
    } finally {
      this.stopping = false;
      if (!preserveFallback && this.status.get().phase !== "fallback") {
        this.status.set({ phase: "disabled" });
      }
    }
  }
}

let gpuVectorService: GpuVectorService | null = null;

export function getGpuVectorService(): GpuVectorService {
  gpuVectorService ??= new GpuVectorService();
  return gpuVectorService;
}

export async function resetGpuVectorService(): Promise<void> {
  await gpuVectorService?.shutdown();
  gpuVectorService = null;
}
