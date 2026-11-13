# Connection setup

Configure the MCP connector with HostDeck's verified HTTPS endpoint. The package keeps `${HOSTDECK_MCP_URL}` as an unresolved preparation placeholder and requests OAuth through the platform's protected authorization flow. Do not place a bearer token or client secret in this package, a prompt, URL, repository, or diagnostic bundle.

The gateway currently targets loopback by default. A verified remotely reachable endpoint, approved ingress, working OAuth registration, correct grants, and platform support for custom HTTP MCP are all required for live use. Keep credentials in the platform's protected connection settings. HostDeck does not create or publish a ChatGPT plugin connection from this source package; this template is not a live connector.

When an existing authenticated HostDeck connection already works, preserve its
App/OAuth identity and inspect actual device status and tool discovery. A missing
tool/resource, unsupported host UI or expired session is not permission to create
another App, broaden grants, expose a listener or change ingress. Diagnose the
specific layer; request only genuinely missing protected login/consent input.

Source skill updates do not update an installed workspace/account plugin by
themselves. Keep portable source, installed plugin version and running server
build distinct. The versioned management resource and source contract index are
references; actual host rendering and tool effects need their own observations.
