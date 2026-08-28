/* eslint-env node */

/**
 * The record template, the batch coverage rule and the value-landing rule.
 *
 * Every fixture here is a REAL failure taken from one reading of one paper -
 * Zhao et al., squeeze casting of Al-Zn-Mg-Cu - because the point of these
 * checks is not that they can be satisfied in principle. It is that they
 * refuse the four specific things that reading actually did while every rule
 * then in force said yes:
 *
 *   1. a chunk carrying Table 1 and Table 2 recorded as "the alloy composition
 *      consists of Zn, Mg, Cu, Si, Fe, Ti, Mn, and balance Al";
 *   2. twenty delivered chunks accounted for by eight citations;
 *   3. a macro summary 98% verbatim from the records sitting above it.
 *
 * And the other half of the contract: a record that does the work passes, and
 * a duplicated section really may be dismissed as no new content.
 */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const {
  WIKI_RECORD_SECTIONS,
  WIKI_MACRO_SECTIONS,
  assertTemplateSections,
  assertBatchChunkCoverage,
  assertValuesLanded,
  assertUnchangedCarriesNothingNew,
  assertMacroIsNotPaste,
  expandedCitedChunkIds,
  measurementValues,
  normalizeMeasurementText,
} = await import("../src/modules/wiki/wikiRecordTemplate.ts");

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
  } catch (error) {
    console.error(`FAIL  ${name}\n      ${error.message}`);
    process.exitCode = 1;
  }
};
const refuses = (fn, ...needles) => {
  let thrown = null;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, "expected a refusal, got none");
  for (const needle of needles) {
    assert.ok(
      thrown.message.includes(needle),
      `refusal should mention ${JSON.stringify(needle)}, got:\n${thrown.message}`,
    );
  }
  return thrown;
};

// ---------------------------------------------------------------- fixtures

/** chunk 19: Table 1 flattened to text, plus Table 2 as a Markdown table. */
const CHUNK_19 = `Table 1 Reference process parameters for simulations and experimental processes.

Pouring temperature (°C) 690 Initial die temperature (°C) 180 Pressure holding time (s) 130 Filling velocity (mm $s^{-1}$ ) 20 Pressure (MPa) 0.1(atm) 25 50 75 100 125 Simulated cooling rate (K/s) 1.58 1.67 1.76 1.83 1.90 1.91

Table 2 Chemical composition of Al-8.5Zn-2Mg-2Cu alloy.

| Element | Zn | Mg | Cu | Si | Fe | Ti | Mn | Al |

| wt% | 8.56 | 1.96 | 2.07 | 0.135 | 0.174 | 0.149 | 0.175 | Bal. |`;

/** chunk 18: the T6 schedule, as MinerU renders it - digits spaced in maths. */
const CHUNK_18 = `The castings were formed by the squeeze casting process, only the pressure was changed from 0. 1 to 125 MPa. A multistage solution heat treatment was carried out at $3 5 0 ~ ^ { \\circ } \\mathrm { C }$ for 4 h, $4 6 5 ~ ^ { \\circ } \\mathrm { C }$ for 10 h and then $5 0 0 ^ { \\circ } \\mathrm { C }$ for 2 h, followed by quenching into water stored at $7 0 \\ ^ { \\circ } \\mathrm { C }$.`;

// ------------------------------------------------------- LaTeX and units

check("maths spans rejoin split digits; table rows do not", () => {
  const out = normalizeMeasurementText(CHUNK_18);
  assert.ok(out.includes("350"), "350 should survive $3 5 0$");
  assert.ok(out.includes("465") && out.includes("500") && out.includes("70"));
  const table = normalizeMeasurementText("| wt% | 8.56 | 1.96 |");
  assert.ok(table.includes("8.56") && table.includes("1.96"));
  const row = normalizeMeasurementText("Pressure (MPa) 0.1(atm) 25 50 75 100 125");
  assert.ok(row.includes("25 50 75"), "adjacent table numbers must stay apart");
});

check("a flattened parameter table and a Markdown table both yield values", () => {
  const values = measurementValues(CHUNK_19);
  for (const wanted of ["690", "180", "130", "125", "1.58", "8.56", "2.07", "0.135"]) {
    assert.ok(values.has(wanted), `expected ${wanted} among ${[...values]}`);
  }
});

