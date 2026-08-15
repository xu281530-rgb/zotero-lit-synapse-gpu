/**
 * Stage-1 候选行的投影：把融合后的检索命中压成「用来筛选」的最小信息。
 *
 * 为什么要有这一层：hybrid_search 的结果是漏斗的第一段，作用是让调用方
 * 决定「下一步值不值得为这篇再发一次请求」，而不是把文献内容一次性搬过去。
 * 摘要照常参与检索（词法分支扫 abstractNote，语义索引由正文构建），但不再
 * 随结果返回——20 篇候选只为其中 3 篇做决定时，另外 17 篇的摘要就是白发的
 * 字节。要读摘要的那几篇，调用方用 get_item_abstract 单篇按需取。
 *
 * 这里全是纯函数，不依赖 XPCOM，可以直接在 Node 下跑单测。
 */

/**
 * 每条候选带回多少命中证据。
 *
 * 这些片段是用来回答「它是不是因为我想要的原因才被召回」的，不是用来当正文
 * 读的：两段、各截断一下，足以把真命中和巧合命中区分开。再多就等于让论文
 * 正文从后门流回来，而那正是 get_item_abstract 和 search_fulltext 的职责。
 */
export const HYBRID_EVIDENCE_CHUNKS = 2;
export const HYBRID_EVIDENCE_CHARS = 220;

export function truncateEvidence(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= HYBRID_EVIDENCE_CHARS
    ? collapsed
    : `${collapsed.slice(0, HYBRID_EVIDENCE_CHARS)}…`;
}

/**
 * 分数只会被人或模型读取、比较、和阈值对照，不会再被拿去二次融合，
 * 保留 4 位小数已经覆盖所有有意义的区分。20 条候选各带 16 位浮点尾数，
 * 是花在无意义精度上的字节。
 */
export function roundScore(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value * 10000) / 10000
    : undefined;
}

/**
 * 判断文献本身是用哪种语言写的。
 *
 * 第三段（单篇全文检索）的关键词必须用文献自身的语言——另一种语言的探针
 * 在单篇文档里什么都匹配不到——所以调用方在写关键词之前需要这个信息。
 * Zotero 自己的 language 字段填了且明确时优先采信；否则看标题、摘要和命中
 * 片段的字符构成：中文文本里夹带少量拉丁字符（单位、缩写、参考文献）很正常，
 * 反过来则不然。
 */
export function detectDocumentLanguage(
  declared: string,
  samples: string[],
): "zh" | "en" {
  const tag = String(declared || "")
    .trim()
    .toLowerCase();
  if (tag.startsWith("zh") || tag.includes("chinese") || tag.includes("中文")) {
    return "zh";
  }
  if (tag.startsWith("en") || tag.includes("english")) return "en";

  const joined = samples.filter(Boolean).join(" ");
  const cjk = (joined.match(/[㐀-䶿一-鿿]/g) || []).length;
  if (cjk === 0) return "en";
  const latin = (joined.match(/[A-Za-z]/g) || []).length;
  return cjk * 2 >= latin ? "zh" : "en";
}

/**
 * 一行候选的全文可用性，取值与 metadata.fullTextCoverage 的五个计数键完全一致
 * ——同一套词汇，一处是单篇的判定，一处是整页的分布。汇总侧一旦另起一套名字，
 * 就变成两份互相打架的词汇表，而且几乎必然顺手把 unknown 并进「有全文」那一
 * 项，把「从没记录过」说成「确认有」——这正是这个字段要防的那种夸大。
 *
 * 这里重新声明而不是从 semantic 模块导入：本文件是纯函数层，刻意不依赖任何
 * 会把 XPCOM 拖进来的模块，否则 Node 下的单测就跑不起来。两处的一致性由
 * test-body-index.js 断言钉住。
 */
export type FullTextAvailability =
  | "indexed"
  | "parse_failed"
  | "no_source"
  | "not_indexed"
  | "unknown";

