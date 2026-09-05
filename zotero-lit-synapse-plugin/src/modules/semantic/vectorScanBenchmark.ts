export interface TimingSample {
  durationsMs: number[];
  minMs: number;
  averageMs: number;
  maxMs: number;
}

export interface VectorScanBenchmarkResult extends TimingSample {
  runs: 10;
}

/** Sequential runs per keyword profile — see runKeywordSearchBenchmark. */
export const KEYWORD_BENCHMARK_RUNS = 5;
/** Sequential runs of the full vector scan. */
export const VECTOR_BENCHMARK_RUNS = 10;

/**
 * Smallest timeout the scan test will ever recommend.
 *
 * A library small enough to scan in 40ms would otherwise be handed a ~80ms
 * timeout, which the first GC pause or background sync would blow through. The
 * floor buys unconditional headroom for events that have nothing to do with
 * library size.
 */
export const RECOMMENDED_TIMEOUT_FLOOR_MS = 3000;

function monotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

export function summarizeDurations(durationsMs: number[]): TimingSample {
  if (durationsMs.length === 0) {
    return { durationsMs: [], minMs: 0, averageMs: 0, maxMs: 0 };
  }
  return {
    durationsMs,
    minMs: Math.min(...durationsMs),
    maxMs: Math.max(...durationsMs),
    averageMs:
      durationsMs.reduce((sum, duration) => sum + duration, 0) /
      durationsMs.length,
  };
}

/** Time `operation` `runs` times, sequentially. */
export async function timeRuns(
  operation: () => Promise<unknown>,
  runs: number,
  now: () => number = monotonicNow,
): Promise<TimingSample> {
  const durationsMs: number[] = [];
  for (let run = 0; run < runs; run += 1) {
    const startedAt = now();
    await operation();
    durationsMs.push(Math.max(0, now() - startedAt));
  }
  return summarizeDurations(durationsMs);
}

/** Run the production scan callback exactly ten times, sequentially. */
export async function runVectorScanBenchmark(
  scan: () => Promise<unknown>,
  now: () => number = monotonicNow,
): Promise<VectorScanBenchmarkResult> {
  const sample = await timeRuns(scan, VECTOR_BENCHMARK_RUNS, now);
  return { runs: VECTOR_BENCHMARK_RUNS, ...sample };
}

/**
 * Turn a timing sample into a timeout worth storing.
 *
 * Two independent safety margins, whichever is larger:
 *
 * - `max x 2` covers proportional slowdown — a machine that is busier, a
 *   library that has grown since the test.
 * - `max + 3 x (max - average)` covers volatility. When every run took roughly
 *   the same time this term is small and the doubling wins; when one run was a
 *   long outlier it means the workload is spiky and deserves more headroom than
 *   doubling gives.
 *
 * The floor then guarantees a minimum absolute headroom. Taking the larger of
 * the three means a stable-but-slow library and a fast-but-spiky one both end
 * up with a timeout that reflects the reason they might overrun.
 */
export function recommendTimeoutMs(
  sample: Pick<TimingSample, "averageMs" | "maxMs">,
  floorMs: number = RECOMMENDED_TIMEOUT_FLOOR_MS,
): number {
  const max = Number.isFinite(sample.maxMs) ? Math.max(0, sample.maxMs) : 0;
  const average = Number.isFinite(sample.averageMs)
    ? Math.max(0, sample.averageMs)
    : 0;
  const proportional = max * 2;
  const volatility = max + 3 * Math.max(0, max - average);
  return Math.ceil(Math.max(proportional, volatility, floorMs));
}