check("chunk citations are never counted as measurements", () => {
  assert.equal(measurementValues("见 chunk 42 与 chunk 118").size, 0);
});

check("equation, figure and citation numbers are not measurements", () => {
  const values = measurementValues(
    "as shown in Fig. 8(a) and Eq. (2), reported by Fras et al. (2013)",
  );
  assert.equal(values.size, 0, `unexpected: ${[...values]}`);
});

// ------------------------------------------------------- chunk coverage

check("runs and lists both expand", () => {
  assert.deepEqual(expandedCitedChunkIds("（chunk 44-47）"), [44, 45, 46, 47]);
  assert.deepEqual(expandedCitedChunkIds("（chunk 44、46、48）"), [44, 46, 48]);
  assert.deepEqual(expandedCitedChunkIds("参见 chunk 7"), [7]);
  assert.deepEqual(expandedCitedChunkIds("文献 [51-68] 指出"), []);
});

check("REAL FAILURE 2: twenty chunks accounted for by eight is refused", () => {
  const record = "…（chunk 1）…（chunk 2）…（chunk 4）…（chunk 13）…（chunk 14）…（chunk 15）…（chunk 18）…（chunk 19）";
  const batch = Array.from({ length: 20 }, (_, i) => i);
  const error = refuses(
    () => assertBatchChunkCoverage(record, batch),
    "本批交付了 20 个 chunk",
    "未被交代的 chunk",
  );
  for (const missing of [0, 3, 5, 16, 17]) {
    assert.ok(
      error.message.includes(String(missing)),
      `should name chunk ${missing}`,
    );
  }
});

check("a grouped dismissal covers the whole run", () => {
  assertBatchChunkCoverage(
    "主体见（chunk 40-43）；（chunk 44-47）为公式推导中间步骤，无独立数据。",
    [40, 41, 42, 43, 44, 45, 46, 47],
  );
});

// -------------------------------------------------------- value landing

check("REAL FAILURE 1: the composition table written as a list of elements", () => {
  refuses(
    () =>
      assertValuesLanded(
        "**测到了什么**\n合金成分包含 Zn、Mg、Cu、Si、Fe、Ti、Mn 和余量 Al（chunk 19）。",
        [{ chunkId: 19, text: CHUNK_19 }],
        "阅读记录",
      ),
    "个实测数值",
    "chunk 19",
    "8.56",
  );
});

check("transcribing both tables passes", () => {
  assertValuesLanded(
    `**做了什么**
浇注温度 690 °C，初始模温 180 °C，保压时间 130 s，充填速度 20 mm/s；
压力取 0.1 (atm)、25、50、75、100、125 MPa，对应模拟冷却速率 1.58、1.67、1.76、1.83、1.90、1.91 K/s（chunk 19）。
成分 Al-8.5Zn-2Mg-2Cu：Zn 8.56、Mg 1.96、Cu 2.07、Si 0.135、Fe 0.174、Ti 0.149、Mn 0.175 wt%，余量 Al（chunk 19）。`,
    [{ chunkId: 19, text: CHUNK_19 }],
    "阅读记录",
  );
});

check("the T6 schedule must survive its LaTeX", () => {
  refuses(
    () =>
      assertValuesLanded(
        "**做了什么**\n铸件经 T6 热处理，多级固溶后水淬（chunk 18）。",
        [{ chunkId: 18, text: CHUNK_18 }],
        "阅读记录",
      ),
    "350",
  );
  assertValuesLanded(
    "**做了什么**\n压力 0.1–125 MPa；固溶 350 °C/4 h + 465 °C/10 h + 500 °C/2 h，70 °C 水淬（chunk 18）。",
    [{ chunkId: 18, text: CHUNK_18 }],
    "阅读记录",
  );
});

/**
 * The miss that survived a batch-level ratio, in the words the paper used.
 *
 * Four temperatures and one solidification range: the record kept the four
 * and dropped the range, which is 80% of this chunk on its own and one value
 * among the forty its ten-chunk page carried. Both readings said yes. The
 * range is the reason the alloy is hard to cast at all.
 */
