# Zotero LitSynapse 3.1.0

Released locally on 2026-09-05. The pre-existing 3.0.2 changes and diagnostic
fixtures were committed first as `76c52f7`.

## Reading Notes and Wiki

| Report | Change |
| --- | --- |
| N01 | Duplicate suppression retains the original note file. Exact duplicates avoid embedding requests; semantic comparison remains available. |
| N02 | Updates to one paper are serialized across service instances. Each write checks the selected note body before replacing it. |
| N03 | An unreadable existing note fails before changing the expert or overwriting content. |
| N04 | Reading, writing, progress refresh and status synchronization retain the selected attachment identity. |
| N05 | A persistent operation journal resumes a saved summary's remaining progress and header updates without appending it twice. |
| N06 | A failed terminal status update can be retried after the session closes, using the original session and attachment. |
| F01 | `readChunkIds` selects question reading and cannot settle an outstanding fulltext batch. |
| F02 | Missing reading records block both final synthesis and fulltext closeout. |
| F03 | An unsupported verdict retracts only the reviewed paper's SUPPORTS links. Original evidence is archived; remaining sources determine claim status. Unsupported claims without evidence are excluded from normal search. |
| Q01 | Question records share chunk coverage, citation and measurement checks with fulltext records, without requiring the fulltext template. |
| Q02 | New understanding reopens Wiki work even for old chunks and invalidates obsolete whole-paper review markers. Duplicate and unchanged readings do not create new-understanding debt. |
| Q03 | Question reading can append passages while a fulltext session is active, preserving outstanding fulltext obligations. |

Schema 18 adds `wiki_note_operations` and `wiki_review_retractions` without
replacing existing notes or rebuilding the knowledge base. Pending note work is
visible through `wiki_get_reading_note.pendingOperation`. Retry the original
request to resume it. A changed source, replaced session, or externally edited
body fails closed and requires reconciliation; recovery never overwrites that
conflict automatically.

## Verification

- The existing 109-script regression sweep ran. Three scripts initially failed:
  two fixtures omitted integration before synthesis/closeout, and the retrieval
  filter also hid pending-relink evidence. The fixtures and filter were corrected;
  all three scripts passed on rerun.
- Three additional Node regression suites cover the reported defects, database
  reopening, header failures, changed source versions, external edits, semantic
  deduplication, concurrent service instances, and source-specific retraction.
- The isolated Zotero runtime suite includes 36 tests, including all 14 original
  diagnostic scenarios and real HTTP MCP requests. Tests use synthetic papers,
  real Markdown attachments and native SQLite, with controlled embeddings and
  explicit fault injection.
- Production build, TypeScript, ESLint on changed Wiki modules, XPI GPU assets,
  manifest version, and update-manifest SHA-512 are verified.

The XPI is built in production mode. It is not installed into the user's normal
Zotero profile and has not been published to GitHub. No model-quality or speed
benchmark is claimed.
