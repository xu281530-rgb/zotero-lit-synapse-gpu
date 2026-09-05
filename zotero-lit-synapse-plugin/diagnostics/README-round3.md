# Wiki and Reading Note Diagnostics

These files investigate the current 3.0.2 behavior. They assert the desired behavior, so an unfixed defect produces a failing test. They are intentionally outside the regular `test/` directory.

Run them only with the repository's isolated Zotero test profile. They create synthetic papers, reading-note attachments, and independent SQLite databases. They do not require an external language model. Local embedding responses are controlled; fault and scheduling injection are identified in each case.

To use the existing scaffold runner, temporarily copy `round3-fulltext.test.ts`, `round3-qa.test.ts`, `round3-notes.test.ts`, and `round3-http.test.ts` into `test/`, run `zotero-plugin test --no-watch --exit-on-finish` with `ZOTERO_PLUGIN_ZOTERO_BIN_PATH` set, then remove only those four temporary copies. Rebuild with `npm run build` afterward to restore production build output.

The tests save their observations in the isolated Zotero data directory as `round3-fulltext-results.json`, `round3-qa-results.json`, `round3-notes-results.json`, and `round3-http-results.json`. Inspect these files: a setup failure does not prove the intended defect, even if the runner prints a failed test. The report distinguishes ordinary calls, constructed prior note states, and explicit fault injection. The HTTP test uses the actual loaded addon's MCP handler on port 23121 and restores its temporary preferences. Run `node scripts/collect-round3-evidence.mjs` before launching another scaffold run, since a new run recreates the disposable data directory.

The `scripts/audit-round3-*.mjs` files are separate diagnostic harnesses. Their exit code zero means they reproduced their expected observations, not that the product has been fixed. `audit-round3-live.mjs` performs read-only checks against the user's running MCP endpoint.
