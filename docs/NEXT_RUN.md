# HostDeck next run

## Current checkpoint — 2026-10-20

`codex/delivery` / PR9 contains the integrated runtime and Windows product. Fresh installation and the frozen-package upgrade completed on the actual Windows host. The installed LocalService, user tray and session HTTP are running. The upgrade check passed three signed enrollment proofs; local health/UI return 200 and unauthenticated MCP returns 401. Installed MCP acceptance passed, including a detached job that survived full client and agent disconnect and produced an artifact. Private receipts remain outside tracked source. Rollback, reupgrade, reboot and remote acceptance remain open.

The owner selected a **direct outbound Cloudflare Tunnel from Windows to the loopback HostDeck listener**. RatServer is a read-only architecture reference, not an ingress intermediary. Do not add the previous Tailscale backend, RatServer proxy or inbound firewall rule. Existing approval covers implementation; do not ask for it again.

## Next actions

1. Complete the bounded installed rollback and reupgrade cycle, checking service, enrolled tray, enrollment proof and MCP readiness after each transition. The temporary maintenance bootstrap staged the protected candidate, but the controller exited before any action because PowerShell converted its JSON deadline to a locale-dependent string. The exact failure is reproduced and corrected privately. Windows canceled the corrected restart before process launch; no maintenance action ran. Inspect actual protected receipts before resumption and wait for the concrete OS consent step before retrying elevation.
2. Deploy the dedicated Windows `cloudflared` service and protected Access configuration using the prepared fixed helper. The tunnel credential, official binary digest, Access application and exact owner identity are verified; installed service, DNS publication and remote ingress remain pending. Publish only after local authorization and health checks pass.
3. Verify the protected remote endpoint and real ChatGPT connection, then reboot and check service, tray, job and artifact recovery. Complete source/artifact screening and release review from tested `main`; historical upstream credential findings still require release disposition.

## Exit boundary

W1/W3/W4 source criteria are accepted; installed Windows and durable-job evidence now covers the upgrade and reconnect paths. W2/W5 still require the remaining lifecycle and remote integration checks. Cloudflare sign-in and concrete certificate consent are observed complete; technical setup remains agent work. On-demand upstream comparison is available; the latest incoming PDF lifecycle fix is incorporated without merging inactive inherited preview code. Automatic monitoring stays off.

Release still requires rollback/reupgrade, remote authorization, actual ChatGPT, reboot/recovery and source/artifact checks. Keep one short plan, the existing Operator project and GitHub; no Linear or GitHub Actions. Keep private evidence outside tracked source and automatic monitoring off.
