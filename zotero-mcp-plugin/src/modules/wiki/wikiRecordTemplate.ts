/**
 * The shape a reading record and a macro summary have to arrive in, and the
 * one thing about their CONTENT that a server can actually check.
 *
 * WHY A TEMPLATE AT ALL. A record with one slot is a record whose only
 * instruction is "summarise", and summarising is lossy in a direction that is
 * not random: it keeps the sentence skeleton - subject, verb, mechanism - and
 * drops the modifiers, which is exactly where a measured value and the
 * condition it was measured under live. Asked to say what twenty chunks
 * established, a model returns "grains transformed from coarse dendrites to
 * refined equiaxed grains" from a chunk whose own sentence reads "a decrease
 * by 63% in the average grain size from 273 µm to 101 µm at 100 MPa". Both
 * sentences are true. Only one of them is the paper.
 *
 * Telling a model not to do that does not work; it was tried, in the tool
 * description, by name, with that exact placeholder wording listed as
 * forbidden, and the next reading wrote "the alloy composition consists of Zn,
 * Mg, Cu, Si, Fe, Ti, Mn, and balance Al" over a chunk carrying the full
 * weight-percent table.
 *
 * The template works where the prohibition failed because it gives the
 * compression instinct somewhere legitimate to go. `一句话` is the slot that is
 * SUPPOSED to be short, plain and lossy - and once it exists, the instinct
 * spends itself there instead of eating `测到了什么`.
 *
 * WHAT IS CHECKED, AND WHAT IS DELIBERATELY NOT. Section presence is checked,
 * because a missing heading is unambiguous. Chunk coverage is checked, because
 * "did the record account for the twenty chunks it was handed" is arithmetic.
 * Measurement landing is checked, because a number in the source that is
 * absent from the record is the one content failure a string comparison can
 * see. Nothing here judges whether a sentence is TRUE, well-written or worth
 * keeping - `wikiSynthesisAudit` covers overstatement from the other side, and
 * between them they bracket the note without either one pretending to read it.
 *
 * PAGE SIZE IS NOT CAPPED, ON PURPOSE. A large page is not the problem; a
 * large page that costs the same as a small one is. Because these checks scale
 * with the batch - twenty chunks means twenty chunks to account for and every
 * measurement in all twenty to land - asking for more text now costs more
 * writing, and the reader can choose the trade rather than being held to a
 * limit somebody else picked.
 */

import { normalizeWikiText } from "./wikiCanonicalizer";

/** How much of a batch's measured values a record has to carry. */
export const WIKI_VALUE_LANDING_RATIO = 0.8;

/** Below this many measurements in a batch, the ratio is not applied. */
export const WIKI_VALUE_LANDING_FLOOR = 3;

/** Verbatim overlap above which a macro summary is a paste of the records. */
export const WIKI_MACRO_PASTE_RATIO = 0.6;

export interface WikiTemplateSection {
  /** The canonical label the heading must start with. */
  label: string;
  /** What belongs in it, quoted back when it is missing or empty. */
  hint: string;
}

/**
 * The five slots of one reading record.
 *
 * `一句话` is first because it is the release valve: the model gets to be
 * brief somewhere, in writing, before it is asked to be exhaustive. `存疑与未
 * 交代` is last because without it a reader with nothing to say about an
 * uncertainty says nothing at all, and the uncertainty leaves the note
 * silently - which is a loss the other four slots cannot register.
 */
