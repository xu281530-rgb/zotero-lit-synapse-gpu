import { getString } from "../utils/locale";

export class BasicExampleFactory {
  static registerPrefs() {
    Zotero.PreferencePanes.register({
      // Zotero would generate a random ID. A fixed one is what
      // preferencesNav.css matches on to size our sidebar icon.
      id: `${addon.data.config.addonRef}-prefpane`,
      pluginID: addon.data.config.addonID,
      src: rootURI + "content/preferences.xhtml",
      scripts: [rootURI + "mark-reader/content/preferences/preferences.js"],
      label: getString("prefs-title"),
      image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
    });
  }
}
