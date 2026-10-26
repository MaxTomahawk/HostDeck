# HostDeck MCP contract v1

Status: implemented contract registry; backend, transport, authorization and end-to-end acceptance remain separate. Canonical code is `src/hostdeck/contracts.ts`, `contractVersion = 1.1.0`. This is an additive catalog for the full product scope, not a claim that the catalogued capabilities are already installed or exposed.

## Search providers (additive v1.1)

`search_files` accepts an optional `provider` (`direct` or `everything`), `entry_type` (`files`, the existing default; `directories`; `all`), optional `sort` (`path` or `name`, ordinal with path tie-breaking), and `metadata` (default false). Existing file/content, case-insensitive literal/restricted-regex and dot-name visibility semantics remain. Explicit roots are searched even if a root name begins with a dot; hidden descendants are excluded unless requested. Windows Hidden attributes are not a new filter. Traversal depth remains bounded at twenty directories, with omitted deeper coverage reported as truncated. Everything supplies filename/path discovery only; content mode with Everything is refused explicitly. Metadata is current authorized filesystem readback, not an assertion about indexed metadata freshness.

`list_providers` requires `files:read`; it observes configured providers on request and does not start/install/reconfigure them. Presence, integration enablement, runtime, compatibility, health and independent qualification are separate fields. Not configured means installation status is unknown. `set_provider_preference` requires `files:write`, reauthorization and a HostDeck-owned private preference store. Preference keys bind owner/device/executor/function; explicit query overrides do not rewrite them. Null clears a preference to the stable direct default. A saved unavailable provider returns its own failure and remains saved; no general fallback policy is selected.

Search handles are ephemeral, owner/device/executor-bound and expire after ten idle minutes once complete. Agent restart invalidates them. `search_results` additionally rechecks the current grant for an Everything query's bound Windows session. Results are workspace-relative and checked for canonical/reparse boundaries before exposure. Engine-global counts are never returned. Sorted results are withheld until the retained snapshot is sealed; ordinary unsorted results remain append-only while running. Page offsets index that retained snapshot. A target removed or replaced by a refused path is omitted at readback; its retained offset is still consumed. `total_results` describes the authorized snapshot at collection, not a live global index count. Truncated queries have state `partial`; timeout, loading, unavailable and real zero results remain distinct. Cancellation is complete only after the owned native client exits; unconfirmed termination has state `uncertain` and `EVERYTHING_TERMINATION_UNCERTAIN`.

`search_files.limit` bounds how many matches are retained **before** optional sorting. A truncated query therefore sorts a bounded subset and does not promise the global first K results. `search_results.limit` is a page size within the retained snapshot. To collect a complete sorted set, the search must finish without truncation and all result pages must be read.

## Registry and discovery

`getToolContract(name)` selects only a canonical `hostdeck_` name. `parseToolArguments(name, args)` applies its strict Zod schema, bounds and defaults. Each entry has a description, required scope set, execution domain and effect class. `discoverTools(implementedAndAuthorized)` emits MCP input schemas only for the intersection with the explicit canonical registry. Unknown upstream names are not passed through. The facade must derive that supplied set from real registered handlers and verified current policy; passing names to this helper does not implement or authorize them.

The registry itself has no networking, authentication, dispatch or OS effects. It must not be exposed directly as an unrestricted server. The accepted security model governs the later facade and worker implementations. In particular, tool annotations are informational; they never replace scope/grant/owner checks. `read` includes potentially sensitive observation, and `execute`/`control` can carry the user's broad OS authority.

Every tool requires an explicit `device_id`. Desktop tools require a positive nonzero Windows `session_id`; window input and UIA operations use opaque `window_id`/`element_ref` values bound by the future worker to the authorized process/session/generation. These selectors are never proof of ownership. Process mutations accept an owned `process_id`, not a raw PID/process-group number. A missing target must not select another device/session. Bounds in the contract supplement ingress byte limits and OS/object checks; they do not establish a path sandbox or resource quota alone.

The initial catalog covers files/documents/search, interactive terminal/processes, window/UIA/input/capture/OCR/clipboard, owned browser sessions/DOM actions, durable jobs, artifacts, events, device diagnostics and bounded host management. Format-specific document options and compound desktop/browser actions use explicit nested variants; arbitrary renderer options, browser debug endpoints, upstream telemetry flags or submitted authentication/approval fields are rejected.

