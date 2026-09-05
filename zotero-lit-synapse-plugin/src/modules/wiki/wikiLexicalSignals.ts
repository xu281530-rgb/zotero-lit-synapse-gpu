/**
 * 词法信号：两篇文献是否在讨论同一个**稀有**术语。
 *
 * 语义信号能发现「换了说法的同一件事」，代价是贵，而且解释不了自己——它只能给出
 * 一个余弦值和两段摘录。词法信号正好互补：它天然带着一个可读的标签（就是那个词），
 * 计算便宜，可解释性强；代价是它只认字面。两条路各自能发现对方发现不了的边。
 *
 * ## 为什么必须用真实 DF，而不能用 libraryFieldStats
 *
 * `keyword/libraryFieldStats.ts` 算的是 BM25F 长度归一化用的各字段平均长度。它和
 * 「一个词在多少篇文献里出现过」没有任何关系。把它当稀有度来源，得到的会是一个与
 * 稀有度无关的数，而整个词法信号的价值全部押在稀有度上：两篇文献都出现「材料」不是
 * 信息，都出现「Lomer-Cottrell」几乎就是结论。
 *
 * 真实 DF 来自 `KeywordIndexStore.documentFrequencies`，它数的是 `kw_postings` 里
 * 活文档的去重 doc_id。
 *
 * ## 为什么在两篇文献的正文上重新分词，而不是查倒排
 *
 * 倒排表是 term → postings，回答不了「文献 A 里有哪些词」——那需要扫遍全库的
 * postings。而两篇文献的正文就在手边（阶段 B 已经把它们的 chunk 读进内存了），
 * 用同一个 `tokenizeForIndex` 重新切一遍是几毫秒的事，且天然保证与索引侧同口径。
 * 只有 DF 需要回查数据库，而且是一次批量查询。
 *
 * 纯函数（DF 由调用方注入），可以直接在 Node 下跑单测。
 */

import { normalize, tokenizeForIndex } from "../keyword/scientificTokenizer";
import { lexicalIdf } from "./wikiLinkScoring";

/** 词法信号的算法版本。切词、停用规则或打分改动都必须改这里。 */
export const LEXICAL_ALGORITHM_VERSION = "link-lex-v5";
// v5 excludes bare prose and figure-color labels, keeping technical phrases
// and curated concepts available through the other candidate channels.
// v4: v3 left the PDF pipeline's own residue — LaTeX command names (mathtt,
// colon, bullet) and units the tokeniser had joined (mmmin from mm/min, which
// UNIT_SHAPED only caught in its slashed form). Both are genuinely rare and
// neither is a term of the field.
//
// v3: v2 stopped the boilerplate but left the tokeniser's own artefacts -
// sliding Han bigrams (高为, 除裂, 金状), unit fragments (c/min, cmin) and bare
// labels (d1, 300, phi) - all genuinely rare and all useless as an edge label.
// v3 adds isUsableLexicalTerm, which is a LABEL-quality gate, not a rarity one.
//
// v2: v1 scored every term the keyword index had never seen as maximally rare,
// because `documentFrequencies` returned 0 for a miss instead of omitting it.
// The terms it had never seen were the ones the keyword indexer strips -
// acknowledgements, funding, data availability - so the worst possible terms
// arrived rated 1.000 and buried the semantic signals. v2 skips unknown-rarity
// terms, filters non-body chunks before tokenising, and caps the lexical scale
// below the semantic one. Bumping the version is what lets the relinker
// recognise every v1 signal as superseded rather than carrying it forward.

export interface LexicalChunk {
  chunkId: number;
  text: string;
}

export interface LexicalTermHit {
  term: string;
  df: number;
  idf: number;
  /** 该词在这一侧首次出现的 chunk 及其原句。 */
  aChunkId: number;
  aExcerpt: string;
  bChunkId: number;
  bExcerpt: string;
}

