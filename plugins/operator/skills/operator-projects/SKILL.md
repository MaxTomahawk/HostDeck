---
name: operator-projects
description: Manage durable Operator projects, phases, task dependencies and separate human/agent queues through connected MCP tools.
---
# Project and task graph

1. List projects and inspect the existing graph before selecting an item.
2. Resolve current task versions and dependency readiness; reject invented or cyclic dependencies.
3. Use atomic claims and short leases where the connected server supports them.
4. On concurrent edits, reload after a conflict; preserve expected versions and stable request IDs.
5. Human steps remain in the normal human-action plan with their existing approval and secret gates.
6. Never treat task scheduling as authority for privileged operations.
7. Record durable evidence and next-actor state to support later continuation.
8. Use only live exposed tool names; disclose missing backend features.
