import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const extra = new Set([
  "test:tool-catalog",
  "test:docs-tool-list",
  "test:mcp-protocol",
  "test:project-consistency",
  "test:data-compatibility-locks",
  "test:reading-ledger-hint",
  "test:round2-reading",
  "test:round2-receipts",
  "test:round2-mcp-guidance",
  "test:round3-notes",
  "test:round3-qa",
  "test:round3-fulltext",
]);
const selected = Object.entries(pkg.scripts).filter(
  ([name, command]) =>
    name !== "test:wiki-review-release" &&
    (name.startsWith("test:wiki-") || extra.has(name)) &&
    command.startsWith("node "),
);
const results = [];
for (const [name, command] of selected) {
  const child = spawnSync(process.execPath, command.split(/\s+/).slice(1), {
    cwd: root,
    encoding: "utf8",
    timeout: 120000,
  });
  const result = {
    name,
    exitCode: child.status,
    stdout: child.stdout,
    stderr: child.stderr,
    error: child.error?.message,
  };
  results.push(result);
  console.log(`${child.status === 0 ? "PASS" : "FAIL"} ${name}`);
  if (child.status !== 0)
    console.log(
      (child.stderr || child.stdout || child.error?.message || "").slice(-2200),
    );
}
const directory = path.resolve(
  root,
  `../../zotero-lit-synapse-${pkg.version}-验证记录`,
);
fs.mkdirSync(directory, { recursive: true });
const report = path.join(directory, "automated-tests.json");
fs.writeFileSync(report, JSON.stringify(results, null, 2));
console.log(
  `${results.filter((r) => r.exitCode === 0).length}/${results.length} suites passed; ${report}`,
);
process.exitCode = results.some((r) => r.exitCode !== 0) ? 1 : 0;
