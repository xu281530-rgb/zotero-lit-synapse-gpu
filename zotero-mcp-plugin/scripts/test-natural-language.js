/* eslint-env node */
/**
 * Regression tests for hasNaturalLanguage in the mark reader.
 *
 * That predicate is the second gate in isTranslatableBlock: a block only
 * reaches the translation LLM if, after code / math / URLs are stripped, some
 * natural-language text remains. The two failure modes are not symmetric.
 *
 *   - A false negative silently drops a block from translation, and when the
 *     cause is the writing system, it drops every block of that language.
 *   - A false positive only sends a block that did not need translating, and
 *     isTranslatableBlock still rejects it by block type for the equation /
 *     code / header cases.
 *
 * So these tests pin both directions: every writing system listed here must be
 * recognised, and the symbol, number, code and URL cases must stay rejected.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

/**
 * The nine ranges the mark reader hand-listed before Unicode script coverage
 * was fixed. Kept so the tests can assert the new rule is a superset of the old
 * one on real language, rather than a different rule that happens to pass.
 *
 * Assembled from a range table rather than written as a literal class: as a
 * literal it reads as ...ۿऀ... , where an Arabic range end is
 * followed by a Devanagari combining mark, and no-misleading-character-class
 * cannot tell that apart from a base-plus-mark pair someone meant as one
 * character. The table says what was actually intended.
 */
const LEGACY_RANGES = [
  ["0041", "005a"], // Latin, upper
  ["0061", "007a"], // Latin, lower
  ["00c0", "024f"], // Latin-1 Supplement + Latin Extended-A/B
  ["0370", "052f"], // Greek, Cyrillic, Cyrillic Supplement
  ["0600", "06ff"], // Arabic
  ["0900", "097f"], // Devanagari
  ["0e00", "0e7f"], // Thai
  ["3040", "30ff"], // Hiragana + Katakana
  ["3400", "9fff"], // CJK Extension A + CJK Unified Ideographs
  ["ac00", "d7af"], // Hangul syllables
];
const LEGACY_SCRIPT_CLASS = new RegExp(
  "[" + LEGACY_RANGES.map(([a, b]) => `\\u${a}-\\u${b}`).join("") + "]",
);

function loadMarkReaderTestExports() {
  const source = fs.readFileSync(
    new URL(
      "../addon/mark-reader/content/scripts/zotero-mark-reader.js",
      import.meta.url,
    ),
    "utf8",
  );
  const context = {
    console,
    // The file gates its internals behind this flag.
    process: { env: { ZMR_TEST: "1" } },
    Zotero: { debug() {}, logError() {} },
    Services: {},
    IOUtils: {},
    PathUtils: {},
    Components: { classes: {}, interfaces: {} },
    ZoteroMarkReader: undefined,
  };
  vm.runInNewContext(source, context, { filename: "zotero-mark-reader.js" });
  const exports = context.ZoteroMarkReader?.__test;
  assert.ok(
    exports?.hasNaturalLanguage,
    "zotero-mark-reader.js must expose hasNaturalLanguage under ZMR_TEST=1",
  );
  return exports;
}

const { hasNaturalLanguage, isTranslatableBlock } = loadMarkReaderTestExports();

/**
 * Writing systems that must be recognised. The second field is the script
 * name, used only to make a failure say which language broke.
 */
const LANGUAGES = [
  ["The alloy shows a clear twinning response.", "Latin"],
  ["La déformation est très élevée.", "Latin (accented)"],
  ["Die Grenzflächenenergie ist größer.", "Latin (umlaut)"],
  ["Cấu trúc tế vi của hợp kim.", "Latin (Vietnamese)"],
  ["Η μικροδομή του κράματος.", "Greek"],
  ["Микроструктура сплава.", "Cyrillic"],
  ["بنية السبيكة الدقيقة", "Arabic"],
  ["मिश्रधातु की सूक्ष्म संरचना", "Devanagari"],
  ["โครงสร้างจุลภาคของโลหะผสม", "Thai"],
  ["ミクロ組織はこちらです", "Kana"],
  ["合金的显微组织特征", "Han"],
  ["합금의 미세조직", "Hangul"],
  // The six that the legacy class missed, which is why this file exists.
  ["מבנה הסגסוגת", "Hebrew"],
  ["Համաձուլվածքի կառուցվածքը", "Armenian"],
  ["সংকর ধাতুর গঠন", "Bengali"],
  ["கலப்பு உலோகக் கட்டமைப்பு", "Tamil"],
  ["შენადნობის სტრუქტურა", "Georgian"],
  ["\u{20000}\u{20001}\u{2A700}", "Han (Extension B/C, astral)"],
  // Further scripts a scanned paper can plausibly contain.
  ["ሚክሮ መዋቅር", "Ethiopic"],
  ["រចនាសម្ព័ន្ធ", "Khmer"],
  ["ໂຄງສ້າງ", "Lao"],
  ["တည်ဆောက်ပုံ", "Myanmar"],
  ["ව්‍යුහය", "Sinhala"],
  ["నిర్మాణం", "Telugu"],
  ["ഘടന", "Malayalam"],
  ["ᏣᎳᎩ", "Cherokee"],
];

