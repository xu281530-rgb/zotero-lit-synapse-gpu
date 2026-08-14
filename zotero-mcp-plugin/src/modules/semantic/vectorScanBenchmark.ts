export interface VectorScanBenchmarkResult {
  runs: 10;
  durationsMs: number[];
  minMs: number;
  averageMs: number;
  maxMs: number;
}

function monotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

/** Run the production scan callback exactly ten times, sequentially. */
export async function runVectorScanBenchmark(
  scan: () => Promise<unknown>,
  now: () => number = monotonicNow,
): Promise<VectorScanBenchmarkResult> {
  const durationsMs: number[] = [];
  for (let run = 0; run < 10; run += 1) {
    const startedAt = now();
    await scan();
    durationsMs.push(Math.max(0, now() - startedAt));
  }

  const minMs = Math.min(...durationsMs);
  const maxMs = Math.max(...durationsMs);
  return {
    runs: 10,
    durationsMs,
    minMs,
    averageMs:
      durationsMs.reduce((sum, duration) => sum + duration, 0) /
      durationsMs.length,
    maxMs,
  };
}