Some catalog entries deliberately precede their backend: recycle/rich clipboard, managed browser control, durable jobs and host management still need implementation and real tests. Discovery must exclude unbound entries and must never report an accepted command as completed merely because its schema parsed. Unavailable native support returns a truthful capability error at the facade. The catalog can expand through reviewed additive changes; it does not reduce the masterplan's final capabilities.

`submit_job` accepts arbitrary commands only with `resume: never`. Safe checkpoint recovery remains required future work: it must use explicit server-registered job types with checkpoint/idempotency handlers and reviewed schemas. A caller cannot make an arbitrary command safe to replay by setting a flag.

Read positions are safe integers (absolute value at most `Number.MAX_SAFE_INTEGER`). File `offset`/`length` and process `offset`/`limit` count text lines, zero-based; a negative offset starts at `max(0, snapshotLineCount + offset)`. LF separates lines, CRLF is one terminator, a final terminator adds no extra empty line, and a nonempty unterminated last line counts. Process lines refer to combined stdout/stderr in observed arrival order. Each read uses one output/file snapshot; truncation or expired retained output must be reported, not silently rebased. Search offsets count results, artifact offsets/lengths count raw bytes, and neither permits negative offsets. Event `after` is an exclusive device-stream sequence cursor, with 0 requesting the retained beginning; retention gaps must be explicit. Page limits count items, and offsets beyond a snapshot end return an empty page. These semantics bind future adapters; no cursor validation here implements retention, snapshots or delivery.

## Resource and prompt namespaces

| Resource template | Policy family |
|---|---|
| `hostdeck://devices/{device_id}/status` | `devices:read` |
| `hostdeck://devices/{device_id}/jobs/{job_id}` | `jobs:read` |
| `hostdeck://devices/{device_id}/artifacts/{artifact_id}` | `artifacts:read` |
| `hostdeck://devices/{device_id}/events` | `devices:read` and `jobs:read` |

`resolveResource(uri)` requires an exact canonical template match and bounded opaque identifiers. Credentials, queries, alternate schemes, percent-encoded aliases, extra components and traversal are rejected. It returns target selectors and required scopes for the same policy/ownership decision used by corresponding tool calls. It does not read a resource or authorize access. `listResourceTemplates()` returns independent metadata copies.

Prompts are `hostdeck_computer_task`, `hostdeck_diagnose_job` and `hostdeck_edit_document`. Their arguments are strict, device-scoped task data. `renderPrompt` separates fixed operating guidance from JSON-encoded caller values and explicitly states that the prompt grants no authorization. Hostile instructions remain untrusted even when encoded; server-side policy is the actual boundary. Prompt reads must undergo normal authenticated ownership/target checks. MCP Apps resources and actual panels will be added with their real implementations, not advertised as placeholders here.

## Errors, versioning and verification

Contract failures use stable `UNKNOWN_OPERATION`, `INVALID_ARGUMENTS`, `UNKNOWN_RESOURCE` and `UNKNOWN_PROMPT` codes without embedding caller values. The transport must map those to the correct MCP/HTTP envelope and keep raw decoder/backend exceptions out of public responses and routine logs. This module does not claim current MCP transport compliance or successful OAuth validation.

Keep existing names/arguments compatible within v1. Removing/changing a public meaning requires an explicit versioned change and downstream review. Recovered v0.1 modules must conform or undergo that same reconciliation; their missing source/provenance gate remains open. Source/engine/security prerequisites replaced the unavailable-archive dependency for defining this contract only, after independent dependency review. No missing module was accepted or imported.

```powershell
npm ci --ignore-scripts --no-fund --no-audit
npm run test:hostdeck:contracts
npm run build
```

The hand-authored contract tests exercise actual Zod validation, generated discovery schemas, explicit action requirements, canonical resource routing and structured prompt rendering. They are compatibility/registry checks; they do not prove filesystem containment, token verification, Windows ACLs, real GUI/browser behavior, installed service lifecycle or ChatGPT operation. Native dependency setup and runtime hooks must be reviewed separately before execution. `SECURITY_ACCEPTANCE.md` retains those full acceptance requirements.


## B007 Office document compatibility (draft behavior; independent Windows acceptance pending)

