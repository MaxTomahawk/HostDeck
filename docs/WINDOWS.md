# Windows lifecycle and desktop adapter

The optional Everything provider uses a bounded `--everything` one-request native child in the authorized user session. It never starts or controls the vendor app/service. Configuration pins the existing executable, SHA-256, exact file version and named/default instance. Each observation checks the worker's eligible medium user/session/logon context and the target process's executable, SID, session, token elevation and authentication/logon ID before local IPC2 traffic. Each query has its own reply window and child lifetime; cancellation affects only that child. Only an escaped authorized root enters the vendor query; original HostDeck matching, path checks and metadata readback remain in the file adapter. No vendor DLL or extra network service is required. Exact-tuple local tests do not qualify other versions, lifecycle or ordinary ChatGPT.

Filtered user execution includes an action-local `PATHEXT=.COM;.EXE;.BAT;.CMD`. This makes Windows PowerShell native invocation wait for the actual child and preserve its stdout and exit code; machine-wide environment settings are untouched.

The native JSON-lines channel and PowerShell command output use UTF-8. HostDeck
suppresses PowerShell progress records; interactive output keeps decoder state
across pipe chunks. Unicode PDF creation/insertion uses the configured Chromium
executable with a fresh owned profile, escaped text, JavaScript disabled and all
network requests blocked. Glyph coverage depends on installed fonts. Without
that renderer, unsupported text fails explicitly instead of being replaced by `?`.

HostDeck uses three Windows executables in `windows/`: `HostDeck.Lifecycle`
(LocalService), `HostDeck.Tray` (unelevated enrolled user), and
`HostDeck.DesktopWorker` (unelevated user child). The service owns a narrow
named pipe for user-agent presence and health. It never starts a shell or
touches the interactive desktop. The tray starts the Node facade as
`agent/node.exe agent/dist/hostdeck/main.js --http --config <path>` on user
logon. The facade must start the desktop worker only after the private
identity handshake succeeds, and must enforce public contracts/policy before
forwarding any operation. Native worker stdin/stdout is private to that
facade. There is no desktop TCP listener.

The worker source copies Windows Commander Core/Windows at upstream commit
`a5b33fed0994dc65782bf8cfb8e1168253098fcf` under the MIT license in
`windows/vendor/LICENSE`. HostDeck bounds its UI Automation enumeration;
see `windows/vendor/PROVENANCE.md`. No upstream MCP server or telemetry is
started by these executables.

## Private adapter protocol

Run `HostDeck.DesktopWorker.exe --identity` once or send
`{"id":"...","operation":"hostdeck_internal_identity","args":{}}` to
`--stdio`. The OS-derived response includes SID, account, token logon LUID,
session ID, elevation, integrity, input desktop, window station and
eligibility. The facade must match the protected enrolled SID, current logon
identity and explicitly selected session; require medium-integrity,
unelevated `WinSta0/Default`; and reject stale worker generations. These
identity fields are private and must not be published as a public MCP tool.

The installer also creates a protected enrollment directory. On first service
start, LocalService creates a nonexportable named CNG P-256 signing key under
its own profile, records its public SPKI SHA-256 fingerprint, random device ID
and generation 1 in `enrollment/device.json`, and preserves that identity
across upgrades. If the recorded key or fingerprint is missing/mismatched,
service startup fails closed. The unelevated facade can call
`HostDeck.DesktopWorker.exe --verify-enrollment <absolute protected device.json>`:
the verifier checks the pipe server's kernel PID, session-0 LocalService
token, fresh challenge signature and exact pinned device metadata. It returns
`verified`, `device_id`, `generation`, `fingerprint`, `sid`, `session_id` and
`logon_id` for the facade's private bootstrap. The service pipe does not
support enrollment/rotation commands; rotation/revocation needs an explicit
administrative transaction and registry binding before remote trust.

Normal stdin JSON Lines request:

`{"id":"opaque-correlation","operation":"hostdeck_list_windows","args":{"session_id":1}}`

