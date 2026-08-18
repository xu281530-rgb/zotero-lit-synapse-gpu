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
 * 排序分（RRF）专用的舍入精度：6 位，不是 4 位。
 *
 * RRF 分数不是相关度，是名次分：k=60 时相邻两名之差只有 1/61-1/62 ≈ 2.6e-4，
 * 名次靠后时降到 1e-5 量级。用 4 位小数会把相邻名次舍入成同一个数，于是一页
 * 结果里出现「分数一样但顺序不同」——而这一栏正是为了让顺序和分数对得上才存在
 * 的。相关度分（余弦、命中片段）仍然用 roundScore：它们是真实的 0-1 量，4 位
 * 足够，多出来的位数只是噪声。
 */
export function roundRankScore(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value * 1000000) / 1000000
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
  /**
   * 排序分：加权 RRF。**这不是相关度**，是名次共识分，数值很小（两路都排第一
   * 时约 0.033），拿它跟 0.6 比或者跟另一次检索的分数比都没有意义。它和列表
   * 顺序是同一个量，所以照着它读顺序永远不会读错。
   */
  score?: number;
  /**
   * 关键词分支自己的 0-1 相关度（归一化 BM25F）。**「有多相关」看这两栏。**
   *
   * 缺失表示这一路没有准入这篇，不表示它得了 0 分——两路各自独立准入，一篇
   * 只要过了其中一路就会出现在这里。
   */
  normalizedKeywordScore?: number;
  /** 语义分支自己的 0-1 相关度（余弦），语义同上。 */
  normalizedSemanticScore?: number;
  /** 这篇是被哪一路准入的。 */
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
  /**
   * 为什么这篇是被**正文关键词**召回的。
   *
   * 关键词分支同时检索元数据字段和**已建立关键词索引的正文**，所以一篇标题、
   * 摘要、标签里一个查询词都没有的文献，完全可能因为正文里出现了这些词而进入
   * 结果。此时 matchedFields 只会显示 "body"，调用方看着一行「哪个词都没在标题
   * 里」的候选，无从判断它到底是真命中还是噪声——这一栏就是把那个判断依据交出来。
   *
   * 只在正文有命中时出现。里面是命中片段本身，不是相关度：`occurrences` 是该
   * 片段内命中次数，用来说明证据强度，**不参与任何排序或打分**。
   */
  bodyEvidence?: Array<{
    chunkId: number;
    /** 这一段命中了查询里的哪些词。 */
    matchedKeywords: string[];
    /** 这一段内的命中次数，合计所有命中词。 */
    occurrences: number;
    /** 片段原文，与 matchedChunks 同样截断。 */
    text?: string;
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
    score: roundRankScore(result.score),
    // 排序分自己说明不了「有多相关」，所以两路各自的相关度必须跟着一起回去。
    // 这两栏正是阈值实际作用的那两个数，缺一个就等于让调用方拿着一个名次分去
    // 判断相关性。
    normalizedKeywordScore: roundScore(result.normalizedKeywordScore),
    normalizedSemanticScore: roundScore(result.normalizedSemanticScore),
    // 正文关键词命中的出处。排序器早就把它算好挂在命中上了，只是投影层从来
    // 没有把它带出去——于是「正文里出现了这些词」这个召回理由，在返回给调用方
    // 的那一刻就丢了。与 matchedChunks 用同一套上限和截断，所以它不会把正文
    // 从后门搬回来。
    ...(Array.isArray(result.bodyEvidence) && result.bodyEvidence.length > 0
      ? {
          bodyEvidence: result.bodyEvidence
            .slice(0, HYBRID_EVIDENCE_CHUNKS)
            .map((chunk: any) => ({
              chunkId: chunk?.chunkId,
              matchedKeywords: Array.isArray(chunk?.matchedKeywords)
                ? chunk.matchedKeywords
                : [],
              occurrences: chunk?.occurrences,
              ...(chunk?.text
                ? { text: truncateEvidence(String(chunk.text)) }
                : {}),
            })),
        }
      : {}),
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
