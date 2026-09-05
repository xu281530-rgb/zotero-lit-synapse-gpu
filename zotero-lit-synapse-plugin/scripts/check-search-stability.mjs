/* eslint-env node */

/**
 * Live check: the same search, run repeatedly, must return the same documents.
 *
 *   node scripts/check-search-stability.mjs [port] [runs]
 *
 * Retrieval is deterministic by construction — same query, same index, same
 * threshold — so any run-to-run difference is a defect, and a quiet one: it
 * shows up as a paper that was in yesterday's literature review and is missing
 * from today's, with nothing in the response admitting anything changed.
 *
 * The failure this guards against was real. The vector scan walks the table in
 * LIMIT/OFFSET batches, and SQLite gives no row order without ORDER BY, so
 * which of several equally-scoring chunks survived the top-K cut depended on
 * the order rows happened to come back in. A document scoring 0.6001 against a
 * 0.60 threshold appeared in one search and vanished from the next.
 *
 * Documents near the threshold are where this surfaces first, so the check
 * reports the weakest kept score alongside any drift.
 */

import net from "node:net";

const PORT = Number(process.argv[2] || 23120);
const RUNS = Number(process.argv[3] || 4);

const SEARCH = {
  query:
    "Effects of thermal gradient and growth rate on columnar-to-equiaxed transition during directional solidification / 温度梯度与生长速率对定向凝固柱状晶-等轴晶转变的影响",
  keywords: [
    "柱状晶-等轴晶转变",
    "定向凝固",
    "温度梯度",
    "columnar-to-equiaxed transition",
    "directional solidification",
    "thermal gradient",
  ],
  domain: "materials science / solidification",
  expertRole: "solidification specialist",
  topK: 20,
};

function rpc(payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const head = Buffer.from(
      "POST /mcp HTTP/1.1\r\n" +
        `Host: 127.0.0.1:${PORT}\r\n` +
        "Content-Type: application/json\r\n" +
        "Accept: application/json, text/event-stream\r\n" +
        `Content-Length: ${body.length}\r\n` +
        "Connection: close\r\n\r\n",
      "ascii",
    );
    const socket = net.connect({ host: "127.0.0.1", port: PORT });
    const chunks = [];
    socket.setTimeout(120000);
    socket.on("connect", () => socket.write(Buffer.concat([head, body])));
    socket.on("data", (d) => chunks.push(d));
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("timed out"));
    });
    socket.on("error", reject);
    socket.on("close", () => {
      const raw = Buffer.concat(chunks);
      const separator = raw.indexOf("\r\n\r\n");
      const envelope = JSON.parse(raw.subarray(separator + 4).toString("utf8"));
      if (envelope.error) {
        reject(new Error(envelope.error.message));
        return;
      }
      resolve(JSON.parse(envelope.result.content[0].text));
    });
  });
}

const call = (args) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "hybrid_search", arguments: args },
});

/** Every page of one search, so drift anywhere in the ranking is visible. */
async function fullRanking() {
  let payload = await rpc(call(SEARCH));
  const rows = [...payload.data];
  let guard = 0;
  while (payload.pagination.hasMore && guard < 40) {
    guard += 1;
    payload = await rpc(call({ cursor: payload.pagination.nextCursor }));
    rows.push(...payload.data);
  }
  return { rows, pagination: payload.pagination };
}

const runs = [];
for (let i = 0; i < RUNS; i += 1) {
  const { rows, pagination } = await fullRanking();
  runs.push(rows);
  console.log(
    `run ${i + 1}: ${rows.length} documents, weakest kept ${rows.length ? rows[rows.length - 1].score : "-"}, threshold ${pagination.appliedMinScore}`,
  );
}

const baseline = runs[0].map((row) => row.itemKey);
const baselineSet = new Set(baseline);
let drifted = 0;

for (let i = 1; i < runs.length; i += 1) {
  const keys = runs[i].map((row) => row.itemKey);
  const set = new Set(keys);
  const missing = baseline.filter((key) => !set.has(key));
  const added = keys.filter((key) => !baselineSet.has(key));
  const reordered =
    keys.length === baseline.length &&
    keys.some((key, index) => key !== baseline[index]);

  if (missing.length || added.length || reordered) {
    drifted += 1;
    console.log(`\nrun 1 vs run ${i + 1}: DRIFT`);
    if (missing.length) console.log(`  disappeared: ${JSON.stringify(missing)}`);
    if (added.length) console.log(`  appeared:    ${JSON.stringify(added)}`);
    if (reordered && !missing.length && !added.length) {
      console.log("  same documents, different order");
    }
  }
}

console.log(
  drifted === 0
    ? `\nStable: ${RUNS} identical searches returned identical rankings.`
    : `\n${drifted} of ${RUNS - 1} repeat searches drifted from the first.`,
);
process.exit(drifted === 0 ? 0 : 1);