The existing \`hostdeck_edit_document\` API retains its established \`text_replace\` and \`table_range\` changes; it stages bytes and does not modify the source on a rejected edit. The following bounded behavior is proposed by the B007 Office patch:

- DOCX \`text_replace\` uses **visible literal \`w:t\` text in one paragraph**, including a text span split across ordinary runs. It compares \`expected_replacements\` against the total across document body, headers and footers **before** staging changes. Matches do not span paragraphs, fields/instructions, tabs, line breaks or other explicit non-text boundaries. A replacement inherits the **first affected run's styling**; remaining run/style elements are preserved, but their replaced text nodes become empty. The patch is not a general Word layout or fields editing engine.
- Input search and replacement are Unicode text, not raw XML fragments. Text entities are decoded for matching and escaped on output; XML/DTD/field instructions and unrelated package entries must not be altered.
- For **openpyxl-comment-layout XLSX workbooks**, existing-cell edits use a narrow OOXML worksheet-patch route. Original comment XML, VML drawings, relationships, other worksheets, media and styles retain their uncompressed ZIP-part bytes. Missing target cells, unsupported cell-owned markup, unsafe package relationships and new-sheet/full-sheet edits are rejected rather than silently losing features. This is not a universal Excel edit/layout-preservation claim. Other ExcelJS-supported workbooks retain the existing edit route.
- Such commented workbooks are read from safe OOXML cell/value parts when ExcelJS 4.4.0 cannot parse their comments. Notes are retained as source package parts, **not exposed as rendered cell comments by the read tool**.
- Uncached Excel formula cells return an explicit structure such as \`{ "formula":"=B1*2", "calculated":false, "cachedResultAvailable":false }\`. **No formula calculation is performed.** Existing non-null cached results remain the previously useful primitive values where supported.
- The ordinary HostDeck DOCX read output documents the actual \`hostdeck_edit_document\` tool and no longer recommends \`edit_block\` or direct low-level raw XML replacement. ExcelJS's upstream generic handler may still expose separate legacy guidance outside HostDeck's JSON read adapter.
- OOXML modifications now validate the **actual document root, nesting, and Word/Spreadsheet/package-relationship namespace bindings** with Saxes 5.0.1 before changing a ZIP entry; lookalike tags in an unrelated namespace and nested substitute roots fail closed. Validated XML remains in its original serialized form except for the specifically patched text/cell.
- Shared, array, data-table, or otherwise attributed formula target cells are refused with `XLSX_FORMULA_GROUP_EDIT_UNSUPPORTED` before staging: neither shared master nor dependent may be rewritten alone. **Unrelated A1 edits retain all formula-group XML in the same worksheet** and leave other ZIP parts unchanged. Reads report `status:"UNSUPPORTED_FORMULA_GROUP"` with `formulaType` and cache presence, never a misleading blank `null` for a shared dependent without a cached result; formula evaluation is not performed.
- DOCX replacements introducing leading/trailing whitespace convert `xml:space="default"` on an affected `w:t` to `xml:space="preserve"` without changing unaffected runs or parts.
- Structural/archive/path/DTD limits, source byte integrity on errors and separate independent client acceptance remain mandatory. Included unit/fixture tests must run on the Codex Windows environment with the exact pinned dependencies before claiming a repaired installed product.

### B007 Office follow-up: date typing, DOCX guidance and public errors

- The openpyxl-comment compatibility **read** route interprets numerical date cells using validated `xl/styles.xml` style indices/number formats and `xl/workbook.xml` `date1904`. Valid dates return UTC ISO strings matching the existing ExcelJS HostDeck JSON read representation (e.g. `2026-01-02T00:00:00.000Z`), rather than untyped Excel serials. Other numbers stay numeric. Unsupported styles, unknown custom format IDs and non-representable date serials receive explicit `UNSUPPORTED_*` status objects. This is **not** a complete Excel number-format renderer.
- The targeted XLSX **edit** route remains unchanged: it modifies only the selected worksheet XML and preserves the uncompressed bytes of all other ZIP parts, including original comments, VML, styling and relationships.
- `hostdeck_read_document` removes the two exact upstream `edit_block`/`read_file offset=1` tooltips only from the generated DOCX outline header, and the legacy Python suggestion only from the generated suffix. These are not generic substitutions in document body/header/footer content.
- Own Office XML root/namespace/structure, unsupported formula, range and count exceptions now have bounded explicit `RuntimeError` codes. For replacement-count conflict, public MCP returns `DOCUMENT_REPLACEMENT_COUNT`, while the internal direct adapter error retains the numbers `Expected N occurrence(s) but found M`; no private text or path is included. The existing `publicError` masks unrelated arbitrary `Error.message` text as `IO_ERROR` and no global whitelist is added.
- The local Windows build and real python-docx/openpyxl/ExcelJS cross-library tests are separate gates; the ordinary ChatGPT implementer does not independently certify its own patch. F002 remains OPEN. No Word/Excel installation, Actions, source merge or deployment is authorized.
