/* eslint-env node */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const AdmZip = require("adm-zip");
const projectDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const assetDirectory = path.join(projectDirectory, "addon", "native", "gpu");
const manifestBytes = await readFile(
  path.join(assetDirectory, "manifest.json"),
);
const manifest = JSON.parse(manifestBytes.toString("utf8"));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.protocol, "vector-gpu/2");
assert.equal(manifest.platform, "windows-x64");
assert.match(manifest.assetVersion, /^vector-gpu-2\.0\.0-cuda12\.6\.77-/);
assert.deepEqual(
  manifest.files.map((file) => file.name),
  [
    "LICENSE-NVIDIA-CUDA.txt",
    "LICENSE-nlohmann-json.txt",
    "cudart64_12.dll",
    "vector-gpu.exe",
  ],
);

const generatedSource = await readFile(
  path.join(
    projectDirectory,
    "src",
    "modules",
    "semantic",
    "gpuAssetManifest.generated.ts",
  ),
  "utf8",
);
const generatedHash = generatedSource.match(
  /GPU_ASSET_MANIFEST_SHA256\s*=\s*"([a-f0-9]{64})"/,
)?.[1];
assert.equal(
  generatedHash,
  sha256(manifestBytes),
  "the bundled manifest must match the compile-time pinned hash",
);

for (const file of manifest.files) {
  assert.match(file.name, /^[A-Za-z0-9_.-]+$/);
  assert.match(file.sha256, /^[a-f0-9]{64}$/);
  const bytes = await readFile(path.join(assetDirectory, file.name));
  assert.equal(bytes.length, file.size, `${file.name} size`);
  assert.equal(sha256(bytes), file.sha256, `${file.name} hash`);
}

const xpiArgument = process.argv.indexOf("--xpi");
if (xpiArgument !== -1) {
  const xpiPath = path.resolve(projectDirectory, process.argv[xpiArgument + 1]);
  const xpi = new AdmZip(xpiPath);
  const entries = new Map(
    xpi.getEntries().map((entry) => [entry.entryName, entry]),
  );
  for (const name of [
    "manifest.json",
    ...manifest.files.map((file) => file.name),
  ]) {
    const entryName = `native/gpu/${name}`;
    const entry = entries.get(entryName);
    assert.ok(entry, `${entryName} must be present in the XPI`);
    const source = await readFile(path.join(assetDirectory, name));
    assert.equal(
      sha256(entry.getData()),
      sha256(source),
      `${entryName} must match the source asset`,
    );
  }
}

console.log(
  xpiArgument === -1
    ? "GPU asset package tests passed"
    : "GPU asset package and XPI tests passed",
);
