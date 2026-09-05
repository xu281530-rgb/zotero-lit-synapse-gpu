/* eslint-env node */
/**
 * Build the keyword-scoring fixture from a COPY of the user's zotero.sqlite.
 *
 * The fixture is what makes the scoring comparison meaningful — a synthetic
 * corpus cannot tell you whether a change loses documents in YOUR library — but
 * it is also that library's titles, abstracts and author lists, so it is
 * generated locally and kept out of version control (see .gitignore).
 *
 *   node scripts/build-keyword-fixture.js --zotero <path to a COPY of zotero.sqlite>
 *
 * Copy the file first. Zotero holds a write lock on the live database while it
 * is running, and this deliberately refuses to open the original.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const source = arg("--zotero", null);
const target = path.resolve(
  rootDir,
  arg("--out", "scripts/fixtures/keyword-scoring-candidates.json"),
);

if (!source || !fs.existsSync(source)) {
  console.error(
    "Pass --zotero <path to a COPY of zotero.sqlite>.\n" +
      "Copy it while Zotero is running rather than opening the original.",
  );
  process.exit(2);
}

const db = new DatabaseSync(`file:${source.replace(/\\/g, "/")}?mode=ro`);

/** Item types that represent a document a user would search for. */
const DOCUMENT_TYPES = [
  "journalArticle",
  "conferencePaper",
  "preprint",
  "thesis",
  "book",
  "bookSection",
  "report",
  "patent",
  "document",
  "webpage",
  "blogPost",
];

const items = db
  .prepare(
    `SELECT i.itemID, i.key, i.libraryID, it.typeName
       FROM items i
       JOIN itemTypes it ON it.itemTypeID = i.itemTypeID
      WHERE i.itemID NOT IN (SELECT itemID FROM deletedItems)
        AND it.typeName IN (${DOCUMENT_TYPES.map(() => "?").join(",")})`,
  )
  .all(...DOCUMENT_TYPES);

const WANTED_FIELDS = [
  "title",
  "abstractNote",
  "publicationTitle",
  "extra",
  "date",
  "DOI",
];
const fieldIds = new Map(
  db
    .prepare("SELECT fieldID, fieldName FROM fields")
    .all()
    .filter((row) => WANTED_FIELDS.includes(row.fieldName))
    .map((row) => [row.fieldID, row.fieldName]),
);

const data = new Map();
for (const [fieldID, fieldName] of fieldIds) {
  for (const row of db
    .prepare(
      `SELECT d.itemID, v.value FROM itemData d
         JOIN itemDataValues v ON v.valueID = d.valueID
        WHERE d.fieldID = ?`,
    )
    .all(fieldID)) {
    const bucket = data.get(row.itemID) ?? {};
    bucket[fieldName] = row.value;
    data.set(row.itemID, bucket);
  }
}

const creators = new Map();
for (const row of db
  .prepare(
    `SELECT ic.itemID, c.firstName, c.lastName FROM itemCreators ic
       JOIN creators c ON c.creatorID = ic.creatorID
      ORDER BY ic.itemID, ic.orderIndex`,
  )
  .all()) {
  const list = creators.get(row.itemID) ?? [];
  list.push(`${row.firstName || ""} ${row.lastName || ""}`.trim());
  creators.set(row.itemID, list);
}

const tags = new Map();
for (const row of db
  .prepare(
    `SELECT it.itemID, t.name FROM itemTags it JOIN tags t ON t.tagID = it.tagID`,
  )
  .all()) {
  const list = tags.get(row.itemID) ?? [];
  list.push(row.name);
  tags.set(row.itemID, list);
}

const out = [];
for (const item of items) {
  const values = data.get(item.itemID) ?? {};
  // Exactly the field names runLexicalSearch hands the ranker, so the fixture
  // exercises the production shape rather than an approximation of it.
  const fields = {};
  for (const field of ["title", "abstractNote", "publicationTitle", "extra"]) {
    if (values[field]) fields[field] = values[field];
  }
  const creatorLine = (creators.get(item.itemID) ?? []).join(", ");
  if (creatorLine) fields.creator = creatorLine;
  const tagList = tags.get(item.itemID) ?? [];
  if (tagList.length > 0) fields.tags = tagList.join(", ");
  if (Object.keys(fields).length === 0) continue;

  out.push({
    key: item.key,
    libraryID: item.libraryID,
    title: fields.title ?? "",
    fields,
    metadata: {
      itemType: item.typeName,
      creators: creatorLine,
      date: (values.date ?? "").slice(0, 4),
      DOI: values.DOI ?? "",
      publicationTitle: fields.publicationTitle ?? "",
    },
  });
}

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(out), "utf8");
db.close();

console.log(
  `fixture: ${out.length} documents -> ${path.relative(rootDir, target)}`,
);
console.log(
  `  with abstract: ${out.filter((c) => c.fields.abstractNote).length}` +
    `  with tags: ${out.filter((c) => c.fields.tags).length}`,
);
console.log(
  "Next: node --experimental-strip-types scripts/compare-keyword-scoring.js --write scripts/fixtures/keyword-scoring-baseline.json",
);
