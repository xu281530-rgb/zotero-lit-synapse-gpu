export function normalizeWikiName(value: string): string {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase();
}

export function normalizeWikiText(value: string): string {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ");
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function hashWikiText(value: string): Promise<string> {
  const normalized = normalizeWikiText(value);
  const subtle = globalThis.crypto?.subtle;
  if (subtle && typeof TextEncoder !== "undefined") {
    const digest = await subtle.digest(
      "SHA-256",
      new TextEncoder().encode(normalized),
    );
    return bytesToHex(new Uint8Array(digest));
  }

  // Old Zotero/Firefox builds without WebCrypto still need a stable fingerprint.
  // This fallback is not used as a security primitive, only as a relocation key.
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
