/* eslint-env node */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const prefPrefix = "extensions.zotero.zotero-lit-synapse.mineru.";
const customLocalURL = "http://127.0.0.1:18101";

function createControl(value = "") {
  return {
    value,
    checked: false,
    disabled: false,
    hidden: false,
    placeholder: "",
    style: {},
    dataset: {},
    classList: { toggle() {} },
    listeners: {},
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
    getAttribute(name) {
      return this.attributes?.[name] ?? null;
    },
    setAttribute(name, value) {
      this.attributes ||= {};
      this.attributes[name] = value;
    },
  };
}

function createPrefs() {
  const values = new Map([
    [prefPrefix + "mode", "local"],
    [prefPrefix + "baseURL", customLocalURL],
    [prefPrefix + "modelVersion", "vlm"],
  ]);
  return {
    get(key) {
      return values.get(key);
    },
    set(key, value) {
      values.set(key, value);
    },
  };
}

function loadMainMinerUBinder(context) {
  const source = fs.readFileSync(
    new URL("../src/modules/preferenceScript.ts", import.meta.url),
    "utf8",
  );
  const compiled = ts.transpileModule(
    source +
      String.fromCharCode(10) +
      "globalThis.__bindMinerUSettings = bindMinerUSettings;",
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  vm.runInNewContext(compiled, context, {
    filename: "preferenceScript.ts",
  });
  return context.__bindMinerUSettings;
}

function testMainPreferencesPreserveCustomURL() {
  const prefs = createPrefs();
  const controls = {
    "#zotero-prefpane-zotero-lit-synapse-mineru-mode": createControl(),
    "#zotero-prefpane-zotero-lit-synapse-mineru-base-url": createControl(),
    "#zotero-prefpane-zotero-lit-synapse-mineru-model-version":
      createControl("vlm"),
  };
  const doc = {
    querySelector(selector) {
      return controls[selector] ?? null;
    },
  };
  const context = {
    console,
    exports: {},
    require(moduleName) {
      if (moduleName.endsWith("package.json")) {
        return { config: { addonRef: "zotero-lit-synapse" } };
      }
      if (moduleName.endsWith("/locale")) {
        return { getString: (key) => key };
      }
      if (moduleName.endsWith("/security")) {
        return { generateSecureIdentifier: () => "" };
      }
      if (moduleName.endsWith("/hooks")) {
        return { trackedSetTimeout() {} };
      }
      return {};
    },
    Zotero: { Prefs: prefs },
    config: { addonRef: "zotero-lit-synapse" },
    getString: (key) => key,
    ztoolkit: { log() {} },
  };

  loadMainMinerUBinder(context)(doc);

  assert.equal(prefs.get(prefPrefix + "baseURL"), customLocalURL);
  assert.equal(
    controls["#zotero-prefpane-zotero-lit-synapse-mineru-base-url"].value,
    customLocalURL,
  );
}

function testReaderPreferencesPreserveCustomURL() {
  const prefs = createPrefs();
  const mode = createControl();
  const baseURL = createControl();
  const validateButton = createControl();
  const status = createControl();
  const controls = {
    "#zmr-mineru-mode": mode,
    "#zmr-mineru-base-url": baseURL,
    "#zmr-mineru-validate": validateButton,
    "#zmr-mineru-validation-status": status,
  };
  const root = {
    querySelector(selector) {
      return controls[selector] ?? null;
    },
    querySelectorAll() {
      return [];
    },
    ownerGlobal: { setTimeout() {} },
  };
  const context = {
    console,
    ChromeUtils: { importESModule: () => ({}) },
    Zotero: { Prefs: prefs },
  };
  const source = fs.readFileSync(
    new URL(
      "../addon/mark-reader/content/preferences/preferences.js",
      import.meta.url,
    ),
    "utf8",
  );
  vm.runInNewContext(
    source +
      String.fromCharCode(10) +
      "globalThis.__preferences = ZoteroMarkReaderPreferences;",
    context,
    { filename: "preferences.js" },
  );

  context.__preferences.initMinerU(root);

  assert.equal(prefs.get(prefPrefix + "baseURL"), customLocalURL);
  assert.equal(baseURL.value, customLocalURL);
}

testMainPreferencesPreserveCustomURL();
testReaderPreferencesPreserveCustomURL();
console.log("MinerU custom base URL survives preference initialization");
