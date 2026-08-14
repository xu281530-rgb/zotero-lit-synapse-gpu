import type { GpuVectorFailureCode } from "./gpuVectorStatus";

export type GpuVectorPrecision = "float32" | "int8";
export type GpuVectorPrecisionPreference = "auto" | GpuVectorPrecision;

export interface GpuVectorSearchResult {
  libraryID: number;
  itemKey: string;
  chunkId: number;
  score: number;
  chunkText: string;
  language: string;
  rowId?: number;
}

export interface GpuVectorSearchRequest {
  query: Float32Array;
  topK: number;
  groupByItem: boolean;
  documentLimit?: number;
  maxChunksPerItem: number;
  language: "zh" | "en" | "all";
  itemKeys?: string[];
  minScore: number;
  libraryID: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  stats?: { scanned?: number };
}

export interface GpuVectorSnapshotRow {
  rowId: number;
  libraryID: number;
  itemKey: string;
  chunkId: number;
  language: "zh" | "en";
  dimensions: number;
  vector: Float32Array | Int8Array;
}

export interface GpuVectorSnapshotInfo {
  total: number;
  dimensions: number;
  float32Count: number;
  int8Count: number;
}

export interface GpuVectorIdentity {
  libraryID: number;
  itemKey: string;
}

export interface GpuVectorDataProvider {
  getSnapshotInfo(): Promise<GpuVectorSnapshotInfo>;
  readSnapshotBatch(
    afterRowId: number,
    limit: number,
    precision: GpuVectorPrecision,
  ): Promise<GpuVectorSnapshotRow[]>;
  readItems(
    identities: GpuVectorIdentity[],
    precision: GpuVectorPrecision,
  ): Promise<GpuVectorSnapshotRow[]>;
}

export type GpuVectorMutation =
  | ({ kind: "itemChanged" } & GpuVectorIdentity)
  | { kind: "itemsDeleted"; items: GpuVectorIdentity[] }
  | { kind: "libraryCleared"; libraryID: number }
  | { kind: "allCleared" };

export interface GpuVectorSearchBackend {
  isEnabled(): boolean;
  getEffectivePrecision(): GpuVectorPrecision;
  getCpuFallbackPrecision(): GpuVectorPrecision | undefined;
  reportCpuPrecision(precision: GpuVectorPrecision): void;
  registerProvider(provider: GpuVectorDataProvider): void;
  startIfEnabled(): Promise<void>;
  search(request: GpuVectorSearchRequest): Promise<GpuVectorSearchResult[]>;
  publishMutation(mutation: GpuVectorMutation): Promise<void>;
  fallback(error: unknown): void;
  setEnabled(enabled: boolean): Promise<void>;
  setPrecision(precision: GpuVectorPrecisionPreference): Promise<void>;
  shutdown(): Promise<void>;
}

export interface GpuVectorBackendError extends Error {
  code?: GpuVectorFailureCode;
}