export interface HybridCandidate {
  itemKey: string;
  libraryID?: number;
  title?: string;
  creators?: string;
  year?: string;
  itemType?: string;
  publicationTitle?: string;
  DOI?: string;
  /** 该文献的书写语言，供第三段决定关键词用哪种语言。 */
  language: "zh" | "en";
  score?: number;
  /** 这篇是被哪一路召回的，取代一堆分路排名与分数字段。 */
  matchedBy: "keyword+semantic" | "keyword" | "semantic";
  matchedKeywords?: string[];
  matchedFields?: string[];
  /** 有没有摘要可取、有多长——是「可用性」，不是内容。 */
  hasAbstract?: boolean;
  abstractChars?: number;
  /**
   * 这篇到底有没有被索引到正文。
   *
   * 没有这一项的时候，「PDF 解析失败、只索引了标题摘要」的文献和真正有全文的
   * 文献长得一模一样：同样的分数、同样的 matchedBy: semantic、同样带
   * matchedChunks——而那几段恰恰就是它的标题和摘要。调用方没有任何依据能把
   * 它们和正文段落区分开，于是摘要会被当成论文的结论引用。这一项就是在筛选
   * 阶段、在引用发生之前把这个区别摆出来。
   */
  fullText?: FullTextAvailability;
  /**
   * fullText 不是 indexed 时出现，说明这一行的 matchedChunks 该怎么读：
   * parse_failed / no_source / not_indexed 是「这就是元数据，不是正文」，
   * unknown 是「旧索引，是不是正文没人记录过，别直接当正文引用」。
   */
  fullTextNote?: string;
  matchedChunks?: Array<{
    chunkId?: number;
    score?: number;
    text: string;
  }>;
}

/**
 * 把一条融合命中投影成调用方用来筛选的候选行。
 *
 * 保留下来的每一项都在回答「这篇值不值得我下一次调用」：它是什么、排得多高、
 * 我自己的哪些探针命中了、命中的段落长什么样。去掉的要么是应当稍后显式获取的
 * 内容（摘要 → get_item_abstract），要么是筛选决策用不上的打分内部量——分路
 * 排名和分路得分由 matchedBy 概括，完整口径仍在 metadata 里。
 */
export function projectHybridCandidate(
  result: Record<string, any>,
): HybridCandidate {
  const matchedByKeyword = typeof result.keywordRank === "number";
  const matchedBySemantic = typeof result.semanticRank === "number";

  const evidence = (
    Array.isArray(result.matchedChunks) ? result.matchedChunks : []
  )
    .slice(0, HYBRID_EVIDENCE_CHUNKS)
    .map((chunk: any) => ({
      chunkId: chunk?.chunkId,
      score: roundScore(chunk?.score),
      text: truncateEvidence(String(chunk?.text || "")),
    }));

  // 两路对「年份」的表达不一致：词法路给日期字符串，语义路给数字。
  // 对外统一成 4 位年份。
  const year =
    String(result.year ?? result.date ?? "").match(/\d{4}/)?.[0] || undefined;

  return {
    itemKey: result.itemKey,
    libraryID: result.libraryID,
    title: result.title,
    creators: result.creators || undefined,
    year,
    itemType: result.itemType,
    publicationTitle: result.publicationTitle || undefined,
    DOI: result.DOI || undefined,
    language:
      result.language ??
      detectDocumentLanguage("", [
        String(result.title || ""),
        ...evidence.map((chunk) => chunk.text),
      ]),
    score: roundScore(result.score),
    matchedBy:
      matchedByKeyword && matchedBySemantic
        ? "keyword+semantic"
        : matchedByKeyword
          ? "keyword"
          : "semantic",
    matchedKeywords: result.matchedKeywords,
    matchedFields: result.matchedFields,
    hasAbstract: result.hasAbstract,
    abstractChars: result.abstractChars,
    fullText: result.fullText,
    // Carried right next to fullText, and before matchedChunks in the object,
    // so it is read before the snippets it is warning about.
    ...(result.fullTextNote ? { fullTextNote: result.fullTextNote } : {}),
    ...(evidence.length ? { matchedChunks: evidence } : {}),
  };
}