/**
 * 这个词能不能当边上的标签？
 *
 * 这是**标签质量**过滤，不是稀有度过滤——两者是不同的问题，而且一个词完全可能既
 * 真的稀有、又完全不能当标签。实测跑出来的最高分词法信号是：
 *
 *     tial  c/min  cmin  d1  phi  300  β
 *     高效  高弹  高化  高为  除裂  金状
 *
 * 每一个的 df 都很小，所以稀有度是对的；但「两篇文献共享『高为』」不构成任何信息，
 * 读者对它做不了任何事。词法通道存在的理由就是它天生带一个可读的标签；标签不可读，
 * 这条信号的全部价值就没了。
 *
 * ## 为什么整类丢掉汉字
 *
 * tokenizer 对中文没有分词器，它在每个偏移上滑一个两字窗口：
 *
 *     柱状晶高温合金 → 柱状 | 状晶 | 晶高 | 高温 | 温合 | 合金
 *
 * 真词（柱状、高温、合金）和跨词边界的切片（状晶、晶高、温合）混在一起，且**无法
 * 区分**。这对检索是对的——查「高温」能命中——但当标签就是掷骰子。所以汉字二元组
 * 整类不进词法信号。
 *
 * 这不损失中文术语：中文术语通过**概念通道**进入图谱，那里存的是术语库里真正的
 * 中文全称，由人确认过，而不是滑窗切出来的。两条通道各自做自己擅长的事。
 *
 * ## 拉丁词的门槛
 *
 * 至少 3 个字母，**或者** 2 个字母配 3 位以上数字。后半条是为合金牌号留的：
 * `gh4169`、`fgh4096`、`ti6al4v` 是这个库里最好的词法信号之一，只按字母数卡会把
 * `gh4169` 一起丢掉，而 `d1`（1 字母 1 数字）、`x2` 仍然挡得住。
 *
 * 计量单位与希腊字母名单列：它们字母数够，但共享一个单位只说明两篇论文用同一套
 * 量纲，共享一个 `phi`/`beta` 只说明两篇论文都用希腊字母做变量名——都不是发现。
 */
const MEASUREMENT_UNITS = new Set([
  "min", "sec", "hrs", "hour", "hours", "mpa", "gpa", "kpa", "kgf",
  "mol", "wt", "vol", "rpm", "kev", "mev", "khz", "mhz",
  "mmin", "cmin", "kmin", "ksec", "msec", "umin",
  "mms", "nms", "ums", "kjmol", "jmol", "wmk",
]);

/**
 * LaTeX / Markdown 命令名。PDF 抽取的残留，不是论文的词。
 *
 * 实测浮到词法信号最前面的有 mathtt、colon、bullet —— 它们 df 很小（只有少数
 * 文献的抽取留下了这些命令），所以稀有度看起来很高，但「两篇文献共享 \colon」
 * 说明的是抽取管线的行为，不是这两篇论文的关系。
 */
const MARKUP_COMMANDS = new Set([
  "mathtt", "mathrm", "mathbf", "mathit", "mathcal", "mathbb", "mathsf",
  "textbf", "textit", "textrm", "texttt", "emph",
  "colon", "bullet", "cdot", "times", "quad", "qquad", "hspace", "vspace",
  "begin", "end", "item", "label", "caption", "footnote",
  "frac", "sqrt", "sum", "int", "lim", "log", "exp",
  "left", "right", "overline", "underline", "widehat", "tilde",
  "rightarrow", "leftarrow", "approx", "leq", "geq", "neq", "pm",
]);

/** 希腊字母的拉丁拼写。它们是符号名，不是术语。 */
const GREEK_SYMBOL_NAMES = new Set([
  "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta",
  "iota", "kappa", "lambda", "mu", "nu", "xi", "omicron", "pi", "rho",
  "sigma", "tau", "upsilon", "phi", "chi", "psi", "omega",
]);

/** 单位/速率的形状：字母（可带斜杠或短横）后面跟单位，如 c/min、k/s、mm/s。 */
const UNIT_SHAPED = /^[a-z]{1,3}[/·-][a-z]{1,4}[0-9]*$/u;

/**
 * 单位被 tokenizer 拼接后的形状：mm/min → mmmin、°C/min → cmin、K/s → ks。
 *
 * tokenizer 对含斜杠的词同时产出原形和去掉分隔符的变体，所以 UNIT_SHAPED 只挡住
 * 前者，后者会漏过去——实测 mmmin 就是这样进来的。这里匹配「短前缀 + 时间/长度
 * 单位」的拼接形状，同时把 min/sec 这些本身就是单位的短词一并挡掉。
 */
