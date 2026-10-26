# HD-WP-05 — optional full-text provider integration contract

This file is a module-local integration boundary, **not** a second product
plan. Source base: `9fcb2956552d62412102f36e56c41ad10a80a5d6`.
Provider ID: `local.sqlite-fts5.document-content.v1`.

## Current state

`FullTextEngine` and `FullTextPort` are **not** wired to the existing
`HostDeckFacade`, MCP tool registry, app UI, Everything or installer. No
automatic watcher, auto-index, semantic model, cloud API, download or GPU route
exists. Calling `FullTextEngine.preview()` only inspects explicitly supplied
configuration and hardware limits; it does not create or scan an index.

No owner-selected root has been supplied. Do not substitute the current
workspace, home directory, first available drive or Everything's file index.

## Exact minimal integration (coordinating Codex)

1. Add a **protected per-device/per-function config** for this provider, loaded
   only when explicitly selected by the owner. Store it in the already
   protected local state settings, not the public repository. It contains:
   `indexFile` in an existing protected state directory, `roots: []` until
   chosen, allowed formats, `includeHidden: false`, and explicit budgets.
   Display `FullTextPort.preview(principal)` **before** providing an owner
   confirmation proof bound to its `digest`. Re-preview after every diff.
2. Instantiate `FullTextPort` only if a compatible, qualified Node 24
   SQLite FTS5 runtime is installed and the capability has been selected.
   Connect `loadSelectedConfig` to protected config, `isOwnerConfirmed` to
   a trusted approval record, and `authorize` to fresh PolicyGate identity,
   device/executor and root/file ACL checks. A caller's boolean or guessed
   digest **is not** an approval. Avoid new grants during this patch.
3. Only after adding genuine separate policy scopes, expose additive,
   explicitly scoped facade operations. Suggested independent operations:
   `fulltext_preview` (no effects), `fulltext_confirm` (owner-selected
   state file), `fulltext_start`, `fulltext_step`, `fulltext_pause`,
   `fulltext_resume`, `fulltext_cancel`, `fulltext_query` and
   `fulltext_status`. Map read/metadata/snippet to **fresh read permission**,
   configuring/indexing to **explicit owner-approved indexing permission**.
   Never pass provider names into the existing `search_files` without an
   independently reviewed contract/selection change; no silent fallback.
4. Call `port.close()` on process shutdown; after a restart `openConfirmed`
   marks a previously running scan `interrupted` and only an explicit
   `resume` can continue. A scan advances only through a bounded
   `step` call, not background scheduling. A requested cancel/pause may
   complete at the next guarded boundary; already committed documents remain.
5. Apply installer-local ACLs to the index database **and WAL/SHM sidecars**
   **and the persistent `.writerlock.sqlite` companion**. This lock companion
   remains on disk across close/crash. SQLite in rollback-journal mode holds
   a live OS-backed `BEGIN EXCLUSIVE` transaction until normal close or
   process termination. A competing writer must return
   `FULLTEXT_WRITER_BUSY` **before** opening or mutating the primary index.
   Never unlink a supposed stale lock, trust PID/TTL, or break a live owner.
   After an actual process crash, the OS releases the lock; opening a new
   instance marks the surviving `running` scan `interrupted`, and resume
   remains explicit.
   This implementation does not encrypt stored document content or authorize
   changes to existing system ACLs. Do not activate it until the state
   directory protection and cross-principal index ownership are verified.
6. UI/manager may show states `unconfigured`, `selected-not-confirmed`,
   `running`, `resource_paused`, `paused`, `interrupted`, `cancelled`,
   `complete-bounded` and `partial`, plus format-by-format gaps. This
   module does not modify the UI.

## Format/semantic qualifications and explicit exclusions

- UTF-8 plain text / Markdown / CSV / JSON: strict decoding, no replacement
  characters or implicit binary indexing, bounded document text.
- DOCX: pre-existing archive checks and existing outline extraction. Rich
  drawing-only content and known Office cold-start/run-boundary failures are
  **not** accepted by this module.
- XLSX: existing archive validation then selected all-sheet primitive value
  extraction. Formula objects, rich values/comments and unqualified semantic
  values are marked `unsupported_office_value` instead of indexing
  `[object Object]`. No formula calculation.
- PDF: existing unpdf text extraction; empty scanned pages are
  `ocr_required`. Arabic/RTL text and presentation-glyph mixtures are
  `pdf_rtl_unqualified` because the existing parser's logical order is
  wrong. No unchecked OCR engine or PDF rewrite is added.
- Search: FTS5 `unicode61 remove_diacritics 2` for tokens; Han 2+ codepoint
  queries use exact overlapping bigram terms plus final literal substring
  verification. Single-Han queries return `FULLTEXT_HAN_MIN_TWO`. Trigram
  or 1/2-character universal CJK recall is **not** claimed.
