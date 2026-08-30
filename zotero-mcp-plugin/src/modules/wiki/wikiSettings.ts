declare const Zotero: any;

const PREFIX = "extensions.zotero.zotero-mcp-plugin.wiki.";

export interface WikiSettings {
  enabled: boolean;
  autoWrite: boolean;
  writeMode: "confirm" | "auto";
  shadowMode: boolean;
  minScore: number;
  rrfWeight: number;
  searchTimeoutMs: number;
}

export const WIKI_SETTING_DEFAULTS: WikiSettings = {
  enabled: true,
  autoWrite: false,
  writeMode: "confirm",
  shadowMode: true,
  // Deliberately uncalibrated. Shadow telemetry must establish these before
  // Wiki is allowed to affect production ordering.
  minScore: 0,
  rrfWeight: 0,
  searchTimeoutMs: 5000,
};

function read(key: string): unknown {
  try {
    return Zotero.Prefs.get(PREFIX + key, true);
  } catch {
    return undefined;
  }
}

function numeric(
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = read(key);
  const parsed = typeof raw === "string" ? Number(raw) : raw;
  return typeof parsed === "number" && Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, parsed))
    : fallback;
}

export function getWikiSettings(): WikiSettings {
  const mode = String(read("writeMode") ?? WIKI_SETTING_DEFAULTS.writeMode);
  return {
    enabled: read("enabled") !== false,
    autoWrite: read("autoWrite") === true,
    writeMode: mode === "auto" ? "auto" : "confirm",
    shadowMode: read("shadowMode") !== false,
    minScore: numeric("minScore", WIKI_SETTING_DEFAULTS.minScore, 0, 1),
    rrfWeight: numeric("rrfWeight", WIKI_SETTING_DEFAULTS.rrfWeight, 0, 10),
    searchTimeoutMs: Math.round(
      numeric(
        "searchTimeoutMs",
        WIKI_SETTING_DEFAULTS.searchTimeoutMs,
        100,
        60000,
      ),
    ),
  };
}

/**
 * 一次问答式阅读要多像已有笔记，才算「没说新东西」。
 *
 * 只在一种情形下用到：这篇文献的笔记已经写过全文总结，因此无法再追加记录，服务端
 * 必须决定是另起一份笔记，还是这一轮根本不值得留下笔记。比较的是**本轮记录的内容**
 * 与**笔记中关于同一批 chunk 的既有论述**，不是 chunk 有没有读过——按 chunk 判定会
 * 在第一个新 chunk 上就另起一份，而一份每读一段就新建的笔记永远攒不满一篇论文的
 * 阅读量，也就永远等不到它的总结。
 *
 * 阈值定得高：只有几乎在复述既有结论才算不值得记，稍有差异就另起一份。两个方向的
 * 错误代价不对称——判宽了多一份大体重复的笔记，人看得见也可以忽略；判严了是把一次
 * 真实阅读悄悄丢掉。所以默认 0.92，并且比较失败时一律另起。
 *
 * 与 wiki.link.* 那批一样，**未经真实库校准**。
 */
export function getWikiNoteEpisodeSimilarity(): number {
  return numeric("note.episodeSimilarity", 0.92, 0, 1);
}
