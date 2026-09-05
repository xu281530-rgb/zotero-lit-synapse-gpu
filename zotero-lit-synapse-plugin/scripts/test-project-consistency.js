/* eslint-env node */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const localeRoot = new URL("../addon/locale/", import.meta.url);
const locales = ["de-DE", "es-ES", "fr-FR", "ja-JP", "zh-CN"];

function messageKeys(source) {
  return new Set(
    Array.from(source.matchAll(/^([a-z0-9-]+)\s*=/gm), (match) => match[1]),
  );
}

const englishSource = await readFile(
  new URL("en-US/preferences.ftl", localeRoot),
  "utf8",
);
const englishKeys = messageKeys(englishSource);

for (const locale of locales) {
  const source = await readFile(
    new URL(`${locale}/preferences.ftl`, localeRoot),
    "utf8",
  );
  const keys = messageKeys(source);
  const missing = Array.from(englishKeys).filter((key) => !keys.has(key));
  assert.deepEqual(missing, [], `${locale} is missing: ${missing.join(", ")}`);
}

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
assert.equal(packageJson.version, packageJson.config.addonVersion);

for (const readmeName of ["README.md", "README-zh.md"]) {
  const readme = await readFile(
    new URL(`../../${readmeName}`, import.meta.url),
    "utf8",
  );
  assert.match(
    readme,
    new RegExp(`Version-${packageJson.version.replaceAll(".", "\\.")}-`),
    `${readmeName} badge must match package version ${packageJson.version}`,
  );
}

console.log("Locale and project version consistency tests passed");
