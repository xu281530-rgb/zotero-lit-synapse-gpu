/* eslint-env node */

/**
 * A stand-in for the rows `Zotero.DB.queryAsync` hands back.
 *
 * Zotero wraps every result row in a Proxy over `mozIStorageRow`
 * (Zotero.DBConnection.prototype.queryAsync, chrome/content/zotero/xpcom/db.js).
 * Three trap behaviours matter to the Wiki module, and all three are
 * reproduced here:
 *
 *   1. `get` on a column the query did not select THROWS
 *      `DB column '<name>' not found` - it does not return `undefined`. That
 *      is what makes `JSON.stringify` lethal: the stringifier probes
 *      `value.toJSON` on every object it visits, `toJSON` is not a column, and
 *      the probe blows up the entire serialisation.
 *   2. `has` returns `!!getResultByName(name)`, so `'col' in row` is false both
 *      for an absent column and for one holding NULL / 0 / ''.
 *   3. `get` on an existing column holding SQL NULL returns `null`.
 *
 * `isZoteroRow` lets a test assert the negative - that a value which reached a
 * response is NOT one of these - which `JSON.stringify` alone cannot prove:
 * a row nested under a key whose own value serialised first would still throw,
 * but a row that merely sits in an unreached branch would not.
 */

const rows = new WeakSet();

export function zoteroRow(columns) {
  const target = {
    getResultByName(name) {
      if (!Object.prototype.hasOwnProperty.call(columns, name)) {
        throw new Error(`no such column: ${name}`);
      }
      return columns[name];
    },
  };
  const proxy = new Proxy(target, {
    get(t, name) {
      // Zotero exempts `then` so an awaited row is not mistaken for a thenable.
      if (name === "then") return undefined;
      try {
        return t.getResultByName(name);
      } catch {
        throw new Error(`DB column '${String(name)}' not found`);
      }
    },
    has(t, name) {
      try {
        return !!t.getResultByName(name);
      } catch {
        return false;
      }
    },
  });
  rows.add(proxy);
  return proxy;
}

/** Whether `value` is one of the proxies {@link zoteroRow} produced. */
export function isZoteroRow(value) {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    rows.has(value)
  );
}

/**
 * Adapt a `node:sqlite` database to the `WikiDatabase` interface, returning
 * rows in either shape.
 *
 * @param {import("node:sqlite").DatabaseSync} sqlite
 * @param {"proxy"|"plain"} rowShape - `proxy` reproduces Zotero at runtime;
 *   `plain` reproduces the node:sqlite shape the other Wiki suites use.
 * @param {(sql: string, params: unknown[]) => [string, unknown[]]} parseQueryAndParams
 */
export function adaptWikiDatabase(sqlite, rowShape, parseQueryAndParams) {
  let depth = 0;
  const normalize = (params) =>
    params.map((value) =>
      typeof value === "boolean" ? (value ? 1 : 0) : value,
    );
  return {
    async queryAsync(rawSql, rawParams = []) {
      const [sql, params] = parseQueryAndParams(rawSql, rawParams);
      const statement = sqlite.prepare(sql);
      const values = normalize(params);
      if (/^\s*(select|pragma|with)\b/iu.test(sql)) {
        const result = statement.all(...values);
        return rowShape === "proxy" ? result.map(zoteroRow) : result;
      }
      statement.run(...values);
      return [];
    },
    async valueQueryAsync(rawSql, rawParams = []) {
      const [sql, params] = parseQueryAndParams(rawSql, rawParams);
      const row = sqlite.prepare(sql).get(...normalize(params));
      return row ? Object.values(row)[0] : undefined;
    },
    async executeTransaction(fn) {
      if (depth > 0) return fn();
      depth += 1;
      sqlite.exec("BEGIN");
      try {
        const result = await fn();
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      } finally {
        depth -= 1;
      }
    },
  };
}
