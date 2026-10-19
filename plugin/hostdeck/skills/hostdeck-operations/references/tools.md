# HostDeck tool reference

Tools use the `hostdeck_` namespace. Availability and schemas come from the connected server's `tools/list` response; do not assume unavailable tools exist.

- Device status: `hostdeck_device_status`
- Files: `hostdeck_list_directory`, `hostdeck_read_file`, `hostdeck_file_info`, plus explicitly scoped file/document editing tools
- Jobs: `hostdeck_submit_job`, `hostdeck_list_jobs`, `hostdeck_read_job`, `hostdeck_cancel_job`
- Desktop: `hostdeck_capture_screen`, UI observation and control tools for an eligible session
- Browser: `hostdeck_browser_open`, `hostdeck_browser_navigate`, `hostdeck_browser_snapshot`, `hostdeck_browser_interact`, `hostdeck_browser_evaluate`, `hostdeck_browser_close`
- Evidence: `hostdeck_read_artifact`, `hostdeck_read_events`, `hostdeck_diagnostics`

Each call is subject to the server's identity, device, scope, session, and effect checks. Tool schemas do not grant authority. Browser navigation also uses the local egress policy.
