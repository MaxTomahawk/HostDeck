---
name: hostdeck-operations
description: Use for authorized HostDeck Windows work across files, document search, Office/PDF, terminal jobs, desktop sessions, browser, providers and explicit management. Use when the user asks to operate or troubleshoot their HostDeck device.
---

# HostDeck operations

Use only tools actually exposed by the connected HostDeck server. Tool availability depends on the user's grants and the device's active session. Ask for the device ID if it is not present in the user's request or the current authorized context.

## Safe workflow

1. Read `hostdeck_device_status` for the requested device and report only returned status and eligible session data.
2. Use read-only file, job, event, or screen tools to inspect first. Keep paths and session IDs within the user's authorized device.
3. Before changing files, controlling a desktop, or submitting terminal work, explain the intended effect and use the corresponding scoped tool. HostDeck policy and effect gates remain authoritative.
4. For terminal work use `hostdeck_submit_job` with an explicit working directory, bounded timeout, fresh idempotency key, and `resume: "never"`. Read the returned job receipt and report its actual state.
5. Retrieve large outputs using owned artifact IDs, exact byte offsets and lengths. Check returned integrity metadata when verifying effects. An accepted/running/uncertain job is not succeeded; reconcile that same job/request instead of submitting it again after a timeout or lost response.
6. Existing owner-authorized routine work does not need repeated permission. Respect explicit availability and maintenance limits; preparing source or a package does not authorize stopping a working service/session or installing it. Preserve original failures and distinguish source, built, installed and independently observed results.

Answer ordinary device/provider questions with compact data tools. Open the full manager only on an explicit management request, using the actual exposed `hostdeck_open_manager` tool. Its resource is `ui://hostdeck/management/v2`; the old unversioned URI is refused by the current server. Metadata or source HTML is not evidence of actual host rendering. Classify unsupported/unobservable resources, prompts and UI honestly. A panel cannot grant permissions or choose a different device scope. A local UI route can use a short-lived OAuth access token in memory; hosted MCP Apps use the existing platform OAuth connection.

For document-content search, first use the exposed read-only status/preview tools. A selected location, protected approval, opened index and started scan are separate states. Existing approval must not be requested again; it does not authorize starting/resuming a scan. Follow [document search](references/document-search.md) before any indexing effect. Filename search is separate and does not require opening an index.

Privileged tools are optional, separately authorized surfaces. Never enable remote privilege or widen a grant to make a test work. A signed client observation is not independent OS attestation, and a same-user signing key is not proof of exclusive client origin.

## References

- [Tool and resource reference](references/tools.md)
- [Document search workflow](references/document-search.md)
- [Connection setup](references/connection.md)
