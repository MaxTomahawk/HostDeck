# Internal user runtime foundation

Status: development adapter, no public listener or installed service. `UserRuntime` implements four file operations and three pipe-process operations using the canonical schemas. The larger runtime task remains open for document integration and real policy/native/protocol acceptance. This module imports no inherited server startup, configuration, telemetry or browser renderer. No prototype archive was imported.

Create an instance with a fixed device ID, an existing canonical workspace, explicit environment, configured absolute shell executables and a trusted facade admission callback. Every request requires admission; errors or missing admission deny. Recheck admission after queued work and before each write/spawn/input. The callback must perform actual policy/audit admission in the later facade; a callback returning true in a test is not authentication or authorization evidence. No remote or service integration is approved on that basis.

`implementedTools` contains only `hostdeck_read_file`, `hostdeck_write_file`, `hostdeck_edit_text`, `hostdeck_file_info`, `hostdeck_start_process`, `hostdeck_read_process` and `hostdeck_interact_process`. A facade still intersects those names with verified policy. Unknown contract names fail and known unsupported handlers return `UNAVAILABLE`. No default device/session/executor substitution occurs.

## Files

UTF-8 text is bounded to 10 MiB per input/output snapshot; binary/NUL or invalid UTF-8 is refused by text reads/edits. File reads follow the canonical line semantics. Exact literal edits require the expected occurrence count before replacing content. File operations are serialized within one runtime; a temporary exclusive file and rename commit writes only after another admission check. Count mismatch leaves the original unchanged. Cross-process editors are not serialized by this queue and can still race a read-modify-write.

Paths outside the workspace, Windows streams/control characters and existing symlink/junction components are refused. These cooperative-use checks **do not** provide native handle/token confinement or prevent same-user reparse/hardlink/rename races. Do not deploy this adapter as a file-only remote sandbox. Windows file-only authority remains disabled until the security model's OS isolation and opened-object enforcement are implemented. Authorized shell users already hold broad user-level authority.

The per-runtime cap is 32 admitted/in-flight requests, including stalled authorization and queued file operations. Saturation rejects new admission with `LIMIT_EXCEEDED`; it does not retry effects. This supplements later ingress byte/rate limits and executor quotas.

## Processes

The caller selects only a server-configured PowerShell or cmd executable. PowerShell uses no profile, text output, UTF-8 console pipes and suppressed progress serialization. No environment is inherited except explicitly configured variables. WSL returns `UNAVAILABLE` until an actual Linux executor/workspace binding exists. Launch only under the OS-authenticated unelevated user executor; this module cannot establish that identity itself and must never run user commands with service authority.

Each child has a random per-runtime handle; other instances/raw PIDs cannot control it. Observation timeouts return `running`, not success. Pipes support input without claiming a PTY. A write has one pending-input fence and a deadline covering write completion. If its completion is unknown, the receipt says `input_delivery: uncertain`, `retry_safe: false`; input can still arrive later and must never be automatically retried. A successful stream callback says `written_to_pipe`, not that the application consumed or acted on it.

Combined stdout/stderr retain at most 1 MiB of UTF-8 prefix data with an explicit truncation flag. Retention stops at the first truncated chunk, preserving complete code points. Line offsets refer to that retained snapshot. A running incomplete last line sets `partial_line: true` and keeps `next_offset` on that line: clients replace the provisional line when polling that offset, rather than appending its returned prefix again. EOF finalizes an unterminated last line. Relative ordering of the two OS pipes is observed arrival order. Stderr is not independently addressable in this foundation.

At most 32 process records are retained; an old closed record can be evicted to admit new work. An evicted handle returns `UNKNOWN_PROCESS`. A failed spawn reports `failed` and no successful exit receipt. No process-tree termination tool is advertised. `dispose` ends only direct child handles and reports failure if they remain; descendants can outlive their parent. Native job objects, cancellation/reconciliation and durable output/artifact delivery remain required work before lifecycle acceptance.

## Verification and provenance

Run `npm run test:hostdeck:contracts`, `npm run test:hostdeck:runtime` and `npm run build` on Windows. Runtime tests perform real file and PowerShell work inside temporary directories, including output/input, environment isolation, saturation, revocation, Unicode and cursor regressions. The callbacks are controlled policy-boundary fixtures; they do not verify OAuth, Windows SID/session identity, ACLs or installed lifecycle. The adapter is newly written against the existing Node dependencies; inherited document handlers remain unchanged and await integration. Root MIT attribution remains in place.

The initial full inherited `npm test` attempt did not complete: runner cleanup after `test-conditional-tools.js` rejected with Windows `EPERM` while removing its temporary test home. That is an unresolved baseline/harness result, not a passing full suite. Its build and earlier modules completed; the isolated HostDeck suites and full build pass separately. Investigate cleanup and obtain complete inherited regression evidence before accepting the full runtime task.
