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
5. Apply installer-local ACLs to the index database **and WAL/SHM sidecars**.
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

These are **NOT_RUN** on this source branch until Codex performs controlled
builds and a separate independent ordinary-ChatGPT acceptance. The local
reported Node 24/SQLite 3.51 FTS5 finding is prior evidence, not an
execution by this delegated developer. Public source screening and history
qualification remain for Codex before merging.
