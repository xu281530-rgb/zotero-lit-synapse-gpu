/* eslint-env node */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = path.join(rootDir, "package.json");

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const [baseVersion, buildMetadata] = packageJson.version.split("+", 2);
const addonVersion =
  buildMetadata && /^[0-9]+(?:[.][0-9]+)*$/.test(buildMetadata)
    ? baseVersion + "." + buildMetadata
    : packageJson.version;

packageJson.config = {
  ...packageJson.config,
  addonVersion,
};

fs.writeFileSync(
  packageJsonPath,
  JSON.stringify(packageJson, null, 2) + String.fromCharCode(10),
  "utf8",
);
console.log(
  "Synchronized Zotero add-on version " +
    addonVersion +
    " from npm version " +
    packageJson.version,
);