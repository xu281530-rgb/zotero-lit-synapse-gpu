declare let Zotero: any;
declare let ztoolkit: ZToolkit;

const PREF_PREFIX = 'extensions.zotero.zotero-mcp-plugin.';

export const DEPRECATED_CONTENT_PREF_KEYS = [
  'ai.maxTokens',
  'content.mode',
  'custom.maxContentLength',
  'custom.maxAttachments',
  'custom.maxNotes',
  'custom.keywordCount',
  'custom.smartTruncateLength',
  'custom.searchItemLimit',
  'custom.maxAnnotationsPerRequest',
  'custom.includeWebpage',
  'custom.enableCompression',
  'ui.includeMetadata',
  'text.preserveFormatting',
  'text.preserveHeadings',
  'text.preserveLists',
  'text.preserveEmphasis',
] as const;

/** Remove preferences retired with the configurable content-mode system. */
export function clearDeprecatedContentSettings(): void {
  for (const key of DEPRECATED_CONTENT_PREF_KEYS) {
    const prefKey = `${PREF_PREFIX}${key}`;
    try {
      Zotero.Prefs.clear(prefKey, true);
    } catch (error) {
      ztoolkit.log(
        `[DeprecatedContentSettings] Could not clear ${prefKey}: ${error}`,
        'warn',
      );
    }
  }
}
