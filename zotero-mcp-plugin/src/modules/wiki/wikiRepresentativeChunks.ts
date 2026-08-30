/**
 * 从一篇文献里挑出最多 20 个「代表性 chunk」，作为全库粗召回的查询向量。
 *
 * 为什么必须是「一次挑 20 个」而不是「分批扫十次」：`MAX_SIMILAR_QUERY_CHUNKS = 20`
 * 限制的不是一次调用的礼貌上限，而是成本本身——每多一个 query chunk，全库向量就
 * 要重新参与一次打分。把 186 个 chunk 分成 10 批连续调用十次全库扫描，形式上每次
 * 都没超过 20，实质上是把护栏绕过去了，而且还多付了十遍 SQL 读取和 Int8 解码。
 * 所以选择在这里发生，一篇文献只选一次。
 *
 *     R = min(20, max(12, ceil(sqrt(totalChunks))))
 *     totalChunks < 12 时用全部 chunk
 *
 * 选出来的这 R 段要能代表整篇论文，而不是代表论文的开头。四条规则同时起作用：
 *
 *   1. **位置覆盖**。正文按阅读顺序切成 R 个区间，每个区间至少出一个代表。没有
 *      这一条，向量聚类会把整篇论文压缩成它最同质的那一部分——通常是引言。
 *   2. **向量代表性**。区间内选最接近该区间向量质心的那一段（medoid），而不是
 *      选第一段。质心是这一节「在讲什么」的最好单点近似。
 *   3. **全局多样性**。位置覆盖用满之后如果还有余额，用 farthest-point 补，
 *      优先补上与已选集合最不像的段落，把论文里另起炉灶的话题捞回来。
 *   4. **噪声与相邻去重**。参考文献、致谢、样品制备套话这类段落，与全库任何一篇
 *      论文都像，作为查询向量只会把整个库召回一遍；相邻的高度相似段落同时入选
 *      则是白白浪费一个 query 名额。两者都在这里剔除。
 *
 * 选择器有版本号，且版本号会写进候选记录。选择规则一改，旧候选的「依据」就不再
 * 成立，必须重算——不写版本号就没有任何东西能发现这件事。
 *
 * 纯函数、无 Zotero 依赖，可以直接在 Node 下跑单测。
 */

/** 选择器版本。规则改动必须同时改这里，否则旧候选无法被识别为需要重算。 */
export const REPRESENTATIVE_SELECTOR_VERSION = "repr-v1";

/** 一次全库粗召回允许的 query chunk 上限，与 MAX_SIMILAR_QUERY_CHUNKS 一致。 */
export const MAX_REPRESENTATIVE_CHUNKS = 20;

/** 低于此数直接全取：分层已经没有意义。 */
export const MIN_REPRESENTATIVE_CHUNKS = 12;

export interface RepresentativeChunkInput {
  chunkId: number;
  /** 正文顺序。调用方按 chunkId 升序给出即可。 */
  text: string;
  vector: Float32Array | null;
}

export interface RepresentativeSelection {
  chunkIds: number[];
  selectorVersion: string;
  /** 代表集指纹：选中的 chunk 及其顺序变了，这个值就变。 */
  signature: string;
  /** 被判为模板/参考文献而排除的段落数，用于诊断。 */
  excludedBoilerplate: number;
  /** 与已选段落过于相似而被跳过的段落数。 */
  excludedNeighbours: number;
}

/**
 * 明显不承载本文观点的段落。
 *
 * 只匹配「整段就是这种东西」的强信号，不做启发式猜测：漏掉一段模板文字的代价是
 * 一个 query 名额，误删一段正文的代价是这篇论文的某个主题永远召不回来。
 */
// `\b` is a Latin word boundary and does not exist between Han characters, so
// the Chinese headings are matched without it. An earlier version used `\b`
// throughout and silently excluded nothing in Chinese - which is the half of
// the library this plugin is mostly used on.
const BOILERPLATE_PATTERNS: RegExp[] = [
  /^\s*(references|bibliography)\b/iu,
  /^\s*(参考文献|引用文献)/u,
  /^\s*acknowledg(e)?ments?\b/iu,
  /^\s*(致谢|鸣谢)/u,
  /^\s*(conflicts? of interest|declaration of competing interest)\b/iu,
  /^\s*利益冲突/u,
  /^\s*funding\b/iu,
  /^\s*(资助|基金项目)/u,
  /^\s*author contributions?\b/iu,
  /^\s*作者贡献/u,
  /^\s*(supplementary|supporting information)\b/iu,
  /^\s*附录/u,
  /^\s*data availability\b/iu,
  /^\s*数据可用性/u,
];

/** 参考文献段落的形状：大量 [1] / (2019) / et al. 而几乎没有句子。 */
function looksLikeReferenceList(text: string): boolean {
  const brackets = (text.match(/\[\d{1,3}\]/gu) ?? []).length;
  const years = (text.match(/\(?(19|20)\d{2}[)a-z]?/gu) ?? []).length;
  const etAl = (text.match(/et al\.?/giu) ?? []).length;
  const length = Math.max(1, text.length);
  return (brackets >= 5 && brackets / (length / 200) >= 3) || (years >= 6 && etAl >= 3);
}

export function isBoilerplateChunk(text: string): boolean {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return true;
  if (BOILERPLATE_PATTERNS.some((pattern) => pattern.test(trimmed))) return true;
  return looksLikeReferenceList(trimmed);
}

