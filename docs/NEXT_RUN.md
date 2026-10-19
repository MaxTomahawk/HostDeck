# HostDeck next run

## Current checkpoint — 2026-10-19

Commit `198ffeb` integrates the Windows runtime and installer. Integrated runtime tests have passed. A real installation transaction is in progress; that work is not installation acceptance. The local UI/CLI and PKCE OAuth flow are prepared, but real SSO, remote ingress, ChatGPT/plugin use, reboot behavior, and upgrade/rollback remain unaccepted.

## Next actions

1. Complete the current Windows installation. Independently verify service health and recovery, enrolled-user logon/tray and desktop-worker identity, local `/ui` and authenticated `/mcp`, device/session scoping, job/artifact behavior, and deny/revocation cases. Keep evidence private until sanitized.
2. Validate the configured OAuth issuer, client registration, redirect/callback, resource and scopes against the actual provider. Exercise PKCE end to end and confirm expired/revoked grants fail. No provider or client registration is accepted merely because metadata loading or local UI works.
3. Only after the controlling approval, validate the already-authorized remote-ingress design, backend TLS pinning and OAuth checks, including negative cases and recovery. Do not change DNS, tunnels, firewall rules, production identity, or provider configuration in this run without its registered approval.
4. Exercise reboot/logon recovery and a real package upgrade followed by rollback. Verify preserved identity, state and grants, and document any recovery limits.
5. Complete actual ChatGPT connector discovery, tool/Skill use, and MCP Apps panel checks when a reachable approved HTTPS endpoint and OAuth client are available. Do not create a placeholder account or claim source packaging as platform acceptance.

## Exit boundary

Release remains blocked until independent Windows install/service/session, remote authorization and deny-case, real ChatGPT, reboot/recovery, upgrade/rollback, public-source and release checks are evidenced. Keep automatic upstream monitoring inactive. Root integrates code and owns commits; use focused checks for changed paths and one integrated acceptance pass, not repeated broad test runs.
