# HostDeck next run

## Checkpoint — 2026-10-21

The Windows service, enrolled tray, local HTTP UI, MCP authorization, and durable job/artifact recovery have real installed evidence. The signed administration broker is installed; direct Codex and the **installed** HostDeck stdio adapter each submitted a bounded request that ran under SYSTEM in session 0. The installed adapter passed five checks with a local `host:manage` grant and remote privilege disabled. An ordinary unpackaged desktop process also verified both enrolled signing keys, the startup entry, public helpers, and canonical machine-data state before reboot. Private receipts remain outside tracked source.

The fixed candidate completed an actual upgrade, rollback, and reupgrade, all with exit code 0. Separate installed checks passed three enrollment proofs, local health/UI, and unauthenticated MCP rejection. These are lifecycle and local acceptance results, not remote or reboot acceptance.

Two authorized Cloudflare attempts failed before deployment: a private wrapper hash-pin typo, then a missing native-command environment variable in the installed broker. Both terminal outcomes were reconciled; protected config remained unchanged. A focused Windows PowerShell 5.1 comparison reproduced the environment defect and its fix. Runner source now supplies the variable; the installed runner is unchanged. A reviewed cutover with an explicit action-local environment and pinned protected PowerShell 7 is pending. **Do not infer success from submission.**

## Next actions

1. Reconcile the pending signed cutover request and independently verify its protected receipt and actual configuration. Restore the enrolled tray after a successful cutover, publish the intended DNS route, then check the edge, OAuth authorization, and a real private ChatGPT plugin connection.
2. Capture a fresh canonical-state baseline after final configuration, then perform an actual reboot and verify automatic service/user startup, broker task health, retained job/artifact bytes, and signed request recovery. Keep automatic upstream monitoring off.
3. Review and merge the tested product through PR review to `main`, then run public-source and artifact screening for release. The candidate history contains 27 credential findings; a full private backup has been verified, and the owner's disposition is pending. Do not rewrite history by default or release while this remains unresolved.

The installed signed route is the durable local administrative path; no further UAC is needed for the current work. Preserve the original installer, service/session, desktop, jobs/artifacts, remote ingress, ChatGPT, and rollback scope. Use the existing Operator project and GitHub as the work/evidence authorities; do not create Linear plans or run GitHub Actions. No automatic upstream monitoring until full acceptance and explicit owner permission.
