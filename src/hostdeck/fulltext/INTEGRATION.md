# HD-WP-05 — optional full-text provider integration contract

This file is a module-local integration boundary, **not** a second product
plan. Source base: `9fcb2956552d62412102f36e56c41ad10a80a5d6`.
Provider ID: `local.sqlite-fts5.document-content.v1`.

## Current state

`FullTextAdapter` is now an additive, dormant-by-default MCP facade source
implementation. It does **not** modify Everything, the normal files contract,
manager/UI rendering, grants, installer or automatic indexing. No protected
personal-corpus selection/digest approval has been provisioned or indexed. No
automatic watcher, auto-index, semantic model, cloud API, download or GPU route
exists. Calling `FullTextEngine.preview()` only inspects explicitly supplied
configuration and hardware limits; it does not create or scan an index.

The owner requests broad local coverage. Represent that with exact selected
fixed-volume roots, exclusions and visible limits in the protected proposal;
do not silently narrow it to a few profile folders or the first drive.
Everything's filename index is not a document-content index.

## Remaining setup and activation (coordinating Codex)

1. Add a **separately admin/SYSTEM-writable owner config/approval directory**
   and a distinct ordinary-user-writable SQLite index directory. Do **not**
   reuse the current ordinary executor `state_directory` as approval storage.
   The selection records exact roots, allowed formats, the chosen Hidden
   policy and explicit hardware-adapted budgets. A separately protected
   approval file containing JSON `null` means no approval; its physical
   existence can permit preview without inventing consent.
   Display `FullTextPort.preview(principal)` **before** providing an owner
   confirmation proof bound to its `digest`. Re-preview after every diff.
2. The adapter/port objects are constructed without creating an index.
   A compatible Node 24 SQLite FTS5 runtime and selected capability are
   required before opening the engine. `loadSelectedConfig` uses protected
   config, `isOwnerConfirmed` uses
   a trusted approval record, and `authorize` to fresh PolicyGate identity,
   device/executor and root/file ACL checks. A caller's boolean or guessed
   digest **is not** an approval. Avoid new grants during this patch.
3. Source contracts now contain separate read/index scopes and additive
   facade operations. These are not production grants. The operations are:
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

The trusted agent configuration accepts optional `desktop_worker_sha256`,
`fulltext_owner_directory` and `fulltext_index_directory`. The SHA must come
from the approved installer/package, not a requester or sampling an untrusted
live file. Owner records and writable index must be outside the workspace and
in disjoint trees; actual native checks remain mandatory. Without these setup
proofs, selected roots, protected digest approval and current scopes, no
personal index is activated. The ordinary state directory's Modify rights
alone do not satisfy the current index verifier: the dedicated index directory
also needs effective `FILE_DELETE_CHILD`. Provision only the dedicated data
directory with the needed rights, rather than changing the existing state or
protected-owner ACLs. Each step remains explicit; there is no background scan.

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
- Traversal: no link/junction/reparse or ADS, no implicit UNC, no automatic
  watcher. A fixed-volume root requires exact `fixedVolumeRoots` approval,
  protected default system exclusions and an explicitly excluded writable
  index subtree; otherwise the volume-root guard remains active. Depth/entry/file/text/total-source limits
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

**Remaining limits:** one active writer per **canonical file path**; read-only
multi-session and cross-host/mounted/network filesystem lock semantics are
NOT QUALIFIED. Do not infer a global distributed mutex or use the companion
for lockfile takeover. The root/source recheck verifies observed replacements
and persisted effects, **not an absolute OS-level race proof** for every
possible transient swap in a path-reopening structured parser. Keep the
capability disabled until those surface/ACL requirements are qualified.

New Hidden/owner-ACL/fixed-volume tests are **NOT_RUN** on this source branch;
Codex must qualify them locally. Earlier recorded Windows failures are retained,
and prior builds/tests cannot be counted as executions of this HEAD. The local
reported Node 24/SQLite 3.51 FTS5 finding is prior evidence, not an
execution by this delegated developer. Public source screening and history
qualification remain for Codex before merging.

## Protected approval vs writable index — exact future integration diff

This is the **proposed** config/installer change, not a deployed change. The
current `main.ts` passes neither a separately qualified protected path nor a
native ACL verifier, so `FullTextSelectionStore.selected()` returns `null` and
`confirmed()` returns `false` regardless of any user-writable JSON content.
Do not grant `fulltext:index` on the installed surface until this boundary
has been physically qualified by Codex.

```diff
 configuration = z.object({
+  fulltext_owner_directory: absolute.optional(),
+  fulltext_index_state_directory: absolute.optional(),
   // existing fields stay unchanged
 })

 const fulltext = new FullTextAdapter({
-  stateDirectory: config.state_directory,
+  stateDirectory: config.fulltext_index_state_directory ?? config.state_directory,
   workspace,
   reauthorize,
+  protectedOwnerDirectory: config.fulltext_owner_directory,
+  verifyProtectedOwnerAcl: nativeWindowsAclVerifierOnlyAfterQualification,
 });
```

These *example deployment locations* are **not** supplied to the runtime by
this PR, are **not** personal roots, and do **not** create directories:

