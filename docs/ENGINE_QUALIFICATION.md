# Windows engine qualification

Status: implementation input selection, 2026-10-19. This is not installed-product, security or full capability acceptance. Exact source revisions and license digests are in `SOURCE_MANIFEST.json`.

## Selection and overlap

Use the Windows Commander .NET Windows/Core services as the primary reuse candidate for the HostDeck desktop-session worker. Its current source builds and tests on the target Windows machine with the already installed .NET 10 SDK. Keep HostDeck's public MCP facade, permissions, durable job journal and lifecycle independent of the upstream MCP executable. Do not expose or launch multiple overlapping desktop servers.

The selected project targets `net10.0-windows10.0.19041.0` and uses WPF/WinForms. Framework-dependent deployment needs the .NET 10 Windows Desktop runtime; self-contained packaging must include its runtime and redistribution notices. SDK availability proves build-host readiness, not clean-machine readiness or a final supported-Windows-version guarantee.

| Capability | Primary implementation input | Integration boundary |
|---|---|---|
| Window discovery, geometry, focus, UIA tree and actions | Windows Commander `WindowService` / `UiAutomationService` | Authorized per-user session worker; facade checks identity/session and risk before dispatch |
| Screenshots, regions, monitor mapping, local OCR | Windows Commander `ScreenService` / `VisionService` | Session worker; ephemeral image artifacts, coordinate/DPI validation and explicit capture policy |
| Keyboard, pointer, clipboard and computer-use indicators | Windows Commander input/clipboard/indicator services | Session worker; locked/secure desktops and other sessions rejected; visible activity state |
| Files, structured documents, terminal and process interaction | Existing Desktop Commander source; selected Transductive reliability changes | One file/process engine behind HostDeck contracts, not duplicate Windows Commander file/shell tools |
| Job restart/cancel/timeout, output receipts and artifacts | HostDeck service/runtime | New durable behavior is required; no upstream interactive process list is a durable job database |
| Browser sessions and DOM control | HostDeck-managed browser adapter | Separate browser contract, authenticated local channel and owned profiles; desktop clicks alone do not prove browser capability |
| OAuth, authorization, audit, resources and prompts | HostDeck facade/service | Deny by default; all surfaces governed; upstream defaults do not establish HostDeck's trust boundary |

The Windows Commander backend is an implementation reference, not an authority boundary. Its risk policy treats unknown tools as low risk, GUI actions as medium, and only high-risk tools as confirmation-gated. Its bounded in-memory audit queue is not durable and may hold original arguments. HostDeck must apply its own deny-by-default registry, per-tool authorization, redacted durable audit and a private authenticated worker channel before invoking reused services.

## Candidate comparison

| Source | Observed fit | Gaps and disposition |
|---|---|---|
| exalsch/windows-commander-mcp | .NET 10, Win32/UIA/WinRT OCR, 60 tools advertised; local Windows build/tests and narrow stdio probe pass | Primary desktop code candidate. Standalone server has tools only, echoes requested protocol versions, and does not provide HostDeck service/session isolation, OAuth, resources/prompts, durable jobs or installer. Replace its public server/policy/audit boundary rather than forwarding all 60 tools. Recycle, rich clipboard formats and some file metadata remain incomplete. |
| CursorTouch/Windows-MCP | Python UIA/screen/input implementation and broader snapshot references | Pinned source requires Python >=3.14, FastMCP >=3 and multiple native packages; inspected local Python is 3.12. Telemetry is enabled unless explicitly disabled. Retain as a source/behavior reference and reassess individual missing capability implementations; do not add a second full desktop runtime by default. No execution qualification claimed. |
| deploymenttheory/windows-mcp-server | Windows control plus posture policy, audit, containment and diagnostics references | Pinned module requires Go 1.26.0 and agentweave-harness/mcp-server-core. Its own test explicitly requires default audit-only policy to permit destructive calls, even when posture signals fail. Reference selected controls, but do not confuse audit mode with enforcement or enable firewall/containment effects during source qualification. No Go build/runtime acceptance claimed. |
| TransductiveScience/desktop-commander-mcp | Native HTTP routing and terminal/process fixes in the inherited Node code family | Review incremental diffs for future reuse. Inspected auth defaults to `none`; OAuth validation relies on a configured verifier module. Session map lookup alone is not proof of identity binding. Do not wholesale merge deployment configuration, external destinations or authorization assumptions. No Node runtime qualification claimed here. |

The selected .NET source includes actual Windows.Media.Ocr pixel recognition; installed language packs are a runtime dependency and absence fails explicitly. OCR confidence is not supplied by that API, so the source's constant score must not be presented as measured confidence. Screenshot fallback behavior and UIA provider hangs still require targeted acceptance tests.

## Windows evidence

At Windows Commander commit `a5b33fed0994dc65782bf8cfb8e1168253098fcf`, with .NET SDK 10.0.400:

```powershell
$env:DOTNET_CLI_TELEMETRY_OPTOUT='1'
$env:DOTNET_NOLOGO='1'
dotnet test WindowsCommander.slnx -c Release --logger 'trx;LogFileName=qualification.trx' --results-directory <private-results-directory> --nologo
```

Result: 30 passed, zero failed, zero skipped. Coverage includes local temporary filesystem round trips, registry/service/display reads, schema/policy and service unit checks. It does not prove installed-service lifecycle, cross-session isolation, real typing, OCR/screenshot fidelity or all 60 tool behaviors.

A separate ephemeral stdio qualification probe ran the actual built executable and verified six observations: initialize, no response to the initialized notification, 60-tool discovery, a nonempty successful display-metrics result, a nonempty successful window-list result and rejection of an unknown tool. Requests used baseline protocol `2024-11-05`; this is not evidence of current MCP protocol compliance. No raw window titles, screenshots, system identities or tool payloads were logged or committed. The TRX/build log and sanitized probe summary are retained privately with Operator checkpoint references.

Source inspection found no custom MSBuild Exec hooks in the selected solution before build. NuGet restore and local tests were run; no upstream installer, service registration, unattended-control override or remote endpoint was enabled.

## Licensing and lifecycle conditions

All four pinned repositories have MIT root licenses at the inspected revisions. Their exact notices must accompany copied source and distributed substantial portions. This qualifies source-level reuse subject to those notices; it is not final clearance of transitive dependencies or release binaries. No third-party desktop implementation has been copied into HostDeck by this qualification.

Before adopting a source module, keep its original attribution, record the imported files and revision, inspect dependency licenses, and add HostDeck behavior tests. The worker must run in the authorized logged-in user's session, expose only a bounded private API, enforce session ownership and cancellation/deadlines, and report loss of desktop access truthfully. The service must not inject input from session 0 or automatically cross UAC/secure-desktop boundaries.

Remaining work includes worker authentication/ACLs and lifecycle, service and tray integration, authoritative tool contracts, durable jobs, browser control, protocol conformance, OAuth ingress, installer/upgrade/rollback and full ChatGPT acceptance. The unavailable earlier v0.1 archive remains a separate recovery/input gate; this selection does not reconstruct or claim to have reviewed it.
