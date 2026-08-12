import { getString } from "../utils/locale";

export class BasicExampleFactory {
  static registerPrefs() {
    Zotero.PreferencePanes.register({
      pluginID: addon.data.config.addonID,
      src: rootURI + "content/preferences.xhtml",
      scripts: [rootURI + "mark-reader/content/preferences/preferences.js"],
      label: getString("prefs-title"),
      image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
    });
  }
}
