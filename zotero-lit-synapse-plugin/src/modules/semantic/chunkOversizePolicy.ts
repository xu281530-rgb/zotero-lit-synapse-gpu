/**
 * What an index build does when a whole chunk is longer than the embedding
 * endpoint will accept.
 *
 * Chunks are never split, so this is the one failure the plugin cannot work
 * around on its own — and it is a settings problem wearing one document's
 * clothes. Chunk length is global, so the paper that tripped it is almost
 * never the only one that will. That leaves two defensible responses, and
 * which is right depends on what the user is doing rather than on anything the
 * code can see: abandoning a four-hour rebuild over three unusual PDFs is as
 * wrong as silently omitting them from a library the user believes is complete.
 *
 * So the choice is theirs, asked once, and everything else here exists to make
 * "once" true and to make the consequences of either answer visible afterwards.
 *
 * This module is deliberately free of Zotero, of the database and of the
 * embedding service: it is the decision, not the plumbing.
 */

export type ChunkTooLargeDecision = 'skip' | 'stop';

export interface ChunkTooLargeDecisionRequest {
  /** The item whose chunk could not be embedded. */
  itemKey: string;
  libraryID: number;
  /** Item title if it could be resolved, so the prompt names a real paper. */
  title?: string;
  /** The bilingual explanation of what is wrong and how to fix it. */
  message: string;
}

export type ChunkTooLargeAsk = (
  request: ChunkTooLargeDecisionRequest,
) => Promise<ChunkTooLargeDecision>;

/**
 * Asks the user at most once per run, then applies the answer silently.
 *
 * Two things make this more than a cached boolean:
 *
 *  - Items are indexed five at a time, so five workers can hit an oversized
 *    chunk before any of them has an answer. They all await the same in-flight
 *    promise, which is why the user sees one dialog and not five stacked on
 *    top of each other.
 *  - Not being able to ask is not permission to discard someone's papers. With
 *    no handler registered (a background auto-update, an MCP-triggered build)
 *    or with a prompt that throws, the answer is 'stop' — the conservative
 *    half, and what the plugin did before this prompt existed.
 */
export class ChunkOversizeDecisionGate {
  private ask?: ChunkTooLargeAsk;
  /** The answer for this run, once given. Null means "not asked yet". */
  private decision: ChunkTooLargeDecision | null = null;
  /** The prompt currently on screen, shared by every waiting worker. */
  private pending: Promise<ChunkTooLargeDecision> | null = null;
  /** Prompts actually shown; a run must never show more than one. */
  private asked = 0;

  setAsk(ask: ChunkTooLargeAsk | undefined): void {
    this.ask = ask;
  }

  hasAsk(): boolean {
    return typeof this.ask === 'function';
  }

  /** Forget this run's answer, so the next build asks again. */
  reset(): void {
    this.decision = null;
    this.pending = null;
    this.asked = 0;
  }

  /** The answer so far, without asking. */
  current(): ChunkTooLargeDecision | null {
    return this.decision;
  }

  /** How many times the user was actually prompted this run. */
  promptCount(): number {
    return this.asked;
  }

  async decide(
    request: ChunkTooLargeDecisionRequest,
    onError?: (error: unknown) => void,
  ): Promise<ChunkTooLargeDecision> {
    if (this.decision) return this.decision;
    if (!this.ask) return 'stop';

    if (!this.pending) {
      this.asked += 1;
      const ask = this.ask;
      this.pending = (async () => {
        try {
          const answer = await ask(request);
          return answer === 'skip' ? 'skip' : 'stop';
        } catch (error) {
          onError?.(error);
          return 'stop';
        }
      })();
    }

    const decision = await this.pending;
    // Recorded only after the prompt settles, so the concurrent callers that
    // were waiting on it all observe the same answer.
    this.decision = decision;
    this.pending = null;
    return decision;
  }
}

export type BuildRunStatus =
  | 'completed'
  | 'incomplete'
  | 'failed'
  | 'aborted';

/**
 * Name a finished run that deliberately left documents out.
 *
 * 'incomplete' is its own status rather than a flavour of 'failed' because the
 * two need different things from the user, and because only 'completed' is
 * allowed to record the full-library chunking signature — so giving skipped
 * runs their own name is also what guarantees the index is never claimed to
 * match the current chunk settings while part of it is missing.
 *
 * 'aborted' is left alone: a run the user stopped is already the more specific
 * fact, and overwriting it would hide why the run ended.
 */
export function applyOversizeSkipToStatus<T extends string>(
  status: T,
  chunkOversizeSkipped: number,
): T | 'incomplete' {
  if (chunkOversizeSkipped <= 0) return status;
  if (status === 'completed' || status === 'failed') return 'incomplete';
  return status;
}

export interface RunTally {
  /** Documents whose vectors were written. */
  indexed: number;
  /** Documents left out because a chunk was too long for the endpoint. */
  skipped: number;
  /** Documents that failed for any other reason. */
  otherFailures: number;
}

/**
 * Split a finished run into the three numbers a user can act on.
 *
 * Skipped documents are also counted in `failedCount` — they are written to
 * index_failures on purpose, so that lowering the chunk length and pressing
 * "retry failed items" picks them up without rebuilding the whole library —
 * which is exactly why the closing summary has to subtract them back out.
 * Reporting "3 items failed" for three documents the user chose to skip would
 * describe their own decision back to them as a malfunction.
 */
export function summarizeRun(progress: {
  processed?: number;
  failedCount?: number;
  chunkOversizeSkipped?: number;
}): RunTally {
  const processed = Math.max(0, progress.processed ?? 0);
  const failed = Math.max(0, progress.failedCount ?? 0);
  const skipped = Math.max(0, progress.chunkOversizeSkipped ?? 0);
  return {
    indexed: Math.max(0, processed - failed),
    skipped,
    otherFailures: Math.max(0, failed - skipped),
  };
}
