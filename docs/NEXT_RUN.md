# HostDeck next run

## Current checkpoint — 2026-10-20

`codex/delivery` / PR9 contains the integrated runtime and Windows product. Fresh installation and subsequent updates completed. Installed native fixes at `c5addaf` pass three independent signed enrollment challenges; LocalService, user tray and session HTTP are running. Local health/UI return 200 and unauthenticated MCP returns 401. Installed MCP discovery, desktop, files, PDF and App checks passed, but the detached-job reconnect returned `uncertain` without a native receipt. Fix that actual runner startup failure before accepting jobs. Reboot and rollback remain open.

The owner selected a **direct outbound Cloudflare Tunnel from Windows to the loopback HostDeck listener**. RatServer is a read-only architecture reference, not an ingress intermediary. Do not add the previous Tailscale backend, RatServer proxy or inbound firewall rule. Existing approval covers implementation; do not ask for it again.

## Next actions

1. The native job fixes are built at `c00fd4e`: detached launch, bounded startup-failure receipts and truthful interruption when remaining child work is terminated. Focused real Windows regressions pass. The frozen next candidate is awaiting its elevated upgrade; do not rebuild or replay the original uncertain jobs. After the update, rerun only the installed reconnect path.
2. Finish the dedicated Windows `cloudflared` deployment. The tunnel now exists with its own credential; official binary digest and real ingress validation pass. The protected helper routes only the selected hostname to loopback and ends with 404. Service and DNS publication remain pending.
3. The optional Cloudflare Access profile and signed-assertion checks are implemented. The actual Access application now uses the existing owner-only policy, 15-minute application/access tokens, a 24-hour OAuth grant and ChatGPT-only redirects. Activate the installed profile with exact verified owner subject/device/executor/session grants before publishing ingress.
4. Bundle the next fixed package upgrade with the required protected configuration. Preserve today's working package as the rollback baseline: the older installed previous package predates the broker fix. Only concrete unavoidable OS/MFA/consent actions belong in Operator.
5. Verify the protected endpoint and real ChatGPT connection, upgrade/rollback and reboot recovery, then complete release review from tested main. Historical upstream credential findings still require release disposition.

## Exit boundary

W1/W3/W4 source criteria are accepted; W2/W5 continue actual integration. Obsolete human work was removed without invented completion. Cloudflare sign-in and concrete certificate consent are observed complete; technical setup remains agent work. Final evidence is a completion requirement, not a circular prerequisite to start producing it. On-demand upstream comparison is available; the latest incoming PDF lifecycle fix is incorporated without merging inactive inherited preview code. Automatic monitoring stays off.

Release still requires installed service/session, remote authorization, actual ChatGPT, reboot/recovery, upgrade/rollback and source/artifact checks. Keep one short plan, the existing Operator project and GitHub; no Linear or GitHub Actions. Use smaller existing workers and focused checks, keep private evidence outside tracked source and automatic monitoring off. A five-hour wake-up resumes this chat when usage/tools allow.
