---
name: hostdeck-operations
description: Use the authorized HostDeck MCP server to inspect devices, files, jobs, desktop sessions, and bounded local work. Use when the user asks to manage their HostDeck Windows device.
---

# HostDeck operations

Use only tools actually exposed by the connected HostDeck server. Tool availability depends on the user's grants and the device's active session. Ask for the device ID if it is not present in the user's request or the current authorized context.

## Safe workflow

1. Read `hostdeck_device_status` for the requested device and report only returned status and eligible session data.
2. Use read-only file, job, event, or screen tools to inspect first. Keep paths and session IDs within the user's authorized device.
3. Before changing files, controlling a desktop, or submitting terminal work, explain the intended effect and use the corresponding scoped tool. HostDeck policy and effect gates remain authoritative.
4. For terminal work use `hostdeck_submit_job` with an explicit working directory, bounded timeout, fresh idempotency key, and `resume: "never"`. Read the returned job receipt and report its actual state.
5. Retrieve large outputs using owned artifact IDs. Do not claim a job succeeded until its receipt reports success.

The management panel is available as `ui://hostdeck/management` when the HostDeck host advertises its resource and associates it with a tool. A panel cannot grant permissions or choose a different device scope. A local UI route can use a short-lived OAuth access token in memory; hosted MCP Apps should use the platform OAuth connection.

## References

- [Tool and resource reference](references/tools.md)
- [Connection setup](references/connection.md)
