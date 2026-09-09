# Wiki relation review implementation

Confirmed with the user on 2026-09-06. This supersedes recommendations in the
original proposal where they differ from the decisions below.

- Implement the complete workflow, including retrieval, durable review, knowledge
  relations, read APIs, graph, legacy audit, lexical filtering and evidence views.
- Full-text completion requires relevant cross-paper reviews. Checkpoints preserve
  work without closing reading. Question-driven review stays within its topic.
- Present ranked old claims, retain every target, and require a reason for each
  exclusion. Existing evidence is reusable; opening the old PDF is conditional.
- Preserve attribution and prefer separate qualifying/comparison claims over
  rewriting another paper's findings. A method extension needs direct evidence.
- Missing knowledge creates a deferred review. Dependency changes reopen affected
  reviews without manufacturing a semantic conclusion.
- Updated in 3.2.1: draw one line per paper pair, with disagreement first,
  then shared Claims, comparisons/qualifications, same-page membership and shared
  concepts. Every relationship remains visible in the line's detail cards.
  A same-page edge is only page membership, never proof of semantic verification.
- Replace probability-like confidence labels with factual evidence summaries.
  Retain the legacy heuristic value with its formula and version for compatibility.
- Back up the real Wiki before migration. Preserve original legacy decisions,
  record dependency defects, and append evidence-grounded re-review results.

Implementation boundaries:

1. Store task snapshots and append-only reviews separately from existing signal
   resolutions; link them by IDs rather than copying a second authoritative claim.
2. Validate snapshots before mutations and result/evidence bindings after mutations
   in the same transaction as the receipt. IDs may refer to claims in this commit.
3. Derive current validity from dependencies during reads without mutating reviews.
4. Use structural validation on the server. Semantic quality remains the reading
   AI's responsibility and is checked using reviewed examples, not text length.
5. Tests use temporary SQLite databases. Preserve unrelated working-tree changes.

Verification baseline: current installed package 3.1.0; schema 19; 39 claims,
105 valid SUPPORTS evidence rows; every legacy score 0.66. Resolution 1 references
Claim 23 as shared support but only 6DGLE2VE supports it. Existing settlement,
confidence, context and reopening suites pass. The installed bundle includes the
dual-source guard. The origin of the legacy defect is not established.

## Delivered And Verified

Version 3.2.0, schema 20. Durable task snapshots, append-only reviews,
Claim relations, evidence assessments and legacy audit records are integrated
with prepare, commit, receipts, recovery, retrieval, export and the graph.
Checkpoints preserve reading state; full-text reviews supersede outstanding
question tasks for the same pair. Source changes during a commit abort the
transaction without acknowledging pending source notifications.

Validation on 2026-09-06:

- 44/44 Wiki and protocol suites passed, including 20 focused cross-paper tests.
- TypeScript passed. Production build and XPI GPU asset checks passed.
- Actual graph renderer passed browser screenshots and pixel/interaction checks
  at 1280x800 and 390x844: five selectable relation lines, animation, no tooltip
  overflow. This is a browser harness, not an installed Zotero end-to-end test.
- Migration passed on a fresh copy and on an already migrated copy. Replaying
  preserved the same review and relation counts.
- Live migration completed after a SQLite backup at 2026-09-06T06:47:08Z.
  Three reviewed paper pairs produced 13 comparisons; six knowledge gaps remain
  deferred. All 39 Claims, 105 Evidence rows and 36 original resolutions remain.
  Integrity check is OK and foreign-key check is empty.

The historical shared-support defect remains visible in the immutable legacy
record; its replacement review records an evidence-bound comparison. The audit
count of one legacy defect does not imply a new shared-support edge is valid.
The migration compares saved excerpts, does not claim a fresh full-text reading,
and does not infer academic inheritance or independent replication.

The standard CLI built the XPI but its update notifier could not write its
external cache. The same production builder was then run successfully through
the scaffold's public Build/Config API; TypeScript was checked separately.
No dependency source or machine-wide configuration was changed for this.

Package: `D:/Zotero_Pluging/zotero-lit-synapse-3.2.0.xpi`.
Verification artifacts and the pre-migration backup are in
`D:/Zotero_Pluging/zotero-lit-synapse-3.2.0-验证记录/`.
The package has not been installed or Zotero restarted by this task.

## 3.2.1 Graph Revision

The user's follow-up replaced separate lines with a single aggregate line.
The primary style never filters the detail payload. All relationship types now
share the candidate card renderer, including Claim links, selected Evidence
quotes, and sourced terms. Disagreements receive a stronger red line and card
accent. Document degree counts distinct neighbours rather than relation count.

The candidate concern was checked against the installed 3.2.0 and live database:
all three pairs among fully read papers are resolved. The remaining twelve open
pairs have an unread endpoint. The user clarified this may have been a visual
misreading. No candidate workflow or live data changes were made in 3.2.1, and
no new copying requirement was added to AI knowledge reuse.

## 3.2.2 Stable Curves

Removed the old screen-distance-dependent curve offset and parallel-line lanes.
The renderer now projects the same spatial control point throughout rotation;
overlap and occlusion do not push a line outward. A regression test reproduced
the former displacement before the fix. Orthographic rotation/zoom and two
complete perspective orbits now pass without discontinuous curve displacement.
Aggregation, priority and full relationship cards are unchanged.

## 3.2.3 Collapsible Excerpts

All graph relationship cards now render chunk excerpts in native details/summary
disclosures, collapsed by default. Source titles and Evidence or term references
remain visible; each excerpt opens independently by mouse or keyboard. Claim
navigation and the complete set of relationships remain available outside the
collapsed excerpt bodies.

## 3.2.4 Group Excerpts By Document Within Each Claim

In graph line details only, each Claim now groups all excerpts from the same
itemKey into one initially closed disclosure. Evidence IDs and roles remain
attached to individual passages inside the group. Different Claims retain
separate groups, including within a single relationship card. Concept source
excerpts use the same document grouping within their concept card.

Disclosure titles show only itemKey. The panel heading maps each full document
title to a bold, highlighted itemKey. Other Wiki and reading-note views are
unaffected. Browser checks cover grouping, all 16 fixture excerpts, Claim
isolation, default collapse, keyboard/mouse toggling and desktop/mobile layout.