const JOINED_UNIT = /^[a-z]{0,3}(min|sec|hr|hrs|mpa|gpa|kpa|mol|rpm)$/u;

const NON_TERM_LABELS = new Set([
  "arise", "arises", "arising", "ambiguity", "shown", "showing", "respectively",
  "black", "white", "red", "green", "blue", "yellow",
]);

export function isUsableLexicalTerm(term: string): boolean {
  const value = String(term ?? "").trim();
  if (!value) return false;
  if (NON_TERM_LABELS.has(value.toLowerCase())) return false;

  const letters = (value.match(/\p{L}/gu) ?? []).length;
  if (letters === 0) return false; // 300, 1100, 数字与符号

  const han = (value.match(/\p{Script=Han}/gu) ?? []).length;
  if (han > 0) {
    // 滑窗二元组，无法与真词区分。见上。
    return false;
  }

  const latin = value.replace(/[^\p{L}]/gu, "");
  const digits = (value.match(/[0-9]/gu) ?? []).length;
  // 3 个字母，或 2 个字母配一串数字（合金牌号）。挡住 d1、x2、β。
  if (latin.length < 3 && !(latin.length >= 2 && digits >= 3)) return false;
  const lower = latin.toLowerCase();
  if (MEASUREMENT_UNITS.has(lower)) return false;
  if (GREEK_SYMBOL_NAMES.has(lower)) return false;
  if (MARKUP_COMMANDS.has(lower)) return false;
  if (JOINED_UNIT.test(lower)) return false;
  if (UNIT_SHAPED.test(value.toLowerCase())) return false; // c/min, k/s
  return true;
}

/** 摘录：包含该词的一句话，而不是整段。 */
const EXCERPT_RADIUS = 90;

function excerptAround(text: string, term: string): string {
  const haystack = String(text ?? "");
  const index = normalize(haystack).indexOf(term);
  const source = haystack.replace(/\s+/gu, " ").trim();
  if (index < 0) {
    return source.length > EXCERPT_RADIUS * 2
      ? `${source.slice(0, EXCERPT_RADIUS * 2)}…`
      : source;
  }
  // 归一化会改变长度，所以偏移只能当作近似定位，两边各留一段余量。
  const from = Math.max(0, index - EXCERPT_RADIUS);
  const to = Math.min(source.length, index + term.length + EXCERPT_RADIUS);
  return `${from > 0 ? "…" : ""}${source.slice(from, to).trim()}${
    to < source.length ? "…" : ""
  }`;
}

/** term → 它首次出现的 chunk。一个词出现一百次和出现一次的稀有度一样。 */
export function termChunkIndex(
  chunks: readonly LexicalChunk[],
): Map<string, LexicalChunk> {
  const index = new Map<string, LexicalChunk>();
  for (const chunk of chunks) {
    for (const occurrence of tokenizeForIndex(chunk.text)) {
      if (!index.has(occurrence.term)) index.set(occurrence.term, chunk);
    }
  }
  return index;
}

export interface LexicalOptions {
  /** 全库活文档数 N。 */
  documentCount: number;
  /** 出现在超过这个比例文献里的词直接丢弃，视为本领域的停用词。 */
  maxDocumentFraction: number;
  /** 每对文献最多保留几个词。 */
  termsPerPair: number;
  /**
   * DF 表里查不到的词怎么办。
   *
   * `"skip"` 用于真正打分的那一遍：查过之后仍然没有 DF，说明关键词索引里没有这个
   * 词的 posting，它的稀有度**未知**——而未知不能当成「很稀有」。默认值 2 会把
   * "and"、"before" 这类词顶到最前面（它们在传入的 DF 表里恰好缺失时），于是边上
   * 写着的就是两篇论文都用了英语。少一条信号是可接受的损失，一条错的不是。
   *
   * `"assume-rare"` 用于「先找出共享词、再批量查 DF」的第一遍：那一遍本来就没有
   * DF 表，过滤全部关掉，这里的取值不影响结果。
   */
  unknownFrequency?: "skip" | "assume-rare";
}

