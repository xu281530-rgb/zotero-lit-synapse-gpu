import { GPU_ASSET_MANIFEST_SHA256 } from "./gpuAssetManifest.generated";

declare const rootURI: string;
declare const Zotero: any;
declare const PathUtils: any;
declare const IOUtils: any;

export interface GpuAssetManifest {
  schemaVersion: 1;
  assetVersion: string;
  protocol: "vector-gpu/1";
  platform: "windows-x64";
  files: Array<{
    name: string;
    sha256: string;
    size: number;
  }>;
}

export interface ExtractedGpuAssets {
  directory: string;
  executable: string;
  manifest: GpuAssetManifest;
}

function resourceError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "RESOURCE_CORRUPT" });
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw resourceError(`Bundled GPU resource is missing: ${url}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export function assertSupportedGpuPlatform(): void {
  const os = String(Services.appinfo.OS || "");
  const abi = String(Services.appinfo.XPCOMABI || "");
  if (os !== "WINNT" || !/x86_64|x64/i.test(abi)) {
    throw Object.assign(
      new Error("GPU vector acceleration supports Windows x64 only"),
      { code: "UNSUPPORTED_PLATFORM" },
    );
  }
}

export async function extractGpuAssets(): Promise<ExtractedGpuAssets> {
  const manifestURL = `${rootURI}native/gpu/manifest.json`;
  const manifestBytes = await fetchBytes(manifestURL);
  const manifestHash = await sha256(manifestBytes);
  if (
    !GPU_ASSET_MANIFEST_SHA256 ||
    manifestHash !== GPU_ASSET_MANIFEST_SHA256
  ) {
    throw resourceError("Bundled GPU resource manifest hash is invalid");
  }

  let manifest: GpuAssetManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch (error) {
    throw resourceError(`Bundled GPU manifest is invalid: ${error}`);
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.protocol !== "vector-gpu/1" ||
    manifest.platform !== "windows-x64" ||
    !manifest.assetVersion ||
    !Array.isArray(manifest.files)
  ) {
    throw resourceError("Bundled GPU manifest has an unsupported schema");
  }

  const directory = PathUtils.join(
    Zotero.DataDirectory.dir,
    "zotero-mcp-plugin",
    "gpu",
    manifest.assetVersion,
  );
  await IOUtils.makeDirectory(directory, {
    createAncestors: true,
    ignoreExisting: true,
  });

  for (const file of manifest.files) {
    if (!/^[A-Za-z0-9_.-]+$/.test(file.name)) {
      throw resourceError(`Unsafe GPU asset name: ${file.name}`);
    }
    const target = PathUtils.join(directory, file.name);
    const existingHash = (await IOUtils.exists(target))
      ? String(await IOUtils.computeHexDigest(target, "sha256")).toLowerCase()
      : "";
    if (existingHash === file.sha256.toLowerCase()) continue;

    const bytes = await fetchBytes(`${rootURI}native/gpu/${file.name}`);
    if (
      bytes.byteLength !== file.size ||
      (await sha256(bytes)) !== file.sha256.toLowerCase()
    ) {
      throw resourceError(`Bundled GPU asset failed verification: ${file.name}`);
    }
    await IOUtils.write(target, bytes, {
      tmpPath: `${target}.tmp`,
      flush: true,
    });
    const writtenHash = String(
      await IOUtils.computeHexDigest(target, "sha256"),
    ).toLowerCase();
    if (writtenHash !== file.sha256.toLowerCase()) {
      throw resourceError(`Extracted GPU asset failed verification: ${file.name}`);
    }
  }

  const storedManifest = PathUtils.join(directory, "manifest.json");
  await IOUtils.write(storedManifest, manifestBytes, {
    tmpPath: `${storedManifest}.tmp`,
    flush: true,
  });
  const executable = PathUtils.join(directory, "vector-gpu.exe");
  if (!(await IOUtils.exists(executable))) {
    throw resourceError("vector-gpu.exe is absent from the GPU asset bundle");
  }
  return { directory, executable, manifest };
}
