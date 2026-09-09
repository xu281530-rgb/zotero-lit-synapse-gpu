import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const plugin = fileURLToPath(new URL("../", import.meta.url));
const repo = fileURLToPath(new URL("../../", import.meta.url));
const source =
  process.env.XPI_SOURCE || path.join(plugin, ".scaffold/build/addon");
let passed = 0;
let failed = 0;
for (const [suite, script] of [
  ["synapse-reaudit-tests", "extended"],
  ["synapse-third-audit-tests", "regression"],
  ["synapse-third-audit-tests", "extended"],
  ["synapse-third-audit-tests", "additional"],
  ["synapse-third-audit-tests", "cache-isolation"],
]) {
  const output = path.join(
    repo,
    suite,
    "results",
    process.env.AUDIT_PHASE || "current-after-fix",
  );
  const run = spawnSync(
    process.execPath,
    [path.join(repo, suite, "tests", `${script}.js`)],
    {
      encoding: "utf8",
      env: { ...process.env, XPI_SOURCE: source, AUDIT_RESULTS: output },
    },
  );
  let results;
  try {
    results = JSON.parse(run.stdout);
  } catch {
    console.error(run.stderr || run.error || run.stdout);
    process.exitCode = 1;
    continue;
  }
  const errors = results.filter((result) => result.status !== "PASS");
  passed += results.length - errors.length;
  failed += errors.length;
  console.log(
    `${suite}/${script}: ${results.length - errors.length} PASS, ${errors.length} FAIL`,
  );
  for (const error of errors)
    console.error(`${error.name}\n${error.error || error.status}`);
  if (run.status !== 0 || errors.length) process.exitCode = 1;
  if (!fs.existsSync(path.join(output, `${script}-results.json`)))
    process.exitCode = 1;
}
console.log(
  `Total: ${passed} PASS, ${failed} FAIL (includes duplicated extended checks in both audit directories)`,
);
