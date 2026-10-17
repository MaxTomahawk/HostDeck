# Public Operator plugin marketplace

A public **skills-only** Operator 1.2 GitHub marketplace. This isolated branch never changes HostDeck's main branch and contains no private RatServer infrastructure source, production config, secrets or internal addresses.

## Import into ChatGPT Business
- Source: `https://github.com/MaxTomahawk/HostDeck`
- Path: leave blank
- Branch: `chatgpt-marketplace`
- Manifest: `.agents/plugins/marketplace.json`

The plugin imports Operator skills. It **does not register or upgrade the Operator MCP App**. Keep the existing connected OAuth App separately, and confirm its tools are available after import. A public plugin directory is not a public account or server.

Add future public-safe plugins to `plugins/<slug>` and the catalog; do not publish secrets, environment files, internal addresses, account IDs, or private Git repositories here.
