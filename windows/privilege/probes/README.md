# B007 intended-client boundary — source-only diagnostic

Owner decision Q-HD-0007, HD-POL-DR01-0007, and HD-REQ-0123–0129. Public source pin: 6c1db056e4f649db29415442de7958501d34f62e. Private canon research pin: e1353f01e48140bcafa12866c99e414b8844137f.

**This is not a signer, authentication decision, approved mandate, deployment or acceptance proof.**

## Verified existing code boundary

Two independently enrolled but same-Windows-SID CurrentUser certificates are used for broker requests. Bridge.Common.ps1 signs request bytes with the user-accessible nonexportable CNG private key. Submit-AdminRequest.ps1 accepts client-provided goal, mandate_evidence, risk, action_summary, project_id and chat_id. Broker.Tick.ps1 receives a queued JSON file and verifies the signature, enrolled client_id, cert, inbox, script hash and limited metadata. It does NOT hold an authenticated IPC connection to the process that initiated signing. Non-critical mandate semantics are client-assessed. A critical goal requires a distinct owner-signed approval. The previously observed unpackaged same-SID ability to use both enrolled keys is an actual negative observation, not merely a hypothesis.

Nonexportable means normal private-key export is prevented; it does not mean a different same-SID process cannot ask CNG to sign. A disabled remote privileged adapter does not prevent the same local Windows user from reaching an authorized public signing helper when ordinary process execution is allowed.

## One-shot metadata probe source

ClientBoundaryProbe.csproj and Program.cs are an **unelevated, read-only and non-installed** .NET 10 Windows probe. It takes two privately selected current process IDs: the candidate Codex process and an existing unpackaged same-SID comparison process. It reads only PROCESS_QUERY_LIMITED_INFORMATION, TOKEN_QUERY and separate READ_CONTROL process handles. It never enumerates other processes or uses signing keys, broker inboxes, privileged APIs, creation/injection rights, process control, network, clipboard or system configuration.

The program reports only categorical JSON about: process and token package identity presence; whether process/token package names agree; TokenIsAppContainer; two observed Windows user SIDs and logon-authentication IDs being equal/unequal; session equality; process creation-time availability; process image location availability; process owner equals observed token user; and whether the process DACL is readable/non-null. **Raw package strings, PIDs, SIDs, logon IDs, paths, parent process records and ACL bytes are not printed.** Image-signature trust, effective DACL rights, parent provenance, package signer, image loaded-module integrity and injection/GUI effects are explicitly NOT_TESTED. Unknown access means UNKNOWN, never positive assurance.

The probe source is deliberately outside the installed broker implementation and its pinned installation manifest. It is NOT built/run by this delegated chat; private Codex review may build using the already approved .NET SDK in an isolated private build directory and invoke with only two authorized observed process IDs. Exit zero means only that both read-only token queries succeeded; it is NOT an intended-client acceptance result. Exit 2 means incomplete observations; 64 means wrong platform/input. Any local IDs or additional diagnostics stay private.

| Metadata | Actual supported observation | Explicitly unsupported conclusion |
|---|---|---|
| MSIX package identity present | Package on this handle/token | App-only protection, exclusive key access |
| AppContainer yes/no | OS token flag | Protected signer or authorization exists |
| Same SID/logon/session | Same kernel-observed account/session metadata at read time | Same intended app or exclusive control |
| Process owner/DACL readable | Current process descriptor is readable | Effective injection resistance, secure parent chain |
| Signed image/publisher/parent/PID | Could be recorded in a separate private trust review | Cryptographic process attestation |
| Valid broker signature | A registered key signed bytes | True Codex origin, owner mandate or actual SYSTEM outcome |

MSIX full-trust medium-IL processes often have package identity but NO AppContainer isolation. Microsoft references: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/app-capability-declarations ; https://learn.microsoft.com/en-us/windows/win32/api/appmodel/nf-appmodel-getpackagefullname ; https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-gettokeninformation .

## Specific missing enforcement choice

A protected signer must hold keys **unusable by arbitrary same-SID processes** and independently authorize each concrete action before any privileged effect. The future boundary needs actual authenticated peer IPC (e.g. kernel-observed token/session/package/AppContainer identity), process handle+creation-time tracking, appropriate protected signer/key ACL, true owner/device/goal scope, and denial of unintended peers. A PID, parent, executable path, publisher signature, package Boolean, GUI window or self-declared chat/project field alone cannot be its authorization proof. Process-creation/image observations require a separately trusted source; the existing queued-file broker has no such source. Kernel callbacks are a driver deployment matter, not an authorized probe: https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntddk/nf-ntddk-pssetcreateprocessnotifyroutineex .

Two potentially enforceable approaches require a **separate product and deployment decision**:
1. Genuinely isolated Windows logon principals for intended Codex and HostDeck routes with protected key/signing credentials and separate access checks.
2. A separately protected LocalService/SYSTEM signer admitting only validated, isolation-constrained package/AppContainer/capability principals via an authenticated kernel-identity channel, *if actual installed processes support that boundary*, with per-operation owner mandate checks.

A plain shared-SID pipe, accessible user-owned key, signed full-trust MSIX binary or restricted process name is not sufficient. Even a protected signer does not guarantee resistance to same-user injection/GUI control of a legitimately authorized client without independently effective OS isolation. No absolute defence is claimed against a fully compromised Windows user or administrator.

The missing owner choice is precisely which **attacker capability is excluded**, whether an AppContainer/separate-SID client is operationally acceptable, who owns the **separately protected signer/trust root**, and the action/mandate and recovery policy it would enforce. This PR implements none of those transitions and does not self-authorize them.

## Requirements coverage and unchanged historical evidence

- HD-REQ-0123: meaningful purpose/mandate not proven by required string length or signing.
- 0124: project/chat optional; absent project is not absent authorization.
- 0125: script and envelope hashes link to client-claimed action summary, not caller process identity or independent effect.
- 0126: completed-unverified-effect/signed-client assertion are not target readback.
- 0127: UTC event chronology and Europe/Amsterdam DST surface verification remain an independent check.
- 0128: enrolled client/SID/certificate are verified; intended app, true source and declared context are not.
- 0129: same-goal retry checks exist; unchanged or changed purpose/mandate must have independently enforceable authorization before future SYSTEM effects.

HD-TC-DR01-0007 requires a negative unintended-same-SID client test. The already observed key usability prevents a current-client-exclusivity PASS. All existing broker scripts, keys, owner-signed critical approvals, Windows services, ACLs, registrations, source manifests, NEXT_RUN and app functionality remain untouched. No live privileged test or ordinary ChatGPT acceptance is represented by this source-only PR.