export const WIKI_RECORD_SECTIONS: readonly WikiTemplateSection[] = [
  {
    label: "一句话",
    hint: "通俗、不带术语、让人一眼看懂这批 chunk 在讲什么。这是唯一允许压缩的地方。",
  },
  {
    label: "做了什么",
    hint: "方法、设备、流程、软件。参数必须落值、带单位、带条件；工艺参数表整表转写。",
  },
  {
    label: "测到了什么",
    hint: "结果与数据，原样保留：测量值、对比组、体积分数、性能指标。本批确无结果数据时写明「本批无结果数据」。",
  },
  {
    label: "概念与术语",
    hint: "准备写进 Wiki 的术语：名称 + 一句定义 + chunk 号。没有新术语时写「无」。",
  },
  {
    label: "存疑与未交代",
    hint: "本批说得不清楚、看起来矛盾、或明显被推迟到后文的东西。没有时写「无」。",
  },
];

/** The seven slots of the whole-paper summary. */
export const WIKI_MACRO_SECTIONS: readonly WikiTemplateSection[] = [
  {
    label: "本篇讲了什么",
    hint: "3-5 句，通俗，写给三个月后不记得这篇论文的自己。",
  },
  {
    label: "研究对象与材料",
    hint: "理解论文核心问题和结论所需的研究对象、材料特征与样品范围。",
  },
  {
    label: "核心方法",
    hint: "研究设计、关键工艺路线、表征手段与分析思路；只保留影响核心结论的条件。",
  },
  {
    label: "主要结果",
    hint: "核心发现、趋势与关键比较；数值仅在表达核心结论或重要条件时保留。",
  },
  {
    label: "机理解释",
    hint: "论文自己的因果链，按论文自己的强度写，不要替它加强。",
  },
  {
    label: "结论",
    hint: "凝练论文最重要的结论，以及方法和结果共同支持的贡献。",
  },
  {
    label: "边界与局限",
    hint: "适用范围、没做的对照、作者自陈的不足。没有写明「作者未讨论」。",
  },
];

export class WikiRecordTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WikiRecordTemplateError";
  }
}

/** A heading, a bold line on its own, or a bold list marker. */
function structuralLabel(line: string): string | null {
  const heading = /^\s{0,3}#{1,6}\s+(.*\S)\s*$/u.exec(line);
  if (heading) return heading[1];
  const emphasised = /^\s{0,3}\*\*(.+?)\*\*\s*[:：]?\s*$/u.exec(line);
  if (emphasised) return emphasised[1];
  const listHeading = /^\s{0,3}[-*+]\s+\*\*(.+?)\*\*\s*[:：]?\s*$/u.exec(line);
  if (listHeading) return listHeading[1];
  return null;
}

