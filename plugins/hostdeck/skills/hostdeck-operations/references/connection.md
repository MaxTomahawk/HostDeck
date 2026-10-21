# HostDeck MCP connection and discovery

The HostDeck ChatGPT App is registered separately in the intended workspace and referenced from this plugin's root `.app.json`. The required App ID is `asdk_app_6ad883b4cbe4819188fb8b85196055f5`. This identifier is not an access token. The public marketplace has no MCP endpoint credentials or Windows host configuration.

Both plugin manifests reference `./.app.json`; no inline `mcp.json` or `.mcp.json` is bundled. This matches the working Operator marketplace pattern. OAuth access, user role eligibility, permissions, available tools, installed runtime and app-catalog refresh are separate checks.

## Diagnosing zero discovered tools

A successful OAuth connection does **not** guarantee a nonempty MCP `tools/list`. HostDeck's `src/hostdeck/gateway.ts` and `src/hostdeck/security.ts` filter tool discovery to real installed adapters and tools authorized by the authenticated principal's active device/executor grant and scopes.

1. Confirm the existing ChatGPT HostDeck App remains connected and has workspace permissions; do not create another App.
2. Inspect **live authenticated** `tools/list` and any actual error. Compare with the local installed HostDeck runtime. Never publish credentials, tokens, internal machine paths or grant-store contents.
3. If `tools/list` returns an empty list, inspect locally and safely whether the verified principal's issuer, subject, client ID, nonexpired per-device/executor grant and scopes match. Different Cloudflare Access identities or an incorrectly scoped grant can lead to zero exposed tools.
4. If the MCP server exposes tools correctly but ChatGPT still lists zero, refresh the *existing registered App's* tool catalog and retry a new session. GitHub marketplace **Sync now** refreshes plugin content, not necessarily the App's tool catalog.
5. Once actual tools appear, first invoke `hostdeck_device_status` for an explicitly authorized device, then use the independent acceptance method.

A source registry of 54 tools is not the same as a running `tools/list` response. Do not bypass policy, broaden grants, expose unauthenticated introspection, or add placeholder tools to hide an empty catalog. Differentiate **connection/authentication**, **grant/policy**, **deployed adapters**, and **host-side cached discovery** in the report.