check("REAL FAILURE: one value dropped from a chunk full of them", () => {
  const chunk17 = String.raw`The intermediate alloys were added to the crucible preheated to $7 4 0 ^ { \circ } \mathrm { C } . $. After melting, pure Mg was pressed in and held at $7 2 0 ^ { \circ } \mathrm { C }$, degassed with argon for 30 min, and the melt was held at $7 0 0 ^ { \circ } \mathrm { C } . $ In particular, due to the relatively wide solidification range of the alloy (about 190 K range), it is prone to thermal cracking.`;
  const asWritten =
    "**做了什么**\n熔炼时坩埚预热 740 °C，720 °C 压入纯 Mg，通氩气除气 30 min，700 °C 保温（chunk 17）。";
  const error = refuses(
    () => assertValuesLanded(asWritten, [{ chunkId: 17, text: chunk17 }], "阅读记录"),
    "chunk 17",
    "190",
  );
  assert.ok(
    !/740|720|700|30 min/.test(error.message.split("未落地的数值")[1] ?? ""),
    "只报真正漏掉的那一个",
  );
  assertValuesLanded(
    `${asWritten}\n该合金结晶温度区间约 190 K，因此铸造时易热裂（chunk 17）。`,
    [{ chunkId: 17, text: chunk17 }],
    "阅读记录",
  );
});

check("REAL FAILURE: a literature comparison written as a characterisation", () => {
  const chunk39 = String.raw`The Al-Zn-Mg-Cu-Cr/TiB2+TiC alloys (1#) by Li et al. (2022b) had the $\sigma _ { \mathrm { U T S } }$ of 510 MPa and $\varepsilon$ of 3.7%; the Al-12Zn-3Mg-2.5Cu-0.07Ti alloy (4#) by Pourkia et al. (2010) had the $\sigma$ of 380 MPa and $\varepsilon$ of 1.4%.`;
  refuses(
    () =>
      assertValuesLanded(
        "**测到了什么**\n传统金属型铸造合金抗拉强度普遍低于 500 MPa（chunk 39）。",
        [{ chunkId: 39, text: chunk39 }],
        "阅读记录",
      ),
    "510",
    "380",
  );
});

check("a batch with almost no numbers is left alone", () => {
  assertValuesLanded(
    "**测到了什么**\n本批无结果数据（chunk 100）。",
    [{ chunkId: 100, text: "References. Acknowledgements. See Fig. 3." }],
    "阅读记录",
  );
});

// ------------------------------------------------ the unchanged loophole

check("a genuinely duplicated section may still be dismissed", () => {
  const priorNote = "第 2 次：成分 Zn 8.56、Mg 1.96、Cu 2.07、Si 0.135、Fe 0.174、Ti 0.149、Mn 0.175 wt%；浇注 690 °C、模温 180 °C、保压 130 s、充填 20 mm/s；压力 0.1、25、50、75、100、125 MPa；冷速 1.58、1.67、1.76、1.83、1.90、1.91 K/s（chunk 19）。";
  assertUnchangedCarriesNothingNew(
    priorNote,
    [{ chunkId: 119, text: CHUNK_19 }],
    "与 chunk 19 重复",
  );
});

check("REAL FAILURE: 'no new content' over numbers nobody ever wrote", () => {
  refuses(
    () =>
      assertUnchangedCarriesNothingNew(
        "第 1 次：本文研究挤压铸造对组织的影响（chunk 1）。",
        [{ chunkId: 119, text: CHUNK_19 }],
        "与前文重复",
      ),
    "所以它不是重复内容",
    "8.56",
  );
});

// ------------------------------------------------------------ templates

check("a record missing sections is refused, and told which", () => {
  const error = refuses(
    () => assertTemplateSections("随便写了一段（chunk 3）。", WIKI_RECORD_SECTIONS, "阅读记录"),
    "阅读记录不符合模板",
    "**一句话**",
    "**测到了什么**",
  );
  assert.ok(error.message.includes("存疑与未交代"));
});

