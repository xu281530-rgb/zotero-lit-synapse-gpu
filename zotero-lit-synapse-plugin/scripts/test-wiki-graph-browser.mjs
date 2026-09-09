import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
const moduleDirectory = process.argv[2];
if (!moduleDirectory)
  throw new Error("Pass an installed Playwright directory.");
const require = createRequire(
  path.join(path.resolve(moduleDirectory), "package.json"),
);
const { chromium } = require(moduleDirectory);
const root = path.resolve(import.meta.dirname, "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const output = path.resolve(root, `../../zotero-lit-synapse-${version}-验证记录`);
fs.mkdirSync(output, { recursive: true });
const bundle = await build({
  stdin: {
    contents:
      'export {createGraph3D} from "./src/modules/wiki/graph3D.ts"; export {aggregateDocumentLinks} from "./src/modules/wiki/wikiGraphLinks.ts"; export {renderGraphLinkDetails} from "./src/modules/wiki/wikiGraphDetails.ts";',
    resolveDir: root,
  },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "WikiGraph",
});
const css = fs.readFileSync(
  path.join(root, "addon/content/wikiPanel.css"),
  "utf8",
);
const browser = await chromium.launch({ headless: true });
const results = [];
async function assertExcerptsCollapsed(page) {
  const count = await page.locator("#details .zmp-wiki-graph-quote").count();
  assert.ok(count > 0);
  assert.equal(
    await page.locator("#details details.zmp-wiki-graph-quote:not([open]) > summary").count(),
    count,
  );
  assert.equal(await page.locator("#details .zmp-wiki-graph-quote-text:visible").count(), 0);
}
try {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${css}
      *{box-sizing:border-box}body{margin:0}#zotero-lit-synapse-wiki-panel{height:100vh;grid-template-rows:48px minmax(0,1fr);grid-template-columns:minmax(0,1fr) 420px}
      header{grid-column:1/-1;padding:14px 18px;font:14px Arial,sans-serif;border-bottom:1px solid var(--wiki-border)}
      .stage{position:relative;min-height:0;min-width:0}canvas{width:100%;height:100%;display:block}
      #details{border-radius:0;margin:0;box-shadow:none}#tooltip{position:absolute;top:0;left:0;max-width:260px;display:grid;gap:4px;padding:8px;background:white;border:1px solid #d8dfdc;pointer-events:none;font:13px Arial}
      #tooltip[hidden]{display:none}
      @media(max-width:700px){#zotero-lit-synapse-wiki-panel{grid-template-columns:minmax(0,1fr);grid-template-rows:48px 320px minmax(0,1fr)}}
      </style></head><body><main id="zotero-lit-synapse-wiki-panel"><header>Zotero LitSynapse · 关系核验</header><div class="stage"><canvas id="graph"></canvas><div id="tooltip" hidden></div></div><aside id="details" class="zmp-wiki-graph-details"></aside></main></body></html>`);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(() => {
      const canvas = document.getElementById("graph"),
        context = canvas.getContext("2d");
      window.curves = [];
      let pen = [0, 0];
      const move = context.moveTo.bind(context),
        curve = context.quadraticCurveTo.bind(context),
        clear = context.fillRect.bind(context);
      context.moveTo = (x, y) => {
        pen = [x, y];
        move(x, y);
      };
      context.quadraticCurveTo = (cx, cy, x, y) => {
        window.curves.push({ ax: pen[0], ay: pen[1], cx, cy, x, y });
        curve(cx, cy, x, y);
      };
      context.fillRect = (...args) => {
        window.curves = [];
        clear(...args);
      };
      const titles = {
        a: "Stress alignment",
        b: "Manufacturing constraints",
        c: "Numerical validation",
      };
      const evidence = (claimId, itemKey, role = "SUPPORTS") => ({
        claimId,
        itemKey,
        evidenceId: claimId * 10 + (itemKey === "a" ? 1 : 2),
        evidenceRole: role,
        linkState: "valid",
        excerpt:
          itemKey === "a"
            ? "主应力轨迹用于构建纤维铺放路径；此处记录指定载荷与材料假设下的数值结果。"
            : "该研究额外限制路径转向角和相邻路径间距，制造约束改变了可行路径集合。",
      });
      const claims = new Map([
        [
          1,
          {
            claimText: "两篇论文都使用主应力方向引导路径设计。",
            evidence: [
              evidence(1, "a"), evidence(1, "b"),
              { ...evidence(1, "a"), evidenceId: 19, excerpt: "补充摘录：路径方向依赖指定载荷。" },
            ],
          },
        ],
        [
          2,
          {
            claimText: "在相同边界条件下，所比较的路径始终满足最小转弯半径。",
            evidence: [
              evidence(2, "a"), evidence(2, "b", "CONTRADICTS"),
              { ...evidence(2, "a", "QUALIFIES"), evidenceId: 29, excerpt: "补充摘录：此结论仅适用于文中的边界条件。" },
            ],
          },
        ],
        [
          23,
          {
            claimText: "第一篇记录未加入转向约束的主应力轨迹生成流程。",
            evidence: [evidence(23, "a")],
          },
        ],
        [
          33,
          {
            claimText: "第二篇在轨迹生成中加入转向角和间距限制。",
            evidence: [evidence(33, "b")],
          },
        ],
        [
          39,
          {
            claimText: "数值验证仅适用于文中给定的材料和载荷。",
            evidence: [evidence(39, "c")],
          },
        ],
      ]);
      const comparison = {
        relationType: "compares_with",
        sourceClaimId: 23,
        targetClaimId: 33,
        statement: "两种方法在制造约束的引入位置和范围上存在差异。",
        dimension: "路径生成与制造约束",
        conditions: "不由数值先后推断学术继承，不把不同载荷的结果当成冲突。",
        taskId: 1,
        reviewId: 1,
        evidenceBindings: [evidence(23, "a"), evidence(33, "b")],
      };
      const data = {
        nodes: Object.entries(titles).map(([id, label], i) => ({
          id,
          label,
          depth: i * 0.35,
          group: i,
        })),
        links: [
          {
            source: "a",
            target: "b",
            style: "solid",
            payload: {
              id: "support",
              kind: "shared-claim",
              stance: "support",
              a: "a",
              b: "b",
              claimIds: [1],
            },
          },
          {
            source: "b",
            target: "a",
            style: "solid",
            tone: "conflict",
            payload: {
              id: "conflict",
              kind: "shared-claim",
              stance: "conflict",
              a: "a",
              b: "b",
              claimIds: [2],
            },
          },
          {
            source: "a",
            target: "b",
            style: "comparison",
            payload: {
              id: "comparison",
              kind: "claim-relation",
              a: "a",
              b: "b",
              claimIds: [23, 33],
              relation: comparison,
            },
          },
          {
            source: "a",
            target: "b",
            style: "dashed",
            payload: {
              id: "page",
              kind: "same-page",
              a: "a",
              b: "b",
              claimIds: [1, 23, 33],
              pageId: 1,
            },
          },
          {
            source: "a",
            target: "b",
            style: "dotdash",
            payload: {
              id: "concept",
              kind: "shared-concept",
              a: "a",
              b: "b",
              claimIds: [],
              concepts: [
                {
                  conceptId: 1,
                  name: "应力对齐 / Stress alignment",
                  df: 2,
                  idf: 0.7,
                },
              ],
            },
          },
          {
            source: "b",
            target: "c",
            style: "comparison",
            payload: {
              id: "conditions",
              kind: "claim-relation",
              a: "b",
              b: "c",
              claimIds: [33, 39],
              relation: {
                ...comparison,
                relationType: "qualifies_scope",
                sourceClaimId: 33,
                targetClaimId: 39,
                evidenceBindings: [evidence(33, "b"), evidence(39, "c")],
              },
            },
          },
          {
            source: "a",
            target: "c",
            style: "dotted",
            payload: {
              id: "candidate",
              kind: "candidate",
              a: "a",
              b: "c",
              claimIds: [],
              signals: [
                {
                  signalId: 7,
                  signalType: "semantic",
                  score: 0.72,
                  termSnapshot: "Stress paths",
                  thisExcerpt: "候选段落：利用应力方向生成连续路径。",
                  otherExcerpt: "候选段落：数值分析比较两种铺放路径。",
                  mustResolve: false,
                },
              ],
            },
          },
        ],
      };
      const details = document.getElementById("details");
      window.detailContext = {
        doc: document,
        documentTitle: (key) => titles[key],
        claim: (id) =>
          claims.has(id)
            ? {
                claim: claims.get(id),
                page: { pageId: 1, canonicalTitle: "应力引导路径设计" },
              }
            : undefined,
        page: () => ({ canonicalTitle: "应力引导路径设计" }),
        openClaim: (_page, claim) => {
          window.openedClaim = claim.claimText;
        },
        openConcept: (id) => {
          window.openedConcept = id;
        },
        getConcept: async () => ({
          primaryTerm: {
            sources: [
              {
                sourceId: 1,
                itemKey: "a",
                chunkIdSnapshot: 1,
                excerpt:
                  "第一篇使用 stress alignment 描述应力方向与路径的关系。",
              },
              {
                sourceId: 2,
                itemKey: "b",
                chunkIdSnapshot: 3,
                excerpt: "第二篇复用应力对齐概念，并补充制造约束。",
              },
              {
                sourceId: 3,
                itemKey: "a",
                chunkIdSnapshot: 4,
                excerpt: "第一篇的另一处术语来源。",
              },
            ],
          },
          aliasTerms: [],
        }),
      };
      window.aggregated = WikiGraph.aggregateDocumentLinks(data.links);
      window.inspected = {};
      window.graph = WikiGraph.createGraph3D({
        win: window,
        canvas,
        tooltip: document.getElementById("tooltip"),
        onSelectLink: (link) => {
          window.picked = link.payload.relations[0].payload.id;
          window.detailWork = WikiGraph.renderGraphLinkDetails(
            details,
            link,
            window.detailContext,
          ).then(() => {
            window.inspected[window.picked] = link.payload.relations.map(
              (r) => r.payload.id,
            );
            window.cardCounts ??= {};
            window.cardCounts[window.picked] = details.querySelectorAll(
              ".zmp-wiki-graph-claim",
            ).length;
          });
        },
      });
      window.graph.setData({ ...data, links: window.aggregated });
      window.graph.setMode("2d");
    });
    await page.waitForTimeout(300);
    const pixels = await page.evaluate(() => {
      const c = document.getElementById("graph"),
        d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      const colors = new Set();
      for (let i = 0; i < d.length; i += 16)
        colors.add(d.slice(i, i + 3).join(","));
      return { colors: colors.size, width: c.width, height: c.height };
    });
    assert.ok(pixels.colors > 20);
    const curves = await page.evaluate(() => window.curves),
      box = await page.locator("#graph").boundingBox();
    assert.equal(curves.length, 3);
    for (const c of curves.slice().reverse()) {
      for (const t of [0.2, 0.35, 0.5, 0.65, 0.8]) {
        const u = 1 - t;
        await page.mouse.click(
          box.x + u * u * c.ax + 2 * u * t * c.cx + t * t * c.x,
          box.y + u * u * c.ay + 2 * u * t * c.cy + t * t * c.y,
        );
        await page.evaluate(() => window.detailWork);
        await assertExcerptsCollapsed(page);
      }
    }
    const inspected = await page.evaluate(() => window.inspected);
    assert.deepEqual(Object.keys(inspected).sort(), [
      "candidate",
      "conditions",
      "conflict",
    ]);
    assert.deepEqual(inspected.conflict.slice().sort(), [
      "comparison",
      "concept",
      "conflict",
      "page",
      "support",
    ]);
    const cardCounts = await page.evaluate(() => window.cardCounts);
    assert.deepEqual(cardCounts, {
      ...cardCounts,
      conflict: 5,
      conditions: 1,
      candidate: 1,
    });
    await page.evaluate(async () => {
      const link = window.aggregated.find((l) => l.tone === "conflict");
      for (const style of [
        "solid",
        "comparison",
        "dashed",
        "dotdash",
        "dotted",
      ]) {
        await WikiGraph.renderGraphLinkDetails(
          document.getElementById("details"),
          { ...link, style },
          window.detailContext,
        );
        if (
          document.querySelectorAll("#details .zmp-wiki-graph-claim").length !==
          5
        )
          throw Error("Primary style removed relationship details");
      }
    });
    assert.equal(
      await page.locator("#details .zmp-wiki-graph-quote").count(),
      12,
    );
    await assertExcerptsCollapsed(page);
    assert.equal(await page.locator("#details .zmp-wiki-graph-quote-text").count(), 16);
    assert.deepEqual(
      (await page.locator("#details h2 strong").allTextContents()).sort(),
      ["a", "b"],
    );
    assert.deepEqual(
      (await page.locator("#details .zmp-wiki-graph-document > span").allTextContents()).sort(),
      ["Manufacturing constraints", "Stress alignment"],
    );
    assert.ok((await page.locator("#details summary").allTextContents()).every(
      (text) => ["a", "b"].includes(text),
    ));
    const conflict = page.locator('#details [data-claim-id="2"]');
    assert.equal(await conflict.locator("details").count(), 2);
    assert.equal(await conflict.locator('[data-item-key="a"] .zmp-wiki-graph-quote-text').count(), 2);
    assert.deepEqual(
      await conflict.locator('[data-item-key="a"] .zmp-wiki-graph-passage-reference').allTextContents(),
      ["Evidence 21 · 支持", "Evidence 29 · 限定"],
    );
    // The same document under separate Claims in one card stays separately scoped.
    const samePage = page.locator("#details .zmp-wiki-graph-claim").filter({ hasText: "页面共属" });
    assert.equal(await samePage.locator('[data-claim-id="1"] [data-item-key="a"] .zmp-wiki-graph-quote-text').count(), 2);
    assert.equal(await samePage.locator('[data-claim-id="23"] [data-item-key="a"] .zmp-wiki-graph-quote-text').count(), 1);
    const conceptCard = page.locator("#details .zmp-wiki-graph-claim").filter({ hasText: "Concept 1" });
    assert.equal(await conceptCard.locator("details").count(), 2);
    assert.equal(await conceptCard.locator('[data-item-key="a"] .zmp-wiki-graph-quote-text').count(), 2);
    const summary = page.locator("#details .zmp-wiki-graph-quote-source").first();
    const excerpt = page.locator("#details .zmp-wiki-graph-quote-text").first();
    await summary.click();
    assert.equal(await excerpt.isVisible(), true);
    assert.equal(await page.locator("#details details[open]").count(), 1);
    assert.equal(await page.locator("#details .zmp-wiki-graph-quote-text:visible").count(), 2);
    await page.screenshot({ path: path.join(output, `graph-group-expanded-${viewport.width}.png`), fullPage: true });
    await summary.click();
    await assertExcerptsCollapsed(page);
    await summary.focus();
    await summary.press("Enter");
    assert.equal(await excerpt.isVisible(), true);
    await summary.press("Space");
    await assertExcerptsCollapsed(page);
    assert.equal(
      await page
        .locator("#details .zmp-wiki-graph-claim .zmp-wiki-graph-claim")
        .count(),
      0,
    );
    assert.equal(await page.locator("#details > .is-block").count(), 0);
    assert.ok(
      await page.evaluate(() =>
        [...document.querySelectorAll("#details .zmp-wiki-graph-quote")].every(
          (q) => q.closest(".zmp-wiki-graph-claim"),
        ),
      ),
    );
    await page.locator('#details [title="打开论断 23"]').first().click();
    assert.match(await page.evaluate(() => window.openedClaim), /主应力轨迹/);
    await page.locator('#details [title="在术语库中打开概念 1"]').click();
    assert.equal(await page.evaluate(() => window.openedConcept), 1);
    await page.mouse.move(0, 0);
    assert.equal(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth > innerWidth ||
          document.documentElement.scrollHeight > innerHeight,
      ),
      false,
    );
    await page.screenshot({
      path: path.join(output, `graph-details-lower-${viewport.width}.png`),
      fullPage: true,
    });
    await page.evaluate(() => {
      document.getElementById("details").scrollTop = 0;
    });
    await page.screenshot({
      path: path.join(output, `graph-${viewport.width}.png`),
      fullPage: true,
    });
    const before = await page.locator("#graph").screenshot();
    await page.evaluate(() => {
      window.graph.setMode("3d");
      window.graph.setAutoRotate(true);
    });
    await page.waitForTimeout(300);
    const after = await page.locator("#graph").screenshot();
    assert.equal(before.equals(after), false);
    await page.screenshot({ path: path.join(output, `graph-3d-${viewport.width}.png`), fullPage: true });
    await page.evaluate(() => window.graph.dispose());
    assert.deepEqual(errors, []);
    await page.close();
    results.push({
      viewport,
      pixels,
      inspected,
      cardCounts,
      allPrimaryStylesPreserveDetails: true,
      excerptGroups: 12,
      evidenceQuotes: 16,
      groupedByClaimAndDocument: true,
      itemKeysOnlyInGroupTitles: true,
      excerptsCollapsedByDefault: true,
      mouseAndKeyboardDisclosure: true,
      moving: true,
      overflow: false,
    });
  }
  fs.writeFileSync(
    path.join(output, "graph-browser-checks.json"),
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
