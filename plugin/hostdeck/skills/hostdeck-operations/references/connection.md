# Connection setup

Configure the MCP connector with HostDeck's verified HTTPS endpoint. The package keeps `${HOSTDECK_MCP_URL}` as an unresolved preparation placeholder and requests OAuth through the platform's protected authorization flow. Do not place a bearer token or client secret in this package, a prompt, URL, repository, or diagnostic bundle.

The gateway currently targets loopback by default. A verified remotely reachable endpoint, approved ingress, working OAuth registration, correct grants, and platform support for custom HTTP MCP are all required for live use. Keep credentials in the platform's protected connection settings. HostDeck does not create or publish a ChatGPT plugin connection from this source package; this template is not a live connector.
