export const TOOL_ABORT_SIGNAL = Symbol("toolAbortSignal");

export function createRequestController(): AbortController {
  const Controller =
    typeof AbortController === "function"
      ? AbortController
      : (Zotero.getMainWindow() as any)?.AbortController;
  if (!Controller)
    throw new Error(
      "Request cancellation is unavailable in this Zotero window.",
    );
  return new Controller();
}

export function requestSignal(args: any): AbortSignal | undefined {
  return args?.[TOOL_ABORT_SIGNAL];
}

export function forwardCancellation(
  signal: AbortSignal | undefined,
  controller: AbortController | null,
): () => void {
  const abort = () => controller?.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return () => signal?.removeEventListener("abort", abort);
}

export function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new Error("Request cancelled. No further retrieval will be started.");
}