Normal response: `{"id":"opaque-correlation","result":{...}}`. Failure:
`{"id":"opaque-correlation","error":{"code":"WRONG_SESSION"}}`.
The worker requires the explicit current positive session ID for every
canonical desktop operation, rejects session 0, elevated tokens, noninteractive
stations, locked/secure desktop and cross-session window targets. Window,
monitor and UI element references are random per-worker IDs. Window references
expire after one minute and are invalidated on another window enumeration;
UI references are invalidated on another tree read. Native HWND and UIA
runtime IDs never cross the pipe. The facade must recheck authorization
immediately before each effect and replace the worker on logoff/unlock or
identity change.

Implemented canonical operations: `hostdeck_list_windows`,
`hostdeck_display_metrics`, `hostdeck_window_action`, `hostdeck_read_ui_tree`,
`hostdeck_find_ui_element`, `hostdeck_invoke_ui_element`,
`hostdeck_set_ui_value`, `hostdeck_type_text`, `hostdeck_send_keys`,
`hostdeck_mouse_action`, `hostdeck_capture_screen`, `hostdeck_ocr_screen`,
`hostdeck_read_clipboard` (text, HTML, image, files),
`hostdeck_write_clipboard` (text), and `hostdeck_write_clipboard_artifact`
(HTML, image, files). Captures and clipboard images return `png_base64` for
the facade to store as owned artifacts. HTML returns `html_text`; file drops
return a bounded `files` array for private artifact delivery. OCR reports
`confidence_status: "unmeasured"` and null confidence. For rich clipboard
writes, the facade must authorize and read the owned artifact, verify its
integrity and format, then append private `internal_data_base64` to the
worker request. The worker limits decoded data to 16 MiB. The public client
cannot supply this field through the canonical tool schema.

## Durable native command runner

`HostDeck.DesktopWorker.exe --run-job <absolute private request JSON path>`
is a separate, detached mode. Its request has `command`, `cwd`,
`shellExecutable` (absolute path to `cmd.exe`, `powershell.exe` or `pwsh.exe`),
`timeoutSeconds`, `stdoutPath`, `stderrPath`, `receiptPath`, `cancelPath`,
and optional `environment`. All paths must be absolute. Requests use a private
`<32-hex-job-id>.request.json` file, with matching `.out`, `.err`, `.json`,
`.cancel` and `.live.json` siblings for output, receipt, cancellation and liveness.
Validation failures before execution also produce a failed receipt when this
private request identity is valid. The user agent must
create the request/output directory with user-only ACLs and start this runner
under the authorized unelevated user token. The runner creates the shell
suspended, assigns it to a Windows Job Object with kill-on-close, then resumes
it. A cancel file or timeout terminates that owned job tree. It writes an
atomic JSON receipt with `status`, `exitCode`, start/end times and
`descendantsContained`. No cancellation uses a supplied PID. A lost runner
closes the job handle and kills remaining descendants. The user facade must
reconcile a missing receipt as uncertain, not success.

## Local build and package

Build the three projects with `dotnet build windows/HostDeck.DesktopWorker/HostDeck.DesktopWorker.csproj`,
and likewise `HostDeck.Lifecycle` and `HostDeck.Tray`. Packaging requires a
reviewed, built Node facade, Node executable and a new output directory:

```powershell
pwsh -NoProfile -File windows/install/New-HostDeckPackage.ps1 -AgentRuntimeDirectory <repository> -NodeExecutable <node.exe> -PackageDirectory <new-package-directory>
```

The package builder requires PowerShell 7; parsing it in Windows PowerShell 5.1 does not establish runtime compatibility. Packaging publishes self-contained win-x64 .NET binaries, copies the facade
distribution and management UI under `agent/ui/newtree`, installs Node production dependencies with
`npm ci --omit=dev --ignore-scripts`, copies Node, and hashes every packaged
file into `manifest.json`. Review the resulting public-source and dependency
contents before release. The installer is an administrative transaction and
must be run only by the owner/integration gate:

