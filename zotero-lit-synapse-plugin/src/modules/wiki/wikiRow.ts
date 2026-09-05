/**
 * Reading columns off a row that `Zotero.DB.queryAsync` returned.
 *
 * Those rows are not plain objects. Zotero wraps each one in a Proxy whose
 * `get` trap calls `mozIStorageRow.getResultByName` and rethrows any failure as
 * `DB column '<name>' not found` (Zotero.DBConnection.prototype.queryAsync in
 * chrome/content/zotero/xpcom/db.js). Two consequences drive this module:
 *
 *   1. Reading a column the query did not select THROWS. It does not yield
 *      `undefined`, so it cannot be probed speculatively.
 *   2. `'col' in row` is useless as an existence test: the Proxy's `has` trap
 *      returns `!!getResultByName(name)`, which is false both for an absent
 *      column and for a column holding NULL, 0 or ''.
 *
 * The Wiki module reads rows that may come either from Zotero (snake_case
 * columns) or from a plain-object test double (either casing), so it needs a
 * lookup that tries both names. Doing that with `row[snake] ?? row[camel]` is
 * what broke: a column that EXISTS but is NULL - `wiki_pages.primary_concept_id`
 * on a page created without a primary concept, `wiki_evidence.last_verified_at`
 * on evidence awaiting reverification - short-circuits `??` into the camelCase
 * probe, and that probe is never a real column, so the read throws and takes
 * down the whole caller.
 */

/**
 * Read one property, treating "this row has no such column" as absence rather
 * than as a failure.
 *
 * Only a genuinely absent column throws here, so the catch cannot mask a NULL:
 * `getResultByName` returns `null` for SQL NULL and never throws for it.
 */
function readColumn(row: any, name: string): unknown {
  try {
    return row[name];
  } catch {
    return undefined;
  }
}

/**
 * Read a column that may be spelled `snake` (a Zotero result set) or `camel`
 * (a plain-object row), preferring the snake_case spelling.
 *
 * NULL and absent are kept distinct, which is the whole point: a Zotero row
 * yields `null` - never `undefined` - for a column it holds, so `undefined`
 * from `readColumn` means only "not a column of this row" / "not a key of this
 * object". A snake_case column that exists is therefore returned as-is, NULL
 * included, and the camelCase name is never touched. The fallback runs solely
 * when the snake_case name is genuinely absent.
 *
 * @returns the column value, `null` for SQL NULL, or `undefined` when neither
 *   spelling exists on the row.
 */
export function rowColumn(row: any, snake: string, camel: string): any {
  if (row === null || row === undefined) return undefined;
  const value = readColumn(row, snake);
  if (value !== undefined) return value;
  // Identical names mean there is no second spelling to try, and probing again
  // would only make Zotero log another "column not found" line.
  if (camel === snake) return undefined;
  return readColumn(row, camel);
}
