import type { GpuVectorFailureCode } from "./gpuVectorStatus";

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
  query: Int8Array;
  queryNorm: number;
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
  norm: number;
  vector: Int8Array;
}

export interface GpuVectorSnapshotInfo {
  total: number;
  dimensions: number;
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
  ): Promise<GpuVectorSnapshotRow[]>;
  readItems(
    identities: GpuVectorIdentity[],
  ): Promise<GpuVectorSnapshotRow[]>;
}

export type GpuVectorMutation =
  | ({ kind: "itemChanged" } & GpuVectorIdentity)
  | { kind: "itemsDeleted"; items: GpuVectorIdentity[] }
  | { kind: "libraryCleared"; libraryID: number }
  | { kind: "allCleared" };

export interface GpuVectorSearchBackend {
  isEnabled(): boolean;
  registerProvider(provider: GpuVectorDataProvider): void;
  startIfEnabled(): Promise<void>;
  search(request: GpuVectorSearchRequest): Promise<GpuVectorSearchResult[]>;
  publishMutation(mutation: GpuVectorMutation): Promise<void>;
  fallback(error: unknown): void;
  setEnabled(enabled: boolean): Promise<void>;
  shutdown(): Promise<void>;
}

export interface GpuVectorBackendError extends Error {
  code?: GpuVectorFailureCode;
}
