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
  return hashExactText(normalizeWikiText(value), false);
}

export async function hashExactText(value: string, useWindowCrypto = true): Promise<string> {
  const win = useWindowCrypto && typeof Zotero !== 'undefined' ? Zotero.getMainWindow?.() : undefined;
  const subtle = globalThis.crypto?.subtle ?? win?.crypto?.subtle;
  const Encoder = typeof TextEncoder !== 'undefined' ? TextEncoder : win?.TextEncoder;
  if (subtle && Encoder) {
    const digest = await subtle.digest(
      "SHA-256",
      new Encoder().encode(value),
    );
    return bytesToHex(new Uint8Array(digest));
  }

  // Old Zotero/Firefox builds without WebCrypto still need a stable fingerprint.
  // This fallback is not used as a security primitive, only as a relocation key.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
