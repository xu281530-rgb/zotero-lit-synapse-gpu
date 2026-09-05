/**
 * 隐私工具：按 `privacy.exposeFilePaths` 偏好剥离 MCP 输出中的本机文件信息。
 *
 * 单点收口的原因：附件路径散落在 itemFormatter / fulltextService /
 * unifiedContentExtractor / searchEngine 等多个格式化器里，逐个改容易漏，
 * 而且新增字段又会重新泄漏。这里在 MCP 响应出栈前统一清洗，
 * 结构化字段与自由文本（错误信息、warning、工具正文）都覆盖。
 */

const EXPOSE_FILE_PATHS_PREF =
  "extensions.zotero.zotero-lit-synapse.privacy.exposeFilePaths";

/** 明确承载本机绝对路径的字段名，值一律被清空。 */
const PATH_KEYS = new Set([
  "path",
  "filepath",
  "fullpath",
  "localpath",
  "storagepath",
  "attachmentpath",
]);

/** 递归深度上限，避免异常结构导致栈溢出。 */
const MAX_DEPTH = 12;

const REDACTION = "[redacted-path]";

/** 路径中不会出现的终止字符，用于界定一段路径的右边界。 */
const PATH_CHARS = String.raw`[^\s"'<>|?*,;:()\[\]{}]`;
/** 允许文件名包含空格，但仍在日志/JSON 常见分隔符处停止。 */
const PATH_WITH_SPACES = String.raw`[^\r\n"'<>|?*,;:()\[\]{}]`;
/** file:// URL 内的 Windows 盘符需要冒号。 */
const FILE_URL_WITH_SPACES = String.raw`[^\r\n"'<>|?*,;()\[\]{}]`;
const FILE_EXTENSION = String.raw`\.[A-Za-z0-9]{1,8}\b`;

/**
 * 无扩展名目录没有天然右边界。只在闭引号或整段文本边界明确时匹配，
 * 避免把路径后面的普通错误说明一并隐藏。
 */
const BOUNDED_LOCAL_PATH = [
  String.raw`file:\/\/` + FILE_URL_WITH_SPACES + "+",
  String.raw`[A-Za-z]:[\\/]` + PATH_WITH_SPACES + "+",
  String.raw`\\\\` + PATH_WITH_SPACES + "+",
  String.raw`\/(?:home|Users|users|root|tmp|var|private|mnt|media|opt|srv|Volumes|data)\/` +
    PATH_WITH_SPACES +
    "+",
].join("|");

const QUOTED_LOCAL_PATH_PATTERN = new RegExp(
  String.raw`(["'])(?:` + BOUNDED_LOCAL_PATH + String.raw`)\1`,
  "g",
);
const STANDALONE_LOCAL_PATH_PATTERN = new RegExp(
  String.raw`^(?:` + BOUNDED_LOCAL_PATH + String.raw`)$`,
);

/**
 * 单遍扫描的路径识别正则。分支顺序即优先级：
 *
 * 1. `http(s)`/`ftp` URL —— 先匹配下来原样保留。放在最前面是关键：否则
 *    `https://example.com/Users/foo` 里的 `/Users/foo` 会被后面的 POSIX 分支
 *    误判成本机路径。
 * 2. `file://` URL —— 整体替换。它指向的就是本机文件，必须隐藏；单独成一支
 *    是为了避免被盘符分支从中间切开（`file:` 里的 `e:` 长得像盘符）。
 * 3. Windows 盘符绝对路径：`C:\Users\...`、`D:/Papers/test.pdf`。左侧的
 *    `(?<![A-Za-z0-9])` 保证只匹配真正的单字母盘符，不会咬进 `https:` 这类协议。
 * 4. UNC 网络路径：`\server\share\file.pdf`（两个前导反斜杠）。
 * 5. 已知系统/用户根目录下的 POSIX 绝对路径：`/home/...`、`/Users/...` 等。
 * 6. 兜底的 POSIX 绝对路径：至少两段且以扩展名结尾，形如 `/data/papers/a.pdf`。
 *    要求扩展名是为了排除 DOI（`10.1/x`，无前导斜杠）、`and/or`、`2024/01/02`。
 *
 * 5、6 两支都带 `(?<![\w.])`：路径必须真的从绝对根开始，`./docs/a.md` 和
 * `pkg/sub/a.md` 这类相对路径不是本机绝对路径，不该被动。
 */
