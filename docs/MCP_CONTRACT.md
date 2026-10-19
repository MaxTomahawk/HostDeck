# HostDeck MCP contract v1

Status: implemented contract registry; backend, transport, authorization and end-to-end acceptance remain separate. Canonical code is `src/hostdeck/contracts.ts`, `contractVersion = 1.0.0`. This is an additive catalog for the full product scope, not a claim that the catalogued capabilities are already installed or exposed.

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
