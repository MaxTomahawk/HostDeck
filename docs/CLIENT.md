# HostDeck client setup

HostDeck exposes its management panel through the MCP Apps resource `ui://hostdeck/management` and serves the same panel locally at `/ui`. It uses live tool responses for devices, sessions, windows, jobs, files, terminal jobs, and screenshot artifacts. Results are treated as text or fetched image artifacts; the panel does not grant access by itself. The gateway remains responsible for device, session, job and effect authorization.

## Local use

The installed user agent can open its loopback management page with the HostDeck CLI `--ui --config <absolute-config-path>` command. The authenticated local MCP endpoint is `/mcp` on the configured loopback listener. For remote administration, use only an explicitly configured and approved HTTPS ingress.

When OAuth client metadata is configured, the page offers authorization-code login with PKCE (S256). The callback URI is exactly the same origin's `/oauth/callback`; state and verifier are short-lived session state, and access tokens remain in page memory and are sent in the Authorization header. The page does not store tokens in URLs, cookies, or persistent browser storage. Without OAuth metadata, the standalone page may offer a manual short-lived access-token fallback. The CLI status and stop modes use the owner-provisioned absolute configuration path and do not bypass server authorization.

## ChatGPT and OAuth setup status

`plugin/hostdeck/` is a portable source package, not an installed or connected ChatGPT plugin. Its endpoint template is preparation only. A reachable, verified HTTPS endpoint and an approved OAuth client registration are required before a ChatGPT connector can be configured. Do not put access tokens or client secrets in the plugin package or UI bundle. Actual SSO, ChatGPT discovery, tool and Skill use, and panel behavior have not yet been accepted.

The server loads authorization-server metadata only for its configured issuer and validates the returned issuer and HTTPS endpoints. The owner must provision the client ID, resource/audience and least-privilege scopes through the approved identity-provider process. A successful metadata fetch or local UI login alone is not end-to-end acceptance.

For the selected direct Windows Tunnel, the optional `http.auth_mode: "cloudflare-access"`
uses Cloudflare Managed OAuth at the edge. Configure the exact HTTPS team issuer,
its `/cdn-cgi/access/certs` JWKS URL, `cloudflare_access.audience` and an explicit
`capability_ceiling`. Configure application sessions for at most 15 minutes.
HostDeck independently verifies the signed `Cf-Access-Jwt-Assertion`, issuer,
application audience, subject, type and lifetime. It ignores a forwarded opaque
Authorization token; that token alone never authenticates to HostDeck.

Grants bind the verified issuer and subject to `clientId: "cloudflare-access:<AUD>"`,
the installed device/executor/session and explicit scopes. This profile binds the
Cloudflare application, not individual OAuth clients; Cloudflare manages its
client revocation. Email and group names do not grant tool permissions. The
standalone protected page connects using its Cloudflare session without token
paste. Native OAuth/PKCE and the MCP Apps host bridge remain supported.
Configure the Access application and operator-only policy before publishing the
Tunnel route. See Cloudflare's [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
and [MCP security guidance](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/).

## Management panel

The local panel and MCP Apps resource share the same client application. The host registers `ui://hostdeck/management` as an MCP App resource and associates it with supported tools using the MCP Apps metadata. Local UI uses the same-origin `/mcp` route. Device/session selection comes from authorized server responses; files require explicit save, terminal activity is submitted as bounded jobs, and screenshot previews are retrieved as owned artifacts.

The managed browser requires an explicitly configured Chrome or Edge executable and an owned temporary profile. It does not install browsers or attach to personal profiles or debugging endpoints. Private/local egress is denied unless an explicit network-policy integration allows it; the current adapter's hostname check is not a complete DNS-rebinding-resistant network boundary.

## Acceptance status

The UI/CLI, native PKCE and optional Cloudflare profile are prepared; focused signed-assertion checks pass. A real fresh installation and package update completed; a native session fix is awaiting the pending elevated update. Real Cloudflare login/provisioning, actual ChatGPT connection and MCP Apps use, reboot recovery, and final upgrade/rollback acceptance remain open. See [NEXT_RUN.md](NEXT_RUN.md).
