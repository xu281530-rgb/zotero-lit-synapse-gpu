/* eslint-env node */

import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const { assembleStructuredDocument, selectStructuredSource } = await import(
  "../src/modules/mineru/structuredDocumentAssembler.ts"
);

const artifactRoot = path.resolve(process.argv[2] || ".tmp-mineru-live");
const zoteroStorage = path.resolve(
  process.argv[3] || "D:/BaiduSyncdisk/ZoteroFile/storage",
);
const keys = process.argv.slice(4);
if (!keys.length) {
  throw new Error("Pass one or more Zotero attachment keys");
}

async function walk(dir) {
  const files = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(fullPath)));
    else files.push(fullPath);
  }
  return files;
}

function canonicalText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function ngrams(value, width = 5) {
  const text = canonicalText(value);
  const result = new Set();
  for (let index = 0; index + width <= text.length; index += 1) {
    result.add(text.slice(index, index + width));
  }
  return result;
}

function overlap(source, target) {
  const sourceGrams = ngrams(source);
  const targetGrams = ngrams(target);
  let common = 0;
  for (const gram of sourceGrams) {
    if (targetGrams.has(gram)) common += 1;
  }
  return sourceGrams.size ? common / sourceGrams.size : 0;
}

function significantLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => canonicalText(line).length >= 45);
}

function unmatchedExamples(source, target, limit = 5) {
  const targetText = canonicalText(target);
  const seen = new Set();
  const examples = [];
  for (const line of significantLines(source)) {
    const normalized = canonicalText(line);
    const probe = normalized.slice(0, Math.min(50, normalized.length));
    if (!probe || targetText.includes(probe) || seen.has(probe)) continue;
    seen.add(probe);
    examples.push(line.slice(0, 180));
    if (examples.length >= limit) break;
  }
  return examples;
}

function extractPDFText(pdfPath) {
  const result = spawnSync(
    "pdftotext",
    ["-enc", "UTF-8", "-layout", pdfPath, "-"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || `pdftotext failed for ${pdfPath}`);
  }
  return result.stdout;
}

for (const key of keys) {
  const artifactDir = path.join(artifactRoot, key);
  const artifactFiles = await walk(artifactDir);
  const jsonFiles = artifactFiles.filter((file) => file.endsWith(".json"));
  const structuredFiles = Object.fromEntries(
    await Promise.all(
      jsonFiles.map(async (file) => [
        path.relative(artifactDir, file).replaceAll(path.sep, "/"),
        await fs.readFile(file, "utf8"),
      ]),
    ),
  );
  const source = selectStructuredSource(structuredFiles);
  const assembled = assembleStructuredDocument(source);
  const storageDir = path.join(zoteroStorage, key);
  const storageFiles = await walk(storageDir);
  const pdfPath = storageFiles.find((file) => file.toLowerCase().endsWith(".pdf"));
  if (!pdfPath) throw new Error(`No local PDF for ${key}`);
  const pdfText = extractPDFText(pdfPath);
  const zoteroCachePath = storageFiles.find(
    (file) => path.basename(file) === ".zotero-ft-cache",
  );
  const zoteroText = zoteroCachePath
    ? await fs.readFile(zoteroCachePath, "utf8")
    : "";
  const markdownPath = path.join(artifactRoot, `${key}.assembled.md`);
  await fs.writeFile(markdownPath, assembled.markdown, "utf8");

  const report = {
    attachmentKey: key,
    pdf: path.basename(pdfPath),
    structuredFormat: source.format,
    parserVersion: source.parserVersion,
    markdownChars: assembled.markdown.length,
    pdfTextChars: pdfText.length,
    zoteroCacheChars: zoteroText.length,
    pdfFiveGramRecallInMarkdown: Number(overlap(pdfText, assembled.markdown).toFixed(4)),
    markdownFiveGramPrecisionAgainstPDF: Number(overlap(assembled.markdown, pdfText).toFixed(4)),
    zoteroFiveGramRecallInMarkdown: Number(overlap(zoteroText, assembled.markdown).toFixed(4)),
    headings: (assembled.markdown.match(/^#{1,6} /gm) || []).length,
    displayEquations: (assembled.markdown.match(/^\$\$/gm) || []).length,
    gfmTableRows: (assembled.markdown.match(/^\|.*\|$/gm) || []).length,
    imageReferences: (assembled.markdown.match(/!\[[^\]]*\]\([^)]*\)|<img\b/gi) || []).length,
    pdfOnlyExamples: unmatchedExamples(pdfText, assembled.markdown),
    markdownOnlyExamples: unmatchedExamples(assembled.markdown, pdfText),
    markdownPath,
  };
  console.log(JSON.stringify(report, null, 2));
}
