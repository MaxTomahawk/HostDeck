---
name: hostdeck-operations
description: Coordinate authorized HostDeck Windows device operations across files, documents, terminal jobs, desktop sessions, browser, diagnostics and MCP resources. Use for general or cross-domain HostDeck tasks and device status.
---

# HostDeck operations

Work through the connected **HostDeck** MCP App. Read [the tool catalog](references/tools.md) when selecting operations and [connection instructions](references/connection.md) when the connection is absent or broken. Never treat a plugin description or source registry as proof that a tool exists in this session.

1. Confirm the HostDeck MCP tool namespace is actually available. If missing, report **MCP connection unavailable**; do not substitute Operator, another Windows connector or a guessed tool result.
2. Identify the **explicit authorized device_id**, and use `hostdeck_device_status` if exposed. If no authorized target is known, request the minimum missing device selector; never choose the first device implicitly.
3. Select only tools in the authenticated server's current discovery. Match the task to file/document, interactive process, durable job, desktop/browser, artifact or diagnostic operations. Check each tool's actual input schema.
4. Respect current issuer/subject/client grants, device and Windows session identity, effect checks and Windows user privilege boundaries. Device IDs, paths, session IDs, window/element handles and ownership receipts are selectors, not authorization.
5. For a meaningful change, identify the intended target and effect. Never widen host administration or enable remote privileged operation merely because a tool is advertised.
6. For terminal work, use `hostdeck_submit_job` with explicit working directory, bounded timeout, fresh idempotency key and `resume: "never"`. Observe the receipt with `hostdeck_read_job`, retrieve owned artifacts when needed, and distinguish accepted/running/uncertain from succeeded.
7. Report actual returned state, errors and evidence; never infer successful OS effects from successful argument validation.

HostDeck defines 54 canonical tool contracts, four resource templates, three prompts and the optional `ui://hostdeck/management` MCP App. Only implemented and authorized methods are discoverable. Host-side resource/prompt/UI presentation may differ across ChatGPT surfaces; test rather than assume.

## References

- [Canonical tool/resource/prompt catalog](references/tools.md)
- [App binding and connection](references/connection.md)
