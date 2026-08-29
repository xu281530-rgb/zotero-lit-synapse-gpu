/**
 * Reading a stored vector back, and comparing two of them.
 *
 * Extracted from the Claim retriever when Concepts got vectors of their own:
 * two places now decode the same BLOB layout, and a decoder that disagreed
 * with the encoder in one of them would not fail loudly - it would silently
 * score everything zero, which reads exactly like "nothing is similar".
 */

/**
 * A stored embedding BLOB as a Float32Array, or null if it is not one.
 *
 * The length check is the point: a row written under a different model, or
 * truncated, decodes to garbage rather than throwing, and garbage compared by
 * cosine returns a plausible-looking number. Refusing the row instead means a
 * mismatch shows up as "no vector" and the caller falls back to lexical.
 */
export function floatVector(
  blob: unknown,
  dimensions: number,
): Float32Array | null {
  if (!Number.isInteger(dimensions) || dimensions <= 0) return null;
  const expectedBytes = dimensions * Float32Array.BYTES_PER_ELEMENT;
  if (blob instanceof Uint8Array) {
    if (blob.byteLength !== expectedBytes) return null;
    return new Float32Array(
      blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength),
      0,
      dimensions,
    );
  }
  if (blob instanceof ArrayBuffer) {
    if (blob.byteLength !== expectedBytes) return null;
    return new Float32Array(blob, 0, dimensions);
  }
  return null;
}

/** Cosine similarity, clamped to [0, 1]. Zero for anything incomparable. */
export function cosine(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length || !left.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (!leftNorm || !rightNorm) return 0;
  return Math.max(0, Math.min(1, dot / Math.sqrt(leftNorm * rightNorm)));
}

/** The bytes to store for a vector, without copying it. */
export function vectorBytes(vector: Float32Array): Uint8Array {
  return new Uint8Array(
    vector.buffer,
    vector.byteOffset,
    vector.byteLength,
  );
}