/**
 * Content that must NOT be treated as natural language. Every entry is free of
 * letters on purpose — a formula such as "E = mc^2" does contain Latin letters
 * and is correctly language-bearing here; equation blocks are excluded by
 * block type in isTranslatableBlock, not by this predicate.
 */
const NON_LANGUAGE = [
  ["1.23 45.6 (7) [8] 9%", "bare numbers"],
  ["--- +++ === ||| *** <<>>", "punctuation only"],
  ["12,345.67 ± 0.01", "measurement without units"],
  ["https://example.com/a/b?c=d#e", "URL only"],
  ["http://127.0.0.1:8000/api/v4/file-urls/batch", "local URL only"],
  ["```\nfor (i = 0; i < n; i++) x[i] = 0;\n```", "fenced code"],
  ["`memcpy(a, b)`", "inline code"],
  ["$$ \\gamma = \\alpha + \\beta^{2} $$", "display math"],
  ["\\[ \\sum_{i=1}^{n} x_i \\]", "bracket display math"],
  ["\\( \\theta \\)", "inline paren math"],
  ["$\\sigma_{ys}$", "inline dollar math"],
  ["( ) [ ] { } < > / \\ | @ # ^ ~", "symbol soup"],
  ["", "empty string"],
  ["   \n\t  ", "whitespace only"],
];

/**
 * Letter-category code points that exist to typeset mathematics and units
 * rather than to write a language. On their own they must not make a block
 * look translatable.
 */
const MATH_LOOKALIKES = [
  ["µ", "U+00B5 micro sign"],
  ["5 µ", "micro sign with a number"],
  ["ℓ", "U+2113 script small l"],
  ["ℏ", "U+210F planck constant"],
  // Written as escapes on purpose: these two are canonically equivalent to
  // U+00C5 and U+03A9, so an editor saving this file as NFC would silently
  // turn them into the Swedish letter and Greek omega and stop testing
  // anything.
  ["\u212B", "U+212B angstrom sign"],
  ["\u2126", "U+2126 ohm sign"],
  ["№", "U+2116 numero sign"],
  ["\u{1d434} + \u{1d435}", "U+1D400.. mathematical italic capitals"],
  ["\u{1d538} ⊗ \u{1d539}", "mathematical double-struck"],
  // Bare operators only. "a × b" is language-bearing and always was, because
  // of the Latin variable names; equation blocks are filtered by type.
  ["× ÷ ± ∑ ∫ ≈", "multiplication and division signs"],
];

let failures = 0;
const check = (label, actual, expected) => {
  if (actual === expected) return;
  failures++;
  console.error(`  FAIL ${label}: expected ${expected}, got ${actual}`);
};

console.log("hasNaturalLanguage: writing systems");
for (const [text, script] of LANGUAGES) {
  check(script, hasNaturalLanguage(text), true);
}

console.log("hasNaturalLanguage: non-language content");
for (const [text, label] of NON_LANGUAGE) {
  check(label, hasNaturalLanguage(text), false);
}

console.log("hasNaturalLanguage: mathematical letter lookalikes");
for (const [text, label] of MATH_LOOKALIKES) {
  check(label, hasNaturalLanguage(text), false);
}

console.log("hasNaturalLanguage: lookalikes do not mask real text");
// A unit or symbol sitting next to real text must not suppress the block.
check("micro sign beside Han", hasNaturalLanguage("在 5 µm 尺度上"), true);
check("angstrom beside Latin", hasNaturalLanguage("spacing of 2.5 Å here"), true);
check(
  "Swedish A-ring is a letter, not the angstrom sign",
  hasNaturalLanguage("År"),
  true,
);
check(
  "math italic beside Latin prose",
  hasNaturalLanguage("where 𝐴 denotes the area"),
  true,
);

console.log("hasNaturalLanguage: superset of the legacy behaviour on language");
// Anything the old class recognised as language must still be recognised.
for (const [text, script] of LANGUAGES) {
  if (!LEGACY_SCRIPT_CLASS.test(text)) continue;
  check(`legacy-recognised ${script}`, hasNaturalLanguage(text), true);
}

console.log("hasNaturalLanguage: input handling");
check("null", hasNaturalLanguage(null), false);
check("undefined", hasNaturalLanguage(undefined), false);
check("number input", hasNaturalLanguage(12345), false);
check("object input", hasNaturalLanguage({}), false);

console.log("isTranslatableBlock: the caller still gates on both signals");
check(
  "Hebrew paragraph is translatable",
  isTranslatableBlock({ type: "paragraph", markdown: "מבנה הסגסוגת" }),
  true,
);
check(
  "Tamil title is translatable",
  isTranslatableBlock({ type: "title", markdown: "கலப்பு உலோகம்" }),
  true,
);
check(
  "equation block stays excluded by type",
  isTranslatableBlock({ type: "equation", markdown: "The energy is E = mc^2" }),
  false,
);
check(
  "page_number block stays excluded by type",
  isTranslatableBlock({ type: "page_number", markdown: "Page 12" }),
  false,
);
check(
  "URL-only paragraph stays excluded by content",
  isTranslatableBlock({ type: "paragraph", markdown: "https://example.com/x" }),
  false,
);

if (failures) {
  console.error(`\n${failures} natural-language check(s) failed.`);
  process.exit(1);
}
console.log("\nAll natural-language detection tests passed.");
