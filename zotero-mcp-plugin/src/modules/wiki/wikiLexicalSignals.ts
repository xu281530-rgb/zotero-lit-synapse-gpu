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
export const LEXICAL_ALGORITHM_VERSION = "link-lex-v2";
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
