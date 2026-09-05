import { createRequestController } from "../requestCancellation";

/** Coalesce identical work while letting each caller cancel its own wait. */
export class SharedQuery<T> {
  private pending = new Map<
    string,
    { controller: AbortController; promise: Promise<T>; users: number }
  >();

  async run(
    key: string,
    work: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) throw new Error("Query cancelled");
    let entry = this.pending.get(key);
    if (!entry) {
      const controller = createRequestController();
      entry = {
        controller,
        users: 0,
        promise: Promise.resolve().then(() => work(controller.signal)),
      };
      const current = entry;
      this.pending.set(key, current);
      void current.promise
        .finally(() => {
          if (this.pending.get(key) === current) this.pending.delete(key);
        })
        .catch(() => undefined);
    }
    entry.users += 1;
    let cancel: (() => void) | undefined;
    try {
      return await Promise.race([
        entry.promise,
        new Promise<never>((_, reject) => {
          cancel = () => reject(new Error("Query cancelled"));
          signal?.addEventListener("abort", cancel, { once: true });
          if (signal?.aborted) cancel();
        }),
      ]);
    } finally {
      if (cancel) signal?.removeEventListener("abort", cancel);
      entry.users -= 1;
      if (entry.users === 0) {
        entry.controller.abort();
        if (this.pending.get(key) === entry) this.pending.delete(key);
      }
    }
  }

  clear(): void {
    for (const entry of this.pending.values()) entry.controller.abort();
    this.pending.clear();
  }
}
