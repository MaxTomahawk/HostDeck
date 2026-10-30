# Security acceptance scenarios

Status: the scenario table is a required test contract, not an executed test report. Scoped candidate evidence below does not close the full table. Reference: `SECURITY_MODEL.md`. Synthetic identifiers below represent separate principals, devices and sessions; they are not deployment configuration.

Every runtime result needs the tested SHA/version, a repeatable command/scenario, the expected effect or lack of effect, sanitized evidence and independent review. Denial checks must prove the backend/effect was not reached, not merely inspect an error message. Positive controls prove legitimate authorized work remains usable.

| ID | Boundary and scenario | Required observation | Evidence owner |
|---|---|---|---|
| AUTH-01 | Missing/expired token; wrong issuer/audience; ID token; unsigned or invalid signature | HTTP 401; no protected MCP discovery/private data/effect; minimal public OAuth metadata remains available; no raw credential in response/log | OAuth ingress |
| AUTH-02 | NaN/infinite/missing expiry, future not-before beyond tolerance, issued lifetime over ten minutes, provider-profile mismatch | Reject; clock tolerance and issued-lifetime boundary explicitly tested | OAuth ingress |
| AUTH-03 | Valid token missing one required scope | HTTP 403 with appropriate challenge; no backend dispatch | OAuth + facade |
| AUTH-04 | Key/metadata endpoint failure or token-controlled key URL | No anonymous fallback or arbitrary fetch; bounded failures/cache behavior | OAuth ingress |
| AUTH-05 | Later HTTP GET/DELETE, reconnect or event request with absent/changed identity | Authentication checked per request; session cannot confer authority | Transports |
| AUTH-06 | Canonical resource differs from token target; forged forwarded host/proto | No audience/origin inference from untrusted headers | OAuth ingress |
| AUTH-07 | Code+PKCE redirect/issuer/state mismatch or refresh reuse | Flow rejected by actual client/provider profile; no credential disclosure | Remote/client acceptance |
| AUTH-08 | Valid provider-issued token for approved client and device | Allowed scoped operation succeeds; resource metadata/challenge supports reauthorization | OAuth + ChatGPT acceptance |
| POLICY-01 | Unknown tool/resource/prompt or changed adapter discovery | Denied/hidden; no implicit upstream exposure | Registry/facade |
| POLICY-02 | Unknown schema fields, malformed types, invalid enum or target | Validation fails before effect; no permissive coercion | Registry/facade |
| POLICY-03 | Scope present but principal/client/device grant absent or revoked | Denied, including private resource metadata reads and events; public OAuth metadata remains minimal and available | Policy engine |
| POLICY-04 | Client submits authenticated/approved fields or injected text claiming permission | Input confers no authority; existing protected route remains necessary | Policy + approvals |
| POLICY-05 | Authorized resource/prompt access maps to an otherwise denied operation | Shared policy denies; no URI/namespace bypass | Resources/prompts |
| POLICY-06 | Active target vanishes or policy/agent generation changes before dispatch | No fallback target; stale dispatch denied and reported | Facade + worker |
| POLICY-07 | Stored grant permits ordinary file/GUI work | Operation works without repeated prompts; administrative work remains separately bounded | End-to-end acceptance |
| LOCAL-01 | Foreign Origin, rebinding Host, malicious webpage targeting loopback | Reject control request; no wildcard CORS or side-effecting unauthenticated route | HTTP/local UI |
| LOCAL-02 | Untrusted browser debug endpoint/profile, document URL or metadata redirect | No arbitrary endpoint connection/credential forwarding; egress policy tested | Browser/doc/auth adapters |
| DEVICE-01 | Model supplies an unregistered ID/hostname/key mapping or user executor edits enrollment | No enrollment/retargeting; protected registry remains unchanged | Device registry/Windows ACLs |
| DEVICE-02 | Copied ID without its key, revoked credential, old enrollment generation or restored superseded key | Broker call/channel rejected; no grant inheritance or silent re-enrollment | Device registry + real transport |
| DEVICE-03 | Remote broker has generic token/tunnel access but no trusted mutual-TLS device identity | No worker link accepted or private data/effect dispatched | Remote transport |
| DEVICE-04 | Exact authorized enrollment/rotation and protected reinstall migration | New key/owner/generation bind correctly; old connections fail; recovery route remains available | Device management acceptance |
| IPC-01 | Another local user/network peer opens service/agent pipe | OS ACL/remote-client refusal prevents an authenticated request | Real Windows IPC |
| IPC-02 | Impostor pre-creates pipe or opens another server instance | Startup/client channel authentication fails; no secret/effect reaches impostor | Real Windows IPC |
| IPC-03 | Correct-looking JSON SID/session from wrong kernel token or reused PID | Denied using live peer/process creation identity | Real Windows IPC |
| IPC-04 | Impersonation/identity lookup fails | No privileged fallback effect; original thread identity restored | Real Windows IPC |
| IPC-05 | Authorized service and intended user agent handshake | Version/logon/session/generation verified; bounded private operation succeeds | Real Windows IPC |
| GUI-01 | Session 0, another SID/session, logged-off/disconnected, locked or secure desktop | Observation/input denied; no automatic console switch/elevation | Real Windows session tests |
| GUI-02 | Selected enrolled RDP session differs from console | Routes to exact eligible session; console remains untouched | Multi-session Windows tests |
| GUI-03 | UIA reference/HWND recycled, worker restarts or session locks during queue | Stale work rejected; no queued input replays into another application | Windows GUI acceptance |
| GUI-04 | UIA provider hangs or input times out after possible effect | Service remains responsive; truthful uncertain status and no blind retry | Windows failure injection |
| GUI-05 | Approved fixture window under correct unelevated session | Find/read/set/invoke/type/capture and coordinates work; screenshots stay private | Real Windows GUI acceptance |
| FILE-01 | Traversal, case/volume aliases, UNC/device path, junction/symlink escape or swap race | Filesystem-only executor cannot open outside approved actual object boundary | Real Windows filesystem tests |
| FILE-02 | User engine inherits service-only credentials or environment | Engine cannot read protected service material; no silent elevation | Windows token/ACL tests |
| FILE-03 | Authorized file/document operation within policy | Real data round trip and format-preserving edit succeed | File/document acceptance |
| JOB-01 | Same idempotency key with same request versus changed arguments/another principal | One accepted execution/recoverable receipt; changed request conflicts; no cross-owner result | Durable jobs |
| JOB-02 | Client/SSH disconnect, service restart, reboot or missing completion receipt | Accepted job survives client loss; restarts reconcile; interrupted/uncertain work not silently replayed/succeeded | Real lifecycle tests |
| JOB-03 | Cancel/timeout with descendants or PID reuse | Only owned process tree affected; unrelated/reused PID remains untouched | Windows process tests |
| DATA-01 | Guess another owner's job/artifact/event/session identifier | No existence/data leak or control effect | Jobs/artifacts/events |
| DATA-02 | Artifact changed after manifest, expired link, quota or unauthorized delete | Integrity/expiry/ownership enforced; no private path leak | Artifact delivery |
| DATA-03 | Subscription token expires or grant is revoked | Stream stops/reauthorizes; no subsequent private events | Events |
| AUDIT-01 | Secret-shaped arguments, environment, clipboard, file/output bodies | Routine audit contains only approved safe fields and keyed digests | Audit/privacy review |
| AUDIT-02 | Journal admission unavailable, disk full/rotation or audit write fails after effect | No new effect without admission; in-flight uncertainty recorded truthfully | Failure injection |
| ADMIN-01 | MCP principal attempts arbitrary Operator/root/system management | Only registered bounded action with actual authorization/receipt can proceed | Operator adapter |
| ADMIN-02 | MCP or tunnel fails | Independent authorized CLI/SSH recovery remains usable | Real recovery acceptance |
| UPDATE-01 | Changed/unsigned artifact, untrusted path, incompatible upgrade or unapproved downgrade | Transaction rejected; running installation and recovery route preserved | Real installer/updater |
| UPDATE-02 | Clean install, reboot, failed upgrade and approved rollback from reviewed main | Service/agent identities, ACLs, health, jobs and rollback verified on actual Windows | Release acceptance |

