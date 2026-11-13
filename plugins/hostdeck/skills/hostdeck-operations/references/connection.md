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

A source registry is not the same as a running `tools/list` response. The bundled contract index describes 67 source contracts; the installed adapters and authenticated grants decide which are exposed. Do not bypass policy, broaden grants, expose unauthenticated introspection, or add placeholder tools to hide an empty catalog. Differentiate **connection/authentication**, **grant/policy**, **deployed adapters**, and **host-side cached discovery** in the report.

For a stale schema, refresh the existing App once and inspect the outcome before
another request. A long-running chat may retain its old tool signatures; a fresh
ordinary chat can inspect the updated catalog without reconnecting or changing
OAuth. An unknown refresh outcome is not permission to repeat it blindly.

Plugin content and App tool catalogs refresh separately. Updating this Skill does
not install a Windows package, start document indexing or grant a maintenance
window. The supported explicit manager uses `ui://hostdeck/management/v2`; the
old unversioned URI is refused. Actual rendering depends on the current host.
