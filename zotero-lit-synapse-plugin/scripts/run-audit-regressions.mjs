import fs from "node:fs";
import { spawnSync } from "node:child_process";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const results = [];
fs.mkdirSync(".scaffold", { recursive: true });
for (const [name, command] of Object.entries(pkg.scripts)) {
  if (
    !name.startsWith("test:") ||
    ["test:gpu-xpi", "test:vector-gpu-native"].includes(name)
  )
    continue;
  const run = spawnSync(command, {
    shell: true,
    encoding: "utf8",
    timeout: 120000,
  });
  results.push({
    name,
    status: run.status,
    error: run.error?.message,
    output: (run.stdout ?? "") + (run.stderr ?? ""),
  });
  console.log(`${name}: ${run.status === 0 ? "PASS" : "FAIL"}`);
  fs.writeFileSync(
    ".scaffold/audit-unit-results.json",
    JSON.stringify(results, null, 2),
  );
}
const failures = results.filter((result) => result.status !== 0);
console.log(`${results.length - failures.length}/${results.length} passed`);
process.exitCode = failures.length ? 1 : 0;