/** 目标代表数。见文件头的公式。 */
export function representativeTarget(totalChunks: number): number {
  if (totalChunks <= 0) return 0;
  if (totalChunks < MIN_REPRESENTATIVE_CHUNKS) return totalChunks;
  return Math.min(
    MAX_REPRESENTATIVE_CHUNKS,
    Math.max(MIN_REPRESENTATIVE_CHUNKS, Math.ceil(Math.sqrt(totalChunks))),
  );
}

function dot(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) sum += a[index] * b[index];
  return sum;
}

function norm(vector: Float32Array): number {
  return Math.sqrt(dot(vector, vector)) || 1;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  return dot(a, b) / (norm(a) * norm(b));
}

/** 区间内离质心最近的一段。没有向量时退化为取中间一段。 */
function medoid(
  members: RepresentativeChunkInput[],
): RepresentativeChunkInput | null {
  if (!members.length) return null;
  const vectors = members.filter((member) => member.vector);
  if (vectors.length < 2) {
    return members[Math.floor(members.length / 2)];
  }
  const dimensions = vectors[0].vector!.length;
  const centre = new Float32Array(dimensions);
  for (const member of vectors) {
    const vector = member.vector!;
    for (let index = 0; index < dimensions && index < vector.length; index += 1) {
      centre[index] += vector[index];
    }
  }
  for (let index = 0; index < dimensions; index += 1) {
    centre[index] /= vectors.length;
  }
  let best: { member: RepresentativeChunkInput; score: number } | null = null;
  for (const member of vectors) {
    const score = cosine(centre, member.vector!);
    if (!best || score > best.score) best = { member, score };
  }
  return best ? best.member : members[Math.floor(members.length / 2)];
}

/** 与已选集合的最大相似度。用于相邻去重和 farthest-point 补位。 */
function maxSimilarityTo(
  candidate: RepresentativeChunkInput,
  chosen: RepresentativeChunkInput[],
): number {
  if (!candidate.vector) return 0;
  let best = -1;
  for (const member of chosen) {
    if (!member.vector) continue;
    const score = cosine(candidate.vector, member.vector);
    if (score > best) best = score;
  }
  return best < 0 ? 0 : best;
}

export interface RepresentativeOptions {
  /** 与已选段落相似度超过此值的候选不再入选。 */
  neighbourSimilarity?: number;
}

/** 相邻去重阈值。两段几乎同义时，第二段不值得一个 query 名额。 */
export const NEIGHBOUR_SIMILARITY = 0.94;

export function selectRepresentativeChunks(
  chunks: readonly RepresentativeChunkInput[],
  options: RepresentativeOptions = {},
): RepresentativeSelection {
  const neighbourSimilarity =
    options.neighbourSimilarity ?? NEIGHBOUR_SIMILARITY;
  const ordered = chunks.slice();

  const usable = ordered.filter((chunk) => !isBoilerplateChunk(chunk.text));
  const excludedBoilerplate = ordered.length - usable.length;
  // 全篇都是模板的极端情况：与其返回空集让这篇文献永远没有候选，不如退回原始
  // 段落——「这篇文献的正文抽取有问题」是另一个层面的故障，不该在这里被吞掉。
  const pool = usable.length ? usable : ordered;

  const target = representativeTarget(pool.length);
  if (target <= 0) {
    return {
      chunkIds: [],
      selectorVersion: REPRESENTATIVE_SELECTOR_VERSION,
      signature: "",
      excludedBoilerplate,
      excludedNeighbours: 0,
    };
  }
  if (pool.length <= target) {
    return finish(pool, excludedBoilerplate, 0);
  }

  // ---- 1 & 2. 位置分层 + 区间 medoid ------------------------------------
  const chosen: RepresentativeChunkInput[] = [];
  const taken = new Set<number>();
  let excludedNeighbours = 0;
  for (let band = 0; band < target; band += 1) {
    const from = Math.floor((band * pool.length) / target);
    const to = Math.max(from + 1, Math.floor(((band + 1) * pool.length) / target));
    const members = pool.slice(from, to).filter((chunk) => !taken.has(chunk.chunkId));
    const pick = medoid(members);
    if (!pick) continue;
    // 相邻去重：与已选段落几乎同义的代表不占名额，留给后面的多样性补位。
    if (chosen.length && maxSimilarityTo(pick, chosen) >= neighbourSimilarity) {
      excludedNeighbours += 1;
      continue;
    }
    chosen.push(pick);
    taken.add(pick.chunkId);
  }

  // ---- 3. farthest-point 补位 -------------------------------------------
  while (chosen.length < target) {
    let best: { chunk: RepresentativeChunkInput; distance: number } | null = null;
    for (const chunk of pool) {
      if (taken.has(chunk.chunkId)) continue;
      const similarity = maxSimilarityTo(chunk, chosen);
      if (similarity >= neighbourSimilarity) continue;
      const distance = 1 - similarity;
      if (!best || distance > best.distance) best = { chunk, distance };
    }
    if (!best) break;
    chosen.push(best.chunk);
    taken.add(best.chunk.chunkId);
  }

  return finish(chosen, excludedBoilerplate, excludedNeighbours);

  function finish(
    picked: readonly RepresentativeChunkInput[],
    boilerplate: number,
    neighbours: number,
  ): RepresentativeSelection {
    // 按正文顺序返回，让同一篇文献的两次选择给出同一个 signature。
    const chunkIds = picked
      .map((chunk) => chunk.chunkId)
      .sort((left, right) => left - right);
    return {
      chunkIds,
      selectorVersion: REPRESENTATIVE_SELECTOR_VERSION,
      signature: `${REPRESENTATIVE_SELECTOR_VERSION}:${chunkIds.join(",")}`,
      excludedBoilerplate: boilerplate,
      excludedNeighbours: neighbours,
    };
  }
}