/** Section label to the text under it, for whichever sections are present. */
export function splitTemplateSections(
  body: string,
  sections: readonly WikiTemplateSection[],
): Map<string, string> {
  const labels = sections.map((section) => section.label);
  const found = new Map<string, string>();
  let current: string | null = null;
  let buffer: string[] = [];
  let inFence = false;
  const flush = (): void => {
    if (current) found.set(current, buffer.join("\n").trim());
    buffer = [];
  };
  for (const line of String(body ?? "").split(/\r?\n/u)) {
    if (/^\s{0,3}(?:`{3,}|~{3,})/u.test(line)) {
      inFence = !inFence;
      if (current) buffer.push(line);
      continue;
    }
    if (!inFence) {
      const structural = structuralLabel(line);
      const matched = structural
        ? labels.find((label) => structural.startsWith(label))
        : undefined;
      if (matched) {
        flush();
        current = matched;
        continue;
      }
    }
    if (current) buffer.push(line);
  }
  flush();
  return found;
}

/**
 * Refuse a record or summary that is not in the agreed shape.
 *
 * @throws WikiRecordTemplateError naming every missing and every empty
 *   section, because the model has to fix them all without a second round
 *   trip to find out which.
 */
export function assertTemplateSections(
  body: string,
  sections: readonly WikiTemplateSection[],
  what: string,
): void {
  const found = splitTemplateSections(body, sections);
  const missing = sections.filter((section) => !found.has(section.label));
  const empty = sections.filter(
    (section) => found.has(section.label) && !found.get(section.label)?.trim(),
  );
  if (!missing.length && !empty.length) return;
  const lines: string[] = [
    `${what}不符合模板，未写入。它必须按固定小节组织，每个小节都要有内容——` +
      `这些小节是为了让「压缩」有个专门的去处（第一节），从而不再侵占数据那几节。`,
  ];
  if (missing.length) {
    lines.push(
      "",
      `缺少小节 ${missing.length} 个：`,
      ...missing.map(
        (section) => `  **${section.label}**  —— ${section.hint}`,
      ),
    );
  }
  if (empty.length) {
    lines.push(
      "",
      `小节存在但为空 ${empty.length} 个：`,
      ...empty.map((section) => `  **${section.label}**  —— ${section.hint}`),
    );
  }
  lines.push(
    "",
    "正文用中文写；术语、化学式、数值和单位保留原文形式（写 1750 ± 7.4 K，不要写「约一千七百五十开」）。",
    "小节标题写成独立的一行 `**标签**`，标签就是上面列出的那几个词。",
  );
  throw new WikiRecordTemplateError(lines.join("\n"));
}

/** `chunk 41`, `chunk 44-47`, `chunk 44、45、46`, `第 3 块`. */
const CHUNK_RUN =
  /(?:chunks?|块|段)\s*#?\s*(\d+(?:\s*(?:[-–—]|to|~|、|,|，)\s*\d+)*)|第\s*(\d+)\s*(?:块|段)/giu;

const REFERENCE_BRACKET = /\[[\d\s,–—-]+\]/gu;

/**
 * Every chunk a text names, expanding runs and lists.
 *
 * `citedChunkIds` in `wikiSynthesisAudit` deliberately reads one number per
 * citation, because that is what an Evidence trail needs. Coverage needs the
 * other reading: a record that dismisses four consecutive chunks of equation
 * derivation in one breath has accounted for all four, and forcing it to
 * repeat the word "chunk" four times would buy nothing but noise.
 */
export function expandedCitedChunkIds(text: string): number[] {
  const cleaned = String(text ?? "").replace(REFERENCE_BRACKET, " ");
  const found = new Set<number>();
  for (const match of cleaned.matchAll(CHUNK_RUN)) {
    const single = match[2];
    if (single !== undefined) {
      found.add(Number.parseInt(single, 10));
      continue;
    }
    const run = match[1];
    if (run === undefined) continue;
    const parts = run.split(/\s*(?:[-–—]|to|~|、|,|，)\s*/u).filter(Boolean);
    const numbers = parts
      .map((part) => Number.parseInt(part, 10))
      .filter((value) => Number.isInteger(value) && value >= 0);
    if (!numbers.length) continue;
    // `41-44` is a range; `44、46、48` is a list. A two-number group separated
    // by a dash is the only ambiguous case, and reading it as a range is the
    // one that matches how ranges are written.
    const isRange =
      numbers.length === 2 && /[-–—]|to|~/u.test(run) && numbers[1] > numbers[0];
    if (isRange) {
      for (let id = numbers[0]; id <= numbers[1]; id += 1) found.add(id);
    } else {
      for (const id of numbers) found.add(id);
    }
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Refuse a record that leaves part of its own batch unaccounted for.
 *
 * This is what makes a large page cost what it is worth. The reader may ask
 * for as many chunks as it likes; what it may not do is take twenty and
 * report on eight, which is what a fixed-length record does to a page it was
 * never asked to cover completely.
 *
 * @throws WikiRecordTemplateError
 */
export function assertBatchChunkCoverage(
  record: string,
  batchChunkIds: readonly number[],
): void {
  if (!batchChunkIds.length) return;
  const cited = new Set(expandedCitedChunkIds(record));
  const missing = batchChunkIds.filter((id) => !cited.has(id));
  if (!missing.length) return;
  throw new WikiRecordTemplateError(
    `本批交付了 ${batchChunkIds.length} 个 chunk，记录只交代了 ` +
      `${batchChunkIds.length - missing.length} 个，未写入。\n\n` +
      `未被交代的 chunk：${missing.join(", ")}\n\n` +
      "每一个交付的 chunk 都要在记录里出现。不是机械地一个 chunk 一行——" +
      "带参数或机理的 chunk 值得写好几行，内容单薄的 chunk 可以并进相邻句子的从句里，" +
      "确实没有独立内容的 chunk 也要点名并说明它装的是什么，例如" +
      "「chunk 44-47 是公式推导的中间步骤，无独立数据」——" +
      "带上「无独立数据」「无新内容」「与前文重复」这类措辞，" +
      "宏观总结就不必再逐条重复这些交代句。连续几个可以合并引用，写成 " +
      "「（chunk 44-47）」或「（chunk 44、45、46）」都可以。\n\n" +
      "如果这一批太大、写不动，下一页少要几个 chunk——页大小由你定，" +
      "但取多少就要交代多少。",
  );
}

const LATEX_CLEANUPS: readonly (readonly [RegExp, string])[] = [
  [/\\(?:mathrm|text|mathbf|mathit|rm)\s*\{([^{}]*)\}/gu, "$1"],
  [/\\circ/gu, "°"],
  [/\\%/gu, "%"],
  [/\\mu\b/gu, "µ"],
  [/\\pm/gu, "±"],
  [/\\times/gu, "x"],
  [/\\cdot/gu, "·"],
  [/\\[a-zA-Z]+/gu, " "],
  [/[{}$~^_]/gu, " "],
];

/**
 * Undo enough of the OCR's LaTeX to see the numbers through it.
 *
 * MinerU renders a temperature as `$3 5 0 ~ ^ { \circ } \mathrm { C }$`, with
 * the digits separated. Outside maths those spaces are meaningful - a table
 * row reading `25 50 75 100` is four pressures, not one number - so the digit
 * join happens INSIDE maths spans only, before the spans are flattened.
 */
export function normalizeMeasurementText(text: string): string {
  let out = String(text ?? "").replace(/\$([^$]*)\$/gu, (_, inner: string) => {
    let joined = inner;
    let previous = "";
    while (joined !== previous) {
      previous = joined;
      joined = joined.replace(/(\d)\s+(\d)/gu, "$1$2");
    }
    return ` ${joined.replace(/(\d)\.\s+(\d)/gu, "$1.$2")} `;
  });
  for (const [pattern, replacement] of LATEX_CLEANUPS) {
    out = out.replace(pattern, replacement);
  }
  // `$0. 1$` and `0. 1 MPa` are both a decimal point the OCR put a space
  // after. A digit on each side of it is the giveaway; a sentence boundary
  // has a letter on the left.
  out = out.replace(/(\d)\.\s+(\d)/gu, "$1.$2");
  // Stripping `{ \circ }` leaves the degree sign orphaned from its C, and
  // `\mathrm { C }` leaves spaces around the C. Put the units back together
  // before anything tries to match one.
  return out
    .replace(/[ \t]+/gu, " ")
    .replace(/°\s*C/gu, "°C")
    .replace(/\b(wt|at|vol)\s*\.?\s*%/gu, "$1%")
    .replace(/\bK\s*\/\s*s/gu, "K/s")
    .replace(/\bm\s*\/\s*s/gu, "m/s");
}

const UNIT =
  "MPa|GPa|kPa|K/s|°C|℃|µm|μm|wt\\.?\\s?%|at\\.?\\s?%|vol\\.?\\s?%|kW|MW|kHz|MHz|kJ|kN|nm|mm|cm|rpm|ton|min|Hz|mol|kg|%|K|W|J|N|h|s|g|m|t";

/** `1750 K`, `0.1 MPa`, `8.56 wt%`, `4 h`. */
const VALUE_THEN_UNIT = new RegExp(
  `(\\d+(?:\\.\\d+)?)\\s*(?:±\\s*\\d+(?:\\.\\d+)?\\s*)?(?:${UNIT})(?![a-zA-Z°µμ])`,
  "gu",
);

/**
 * `Pouring temperature (°C) 690`, and the series form a flattened table takes:
 * `Pressure (MPa) 0.1(atm) 25 50 75 100 125`. Capturing only the first number
 * would read a six-point pressure sweep as one pressure.
 */
const UNIT_THEN_VALUES = new RegExp(
  `\\((?:${UNIT})[^)]{0,24}\\)\\s*((?:\\d+(?:\\.\\d+)?(?:\\([^)]{0,12}\\))?[ \\t]*)+)`,
  "gu",
);

/** Any number inside a Markdown table row: composition tables live here. */
const TABLE_ROW = /^\s{0,3}\|.*\|\s*$/u;
const BARE_NUMBER = /\d+(?:\.\d+)?/gu;

/** Chunk citations are addresses, never measurements. */
const CITATION_NUMBER = /(?:chunks?|块|段)\s*#?\s*\d+(?:\s*(?:[-–—]|to|~|、|,|，)\s*\d+)*/giu;

/**
 * The measured values a piece of text carries, as written.
 *
 * Deliberately under-inclusive rather than over-inclusive: a value is only
 * counted when a unit stands next to it or a Markdown table puts it in a
 * column. Equation numbers, figure numbers, citation years and the "two" in
 * "two-step aging" are not measurements, and a check that demanded them would
 * be a check nobody could satisfy honestly.
 */
export function measurementValues(text: string): Set<string> {
  const normalized = normalizeMeasurementText(text).replace(
    CITATION_NUMBER,
    " ",
  );
  const values = new Set<string>();
  const add = (raw: string | undefined): void => {
    if (!raw) return;
    const trimmed = raw.replace(/^0+(?=\d)/u, "");
    if (trimmed) values.add(trimmed);
  };
  for (const match of normalized.matchAll(VALUE_THEN_UNIT)) add(match[1]);
  for (const match of normalized.matchAll(UNIT_THEN_VALUES)) {
    for (const value of (match[1] ?? "").matchAll(BARE_NUMBER)) add(value[0]);
  }
  for (const line of normalized.split(/\r?\n/u)) {
    if (!TABLE_ROW.test(line)) continue;
    for (const match of line.matchAll(BARE_NUMBER)) add(match[0]);
  }
  return values;
}

export interface WikiValueLandingChunk {
  chunkId: number;
  text: string;
}

export interface WikiMissingValues {
  chunkId: number;
  values: string[];
}

/** Which of a batch's measured values never reached the text. */
export function missingMeasurements(
  written: string,
  chunks: readonly WikiValueLandingChunk[],
): { missing: WikiMissingValues[]; total: number; landed: number } {
  const present = measurementValues(written);
  const bare = new Set<string>();
  for (const match of normalizeMeasurementText(written)
    .replace(CITATION_NUMBER, " ")
    .matchAll(BARE_NUMBER)) {
    bare.add(match[0].replace(/^0+(?=\d)/u, ""));
  }
  const missing: WikiMissingValues[] = [];
  const seen = new Set<string>();
  let total = 0;
  let landed = 0;
  for (const chunk of chunks) {
    const wanted = [...measurementValues(chunk.text)].filter(
      (value) => !seen.has(value),
    );
    for (const value of wanted) seen.add(value);
    if (!wanted.length) continue;
    const absent = wanted.filter(
      (value) => !present.has(value) && !bare.has(value),
    );
    total += wanted.length;
    landed += wanted.length - absent.length;
    if (absent.length) missing.push({ chunkId: chunk.chunkId, values: absent });
  }
  return { missing, total, landed };
}

/**
 * Refuse a record that read the numbers and did not write them down.
 *
 * The ratio rather than a flat "all of them" is what keeps this satisfiable:
 * an OCR artefact that looks like a measurement, or a coefficient inside a
 * derivation, should not be able to block a reading that is otherwise
 * complete. The floor keeps a batch carrying one or two numbers out of the
 * check entirely, where a ratio would be noise.
 *
 * @throws WikiRecordTemplateError listing the values by chunk, so the fix is
 *   transcription rather than guesswork.
 */
export function assertValuesLanded(
  written: string,
  chunks: readonly WikiValueLandingChunk[],
  what: string,
): void {
  const { missing, total, landed } = missingMeasurements(written, chunks);
  if (total < WIKI_VALUE_LANDING_FLOOR) return;
  if (landed / total >= WIKI_VALUE_LANDING_RATIO) return;
  const shown = missing.slice(0, 12);
  throw new WikiRecordTemplateError(
    `${what}丢掉了本批 chunk 里的实测数值，未写入。本批可识别的测量值 ${total} 个，` +
      `落地 ${landed} 个（${Math.round((landed / total) * 100)}%），` +
      `要求不低于 ${Math.round(WIKI_VALUE_LANDING_RATIO * 100)}%。\n\n` +
      "未落地的数值，按 chunk 列出：\n" +
      shown
        .map((entry) => `  chunk ${entry.chunkId}: ${entry.values.join(", ")}`)
        .join("\n") +
      (missing.length > shown.length
        ? `\n  …另有 ${missing.length - shown.length} 个 chunk 有遗漏。`
        : "") +
      "\n\n把它们写进「**测到了什么**」或「**做了什么**」，每个值带上单位和它的测量条件——" +
      "写「21.6 kW 下锭温 1750 ± 7.4 K，处于单相 β 区」，不要写「在给定功率下发生 β 相变」。" +
      "成分表、工艺参数表、性能表整表转写，不要改写成描述。\n" +
      "带条件写还有一个好处：夸大审计拦的是「丢了条件的数字」，条件齐全的数值根本不会被标记。",
  );
}

/**
 * Refuse a no-new-content record that is hiding measurements nobody wrote.
 *
 * `unchanged` exists for bibliographies, acknowledgements and a paper that the
 * index holds twice, and all three are real. What it must not become is the
 * cheap way past the value check, so it is allowed exactly when the batch's
 * numbers are already somewhere in the note - which is what "no NEW content"
 * means, and is true of a duplicated section by construction.
 *
 * @throws WikiRecordTemplateError
 */
export function assertUnchangedCarriesNothingNew(
  previousBody: string,
  chunks: readonly WikiValueLandingChunk[],
  reason: string,
): void {
  const { missing, total, landed } = missingMeasurements(previousBody, chunks);
  if (total < WIKI_VALUE_LANDING_FLOOR) return;
  if (landed / total >= WIKI_VALUE_LANDING_RATIO) return;
  const shown = missing.slice(0, 12);
  throw new WikiRecordTemplateError(
    `这一批被标为「本次无新内容」（${reason}），但它带着 ${total} 个测量值，` +
      `其中 ${total - landed} 个在此前的全部阅读记录里从未出现过，所以它不是重复内容。\n\n` +
      "此前从未记录过的数值：\n" +
      shown
        .map((entry) => `  chunk ${entry.chunkId}: ${entry.values.join(", ")}`)
        .join("\n") +
      (missing.length > shown.length
        ? `\n  …另有 ${missing.length - shown.length} 个 chunk 有遗漏。`
        : "") +
      "\n\n请改为一条正常记录，按模板写下这些数值。" +
      "如果这一批确实是同一篇论文的第二份副本，那么它的数值应当已经在前面出现过——" +
      "没有出现，说明第一份副本对应的那一批当时也漏掉了它们。",
  );
}

/** Sentences long enough that repeating one is a choice, not a coincidence. */
function comparableSentences(text: string): string[] {
  return String(text ?? "")
    .split(/(?<=[.。!！?？])\s+|\n{2,}/u)
    .map((sentence) => normalizeWikiText(sentence))
    .filter((sentence) => sentence.length >= 40);
}

/**
 * Refuse a macro summary that is the reading records pasted end to end.
 *
 * Concatenating the records passed as a summary on a real paper at 98%
 * verbatim overlap. It added nothing because every one of its sentences was
 * already sitting directly above it in the same file.
 *
 * @throws WikiRecordTemplateError
 */
export function assertMacroIsNotPaste(
  recordsBody: string,
  summary: string,
): void {
  const sentences = comparableSentences(summary);
  if (sentences.length < 4) return;
  const haystack = normalizeWikiText(recordsBody);
  const repeated = sentences.filter((sentence) => haystack.includes(sentence));
  const ratio = repeated.length / sentences.length;
  if (ratio < WIKI_MACRO_PASTE_RATIO) return;
  throw new WikiRecordTemplateError(
    `宏观总结有 ${repeated.length}/${sentences.length} 句（${Math.round(ratio * 100)}%）` +
      `与上面的阅读记录逐字相同，未写入。上限是 ${Math.round(WIKI_MACRO_PASTE_RATIO * 100)}%。\n\n` +
      "把各条记录首尾相接不产生任何新东西——" +
      "那些句子就在同一个文件里、就在这段总结的正上方。\n\n" +
      "重写一遍：现在全文已经交付，回读任意 chunk 都是免费的。先通读全部阅读记录，" +
      "指出它们之间的关系——哪一条是另一条的机理解释、哪一条修正了前面的判断、" +
      "哪几条是同一个现象在不同条件下的测量——再按模板写。" +
      "提炼核心内容和核心方法；只有对核心结论或重要条件不可缺少的数值才需要保留。",
  );
}

/** One reading record, as `parseAppendOnlyReadingNote` returns it. */
export interface WikiRecordSummaryUnit {
  number: number;
  chunkIds: number[];
  noNewContent: boolean;
}

/**
 * Refuse a whole-paper summary that walked past whole stretches of the reading.
 *
 * This replaces a check that compared the summary's WORDING against each
 * record's findings, sentence by sentence and anchor by anchor. That version
 * had to go: once a record was required to account for every chunk on its
 * page, every record grew dismissal lines - "chunks 44-47 are intermediate
 * algebra" - and demanding the summary preserve each of those findings meant
 * demanding it repeat them, which is precisely the concatenation
 * `assertMacroIsNotPaste` refuses. Two rules that cannot both be satisfied are
 * worse than either alone, and the way that one was answered in practice was
 * by deleting it, which left nothing at all.
 *
 * So this asks the weakest question that still catches the failure it exists
 * for: does the summary CITE something from each substantive record? A record
 * is a stretch of the paper somebody read; a summary that names no chunk from
 * it has left that stretch out. Nothing here looks at wording, so writing the
 * summary in completely different words - which is exactly what the paste rule
 * demands - can never make this one fail. The two rules point the same way.
 *
 * No-new-content records are skipped, because there is nothing in them to
 * leave out.
 *
 * @throws WikiRecordTemplateError
 */
export function assertMacroTouchesEveryRecord(
  records: readonly WikiRecordSummaryUnit[],
  summary: string,
  /**
   * Every other address the same passage answers to.
   *
   * A chunk has two: its position in the paper and the row id the index gave
   * it. They coincide for almost every document, and the reading ledger stores
   * whichever one the caller supplied - a full-text page books positions, a
   * question books the chunkIds it was handed - while a note cites whichever
   * the model saw. Comparing the two sets directly would report a record as
   * skipped because it was written down under its other name.
   */
  aliases?: ReadonlyMap<number, readonly number[]>,
): void {
  const cited = new Set(expandedCitedChunkIds(summary));
  const touches = (chunkId: number): boolean =>
    cited.has(chunkId) ||
    (aliases?.get(chunkId) ?? []).some((alias) => cited.has(alias));
  const missed = records.filter(
    (record) =>
      !record.noNewContent &&
      record.chunkIds.length > 0 &&
      !record.chunkIds.some(touches),
  );
  if (!missed.length) return;
  throw new WikiRecordTemplateError(
    `宏观总结完全没有涉及 ${missed.length} 条阅读记录读过的内容，未写入。\n\n` +
      missed
        .map(
          (record) =>
            `  第 ${record.number} 次 · chunk ${formatChunkList(record.chunkIds)}`,
        )
        .join("\n") +
      "\n\n这些记录覆盖的段落，总结里一个 chunk 都没有引用——" +
      "说明论文有整段内容没有进入全篇视野。\n" +
      "检查的只是「有没有引用到」，不看措辞：用完全不同的话去讲同一段，" +
      "同样能通过，而且那正是防拼接规则要求的写法。两条规则不冲突。\n" +
      "如果某一段确实对全篇论述没有贡献（公式推导中间步骤、与前文重复的副本），" +
      "在相应小节里用一句话交代它，并引用其中一个 chunk。",
  );
}

/** `0-4,7,12-15`, so a long record does not print sixty numbers. */
function formatChunkList(ids: readonly number[]): string {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start: number | null = null;
  let previous: number | null = null;
  const flush = (): void => {
    if (start === null || previous === null) return;
    parts.push(start === previous ? `${start}` : `${start}-${previous}`);
  };
  for (const id of sorted) {
    if (start === null) {
      start = id;
      previous = id;
      continue;
    }
    if (previous !== null && id === previous + 1) {
      previous = id;
      continue;
    }
    flush();
    start = id;
    previous = id;
  }
  flush();
  return parts.join(",");
}

/**
 * Refuse to write when the note has fewer records than the session has
 * accepted writes.
 *
 * The reading records are append-only and the note file is the only place
 * they exist; the database keeps the chunk ledger but not the prose. That
 * split is fine while the two agree, and silent when they do not: a real
 * reading delivered ten batches, integrated ten batches, and ended with a note
 * containing ONE record whose declared chunks matched no batch at all. Every
 * counter still said the paper had been read completely, because every counter
 * lives on the side that did not lose anything.
 *
 * The invariant is arithmetic and asks for no extra writing: a note that has
 * been accepted N times holds at least N records. Records from earlier
 * sessions only ever make the left side bigger, and an integration that
 * settled nothing new is not counted, so the check errs towards silence.
 *
 * @throws WikiRecordTemplateError naming the gap, because the note on disk has
 *   to be repaired by a person - nothing here can reconstruct prose that was
 *   overwritten.
 */
export function assertRecordLedgerIntact(
  recordCount: number,
  integrationCount: number,
): void {
  if (recordCount >= integrationCount) return;
  throw new WikiRecordTemplateError(
    `阅读笔记与账本对不上，未写入。本次阅读已经有 ${integrationCount} 次记录被接受，` +
      `但笔记里只剩 ${recordCount} 条阅读记录——中间有 ${integrationCount - recordCount} 条丢了。\n\n` +
      "阅读记录是只增不改的，而它们只存在于笔记文件里；数据库只记 chunk 账本，不记正文。" +
      "所以出现这种情况，说明笔记文件被整份重写或重建过，而不是被追加。" +
      "如果继续写下去，账本会显示全篇已读，笔记却缺着几段，" +
      "而之后没有任何一处会发现这件事。\n\n" +
      "请先确认这篇文献的笔记附件（`Wiki Reading Note (…)`）是不是被删除或替换过。" +
      "丢掉的正文无法从数据库恢复——只能用 wiki_finish_reading 以 outcome \"failed\" 关闭这次阅读，" +
      "然后重新读一遍。",
  );
}
