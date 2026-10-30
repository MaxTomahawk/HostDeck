# HostDeck fulltext native helper — private source contract

Scope: HD-WP-05/06, only `windows/HostDeck.DesktopWorker/FullTextNative.cs`,
`FullTextProtectedAcl.cs`, the existing `Program.cs` entrypoint and the
unregistered `src/hostdeck/fulltext-native-bridge.ts`. No public MCP tools, API
grants, installer, service, config selection or content indexing are changed.

## Launch and framing

The **existing, trusted, installer-pinned** DesktopWorker binary is launched
once with `--fulltext-native`; stdout/stdin exchange one UTF-8 JSON object
per line. It is deliberately a persistent local child process, **not one
`attrib.exe` process per candidate**. The private TypeScript bridge verifies
the exact executable SHA-256 before spawn and verifies a **locally observed**
worker SID, logon ID and session against the trusted executor identity before
accepting operations. An MCP client may not supply that identity or choose a
trusted executable. The worker itself never changes Windows privilege or
permissions and refuses elevated/SYSTEM execution.

Request: `{"id":"1","operation":"attributes_batch","args":{"paths":[<absolute local paths>]}}`

Successful response: `{"id":"1","result":{"count":N,"items":[{"index":0,
"status":"ok","hidden":false,"system":false,"reparse":false,
"hidden_component":false,"system_component":false,"directory":false}]}}`.
All flags are **nullable**, and errors/missing files are `unavailable`, not
fabricated `false`. `reparse_component` is terminal/denied by the fulltext
caller, including junctions in an ancestor. **No filenames or contents are
returned.** Flags come from `GetFileAttributesW` on each component of the
actual UTF-16 path, not from an OEM/console representation or the localized
output of `attrib.exe`.

Request: `{"id":"2","operation":"owner_boundary","args":{
"protectedDirectory":<path>,"selectionFile":<path>,
"approvalFile":<path>,"indexDirectory":<path>}}`

Positive response (only under real Windows kernel checks): `{"id":"2",
"result":{"verified":true,"status":"verified",
"code":"FULLTEXT_NATIVE_BOUNDARY_VERIFIED","protected_sources":3,
"writable_index_separate":true,
"scope":"physical_filesystem_snapshot_only"}}`.
Other responses are explicitly `unqualified`; a non-positive response
**never** authorizes protected config/approval loading. For debugging a
single object there is also internal `effective_acl` with `{"path":...}`.
Internal `identity` reads the worker token; neither endpoint is a public MCP
tool or a writable operation.

## Exact native physical qualification (fail closed)

- The protected directory and **both already existing, separate files** are
  checked individually. The file names must be direct children of the protected
  directory; the SQLite/index directory must be disjoint. The index directory
  must already exist and the current, non-elevated worker token must have
  actual directory create/write/delete-child rights for future SQLite/WAL/SHM
  and the writer-lock companion. The helper **does not create them**.
- Each protected path is checked from the fixed-volume root down to the
  target with `CreateFileW` (`FILE_FLAG_OPEN_REPARSE_POINT`), file identity,
  `GetSecurityInfo` on opened handles, `AccessCheck(MAXIMUM_ALLOWED)` against a
  duplicated **actual current process impersonation token**, plus a strict
  DACL writer and owner trust check on **every ancestor**. Any effective
  `FILE_WRITE_DATA`, `APPEND_DATA`, `WRITE_EA`, `WRITE_ATTRIBUTES`,
  `DELETE`, `FILE_DELETE_CHILD`, `WRITE_DAC`, `WRITE_OWNER`, generic
  write/all, or potentially enabling privileged token rights rejects.
  Reparse paths, hardlinked protected files, unknown ACE forms, untrusted
  owner/write ACE, unreadable security descriptor and unqualified disk roots
  reject. Trusted owners/writers are limited to SYSTEM, Builtin Administrators
  and the standard Windows TrustedInstaller SID, not a caller-controlled SID.
- This is **only a physical ACL/token snapshot for the worker process**.
  It does not prevent a subsequent ACL change, a path swap between checking
  and reading, impersonation or abuse of a same-SID accessible private key,
  or invocation of an already authorized SYSTEM broker. It does not establish
  cryptographic intended-client isolation or owner consent. The coordinator
  must independently enforce the actual per-owner/device/executor PolicyGate,
  protected digest confirmation and fresh checks at each sensitive boundary.
  Without the native verifier or binding, the existing PR21 selection store
  must remain fail closed.

## Hard limits

- Fixed local volume paths only; rejects UNC, device paths, ADS and ambiguous
  dot/trailing-name aliases; path max 4096 UTF-16 chars, batch max 64 entries
  and 32768 combined path chars; input line max 65536 chars; per-batch CPU
  budget check ~2000ms; private bridge timeout max 5000ms.
- The native Win32 call itself is not preemptible while inside a filesystem
  driver. The client timeout stops **only its own helper process**; no
  application/service/job kill or automatic replay is permitted.
- Output limit 128KiB and correlation by request ID, serial requests only.
  All reported error/status codes are finite; the public source and tool
  responses contain no personal SID/path/credential or file content.

## Integration instructions for the co-ordinating Codex/fulltext author

Use the already supplied `FullTextSelectionStore` callback **shape** from
PR21 (not a new MCP operation):

```ts
// Trusted installer-local references, not any MCP request arguments:
const native = new FullTextNativeBridge({
  workerExecutable: verifiedInstalledWorkerBinary,
  workerSha256: approvedPackageSha256,
  expectedExecutor: locallyVerifiedSameTokenSidLogonSession,
});
const verifiedEffectiveAcl = (paths: Readonly<{
  protectedDirectory: string; selectionFile: string;
  approvalFile: string; indexDirectory: string;
}>) => native.verifyProtectedOwnerAcl(paths);

// Only after independent Windows ACL qualification, apply this callback
// to the protected source store through the authorised PR21 integration.
// No verifier or failed verifier => selection/approval not accepted.
```

For Unicode metadata, **after** fresh root/target access and reparse checks,
call `native.attributes(batch, path => actualPolicyGateCheck(path))`. Never
treat a native metadata result, string path, caller boolean, token equality,
or a catalogue selection as user approval. Preserve the PR21 fulltext owner's
existing exclusion rules (System is always excluded; Hidden depends on
includeHidden), freshness checks and index lifecycle. This PR does **not**
change the currently deployed `attrib.exe` path until the fulltext author
connects/qualifies the bridge.

## Evidence gates; no simulated Windows pass

Only the local Windows build owner can report an actual `dotnet build` and
native process outcome. Bounded focused test:

```bash
npm run build:hostdeck
node --import tsx --test test/hostdeck-fulltext-native.test.ts
```

The first five tests use unique, disposable user-owned roots and only
read their ACLs; the Hidden/System fixture changes attributes **only on its
own disposable file**, with targeted cleanup. The sixth/positive ACL case
requires **pre-existing, explicitly approved, admin-protected**
`HOSTDECK_TEST_PROTECTED_FULLTEXT_DIR` and ordinary-writable
`HOSTDECK_TEST_FULLTEXT_INDEX_DIR`. If absent, **SKIP / NOT_RUN positive**.
No permission/ACL changes, personal index, broad drive scan or protected
config writes may be made just to force this positive case to pass.

The current product branch and this delegated patch remain pre-release;
Codex performs build, real Windows fixtures, source scan, integration and
separate installed/ordinary-ChatGPT acceptance. No Actions, merge, installer,
UAC, service or user-enrollment effects originate from this helper.
