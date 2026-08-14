export type IndexWorkOutcome =
  | { status: "succeeded" }
  | { status: "failed"; error: unknown }
  | { status: "incomplete" };

export interface IndexWorkQueueResult {
  status: "completed" | "failed" | "aborted";
  processed: number;
  failedCount: number;
}

export async function runIndexWorkQueue<T>(options: {
  items: T[];
  concurrency: number;
  processItem: (item: T, workerIndex: number) => Promise<IndexWorkOutcome>;
  isPaused: () => boolean;
  isAborted: () => boolean;
  waitWhilePaused: () => Promise<void>;
  onSettled?: (
    item: T,
    outcome: Exclude<IndexWorkOutcome, { status: "incomplete" }>,
  ) => void | Promise<void>;
  onProgress?: (result: IndexWorkQueueResult) => void | Promise<void>;
}): Promise<IndexWorkQueueResult> {
  const pending = [...options.items];
  let processed = 0;
  let failedCount = 0;

  while (pending.length > 0) {
    if (options.isAborted()) {
      return { status: "aborted", processed, failedCount };
    }
    if (options.isPaused()) {
      await options.waitWhilePaused();
      if (options.isAborted()) {
        return { status: "aborted", processed, failedCount };
      }
    }

    const batch = pending.splice(0, Math.max(1, options.concurrency));
    const outcomes = await Promise.all(
      batch.map((item, workerIndex) => options.processItem(item, workerIndex)),
    );

    for (let index = 0; index < batch.length; index += 1) {
      const item = batch[index];
      const outcome = outcomes[index];
      if (outcome.status === "incomplete") {
        pending.push(item);
        continue;
      }
      processed += 1;
      if (outcome.status === "failed") failedCount += 1;
      await options.onSettled?.(item, outcome);
    }

    await options.onProgress?.({
      status: failedCount > 0 ? "failed" : "completed",
      processed,
      failedCount,
    });

    // An incomplete outcome must be paired with pause/abort. Avoid a tight
    // retry loop if a collaborator violates that contract.
    if (
      outcomes.some((outcome) => outcome.status === "incomplete") &&
      !options.isPaused() &&
      !options.isAborted()
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return {
    status: failedCount > 0 ? "failed" : "completed",
    processed,
    failedCount,
  };
}
