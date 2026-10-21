# HostDeck next run

## Checkpoint — 2026-10-21

The Windows service, enrolled tray, local HTTP UI, MCP authorization, and durable job/artifact recovery have real installed evidence. The signed administration broker is installed; direct Codex and the **installed** HostDeck stdio adapter each submitted a bounded request that ran under SYSTEM in session 0. The installed adapter passed five checks with a local `host:manage` grant and remote privilege disabled. An ordinary unpackaged desktop process also verified both enrolled signing keys, the startup entry, public helpers, and canonical machine-data state before reboot. Private receipts remain outside tracked source.

The fixed candidate completed an actual upgrade, rollback, and reupgrade, all with exit code 0. Separate installed checks passed three enrollment proofs, local health/UI, and unauthenticated MCP rejection. These are lifecycle and local acceptance results, not remote or reboot acceptance.

The dedicated direct Cloudflare tunnel now runs as an automatic LocalService. A real fresh-service acceptance of the corrected source verified the LocalService process token, unrestricted service SID, event-log registration, and restart recovery before DNS publication. The intended DNS route is now published, and the public MCP edge returns the OAuth discovery challenge with HTTP 401. Protected configuration, grants, enrollment and canonical state were preserved. Real authenticated ChatGPT acceptance remains open.

## Next actions

1. Complete edge OAuth metadata checks, save/connect the private ChatGPT plugin, and verify actual authorized tool and App interactions. Reconcile existing installation or authentication outcomes before any retry.
2. Capture a fresh canonical-state baseline after final configuration, then perform an actual reboot and verify automatic service/user startup, broker task health, retained job/artifact bytes, and signed request recovery. Keep automatic upstream monitoring off.
3. Review and merge the tested product through PR review to `main`, then run public-source and artifact screening for release. The candidate history contains 27 credential findings; a full private backup has been verified, and the owner's disposition is pending. Do not rewrite history by default or release while this remains unresolved.

The installed broker still needs an action-local native-command environment preamble, documented in the global discovery guide; the corrected native runner has been built for future packaging. The installed signed route is the durable local administrative path; no further UAC is needed for the current work. Preserve the original installer, service/session, desktop, jobs/artifacts, remote ingress, ChatGPT, and rollback scope. Use the existing Operator project and GitHub as the work/evidence authorities; do not create Linear plans or run GitHub Actions. No automatic upstream monitoring until full acceptance and explicit owner permission.
