// @ts-check Let TS check this config file

import zotero from "@zotero-plugin/eslint-config";
import globals from "globals";

/**
 * Gecko/Zotero globals available to any script running with the system
 * principal. Deliberately limited to the names the addon scripts collectively
 * use, so a misspelled identifier still fails `no-undef` instead of being
 * waved through. Not split further per file: all six genuinely exist in all
 * three contexts below, and narrowing to per-file usage would turn the next
 * legitimate call into a false positive.
 *
 * Each one is a real platform global, not a convenience:
 *   ChromeUtils  zotero-types/types/gecko.d.ts
 *   IOUtils      zotero-types/types/gecko/generated/lib.gecko.dom.d.ts
 *   PathUtils    zotero-types/types/gecko/generated/lib.gecko.dom.d.ts
 *   Services     zotero-types/types/gecko/index.d.ts (`const Services`)
 *   Components   classic XPCOM global; used here only as
 *                Components.classes / Components.interfaces
 *   Zotero       Zotero's own application global
 */
const geckoPrivilegedGlobals = {
  ChromeUtils: "readonly",
  Components: "readonly",
  IOUtils: "readonly",
  PathUtils: "readonly",
  Services: "readonly",
  Zotero: "readonly",
};

export default zotero({
  overrides: [
    {
      files: ["**/*.ts"],
      rules: {
        // We disable this rule here because the template
        // contains some unused examples and variables
        "@typescript-eslint/no-unused-vars": "off",

        // All require() calls in src/ are *deliberate* lazy loads placed inside
        // function bodies, never at module top level:
        //   - hooks.ts shutdown path must not pull semantic/vector modules into
        //     the eager import graph at startup;
        //   - preferenceScript.ts / semanticIndexColumn.ts load the vector store
        //     and GPU service only when the prefs pane / item tree column is
        //     actually used;
        //   - several of them also break import cycles.
        // Rewriting them as static `import` would change module init order, and
        // `await import()` would make sync shutdown/column paths async. esbuild
        // resolves and bundles these require() calls, so they work as-is.
        "@typescript-eslint/no-require-imports": "off",
      },
    },
    {
      files: ["scripts/**/*.js", "scripts/**/*.mjs"],
      languageOptions: {
        globals: {
          ...globals.node,
        },
      },
    },

    // ---------------------------------------------------------------------
    // addon/mark-reader/** — three files, three different runtime contexts.
    //
    // All three are *classic* scripts, never ES modules: none contains an
    // import/export statement, translation-task.xhtml loads its script with a
    // plain <script src> (no type="module") and then calls into it from an
    // onload="" attribute, which only resolves if the script's top-level `var`
    // became a window property. Declaring sourceType here is therefore a
    // correction, not a workaround — under the inherited "module" setting the
    // top-level bindings these files rely on would not exist at runtime.
    //
    // Globals are granted per context rather than once for the directory, so
    // each file is checked against what its own scope actually provides.
    // ---------------------------------------------------------------------

    {
      // Loaded by addon/bootstrap.js via Services.scriptloader.loadSubScript,
      // i.e. into the bootstrap scope — a privileged sandbox, NOT a window.
      // window/document are withheld on purpose: neither exists here, and a
      // bare reference to either would be a genuine bug worth failing on.
      files: ["addon/mark-reader/content/scripts/*.js"],
      languageOptions: {
        sourceType: "script",
        globals: {
          ...geckoPrivilegedGlobals,
          // Provided by the bootstrap sandbox (wantGlobalProperties), and each
          // one is used by this file.
          AbortController: "readonly",
          TextDecoder: "readonly",
          TextEncoder: "readonly",
          clearTimeout: "readonly",
          fetch: "readonly",
          setTimeout: "readonly",
          // bootstrap.js declares `var ZoteroMarkReader;` and this subscript
          // assigns it to hand the module back — bootstrap then throws if the
          // assignment did not happen. Writable, because that assignment is
          // the documented handshake between the two files.
          ZoteroMarkReader: "writable",
        },
      },
    },

    {
      // Window script for translation-task.xhtml: a real chrome window, so it
      // has the full DOM surface on top of the privileged globals.
      files: ["addon/mark-reader/content/*.js"],
      languageOptions: {
        sourceType: "script",
        globals: {
          ...globals.browser,
          ...geckoPrivilegedGlobals,
        },
      },
    },

    {
      // Zotero preference pane script, injected into Zotero's own preferences
      // window — same DOM surface, plus that window's Zotero_Preferences
      // object, which this file registers itself on.
      files: ["addon/mark-reader/content/preferences/*.js"],
      languageOptions: {
        sourceType: "script",
        globals: {
          ...globals.browser,
          ...geckoPrivilegedGlobals,
          Zotero_Preferences: "readonly",
        },
      },
    },
  ],
});
