import type { EmbeddingIdentity } from "./embeddingService";

export function parseEmbeddingIdentity(
  value: unknown,
): EmbeddingIdentity | undefined {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== "object") return undefined;
    const v = parsed as Record<string, unknown>;
    if (
      typeof v.model !== "string" ||
      !v.model ||
      typeof v.apiBase !== "string" ||
      !v.apiBase ||
      typeof v.provider !== "string" ||
      !v.provider ||
      !Number.isInteger(v.dimensions) ||
      Number(v.dimensions) <= 0 ||
      (v.requestedDimensions !== undefined &&
        (!Number.isInteger(v.requestedDimensions) ||
          Number(v.requestedDimensions) <= 0))
    )
      return undefined;
    return {
      model: v.model,
      apiBase: v.apiBase,
      provider: v.provider as EmbeddingIdentity["provider"],
      dimensions: Number(v.dimensions),
      ...(v.requestedDimensions !== undefined
        ? { requestedDimensions: Number(v.requestedDimensions) }
        : {}),
      ...(typeof v.inputHash === "string" ? { inputHash: v.inputHash } : {}),
      ...(typeof v.queryMode === "boolean" ? { queryMode: v.queryMode } : {}),
    };
  } catch {
    return undefined;
  }
}

export function serializeEmbeddingIdentity(
  identity?: EmbeddingIdentity,
  dimensions?: number,
): string | null {
  if (!identity) return null;
  const parsed = parseEmbeddingIdentity(identity);
  if (
    !parsed ||
    (dimensions !== undefined && parsed.dimensions !== dimensions)
  ) {
    throw new Error("Embedding identity does not match the generated vector");
  }
  return JSON.stringify(parsed);
}

// Input and query mode are provenance. Documents and questions intentionally differ.
export function compatibleEmbeddingIdentity(
  left?: EmbeddingIdentity,
  right?: EmbeddingIdentity,
): boolean {
  return Boolean(
    left &&
      right &&
      left.model === right.model &&
      left.apiBase === right.apiBase &&
      left.provider === right.provider &&
      left.dimensions === right.dimensions &&
      left.requestedDimensions === right.requestedDimensions,
  );
}

export function embeddingSpaceKey(identity?: EmbeddingIdentity): string | null {
  const parsed = parseEmbeddingIdentity(identity);
  return parsed
    ? JSON.stringify([
        parsed.provider,
        parsed.apiBase,
        parsed.model,
        parsed.dimensions,
        parsed.requestedDimensions ?? null,
      ])
    : null;
}