```text
Protected owner selection + approval:
  C:\ProgramData\HostDeck\OwnerApprovals\fulltext-selection.json
  C:\ProgramData\HostDeck\OwnerApprovals\fulltext-approval.json
  WRITE: SYSTEM/Administrators ONLY, including all replacement-capable
  ancestors and DELETE_CHILD/rename/WRITE_DAC/WRITE_OWNER checks.

Writable SQLite (separate tree, never an approval source):
  C:\ProgramData\HostDeck\State\Fulltext\fulltext-<owner-hash>.sqlite
  C:\ProgramData\HostDeck\State\Fulltext\*.sqlite-wal / -shm
  C:\ProgramData\HostDeck\State\Fulltext\*.writerlock.sqlite
```

A verified ACL gate must establish the **actual executor token's effective
write/replace/delete rights** on both files, the protected directory and all
replacement-capable ancestors. ACL text or `fs.access(W_OK)` alone does not
prove `DELETE_CHILD` denial. This native verifier is **NOT IMPLEMENTED OR
QUALIFIED** in this PR; the optional callback in `FullTextAdapter` is a
privileged integration seam, never an MCP parameter. The synthetic test
callback proves digest/revocation logic **only**; no cryptographic owner claim
or physical ACL acceptance follows from source literals or caller booleans.

Any changed protected selection/root/exclusion/budget creates a new digest.
The existing index's scope/config mismatch remains fail-closed: integrating
Codex must separately qualify reindex/migration rather than reuse old data
under a new approval. Revocation of either approval or native ACL verification
must suppress old snippets, metadata and visible counters immediately.

## Broad fixed-volume opt-in and honest budget/coverage semantics

The owner may explicitly choose qualified fixed volumes C:, D: and G: if
desired. **Do not enumerate or index any of these without a protected
selection/approval record.** Example *selection content* (not applied):

```json
{
  "roots": ["C:\\", "D:\\", "G:\\"],
  "fixedVolumeRoots": ["C:\\", "D:\\", "G:\\"],
  "excludedRoots": [
    "C:\\ProgramData\\HostDeck\\State\\Fulltext",
    "D:\\PrivateExcluded",
    "G:\\PrivateExcluded"
  ],
  "formats": [".txt", ".md", ".csv", ".json", ".docx", ".xlsx", ".pdf"],
  "includeHidden": false,
  "budgets": {
    "maxOperationsPerStep": 16,
    "maxStepMilliseconds": 3000
  }
}
```

The full protected selection record additionally contains the exact
`version:1` and `owner` envelope; the approval record independently binds
the digest. A fixed-volume root requires an exact `fixedVolumeRoots` entry
and read-only Windows `DriveInfo.DriveType = Fixed` qualification. Built-in
system exclusions block `Windows`, `Program Files`, `ProgramData`,
`System Volume Information`, `$Recycle.Bin`, `Recovery` and profile
`Users/*/AppData`, even if a broad root is selected. Explicit exclusion
paths must also cover the writable index subtree.

No three-folder limit exists: protected selection accepts up to 128 explicit
roots plus an explicitly bounded fixed-volume mode. Initial document/source
budgets derive from detected physical RAM rather than always 5,000 files
and 256 MiB; adjustable hard ceilings and per-step time/IO/memory/disk limits
remain to avoid an unbounded scan. `maxFileBytes`, unsupported extraction,
scan deadlines and entry limits still produce partial coverage where
appropriate; no all-content recall, cloud-model or GPU claims.

On Windows, Node Dirent/Stats do **not** report `Hidden`. The earlier
`attrib.exe` compatibility probe failed the actual accented/CJK filename
oracle; preserve that failure. The current facade uses the installer-pinned
native metadata bridge, with bounded batches and fail-closed unknown results.
Actual Windows Unicode and Hidden-before/during-extraction fixtures pass.
The exact selected fixed-volume anchor alone can tolerate its own volume
flags; Hidden/System descendants remain subject to policy. This does not
qualify high-throughput full-volume indexing or a real protected personal
selection/approval/index tuple. Those remain independent activation gates.

New focused oracles (do not replay the whole suite):
- `node --import tsx --test test/hostdeck-fulltext-hidden.test.ts`:
  actual fixture `attrib +H` and `-H`, inclusion/exclusion/purge, raw SQLite
  rows, and hidden-while-extracting. Original RED
  **HD-B007-FULLTEXT-HIDDEN-001**: a hidden ordinary TXT was indexed and
  `bounded_complete` returned. This remains historical FAIL evidence.
- `node --import tsx --test test/hostdeck-fulltext-owner-boundary.test.ts`:
  no verifier -> no consent, synthetic protected record/digest and ACL
  revocation, disjoint writable index. **NOT a physical ACL test.**
- `node --import tsx --test test/hostdeck-fulltext-broad-selection.test.ts`:
  fixed-volume schema/exclusions **without opening actual C:/D:/G:**,
  adaptive defaults, and scan of a disposable explicitly selected subtree.

There is **no personal index, new remote grant, installer change, manager
change, service transition, UI resource auto-rendering, or Actions run** in
this source PR.
