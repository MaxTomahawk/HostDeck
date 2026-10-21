# Windows lifecycle and desktop adapter

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