check("an empty section is refused as loudly as a missing one", () => {
  refuses(
    () =>
      assertTemplateSections(
        [
          "**一句话**",
          "本批介绍挤压铸造工艺（chunk 13）。",
          "**做了什么**",
          "1800 吨压铸机，H13 钢模（chunk 13）。",
          "**测到了什么**",
          "",
          "**概念与术语**",
          "挤压铸造：高压下凝固的近净成形工艺（chunk 13）。",
          "**本批覆盖**",
          "本批涉及 chunk 13。",
          "**存疑与未交代**",
          "无。",
        ].join("\n"),
        WIKI_RECORD_SECTIONS,
        "阅读记录",
      ),
    "小节存在但为空",
    "测到了什么",
  );
});

check("the full five-section record passes", () => {
  assertTemplateSections(
    [
      "**一句话**",
      "本批交代了怎么做的实验：设备、压力范围和热处理制度（chunk 13-19）。",
      "**做了什么**",
      "1800 吨压铸机配 H13 钢模，压力 0.1–125 MPa（chunk 18）。",
      "**测到了什么**",
      "本批无结果数据（chunk 13-19）。",
      "**概念与术语**",
      "挤压铸造 —— 高压下凝固的近净成形铸造工艺（chunk 13）。",
      "**本批覆盖**",
      "本批涉及 chunk 13-19。",
      "**存疑与未交代**",
      "无。",
    ].join("\n"),
    WIKI_RECORD_SECTIONS,
    "阅读记录",
  );
});

check("the macro summary template is checked the same way", () => {
  refuses(
    () => assertTemplateSections("## 本篇讲了什么\n讲了挤压铸造（chunk 1）。", WIKI_MACRO_SECTIONS, "宏观总结"),
    "宏观总结不符合模板",
    "主要结果",
    "边界与局限",
  );
});

// ------------------------------------------------------- macro synthesis

check("REAL FAILURE 3: a summary pasted from the records is refused", () => {
  const sentences = [
    "The results showed that the primary grains transformed from coarse dendrites to refined equiaxed grains with increasing pressure (chunk 1).",
    "The applied pressure increased the thermodynamic driving force to promote primary grain nucleation (chunk 2).",
    "Solute diffusion and constitutional undercooling at the solid-liquid interface were inhibited by pressure (chunk 2).",
    "Non-equilibrium eutectic phases precipitate at the grain boundaries during late solidification (chunk 5).",
    "The average grain size was determined by the linear intercept method as the average of 100 measurements (chunk 20).",
  ];
  const records = `## 阅读记录\n\n${sentences.join("\n\n")}`;
  refuses(
    () => assertMacroIsNotPaste(records, sentences.join(" ")),
    "与上面的阅读记录逐字相同",
  );
});

check("a genuinely rewritten summary passes", () => {
  const records = [
    "施加压力使初生 α-Al 由粗大枝晶转为细小等轴晶（chunk 1）。",
    "压力提高了形核的热力学驱动力（chunk 2）。",
    "固/液界面前沿的溶质扩散与成分过冷被压力抑制（chunk 2）。",
    "非平衡共晶相在凝固后期于晶界析出（chunk 5）。",
  ].join("\n\n");
  assertMacroIsNotPaste(
    records,
    [
      "这篇论文把压力当成一个凝固控制变量，回答的是压力究竟通过哪条路径细化晶粒（chunk 1）。",
      "两条机制被分开处理：热力学上压力抬高驱动力促进形核，动力学上压力压缩溶质扩散层从而抑制枝晶长大（chunk 2）。",
      "晶界共晶网络的细化是同一件事的下游结果，而不是另一个独立现象（chunk 5）。",
      "作者用相互依赖理论把这两条路径合成一个可预测晶粒尺寸的表达式（chunk 74）。",
    ].join("\n\n"),
  );
});

check("macro template asks for core synthesis instead of complete tables", () => {
  const hints = WIKI_MACRO_SECTIONS.map((section) => section.hint).join(" ");
  assert.match(hints, /核心方法|核心发现/u);
  assert.doesNotMatch(hints, /完整参数表|完整成分表|尽量成表/u);
});


// ------------------------------------------- the macro summary reaches everywhere

const { assertMacroTouchesEveryRecord, assertRecordLedgerIntact } = await import(
  "../src/modules/wiki/wikiRecordTemplate.ts"
);

const RECORDS = [
  { number: 1, chunkIds: [0, 1, 2, 3, 4], noNewContent: false },
  { number: 2, chunkIds: [5, 6, 7, 8, 9], noNewContent: false },
  { number: 3, chunkIds: [10, 11, 12], noNewContent: true },
];