const PATH_PATTERN = new RegExp(
  [
    // 1. 受保护的远程 URL
    String.raw`(?:https?|ftp):\/\/` + PATH_CHARS + "*",
    // 2. 带空格的本机文件路径。用扩展名作右边界，避免吞掉后续错误说明。
    String.raw`file:\/\/` + FILE_URL_WITH_SPACES + "*?" + FILE_EXTENSION,
    String.raw`(?<![A-Za-z0-9])[A-Za-z]:[\\/]` +
      PATH_WITH_SPACES +
      "*?" +
      FILE_EXTENSION,
    String.raw`\\\\` + PATH_WITH_SPACES + "*?" + FILE_EXTENSION,
    String.raw`(?<![\w.])\/(?:home|Users|users|root|tmp|var|private|mnt|media|opt|srv|Volumes|data)\/` +
      PATH_WITH_SPACES +
      "*?" +
      FILE_EXTENSION,
    // 3. 本机 file:// URL
    String.raw`file:\/\/` + PATH_CHARS + "*",
    // 4. Windows 盘符
    String.raw`(?<![A-Za-z0-9])[A-Za-z]:[\\/]` + PATH_CHARS + "*",
    // 5. UNC（正则源里的 \\ 表示两个字面反斜杠）
    String.raw`\\\\` + PATH_CHARS + "+",
    // 6. 已知 POSIX 根目录
    String.raw`(?<![\w.])\/(?:home|Users|users|root|tmp|var|private|mnt|media|opt|srv|Volumes|data)\/` +
      PATH_CHARS +
      "*",
    // 7. 兜底：/a/b.ext
    String.raw`(?<![\w.])\/(?:` + PATH_CHARS + String.raw`+\/)+` + PATH_CHARS +
      String.raw`+\.[A-Za-z0-9]{1,8}\b`,
  ].join("|"),
  "g",
);

/** 相邻的多个替换标记合并成一个，避免出现 `[redacted-path][redacted-path]`。 */
const COLLAPSE_PATTERN = /(?:\[redacted-path\])+/g;

const REMOTE_URL_PATTERN = /^(?:https?|ftp):\/\//i;

/**
 * 是否允许在输出中返回本机文件路径。默认（偏好缺失时）为不允许，
 * 与 addon/prefs.js 中 `privacy.exposeFilePaths = false` 一致。
 */
export function areFilePathsExposed(): boolean {
  try {
    return Zotero.Prefs.get(EXPOSE_FILE_PATHS_PREF, true) === true;
  } catch {
    return false;
  }
}

function getDataDirectory(): string {
  try {
    return Zotero.DataDirectory?.dir || "";
  } catch {
    return "";
  }
}

/**
 * 抹掉一段文本里的本机绝对路径，保留远程 URL 与其余内容。
 *
 * 先按数据目录做一次字面替换，再跑通用识别：前者能命中数据目录本身
 * （`/home/u/Zotero` 这种没有扩展名、也可能不在已知根目录下的情况），
 * 后者负责用户传入的任意路径与系统临时目录。
 */
export function redactAbsolutePaths(value: string, dataDir?: string): string {
  if (!value) return value;

  let text = value;
  const directory = dataDir ?? getDataDirectory();
  if (directory && text.includes(directory)) {
    text = text.split(directory).join(REDACTION);
  }
  if (directory && directory.includes("\\")) {
    // 错误信息里同一路径有时以正斜杠形式出现。
    const alternate = directory.split("\\").join("/");
    if (text.includes(alternate)) text = text.split(alternate).join(REDACTION);
  }

  text = text.replace(QUOTED_LOCAL_PATH_PATTERN, (_match, quote: string) =>
    `${quote}${REDACTION}${quote}`,
  );
  if (STANDALONE_LOCAL_PATH_PATTERN.test(text)) return REDACTION;

  text = text.replace(PATH_PATTERN, (match) =>
    REMOTE_URL_PATTERN.test(match) ? match : REDACTION,
  );
  return text.replace(COLLAPSE_PATTERN, REDACTION);
}

/**
 * 只做结构化字段清理，不碰字符串内容。
 *
 * 供 tools/call 在把结果序列化进 `content[0].text` 之前调用：一旦序列化成
 * 字符串，按字段名清空就无从下手了。字符串级脱敏留给出口处的
 * {@link sanitizeForPrivacy} 统一做一遍，避免大文本被扫描两次。
 */
export function scrubPathFields<T>(result: T): T {
  if (areFilePathsExposed()) return result;
  return walk(result, undefined, 0) as T;
}

/**
 * 完整清洗：结构化字段 + 所有字符串中的绝对路径。
 * 用于 MCP 响应的最终出口，覆盖 result、error.message、error.data、
 * warnings、工具正文等一切会送到客户端的内容。
 */
export function sanitizeForPrivacy<T>(value: T): T {
  if (areFilePathsExposed()) return value;
  return walk(value, getDataDirectory(), 0) as T;
}

/**
 * 为日志描述敏感文本，只保留定位分帧问题所需的长度。
 * 不返回头尾片段，因为 MCP 参数可能包含检索词、笔记正文或本机路径。
 */
export function describePrivateText(value: string): string {
  return `${value.length} chars; content omitted`;
}

/**
 * 就地遍历。`dataDir` 为 undefined 时只清字段、不动字符串。
 */
function walk(value: unknown, dataDir: string | undefined, depth: number): unknown {
  if (depth > MAX_DEPTH) return value;

  if (typeof value === "string") {
    return dataDir === undefined ? value : redactAbsolutePaths(value, dataDir);
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = walk(value[index], dataDir, depth + 1);
    }
    return value;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (PATH_KEYS.has(key.toLowerCase())) {
        // 只清空字符串路径，保留字段本身，避免调用方读取 undefined 报错。
        if (typeof record[key] === "string") record[key] = "";
        continue;
      }
      record[key] = walk(record[key], dataDir, depth + 1);
    }
    return record;
  }

  return value;
}
