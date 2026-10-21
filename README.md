# HostDeck ChatGPT marketplace — Operator and HostDeck

This dedicated `chatgpt-marketplace` branch publishes two ChatGPT plugins to the user's existing GitHub marketplace:

- **Operator 1.3.0**: five skills and its unchanged, existing registered OAuth App.
- **HostDeck 0.3.2**: two skills (`hostdeck-operations` and `hostdeck-acceptance`), a full documented canonical 54-tool capability catalog, and a binding to the user's existing registered HostDeck MCP App.

This marketplace branch is **publicly readable GitHub source**, separate from HostDeck's software delivery branch. Only plugin metadata, public-safe instructions, icons and **non-secret technical App IDs** belong here. The associated MCP services, users, OAuth credentials, Windows device identity/grants and connected data are **not made public** by this repository. No RatServer private infrastructure source or protected HostDeck runtime configuration is included.

## Import into ChatGPT Business

- Source: `https://github.com/MaxTomahawk/HostDeck`
- Path: leave blank
- Branch: `chatgpt-marketplace`
- Marketplace manifest: `.agents/plugins/marketplace.json`

Both plugin entries refer to local `plugins/<slug>` directories. Each plugin uses `./.app.json` to refer to its **own registered** ChatGPT MCP App (not to an inline `mcp.json` or `.mcp.json`). Each App ID is a reference, not a credential; importing the marketplace does not create an App, bypass OAuth or expand grants.

The existing **Operator** catalog entry, App ID and manifests are intentionally unchanged. Do not replace its App or modify OAuth to register HostDeck.

## HostDeck installation and acceptance

1. In the **existing** workspace marketplace for this repository/branch, choose **Sync now**, inspect the import result, and confirm HostDeck version 0.3.2 with exactly two skills.
2. Confirm HostDeck's required App is `asdk_app_6ad883b4cbe4819188fb8b85196055f5`, registered in the same workspace, eligible for the intended member, with its own OAuth sign-in.
3. The registered HostDeck App reported **zero discovered tools** at creation on 2026-10-21. Installing this plugin **will not automatically repair that**. Check the authenticated server's real `tools/list`, the installed HostDeck adapters, device/executor authorization grants and scoped identity; if the server returns tools but the ChatGPT App does not, refresh the existing App tool catalog separately.
4. In a fresh ChatGPT conversation select **HostDeck** and try `hostdeck_device_status` for an authorized device. Run `hostdeck-acceptance` only after tools are visible, and distinguish source catalog, runtime implementation and actual end-to-end results. The connected server's policy remains authoritative.

Detailed discovery diagnostics are in `plugins/hostdeck/skills/hostdeck-operations/references/connection.md`. The product code, MCP implementation and acceptance documents are in the separately maintained HostDeck delivery source/branch and must be compared to the actually installed version.

## Public-source hygiene

Do not publish secrets, tokens, local/private host addresses, internal user/project IDs, service credentials, protected config or private Git repositories here. Keep the app-to-plugin binding in `.app.json`; keep all authentication and device permissions server-side.
