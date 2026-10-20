# HostDeck next run

## Current checkpoint — 2026-10-20

`codex/delivery` / PR9 contains the integrated runtime and Windows product. The installed HostDeck LocalService, user tray, session HTTP, and MCP durable-job reconnect acceptance were verified earlier, including an artifact after client/agent disconnect. The permanent signed administration broker was actually installed after the owner confirmed Windows consent. An unelevated direct-Codex request produced independently checked SYSTEM/session-0 proof, while owner-key signing was denied to the ordinary client. A source-built HostDeck adapter also passed actual submission, exact status/ownership and signed-verification checks against that broker. Invalid signatures were rejected before runner startup. These adapter checks do not yet prove the new installed HostDeck package. Private receipts remain outside tracked source.

The package builder now includes the broker's pinned scripts, self-contained runner, licenses and provenance under `installer/privilege`. A separate candidate was built without changing the installed product or registering the SYSTEM task. Broker registration remains a separate explicit first installation; shipping its files does not prove installation or execution.

The current authorized priority is to complete the direct Codex durable signed broker first, then fully integrate it into HostDeck and finish the remaining original lifecycle, remote ingress, ChatGPT and recovery acceptance. The broker is a standing delegation: an enrolled, signed same-SID client can submit arbitrary scripts for SYSTEM execution. Keep the broker's audit and signed result context visible and verified. Optional remote-host management requires explicit opt-in and exact grants. The owner key is a nonexportable LocalMachine Software KSP key controlled by administrators; it does not form a security boundary against SYSTEM. Stored times are UTC and may be displayed in Amsterdam local time.

The owner selected a **direct outbound Cloudflare Tunnel from Windows to the loopback HostDeck listener**. RatServer is a read-only architecture reference, not an ingress intermediary. Do not add the previous Tailscale backend, RatServer proxy or inbound firewall rule. Existing approval covers implementation; do not ask for it again.

## Next actions

1. Reuse the installed signed broker, not UAC or the expired temporary controller. Its PowerShell 5.1 atomic-replacement defect was reproduced and repaired through a signed maintenance request, preserving backups and identities. Verify protected boot/replay evidence and current helper hashes; global Codex instructions now preserve discovery and request-recovery rules across chats. No first-install retry is needed.
2. Install the fixed HostDeck candidate with broker configuration and exact local grants, and verify the installed adapter. Then finish rollback/reupgrade, Cloudflare service and Access configuration, remote endpoint plus real ChatGPT connection, and reboot job/artifact recovery.
3. Complete source/artifact screening and release review from tested `main`; historical upstream credential findings still require release disposition.

## Exit boundary

Direct-Codex installation and signed execution have actual evidence; boot recovery and protected replay inspection remain separate checks. Full installed HostDeck integration, lifecycle, remote ingress, ChatGPT and reboot recovery remain open. No UAC request is currently live or needed for the completed first installation. An earlier temporary controller expired and must not be resumed. On-demand upstream comparison is available; automatic monitoring stays off.

Release still requires direct-Codex broker acceptance, full HostDeck integration, rollback/reupgrade, remote authorization, actual ChatGPT, reboot/recovery and source/artifact checks. Keep one short plan, the existing Operator project and GitHub; no Linear or GitHub Actions. Keep private evidence outside tracked source and automatic monitoring off.
