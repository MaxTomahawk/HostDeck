---
name: operator-connect
description: Check an existing authenticated Operator MCP connection, discover account identity and actual tools, and troubleshoot missing capabilities without replacing OAuth or creating another app.
---
# Connect and discover

1. Reuse the connected Operator app. Read `operator_get_capabilities`, `operator_capabilities` and `operator_profile` when exposed; use `operator_list_projects` or `operator_list_plans` for a read-only connectivity check. Never create a dummy plan or project.
2. Treat authenticated server responses as authoritative for identity, available actions, versions, state and links. Caller context, an agent label or a remembered result cannot override them.
3. This package describes the 1.3 contract. Discover the actual tool schemas before use: a package update, server deployment and host discovery refresh are separate operations. Report a missing capability accurately and refresh the existing connection when appropriate.
4. Use `operator_home` or `operator_thread` for project, plan and result discovery when the host supports native panels. Human plan and step links open the original Operator steps view directly. Do not introduce an AI-chat handoff, mode selector or second human editor.
5. Route project coordination to `operator-projects`, human steps to `operator-plans`, bounded execution to `operator-actions` and durable action workflows to `operator-workflows`.
6. Resolve the specific cause of 401/403, `NEEDS_HUMAN`, stale versions or unknown outcomes. Preserve OAuth identity and permissions. Never ask for passwords, tokens or session cookies in chat, register a duplicate app or broaden authority as an ordinary repair.

Host support for panels, files, forms, preferences and Events is independent of server support. A form response or event notification does not authorize execution. Read [connection contracts](references/tool-contracts.md) for discovery and fallback details.
