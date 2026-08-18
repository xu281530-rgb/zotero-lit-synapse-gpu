import {
  SemanticDatabaseClearError,
  type SemanticDatabaseClearOptions,
  type SemanticDatabaseClearReport,
} from "./vectorStore";

export interface SemanticDatabaseResetDependencies {
  semanticService: {
    beginDatabaseReset(): Promise<void>;
    resetAfterDatabaseClear(): void;
    endDatabaseReset(): void;
  };
  vectorStore: {
    initialize(): Promise<void>;
    clearAll(
      options?: SemanticDatabaseClearOptions,
    ): Promise<SemanticDatabaseClearReport>;
  };
  suspendRefreshQueue(): Promise<void>;
  resumeRefreshQueue(): void;
  prepareRefreshQueueReset(): string;
  markRefreshQueueDatabaseCleared(generation: string): void;
  cancelRefreshQueueReset(generation: string): void;
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
  let resetGeneration: string | null = null;
  let databaseCleared = false;
  let refreshQueueCleared = false;
  try {
    await dependencies.suspendRefreshQueue();
    await dependencies.suspendPDFRefreshes();
    resetGeneration = dependencies.prepareRefreshQueueReset();
    await dependencies.semanticService.beginDatabaseReset();
    resetStarted = true;

    await dependencies.vectorStore.initialize();
    const report = await dependencies.vectorStore.clearAll({
      resetGeneration,
      onDatabaseCleared: () => {
        databaseCleared = true;
        dependencies.markRefreshQueueDatabaseCleared(resetGeneration!);
      },
    });
    databaseCleared = true;

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
    await cleanup("persisted refresh queue", () => {
      dependencies.clearRefreshQueue();
      refreshQueueCleared = true;
    });
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
  } catch (error) {
    if (
      error instanceof SemanticDatabaseClearError &&
      error.databaseCleared
    ) {
      databaseCleared = true;
      if (resetGeneration) {
        try {
          dependencies.markRefreshQueueDatabaseCleared(resetGeneration);
        } catch {
          // The SQLite generation is authoritative. A preparing preference is
          // intentionally left blocking so startup can reconcile it.
        }
      }
    }
    throw error;
  } finally {
    if (resetStarted) dependencies.semanticService.endDatabaseReset();
    if (!databaseCleared && resetGeneration) {
      dependencies.cancelRefreshQueueReset(resetGeneration);
      resetGeneration = null;
    }
    // After clearAll commits, the old queue is invalid forever. Keep every
    // producer and drain paused until its persisted rows have actually gone.
    if (!databaseCleared || refreshQueueCleared) {
      dependencies.resumeAutoUpdates();
      dependencies.resumePDFRefreshes();
      dependencies.resumeRefreshQueue();
    }
  }
}
