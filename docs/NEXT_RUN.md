# HostDeck next run

## Current checkpoint — 2026-10-20

`codex/delivery` / PR9 contains the integrated runtime and Windows product. Fresh installation and the first package update completed; LocalService runs automatically. Installed enrollment exposed Windows process-handle permission failures. Native fixes are built at `c5addaf`; their next elevated update is awaiting Windows UAC. Installed session/tray/MCP acceptance, reboot and rollback remain open.

The owner selected a **direct outbound Cloudflare Tunnel from Windows to the loopback HostDeck listener**. RatServer is a read-only architecture reference, not an ingress intermediary. Do not add the previous Tailscale backend, RatServer proxy or inbound firewall rule. Existing approval covers implementation; do not ask for it again.

## Next actions

1. Finish the pending native update, then use the installed enrollment/session/tray and one installed MCP/job reconnect scenario. Reuse existing passing subsystem evidence.
2. Use a dedicated Windows `cloudflared` tunnel, fixed hostname, loopback origin and final 404 rule. The official binary digest and real CLI ingress validation are checked. The helper protects executable and per-tunnel credentials; no live tunnel, DNS record or service has been provisioned yet.
3. Complete the optional Cloudflare Access authentication profile and focused signed-assertion checks before using Managed OAuth. Preserve owner/device/executor/session grants; do not assume a Cloudflare assertion satisfies the native OAuth profile.
4. Configure the actual Cloudflare application/policy before publishing its route using the existing account. Only real login/MFA/consent or OS UAC that the agent cannot perform belongs in Operator; no generic Operator-action registration or premature SSO task.
5. Verify the protected endpoint and real ChatGPT connection, upgrade/rollback and reboot recovery, then complete release review from tested main. Historical upstream credential findings still require release disposition.

## Exit boundary

W1, W2 and W5 run as agent work. W3/W4 source criteria are accepted; full product acceptance remains W5. The obsolete human proposal and two premature plan steps were removed without marking them Done. W5 integrates alongside W1/W2 fixes; final evidence is a completion requirement, not a circular prerequisite to start producing it.

Release still requires installed service/session, remote authorization, actual ChatGPT, reboot/recovery, upgrade/rollback and source/artifact checks. Keep one short plan, the existing Operator project and GitHub; no Linear or GitHub Actions. Use smaller existing workers and focused checks, keep private evidence outside tracked source and automatic monitoring off. A five-hour wake-up resumes this chat when usage/tools allow.