check("a summary that skips a whole record is refused, and it is named", () => {
  const error = refuses(
    () =>
      assertMacroTouchesEveryRecord(
        RECORDS,
        "## 主要结果\n压力升高使晶粒细化（chunk 1）。",
      ),
    "完全没有涉及 1 条阅读记录",
    "第 2 次",
  );
  assert.ok(!error.message.includes("第 3 次"), "无新内容的记录不该被要求覆盖");
});

check("touching one chunk of each substantive record is enough", () => {
  assertMacroTouchesEveryRecord(
    RECORDS,
    "## 主要结果\n压力升高使晶粒细化（chunk 1）。\n\n## 机理解释\n溶质扩散被抑制（chunk 7）。",
  );
});

check("a record booked by chunkId is matched by a summary citing its index", () => {
  // A question books the chunkIds it was handed (8000+i); the note cites
  // positions. Without the alias map the record reads as skipped purely
  // because it was written down under its other name.
  const byChunkId = [{ number: 1, chunkIds: [8000, 8001], noNewContent: false }];
  refuses(
    () => assertMacroTouchesEveryRecord(byChunkId, "## 主要结果\n站位一致（chunk 0）。"),
    "第 1 次",
  );
  assertMacroTouchesEveryRecord(
    byChunkId,
    "## 主要结果\n站位一致（chunk 0）。",
    new Map([
      [8000, [0]],
      [0, [8000]],
      [8001, [1]],
      [1, [8001]],
    ]),
  );
});

check("a grouped citation covers the record it spans", () => {
  assertMacroTouchesEveryRecord(
    RECORDS,
    "## 核心方法\n全篇的测量条件一致（chunk 0-9）。",
  );
});

/**
 * The two rules must be satisfiable together, which is the whole reason this
 * check counts citations instead of comparing wording: the paste rule demands
 * the summary be worded differently from the records, and a wording-based
 * coverage rule demanded the opposite. One summary has to pass both.
 */
check("the same summary passes coverage AND the paste rule", () => {
  const recordsBody = [
    "## 阅读记录",
    "",
    "### 第 1 次 · chunk 0-4",
    "浇注温度 690 °C，模具预热 180 °C，保压 130 s（chunk 1）。",
    "",
    "### 第 2 次 · chunk 5-9",
    "0.1 MPa 下平均晶粒尺寸为 273 µm，100 MPa 下降至 101 µm（chunk 7）。",
  ].join("\n");
  const summary = [
    "## 本篇讲了什么",
    "这篇论文把压力当作凝固控制变量，回答它究竟通过哪条路径细化晶粒（chunk 1）。",
    "",
    "## 主要结果",
    "晶粒尺寸随压力从 273 µm 降到 101 µm，降幅 63%，拐点出现在 100 MPa（chunk 7）。",
    "",
    "## 机理解释",
    "热力学驱动力与溶质扩散抑制是同一件事的两个侧面，而不是两条独立机制（chunk 7）。",
    "",
    "## 边界与局限",
    "只覆盖了这一种合金与这一组模具几何（chunk 1）。",
  ].join("\n");
  assertMacroTouchesEveryRecord(
    [
      { number: 1, chunkIds: [0, 1, 2, 3, 4], noNewContent: false },
      { number: 2, chunkIds: [5, 6, 7, 8, 9], noNewContent: false },
    ],
    summary,
  );
  assertMacroIsNotPaste(recordsBody, summary);
});

// --------------------------------------------------- the record ledger holds

check("REAL FAILURE: ten accepted writes, one surviving record", () => {
  refuses(
    () => assertRecordLedgerIntact(1, 10),
    "已经有 10 次记录被接受",
    "只剩 1 条",
    "丢了",
  );
});

check("a note that kept everything is not accused", () => {
  assertRecordLedgerIntact(10, 10);
  assertRecordLedgerIntact(0, 0);
});

check("records carried over from an earlier reading never trip it", () => {
  // A note accumulates across sessions; the ledger counts one session. More
  // records than integrations is the normal shape, not a fault.
  assertRecordLedgerIntact(14, 3);
});

console.log(`wiki record template: ${passed} check(s) passed`);
