/* eslint-env node */

/**
 * A faithful port of `Zotero.DBConnection.prototype.parseQueryAndParams`
 * (chrome/content/zotero/xpcom/db.js), for use by test database adapters.
 *
 * Test adapters hand parameters straight to node:sqlite, which accepts null,
 * undefined and booleans without complaint. Zotero does not, and the gap is not
 * cosmetic: `wiki_commit` shipped a statement that threw
 * "Null parameter provided for a query without placeholders" on every fully
 * read paper, and every test passed because node:sqlite bound the null happily.
 *
 * The subtle rule this reproduces - and the one that caused that bug - is how
 * Zotero finds placeholders when it has to hard-code a NULL:
 *
 *     let placeholderRE = /\s*[=,(]\s*\?/g;
 *
 * A `?` counts only when preceded by '=', ',' or '('. A `?` anywhere else -
 * after WHEN, after LIMIT, after a comparison operator - is INVISIBLE to this
 * scan. The scan is advanced once per bound parameter regardless, so binding a
 * NULL at or after an invisible placeholder runs it off the end of the matches
 * and throws. A non-null parameter never consults the scan, which is why such a
 * statement can work for months and then fail on the first null.
 *
 * Passing every test query through this makes those rules apply in tests too.
 */

/**
 * @param {string} sql
 * @param {unknown[]|unknown} params
 * @returns {[string, unknown[]]} the rewritten SQL and the surviving parameters
 * @throws the same errors Zotero throws, with the same messages
 */
export function parseQueryAndParams(sql, params) {
  if (params === undefined || params === null) params = [];
  if (!Array.isArray(params)) params = [params];
  else params = params.slice();

  if (params.length) {
    const queryMethod = sql.match(/^[^\s(]*/)[0].toLowerCase();
    const placeholderRE = /\s*[=,(]\s*\?/g;
    let matches;
    for (let i = 0; i < params.length; i++) {
      matches = placeholderRE.exec(sql);

      if (typeof params[i] === "boolean") {
        throw new Error(
          `Invalid boolean parameter ${i} '${params[i]}' [QUERY: ${sql}]`,
        );
      }
      if (params[i] === undefined) {
        throw new Error(`Parameter ${i} is undefined [QUERY: ${sql}]`);
      }
      if (params[i] !== null) continue;

      if (!matches) {
        throw new Error(
          "Null parameter provided for a query without placeholders " +
            `-- use false or undefined [QUERY: ${sql}]`,
        );
      }
      let repl;
      if (matches[0].trim().indexOf("=") === -1) {
        if (queryMethod === "select") {
          throw new Error(
            `NULL cannot be used for parenthesized placeholders in SELECT queries [QUERY: ${sql}]`,
          );
        }
        repl = matches[0].replace("?", "NULL");
      } else if (queryMethod === "select") {
        repl = " IS NULL";
      } else {
        repl = "=NULL";
      }
      sql =
        sql.substring(0, matches.index) +
        repl +
        sql.substr(matches.index + matches[0].length);
      params.splice(i, 1);
      i--;
    }
  } else if (/\?/g.test(sql)) {
    throw new Error(
      `Parameters not provided for query containing placeholders [QUERY: ${sql}]`,
    );
  }
  return [sql, params];
}

/**
 * Report placeholders Zotero's NULL rewriter cannot see.
 *
 * Only these positions are dangerous, and only when the bound value can be
 * null - a null at a visible placeholder is rewritten to a hard-coded NULL and
 * works correctly.
 *
 * @param {string} sql
 * @returns {{ total: number, visible: number, invisible: number }}
 */
export function placeholderVisibility(sql) {
  const total = (sql.match(/\?/g) || []).length;
  const visible = (sql.match(/\s*[=,(]\s*\?/g) || []).length;
  return { total, visible, invisible: total - visible };
}
