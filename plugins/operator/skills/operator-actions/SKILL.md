---
name: operator-actions
description: Inspect and preview registered Operator actions, create durable bounded execution intents, verify receipts and evidence, or prepare a nonexecutable action draft. Use for execution, authorization, recovery and parameter binding.
---
# Prepare, execute and verify

1. Discover `operator_list_actions` and inspect the exact current action. Server contracts determine the target, accepted inputs and authority. Drafts, task assignments and displayed command text do not grant execution privileges.
2. Preview with the actual plan ID, step key, current version and typed parameters. When authorized, create a durable intent with `operator_execute_action` and a stable request ID. Inspect `operator_get_execution_status` after an uncertain response before repeating anything.
3. Honor the returned approval and channel restrictions. Protected actions, exact intent approval, MFA and secret entry use the existing canonical human view or the provider's protected surface. Never request secrets in chat or send them through MCP.
4. Verify the authoritative receipt and relevant postcondition. An agent report, user report or project checkpoint has a different evidence meaning. An unknown outcome requires reconciliation and the original request identity, not blind retry.
5. Discover supported retry, cancel and compensation operations and honor their state and permission limits. No registered compensation means no promised rollback. Creating or validating an action draft never registers a new executable.

Read [tool contracts](references/tool-contracts.md), [action discovery](references/action-catalog.md), [parameter binding](references/parameter-binding.md), [secrets and execution](references/secrets-and-execution.md), or [readiness](references/validation.md) for the operation at hand.