- Ranking: native FTS5 BM25 (smaller score first); bounded result pages and
  snippets, explicitly `last_scan_only`/`not_monitored`. ACLs are checked
  again **before** metadata, counters and snippets. Results may be stale
  until an explicitly requested new scan.
- Traversal: no link/junction/reparse or ADS, no volume root, no implicit
  UNC, no automatic watcher. Depth/entry/file/text/total-source limits
  mean `partial` coverage, **not** full recall. Ambiguous duplicate-hash
  renames may be represented as create+delete, never guessed.

## Ground-truth and acceptance routes

- `node --import tsx --test test/hostdeck-fulltext.test.ts`
- `node --import tsx --test test/hostdeck-fulltext-documents.test.ts`
- `npm run build:hostdeck` (targeted TypeScript compile)
- On the intended Windows installation: **new, uniquely named disposable
  corpus**, an explicitly protected index location, authorized identity,
  create/update/rename/delete, actual query/readback, Unicode Han and
  accent oracles, denial after ACL/root/config revocation, pause/cancel/
  interrupted recovery, file-size and memory pressure, resource observation
  and exact cleanup. No personal document roots or whole-drive index.

New focused writer and source-race checks:
- `node --import tsx --test test/hostdeck-fulltext-writer.test.ts`
  exercises a second instance in the **same process** and two **real child
  processes**. It snapshots primary `meta`/`runs`/`queue` for a rejected
  writer, tests normal close, forcefully kills **only a disposable child**,
  and verifies OS release + truthful interrupted recovery.
- `node --import tsx --test test/hostdeck-fulltext-reparse.test.ts`
  changes an owned file/root *after source extraction but before commit*.
  Metadata/FTS must remain empty and the run paused. A symlink/junction
  case is conditional on actual test-user rights (report a skip truthfully).
  Source identities use native `dev`/`ino` and fail closed when unavailable.

### HD-B007-FULLTEXT-DELETE-001 — traversal proof versus document recall

- **Original reproduced RED on the preceding source** `3b9af82`: a fully
  enumerated directory with one TXT and one blank PDF (`ocr_required`) marked
  the scan `incomplete=1`. After deleting TXT and rescanning, `removed=0`;
  its metadata and private source text still existed in raw SQLite/FTS5.
- `runs.incomplete` continues to mean **any** recall gap. New
  `runs.traversal_incomplete` independently records an incomplete tree walk,
  ACL/root/source/budget failure, depth or per-directory entry truncation.
  A fresh explicitly requested scan starts with both zero; a pre-existing
  legacy run without the new column migrates to
  `traversal_incomplete=1` (fail-closed, no legacy purge claim).
- Only after the scan queue has been fully traversed and
  `traversal_incomplete=0` may `finish` purge stale `docs` AND their
  `docs_fts` rows. Each removed path needs fresh metadata/root authorization
  and pinned-root identity validation. OCR-required or unqualified document
  content still leaves `incomplete=1` and **partial recall**, while a
  separate `traversalCoverage` field reports whether enumeration completed.
- On incomplete/denied directory access, root identity changes, depth/entry
  limits, or source-budget failure: **do not purge** previously indexed
  entries. No background scan starts or a personal root is selected.
- Targeted committed regression:
  `node --import tsx --test test/hostdeck-fulltext-delete.test.ts`.
  In delegated testing, this same committed test ran on the authorized
  Windows Node 24 runtime with native TypeScript transform and a fixture-only
  loader against the exact new engine source: **6 passed, 0 failed, 0 skips**.
  Separate actual baseline-vs-candidate source execution produced RED
  `removed=0,staleRows=1,staleFTS=1` and GREEN
  `removed=1,staleRows=0,staleFTS=0`. Four independently executed
  incomplete-traversal cases (ACL, depth, entry limit, total source budget)
  retained prior rows. These checks do **not** constitute a normal installed
  product release or independent MCP facade acceptance.

**Remaining limits:** one active writer per **canonical file path**; read-only
multi-session and cross-host/mounted/network filesystem lock semantics are
NOT QUALIFIED. Do not infer a global distributed mutex or use the companion
for lockfile takeover. The root/source recheck verifies observed replacements
and persisted effects, **not an absolute OS-level race proof** for every
possible transient swap in a path-reopening structured parser. Keep the
capability disabled until those surface/ACL requirements are qualified.

Earlier general fulltext builds and six tests, plus writer/reparse
qualifications, are **owner-reported Windows PASS**, not rerun by this
delegated change. The focused delete/coverage checks above **were** executed
with disposable HostDeck-owned Windows fixtures. A clean integrated Windows
build of this newest commit, public-source screening, other broad suites
and independent ordinary-ChatGPT facade acceptance remain **NOT_RUN**.
No installed source, system privileges or index location was changed.
