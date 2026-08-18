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