Pure policy tests use synthetic verified-principal inputs only at the decision boundary and must never be described as successful authentication. Actual token-signature/provider, IPC/ACL, multi-user session, GUI and lifecycle tests remain distinct mandatory checks. A passing scenario proves only its stated boundary; all release and ChatGPT gates remain in force.


## B007 intended-client boundary: source-only checkpoint, NOT ACCEPTED

B005 HD-POL-DR01-0007 / HD-TC-DR01-0007 asks for separately identifiable **and** independently authorized intended Codex and HostDeck clients. The existing signed Windows SYSTEM broker proves enrolled signature/key and Windows SID association but **not** the exclusive originating process. Actual owner evidence says a regular **unpackaged, same-SID desktop process can use both CurrentUser enrolled client keys**. The remote privileged adapter being disabled is not a separate same-user OS boundary. A source fixture or code review cannot turn this negative observation into PASS. Preserve existing broker and critical owner-approval behavior; do not test via unauthorized signing.

The isolated diagnostic source in [windows/privilege/probes/README.md](../windows/privilege/probes/README.md) inspects **read-only** process handles and token/package/AppContainer/owner/DACL properties, without executing any broker action, altering keys or printing raw private process identities. It does not verify code signing, kernel creation provenance, app injection resistance, effective token rights or owner mandate. Actual Codex MSIX trust level, package/token binding and image-signing evidence remain **UNKNOWN until independently observed**; an MSIX package identity does not by itself prove AppContainer isolation.

**Gate remains OPEN:** true negative test for an unintended same-SID process *before* elevated effect; separate protected signer/trust-root admission, per-client authorization and legitimate goal/mandate enforcement; true installed package isolation and effects. Source requirements HD-REQ-0123–0129 remain separate purpose/action/effect/context/UTC/audit cases. Any selected protected-signer/account/AppContainer solution needs a concrete owner decision and separately authorized deployment. No test of a compromised Windows administrator can be claimed as an absolute guarantee.

## B007 pending authorization correction 062 — scoped source evidence

A real loopback HTTP MCP regression with signed fixture tokens, an on-disk grant store and an owned file reproduces a facade race: grant revocation or revision replacement during the asynchronous executor check still permits backend dispatch and returns the synthetic private bytes. Adapter reauthorization has the same gap. The original failed runs are retained privately.

The candidate rechecks current grants and token lifetime after that asynchronous check, verifies the executor binding and rejects a changed grant revision before dispatch. The same check protects the explicit manager operation and its resource reads. Thirteen affected security/gateway/manager cases pass without skips, including no backend dispatch after revocation, no private read after adapter reauthorization is revoked, expiry/renewal, token expiry while waiting, and manager-resource refusal. Positive controls permit a newly requested operation after renewal without replaying the old request.

The executor barrier is controlled test instrumentation; it is not Windows peer-authentication evidence. Tokens use a fixture signing key, not the deployed OAuth provider. This source result does not close the intended-client, protected signer, streaming-event, installed acceptance or full release gates. No production grant, service or installed module is changed by these tests.