```powershell
windows/install/Install-HostDeck.ps1 -PackageDirectory <package> -InstallRoot <protected-absolute-directory> -EnrolledUserSid <actual-user-SID> -FacadeConfigPath <prepared-config> -GrantsPath <prepared-grants> -StateDirectory <new-private-state-directory>
```

On first install, the installer generates a random 128-bit device ID and
rewrites the prepared config and its matching grant entries to that ID. The
prepared config and grants are copied under the
protected install root; only Administrators/SYSTEM can alter them, and the
enrolled user can read them. The new state directory grants only that user
Modify and Administrators/SYSTEM Full. Upgrades preserve config, grants and
state. Choose an explicit machine-data directory outside the install root and any packaged application's profile cache. A packaged host can redirect a visible user-profile path to a different physical directory, leaving SYSTEM unable to find the visible path. Verify the chosen location from both the enrolled user and SYSTEM. Any migration must preserve the original data, rebase active artifact storage references, and check the existing job/artifact identities and bytes before switching the protected configuration.

The installer verifies the manifest, stages exact files, stops the service,
switches `current`/`previous`, registers LocalService with a service SID,
starts it and restores the old release on failure. It does not add a firewall
rule or change a tunnel, DNS or production identity. An enrolled user then
runs `windows/install/Register-HostDeckUser.ps1` unelevated with
`-InstallRoot`; it verifies the enrolled SID and sets only that user's HKCU Run entry.
`windows/install/Rollback-HostDeck.ps1 -InstallRoot <path>` restores the
previous package. A real fresh installation and package update completed;
installed enrollment initially revealed Windows process-query permission failures.
The subsequent update passes repeated signed enrollment challenges, enrolled-user
tray startup and loopback HTTP checks. Installed detached-job reconnect still
requires its startup fix. Reboot recovery and final upgrade/rollback acceptance remain pending; see
[NEXT_RUN.md](NEXT_RUN.md) for the current checkpoint.

## Direct Cloudflare Tunnel

`Install-HostDeckCloudflared.ps1` prepares a dedicated locally managed Windows
tunnel. Supply the exact official binary's SHA-256, tunnel UUID, public hostname
and protected per-tunnel JSON file. It copies verified executable bytes into a
protected directory, uses LocalService, routes the hostname to loopback port
18763 and ends ingress with 404. It refuses an unrelated existing service.
Validate configuration with `-ValidateOnly` before installation. Configure the
Cloudflare access application/policy and compatible HostDeck authentication
before publishing DNS. Keep account-management certificates out of the service
directory; only per-tunnel credentials belong there. No inbound firewall rule or
RatServer proxy is needed. `-RemoveService` removes only the owned service and
retains protected files for recovery. A prepared helper is not live-tunnel proof.

The LocalService named pipe `HostDeck.Service` accepts only short
`{"operation":"register"}` messages or status queries. The service checks
the caller's pipe-impersonated OS SID and kernel-reported process session
against protected enrollment before returning health and last user-agent
presence. The pipe conveys no public MCP data or command execution.

## Direct Codex signed SYSTEM broker

The separate Codex administration bundle is intended to install a persistent
SYSTEM task that runs scripts signed by the enrolled client key. This is broad,
standing delegation, not a command catalog: any script authorized by that
client can execute as SYSTEM. The prepared enrollment contains two
nonexportable client keys bound to the same Windows SID. Requests and results
must retain their signature verification, request/goal context, and protected
audit receipts. The user SID is the local authorization boundary; optional
remote-host management must stay opt-in and use exact grants.

