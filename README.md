# Public Operator plugin marketplace

A public Operator 1.2.1 plugin marketplace with five skills **and a link to the existing registered Operator MCP app**. This isolated branch never changes HostDeck's main branch and contains no private RatServer infrastructure source, production config, secrets or internal addresses.

## Import into ChatGPT Business
- Source: `https://github.com/MaxTomahawk/HostDeck`
- Path: leave blank
- Branch: `chatgpt-marketplace`
- Manifest: `.agents/plugins/marketplace.json`

The plugin imports Operator skills **and references the existing Operator OAuth app** through `plugins/operator/.app.json`. The reference is to a registered app ID, not credentials, and neither creates an app nor changes OAuth or grants additional permissions. The connected app must be eligible and available to the importing workspace and member. A public marketplace does not expose account data or make the MCP service public. No MCP server or `mcp.json` is bundled, preserving web compatibility.

Add future public-safe plugins to `plugins/<slug>` and the catalog; do not publish secrets, environment files, internal addresses, account IDs, or private Git repositories here.

## Private service and import validation

The `.app.json` includes only the **registered app's technical ID**, which is visible in this public GitHub branch; it is **not a token**, secret, server key or invitation. The app's existing OAuth authorization and workspace eligibility remain mandatory. No private RatServer source, host addresses, credentials or human data are published.

After merging a plugin update, the workspace admin selects **Sync now** on the HostDeck marketplace and checks the plugin's **Required apps** list. Then, in a new ChatGPT conversation, verify that the selected Operator plugin exposes read-only calls such as `operator_list_plans` and `operator_list_projects`. If the update fails with `app_not_eligible`, enable/make the registered development app available in the workspace through Admin Console or use a workspace-eligible app. Never weaken server OAuth to work around it. A new plugin version in GitHub cannot by itself refresh cached ChatGPT MCP tool discovery.