/**
 * 两篇文献共享的稀有术语。
 *
 * `documentFrequencies` 由调用方注入，既是为了可测，也是因为 DF 属于关键词索引，
 * 不属于 Wiki——让这个模块自己去连另一个数据库会把两层耦死。
 */
export function sharedRareTerms(
  a: readonly LexicalChunk[],
  b: readonly LexicalChunk[],
  documentFrequencies: ReadonlyMap<string, number>,
  options: LexicalOptions,
): LexicalTermHit[] {
  const aIndex = termChunkIndex(a);
  const bIndex = termChunkIndex(b);
  const ceiling = Math.max(
    1,
    Math.floor(options.maxDocumentFraction * Math.max(1, options.documentCount)),
  );

  const hits: LexicalTermHit[] = [];
  for (const [term, aChunk] of aIndex) {
    const bChunk = bIndex.get(term);
    if (!bChunk) continue;
    // 标签质量先于稀有度：一个不能当标签的词，再稀有也没有价值。
    if (!isUsableLexicalTerm(term)) continue;
    const known = documentFrequencies.get(term);
    // Absent = the keyword index has no posting for this term = rarity UNKNOWN.
    // Not rare. This guard was dead for one release because
    // `documentFrequencies` filled misses with 0, and the terms it let through
    // were `acknowledgements`, `availability`, `funds` - each scored 1.000.
    if (known === undefined && options.unknownFrequency === "skip") continue;
    // 缺失时按 2 计——这两篇文献就是它已知的两个来源。记 0 会让 idf 虚高，把一个
    // 从未被索引的偶然字符串排到最前面。
    const df = known ?? 2;
    // 本领域的停用词。「材料」「实验」「结果」在冶金库里的 DF 接近 N，共享它们
    // 不是发现，只是这两篇论文都是用中文写的金属材料论文。
    if (df > ceiling) continue;
    hits.push({
      term,
      df,
      idf: lexicalIdf(df, options.documentCount),
      aChunkId: aChunk.chunkId,
      aExcerpt: excerptAround(aChunk.text, term),
      bChunkId: bChunk.chunkId,
      bExcerpt: excerptAround(bChunk.text, term),
    });
  }

  // 最稀有的在前，截断时留下的就是最有区分度的。
  hits.sort(
    (left, right) => right.idf - left.idf || left.term.localeCompare(right.term),
  );
  return hits.slice(0, Math.max(1, Math.floor(options.termsPerPair)));
}

/**
 * 把 IDF 折成 0..1 的信号分。
 *
 * 词法分必须和语义分同尺度，否则 `wiki_status` 的按类型统计、以及每对文献内部
 * 按分数取 top-3 的截断，比较的就是两把不同的尺子。上界是 log(N+1)——一个只在
 * 一篇文献里出现过的词的 IDF——所以除以它就落在 0..1。
 */
export function lexicalScore(idf: number, documentCount: number): number {
  const ceiling = Math.log(Math.max(1, documentCount) + 1);
  if (!(ceiling > 0)) return 0;
  const normalized = Math.min(1, Math.max(0, idf / ceiling));
  return normalized * LEXICAL_SCORE_CEILING;
}

/**
 * 词法分的天花板，低于 1。
 *
 * 两种信号必须能放在一把尺子上比较——每对文献内部按分数取 top-3、`wiki_status`
 * 的按类型统计、以及面板的排序，都在直接比大小。但它们的**上界性质不同**：词法分
 * 的满分是「这个词只在这两篇里出现过」，一个只要 df 够小就能拿到的值；语义分的满分
 * 是「两篇文献的代表段落几乎逐段对应」，实测极难超过 0.9。让词法能拿到 1.000，
 * 等于让一个便宜的、只认字面的信号永远排在昂贵的、能发现换了说法的同一件事的信号
 * 前面——实测就是这样：词法均值 0.82 对语义均值 0.61，面板上语义信号被整段挤掉。
 *
 * 0.85 让最稀有的词落在语义实测上界附近而不越过它。这是**调参不是修 bug**，
 * 真实库校准后应当重新审视；它与 wiki.link.* 里那些阈值属于同一类未测量的数。
 */
export const LEXICAL_SCORE_CEILING = 0.85;
