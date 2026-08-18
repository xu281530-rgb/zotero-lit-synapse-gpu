import type { SemanticDatabaseClearReport } from "./vectorStore";

export interface SemanticDatabaseResetDependencies {
  semanticService: {
    beginDatabaseReset(): Promise<void>;
    resetAfterDatabaseClear(): void;
    endDatabaseReset(): void;
  };
  vectorStore: {
    initialize(): Promise<void>;
    clearAll(): Promise<SemanticDatabaseClearReport>;
  };
  suspendRefreshQueue(): Promise<void>;
  resumeRefreshQueue(): void;
  suspendPDFRefreshes(): Promise<void>;
  resumePDFRefreshes(): void;
  clearRefreshQueue(): void;
  suspendAutoUpdates(): void;
  resumeAutoUpdates(): void;
  clearChunkingSignatures(): void;
  clearPaginationState(): void;
}

export async function clearSemanticDatabase(
  dependencies: SemanticDatabaseResetDependencies,
): Promise<SemanticDatabaseClearReport> {
  dependencies.suspendAutoUpdates();
  let resetStarted = false;
  try {
    await dependencies.suspendRefreshQueue();
    await dependencies.suspendPDFRefreshes();
    dependencies.clearRefreshQueue();
    await dependencies.semanticService.beginDatabaseReset();
    resetStarted = true;

    await dependencies.vectorStore.initialize();
    const report = await dependencies.vectorStore.clearAll();

    const cleanupFailures: string[] = [];
    const cleanup = async (
      label: string,
      operation: () => void | Promise<void>,
    ) => {
      try {
        await operation();
      } catch (error) {
        cleanupFailures.push(`${label}: ${String(error)}`);
      }
    };
    await cleanup("persisted refresh queue", () =>
      dependencies.clearRefreshQueue(),
    );
    await cleanup("chunking signatures", () =>
      dependencies.clearChunkingSignatures(),
    );
    await cleanup("index progress and failures", () =>
      dependencies.semanticService.resetAfterDatabaseClear(),
    );
    await cleanup("pagination state", () =>
      dependencies.clearPaginationState(),
    );
    if (cleanupFailures.length > 0) {
      throw new Error(
      `Search index database rows were cleared, but runtime cleanup was incomplete: ${cleanupFailures.join("; ")}`,
      );
    }
    return report;
  } finally {
    if (resetStarted) dependencies.semanticService.endDatabaseReset();
    dependencies.resumeAutoUpdates();
    dependencies.resumePDFRefreshes();
    dependencies.resumeRefreshQueue();
  }
}
