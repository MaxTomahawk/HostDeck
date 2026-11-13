# HostDeck tool reference

Tools use the `hostdeck_` namespace. Availability and schemas come from the connected server's `tools/list` response; do not assume unavailable tools exist.

- Device status: `hostdeck_device_status`
- Files: `hostdeck_list_directory`, `hostdeck_read_file`, `hostdeck_file_info`, plus explicitly scoped file/document editing tools
- Jobs: `hostdeck_submit_job`, `hostdeck_list_jobs`, `hostdeck_read_job`, `hostdeck_cancel_job`
- Desktop: `hostdeck_capture_screen`, UI observation and control tools for an eligible session
- Browser: `hostdeck_browser_open`, `hostdeck_browser_navigate`, `hostdeck_browser_snapshot`, `hostdeck_browser_interact`, `hostdeck_browser_evaluate`, `hostdeck_browser_close`
- Evidence: `hostdeck_read_artifact`, `hostdeck_read_events`, `hostdeck_diagnostics`
- Content index: read-only `hostdeck_fulltext_status`, `hostdeck_fulltext_preview`, `hostdeck_fulltext_query`; separately authorized open/start/pause/resume/cancel tools. See [document search](document-search.md).
- Providers: `hostdeck_list_providers`; explicit preference/enablement changes use the exposed schemas. Research candidates are not installed, qualified or lifecycle-enabled providers.
- Explicit manager: `hostdeck_open_manager`; ordinary answers do not need the full panel.

Each call is subject to the server's identity, device, scope, session, and effect checks. Tool schemas do not grant authority. Browser navigation also uses the local egress policy.

Current provider-setting servers expose per-function `revision`, Everything
`enabledRevision`, and recent `changes` in `list_providers`. Pass the inspected
revision as `expected_revision` when changing a preference or integration
setting. A conflict is not permission to overwrite or automatically retry.
The returned `change` receipt is durable in the same setting transaction; the
last20 of up to200 receipts are visible per owner/device/executor. It is not
independent OS attestation. Older snapshots lack this feature; do not invent it.

Restore only the prior value of a receipt still in the current scoped history
whose target revision and value still match, using the same setter and expected
revision. Intervening changes (even away and back) invalidate restoration. After
an unknown effect, read status/history before another write. This restores
HostDeck settings, never vendor software or external configuration.

[The generated source contract index](contracts.md) lists tool names/effects/scopes,
four resource templates and three prompts from the actual source definitions.
It does not replace live discovery or prove implementation, grants or host support.
Read only the relevant workflow/reference; do not load every schema or old log
for a small operation. MCP protocol methods such as resources/read and prompts/get
are not automatically callable model tools in a given host.
