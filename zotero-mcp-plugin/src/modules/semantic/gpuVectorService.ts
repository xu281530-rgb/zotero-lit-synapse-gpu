import type {
  GpuVectorDataProvider,
  GpuVectorMutation,
  GpuVectorPrecision,
  GpuVectorPrecisionPreference,
  GpuVectorSearchBackend,
  GpuVectorSearchRequest,
  GpuVectorSearchResult,
  GpuVectorSnapshotInfo,
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
import { GPU_PROTOCOL_VERSION, type GpuFrame } from "./gpuVectorProtocol";

declare const Zotero: any;
declare const addon: any;
declare let ztoolkit: ZToolkit;

export const GPU_ACCELERATION_PREF =
  "extensions.zotero.zotero-mcp-plugin.hybrid.gpuAccelerationEnabled";
export const GPU_PRECISION_PREF =
  "extensions.zotero.zotero-mcp-plugin.hybrid.gpuPrecision";

const GPU_MEMORY_RESERVE_BYTES = 512 * 1024 * 1024;
const GPU_CAPACITY_NUMERATOR = 5;
const GPU_CAPACITY_DENOMINATOR = 4;

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
  readPrecision(): GpuVectorPrecisionPreference;
  writePrecision(precision: GpuVectorPrecisionPreference): void;
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

function formatFallbackNotification(code: string, reason: string): string {
  try {
    const message = addon.data.locale?.current.formatMessagesSync([
      {
        id: "zotero-mcp-plugin-pref-hybrid-gpu-fallback-notification",
        args: { code, reason },
      },
    ])?.[0]?.value;
    if (message) return message;
  } catch {
    // Locale initialization must not affect retrieval fallback.
  }
  return `GPU vector acceleration is unavailable; using CPU (${code}): ${reason}`;
}

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
    readPrecision: () => {
      try {
        const value = String(Zotero.Prefs.get(GPU_PRECISION_PREF, true));
        return value === "float32" || value === "int8" ? value : "auto";
      } catch {
        return "auto";
      }
    },
    writePrecision: (precision) =>
      Zotero.Prefs.set(GPU_PRECISION_PREF, precision, true),
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
            text: formatFallbackNotification(code, reason),
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

function bytesPerElement(precision: GpuVectorPrecision): number {
  return precision === "float32" ? Float32Array.BYTES_PER_ELEMENT : 1;
}

export function estimateGpuIndexBytes(
  total: number,
  dimensions: number,
  precision: GpuVectorPrecision,
): number {
  if (total <= 0 || dimensions <= 0) return 0;
  const capacity = Math.max(
    1024,
    Math.ceil((total * GPU_CAPACITY_NUMERATOR) / GPU_CAPACITY_DENOMINATOR),
  );
  return (
    capacity * dimensions * bytesPerElement(precision) +
    capacity * 2 * Float64Array.BYTES_PER_ELEMENT +
    dimensions * bytesPerElement(precision)
  );
}

export function chooseGpuPrecision(options: {
  preference: GpuVectorPrecisionPreference;
  snapshot: GpuVectorSnapshotInfo;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
}): GpuVectorPrecision {
  const { preference, snapshot } = options;
  const reserve = Math.max(
    GPU_MEMORY_RESERVE_BYTES,
    Math.floor(options.totalMemoryBytes * 0.1),
  );
  const usable = Math.max(0, options.freeMemoryBytes - reserve);
  const available = (precision: GpuVectorPrecision) =>
    snapshot.total === 0 ||
    (precision === "float32"
      ? snapshot.float32Count === snapshot.total
      : snapshot.int8Count === snapshot.total);
  const fits = (precision: GpuVectorPrecision) =>
    available(precision) &&
    estimateGpuIndexBytes(snapshot.total, snapshot.dimensions, precision) <=
      usable;

  if (preference !== "auto") {
    if (!available(preference)) {
      throw Object.assign(
        new Error(`The semantic index has incomplete ${preference} vectors`),
        { code: "INDEX_UNSUPPORTED" },
      );
    }
    if (!fits(preference)) {
      throw Object.assign(
        new Error(`Insufficient GPU memory for ${preference}`),
        { code: "OUT_OF_MEMORY" },
      );
    }
    return preference;
  }
  if (fits("float32")) return "float32";
  if (fits("int8")) return "int8";
  throw Object.assign(
    new Error("Insufficient GPU memory for Float32 or Int8 vectors"),
    { code: "OUT_OF_MEMORY" },
  );
}

function quantizeQuery(vector: Float32Array): Int8Array {
  let maxAbs = 0;
  for (const value of vector) maxAbs = Math.max(maxAbs, Math.abs(value));
  const scale = maxAbs > 0 ? 127 / maxAbs : 1;
  const result = new Int8Array(vector.length);
  for (let index = 0; index < vector.length; index++) {
    result[index] = Math.round(vector[index] * scale);
  }
  return result;
}

function encodeRows(
  rows: GpuVectorSnapshotRow[],
  precision: GpuVectorPrecision,
): {
  fields: Record<string, unknown>;
  payload: Uint8Array;
} {
  const dimensions = rows[0]?.dimensions ?? 0;
  const elementBytes = bytesPerElement(precision);
  const payload = new Uint8Array(rows.length * dimensions * elementBytes);
  const metadata = rows.map((row, index) => {
    if (
      row.dimensions !== dimensions ||
      row.vector.byteLength !== dimensions * elementBytes ||
      (precision === "float32" && !(row.vector instanceof Float32Array)) ||
      (precision === "int8" && !(row.vector instanceof Int8Array))
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
      index * dimensions * elementBytes,
    );
    return {
      rowId: row.rowId,
      libraryID: row.libraryID,
      itemKey: row.itemKey,
      chunkId: row.chunkId,
      language: row.language,
    };
  });
  return { fields: { dimensions, precision, rows: metadata }, payload };
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error("Vector scan cancelled"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("Vector scan cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
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
  private effectivePrecision: GpuVectorPrecision = "int8";
  private readonly dependencies: GpuVectorServiceDependencies;

  constructor(
    dependencies: GpuVectorServiceDependencies = defaultDependencies(),
  ) {
    this.dependencies = dependencies;
    const preference = dependencies.readPrecision();
    if (preference !== "auto") this.effectivePrecision = preference;
  }

  isEnabled(): boolean {
    return !this.sessionFailed && this.dependencies.readPreference();
  }

  getEffectivePrecision(): GpuVectorPrecision {
    return this.effectivePrecision;
  }

  getCpuFallbackPrecision(): GpuVectorPrecision | undefined {
    return this.sessionFailed && this.dependencies.readPreference()
      ? this.effectivePrecision
      : undefined;
  }

  reportCpuPrecision(precision: GpuVectorPrecision): void {
    this.effectivePrecision = precision;
    const status = this.status.get();
    if (status.phase === "fallback" || status.phase === "disabled") {
      this.status.set({ ...status, precision });
    }
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
      this.status.set({
        phase: "disabled",
        backend: "cpu",
        precision: this.effectivePrecision,
      });
      return;
    }
    this.sessionFailed = false;
    await this.startIfEnabled();
  }

  async setPrecision(precision: GpuVectorPrecisionPreference): Promise<void> {
    this.dependencies.writePrecision(precision);
    if (precision !== "auto") this.effectivePrecision = precision;
    this.sessionFailed = false;
    this.queuedMutations = [];
    await this.stopProcess();
    if (this.dependencies.readPreference()) await this.startIfEnabled();
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
      const preference = this.dependencies.readPrecision();
      if (preference !== "auto") this.effectivePrecision = preference;
      this.dependencies.assertPlatform();
      const assets = await this.dependencies.extractAssets();
      const snapshot = await this.provider!.getSnapshotInfo();
      try {
        await this.launchAndLoad(assets, snapshot, preference);
      } catch (error) {
        if (
          preference === "auto" &&
          this.effectivePrecision === "float32" &&
          errorCode(error) === "OUT_OF_MEMORY"
        ) {
          await this.stopProcess(true);
          await this.launchAndLoad(assets, snapshot, "int8");
        } else {
          throw error;
        }
      }
    } catch (error) {
      this.fallback(error);
      throw error;
    }
  }

  private async launchAndLoad(
    assets: ExtractedGpuAssets,
    snapshot: GpuVectorSnapshotInfo,
    preference: GpuVectorPrecisionPreference,
  ): Promise<void> {
    this.process = await this.dependencies.launchProcess(assets, (exitCode) => {
      if (this.stopping) return;
      this.fallback(
        Object.assign(
          new Error(`vector-gpu.exe exited unexpectedly (${exitCode})`),
          { code: "PROCESS_EXITED" },
        ),
      );
    });
    const hello = await this.process.request(
      "hello",
      { expectedProtocol: GPU_PROTOCOL_VERSION },
      new Uint8Array(0),
      10000,
    );
    const totalMemoryBytes = Number(hello.header.totalMemoryBytes ?? 0);
    const freeMemoryBytes = Number(hello.header.freeMemoryBytes ?? 0);
    const device = String(hello.header.device || "NVIDIA CUDA GPU");
    this.effectivePrecision = chooseGpuPrecision({
      preference,
      snapshot,
      totalMemoryBytes,
      freeMemoryBytes,
    });
    this.status.set({
      phase: "preparing",
      precision: this.effectivePrecision,
    });
    await this.loadSnapshot(device, snapshot, this.effectivePrecision);
  }

  private async loadSnapshot(
    device: string,
    info: GpuVectorSnapshotInfo,
    precision: GpuVectorPrecision,
  ): Promise<void> {
    if (!this.provider || !this.process) {
      throw new Error("GPU snapshot prerequisites are unavailable");
    }
    await this.process.request(
      "snapshot.begin",
      { total: info.total, dimensions: info.dimensions, precision },
      new Uint8Array(0),
      10000,
    );
    let afterRowId = 0;
    let loaded = 0;
    this.status.set({ phase: "loading", loaded, total: info.total, precision });
    for (;;) {
      const rows = await this.provider.readSnapshotBatch(
        afterRowId,
        2048,
        precision,
      );
      if (rows.length === 0) break;
      const encoded = encodeRows(rows, precision);
      await this.process.request(
        "snapshot.batch",
        encoded.fields,
        encoded.payload,
        30000,
      );
      loaded += rows.length;
      afterRowId = rows[rows.length - 1].rowId;
      this.status.set({
        phase: "loading",
        loaded,
        total: info.total,
        precision,
      });
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
    this.status.set({
      phase: "available",
      backend: "gpu",
      vectors,
      device,
      precision,
      deviceBytes: Number(committed.header.deviceBytes ?? 0),
    });
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
      const precision = this.effectivePrecision;
      const query =
        precision === "float32" ? request.query : quantizeQuery(request.query);
      let queryNormSquared = 0;
      for (const value of query) queryNormSquared += value * value;
      if (!(queryNormSquared > 0)) return [];
      const response = await this.process.request(
        "search",
        {
          dimensions: request.query.length,
          precision,
          queryNorm: Math.sqrt(queryNormSquared),
          topK: request.topK,
          groupByItem: request.groupByItem,
          documentLimit: request.documentLimit,
          maxChunksPerItem: request.maxChunksPerItem,
          language: request.language,
          itemKeys: request.itemKeys,
          // Explicit null rather than an omitted key: the worker treats both as
          // "all libraries", and sending the key keeps the frame shape stable.
          libraryID: request.libraryID ?? null,
          minScore: request.minScore,
        },
        new Uint8Array(query.buffer, query.byteOffset, query.byteLength),
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
      if (
        this.dependencies.readPrecision() === "auto" &&
        this.effectivePrecision === "float32" &&
        errorCode(error) === "OUT_OF_MEMORY"
      ) {
        try {
          await this.reloadSnapshotAsInt8();
          return;
        } catch (retryError) {
          this.fallback(retryError);
          return;
        }
      }
      this.fallback(error);
    }
  }

  private async reloadSnapshotAsInt8(): Promise<void> {
    if (!this.provider) {
      throw Object.assign(new Error("GPU vector data provider is unavailable"), {
        code: "PROCESS_START_FAILED",
      });
    }
    this.status.set({ phase: "preparing", precision: "int8" });
    await this.stopProcess(true);
    const assets = await this.dependencies.extractAssets();
    const snapshot = await this.provider.getSnapshotInfo();
    await this.launchAndLoad(assets, snapshot, "int8");
  }

  private async syncMutation(mutation: GpuVectorMutation): Promise<void> {
    if (!this.process || !this.provider) return;
    if (mutation.kind === "itemChanged") {
      const rows = await this.provider.readItems(
        [mutation],
        this.effectivePrecision,
      );
      const encoded = encodeRows(rows, this.effectivePrecision);
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
      await this.process.request("index.delete", {
        precision: this.effectivePrecision,
        items: mutation.items,
      });
      return;
    }
    if (mutation.kind === "libraryCleared") {
      await this.process.request("index.clear", {
        precision: this.effectivePrecision,
        libraryID: mutation.libraryID,
      });
      return;
    }
    const cleared = await this.process.request("index.clear", {
      precision: this.effectivePrecision,
      all: true,
    });
    const status = this.status.get();
    if (status.phase === "available") {
      this.status.set({
        ...status,
        vectors: Number(cleared.header.vectors ?? 0),
        deviceBytes: Number(cleared.header.deviceBytes ?? 0),
      });
    }
  }

  fallback(error: unknown): void {
    if (this.sessionFailed) return;
    this.sessionFailed = true;
    const code = errorCode(error);
    const reason = errorMessage(error);
    this.status.fallback(
      code,
      reason,
      this.dependencies.readPreference(),
      this.effectivePrecision,
    );
    try {
      ztoolkit.log(
        `[GpuVectorService] ${code}: ${reason}; falling back to CPU`,
        "error",
      );
    } catch {
      // Logging is best-effort during shutdown or partial initialization.
    }
    this.dependencies.notifyFallback(code, reason);
    void this.stopProcess(true);
  }

  async shutdown(): Promise<void> {
    await this.syncQueue.catch(() => undefined);
    this.queuedMutations = [];
    await this.stopProcess();
    this.status.set({
      phase: "disabled",
      backend: "cpu",
      precision: this.effectivePrecision,
    });
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
        this.status.set({
          phase: "disabled",
          backend: "cpu",
          precision: this.effectivePrecision,
        });
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