The owner signing identity is a nonexportable RSA key in the LocalMachine
Microsoft Software KSP, created and ACL-checked by an administrator. Its key
ACL is administrator-controlled; it does not form a security boundary against SYSTEM.
The Windows CNG ACL mechanism uses `NCryptSetProperty` with
`NCRYPT_SECURITY_DESCR_PROPERTY` ([Microsoft API reference](https://learn.microsoft.com/en-us/windows/win32/api/ncrypt/nf-ncrypt-ncryptsetproperty)).
Store timestamps in UTC; presentation may convert them to Amsterdam local time.
Bundle preparation and focused checks do not prove that an initial UAC
bootstrap installed the SYSTEM task. Require protected install receipts and an
unelevated signed-client probe before recording acceptance.

Any process that can run code as an enrolled signing account may use that
account's key. This includes terminal execution under that account: a
`host:manage` tool grant is not an independent OS boundary against such code.
Account/key isolation must be assessed before granting less-trusted remote
principals process execution or enabling a remote management bridge.

## B007 WP-01/06: durable jobs, signed-client evidence and lifecycle preflight

**Base:** codex/everything-b007 at 3e9403cfad3e968447f7f026dec6915b7f880d7b. This is a bounded engineering/acceptance matrix, not a second NEXT_RUN plan, permission change or live Windows transition.

### Cancellation and recovery contract

| State or request | Honest receipt/readback | Authorization and evidence boundary |
|---|---|---|
| Native cancellation *requested* | cancelling, cancelled:true = accepted request, outcome:uncertain | Only the owned job's private cancel flag, never arbitrary PIDs; no automatic retry |
| Native cancelled/timed_out receipt | Confirm terminal state only when descendantsContained:true from that owned native Job Object | Actual TerminateJobObject, root handle completion and QueryInformationJobObject active count, not generic job membership |
| Missing/invalid receipt or no containment | uncertain or interrupted, never confirmed cancelled | Preserve raw receipt/outputs/marker; do not replay resume:never |
| Complete receipt before concurrent cancel | Reconcile receipt first and return terminal status; do not write cancel flag | Owner/device/executor-bound durable job |
| Legacy PowerShell kill signal | Report uncertain descendant outcome, not cancelled | Node ChildProcess.kill indicates a wrapper signal only |
| Artifact write failure after terminal receipt | Preserve original private .json/.out/.err and report artifact retention failure | Do not erase the only copy of output or pretend artifact success |
| Reconnect/restart | Reuse job ID/idempotency key/artifact hashes and stored effect receipts | No accepted command re-execution; owner/device/executor binding persists |

The JobStatus.Check marker validates a PID against process creation ticks, session and SID, but **does not** prove that this process belongs to HostDeck's intended native Job Object or that every descendant exited. IsProcessInJob(process, null) proves membership in **some** job, never ownership of the Codex/HostDeck job. Only the native runner's own Job Object handle and active-process accounting support the positive descendantsContained claim. If the handle is gone or the receipt lacks that proof, status remains uncertain.

### Original owner audit atoms: purpose/action/effect/context/time

**HD-REQ-0123–0129**, original S01-L0006738 at **2026-10-20 06:35:10.776 UTC = 08:35:10.776 CEST (Europe/Amsterdam)**. The source code and B005 future policies do not close these separate acceptance gates.

| Requirement | Concrete acceptance need | Existing source and evidence limit |
|---|---|---|
| 0123 | Nonempty meaningful purpose, separately authorized mandate/scope/risk, before elevated effect; purpose linked to receipt | Submit-AdminRequest and Broker.Tick validate goal, mandate and action metadata, but string length and valid signing alone do not verify purpose or mandate |
| 0124 | Accept requests without an Operator project; never manufacture a project/chat ID | ProjectId and ChatId are optional. Missing project does not mean missing owner mandate |
| 0125 | Claimed action summary, exact script SHA-256 and actual broker operation joined in a sanitized audit | Script hash and action fields exist; submitted action_summary is not an independent effect observation |
| 0126 | Compare expected_change against actual post-effect values, method and evidence hash | completed-unverified-effect and signed client assertions are not independent OS readback |
| 0127 | Accurate UTC chronology and Europe/Amsterdam DST rendering across request, native and public surfaces | Original raw receipt strings use UTC; PowerShell JSON date coercion caused the apparent offset discrepancy. HD-B007-AUDIT-UTC-RAW-001 and the unchanged Windows PowerShell 5.1 audit display pass four DST cases. Preserve raw strings; broader cross-surface audit acceptance remains open. |
| 0128 | Enrolled client credential, real origin, purpose/project/chat context when supplied, explicit unavailable state otherwise | Signed client_id/cert can establish enrolled signer, not which same-SID application originated a request; public status omits some source receipt fields |
| 0129 | Same-goal continuation and changed-purpose scope/risk review, no blind replay after uncertain effect | retry_of/goal and owner checks exist; genuine client exclusivity and target effect/retry acceptance remain unproven |

**HD-REQ-0132**, S01-L0010541 at **2026-10-21 10:49:59.283 UTC = 12:49:59.283 CEST**: measure exact idle/active component set, timers, CPU/RAM/disk/network bytes and index/service startup cost before claiming efficiency. No automatic monitoring is authorized. B005 DR01-0007 establishes the **future** requirement for distinct intended Codex/authorized HostDeck clients, not proof that current signed requests enforce such process isolation.

**Specific same-SID threat:** another executable under the same account may be able to invoke the CurrentUser signing key or submit a request under an enrolled client identity. Valid RSA signature, client_id, process display name or a self-reported chat_id proves neither exclusive intended-client origin nor owner authority for arbitrary SYSTEM effects. Stronger isolation requires a separately protected signer/client identity boundary with target-action admission and effect verification; no broker reenrollment, key export, ACL change or other privilege mutation is performed by this patch. Signed broker policy remains in force but is not misrepresented as a cryptographic process-identity proof.

### Lifecycle: preflight → future effect → recovery (transitions NOT_RUN)

| Scenario | Read-only preflight | Later separately authorized effect/check | Recovery proof |
|---|---|---|---|
| User logon | Enrolled SID/LUID/session, service state, tray, HTTP listener, user worker, Everything process/IPC and startup context | Check actual session-bound status and safe MCP query; no automatic app startup in this delegation | Original user settings and exact startup receipts preserved |
| Crash or launcher exit | Journal/receipt/marker, PID+creation/SID/session, artifact hash and ownership | In a disposable authorized fixture only, inspect recovery and no-replay; process death alone is not tree containment | No re-execution, prior receipts and idempotency intact; unknown effects remain unknown |
| Reboot | Current/previous package version, source hash, protected state directory, owner/session identities and planned downtime | Reboot only under independent human-approved run; verify fresh session, service/tray/HTTP/Everything and job readback | No stale PID/session carried across reboot; persistent receipts/artifacts/permissions |
| Update | Signed staged package, exact hashes, compat/config/ACL diff, previous stable package | Apply only after concrete reviewed release mandate and verify service/UI/MCP health | Previous version rollback candidate, journal and configuration map; no silent version promotion |
| Rollback | Known previous package and full state/receipt/config baseline | Apply only under separate authorization and verify effect via actual readback | Verify restored binary, preserved artifact/job identities and settings; backup alone is insufficient |

**Runtime observation supplied by owner:** 2026-10-26 **20:39 UTC = 21:39 CET** (DST ended October 25). HostDeck and cloudflared services were Running; tray, loopback HTTP and user Everything unavailable. Root cause **not proven**. Existing Codex user-app recovery is separate. Do not infer intended job membership from IsProcessInJob(null), or claim service Running proves HTTP/client/desktop readiness. Register-HostDeckUser.ps1 variables are not changed or called defective by this PR.

**Narrow tests for Codex Windows integration:** execute the new receipt-interpretation and isolated job-recovery fixtures, plus one existing bounded native job/descendant regression. A source/mock PASS never qualifies installed product; Windows-native tests must report SKIP when build unavailable. Ordinary ChatGPT independent acceptance and logon/crash/reboot/update/rollback effects remain separate. No installed user app, existing job, Windows service, tunnel, index, key, task, ACL or grants are modified by this source-only branch.
