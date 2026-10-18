---
name: operator-workflows
description: Create and resume durable Operator dependency workflows with canonical human gates, bounded action receipts, verification and agent connector reports. Use for prerequisites, controlled continuation, pauses and failures.
---
# Workflow execution

1. Read the existing plan, current version and registered actions. Create the supported DAG with stable node keys and a stable request ID. Inspect the returned workflow and start it when the intended effects are authorized.
2. Link every new human node to the actual original plan step with `step_key`. Open that canonical step directly; `node.key` is the workflow identity and may differ. Preserve original inputs, feedback, outcomes, secret controls and attachments.
3. The worker evaluates prerequisites and schedules eligible bounded actions. It adopts completed canonical human steps; a node report cannot replace the source human outcome or impersonate an action receipt.
4. Perform connector nodes through the user's already authorized provider tools. Record a structured agent report with a stable request ID. Human acceptance of a report, technical verification and executor receipts are distinct.
5. Preserve failed dependencies, blockers and unknown outcomes. Use supported pause, resume, cancel and recovery operations; never bypass a gate or blindly repeat a possible side effect. Independent eligible branches may continue.
6. Resume by reading durable workflow and execution state. Project worker processing and optional host Events do not establish an autonomous LLM daemon or guarantee that a chat wakes itself. Use `operator-projects` for task claims, input validation and project event recovery.

Read [workflow contracts](references/workflow-contract.md), [dependency rules](references/dependencies.md), [examples](references/workflow-examples.md) and [tool contracts](references/tool-contracts.md) when composing a chain.
