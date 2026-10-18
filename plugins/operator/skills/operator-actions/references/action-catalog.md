# Discover registered action contracts

Use `operator_list_actions` and `operator_inspect_action(action_id)` on the connected server. Registry contents vary by deployment; this skill does not contain a private action inventory or authorize an example action.

Read the action's exact ID and revision, target, required identity, accepted parameters, preconditions, side effects, timeout, expected output, permitted execution channel and recovery contract. A name containing "verify" does not establish that an operation is read-only: inspect its actual effects.

| Operation | Meaning |
| --- | --- |
| Inspect or preview | Read the registered contract and proposed binding; no execution approval |
| Create or validate a draft | Prepare a nonexecutable proposal |
| Bind or publish an existing action | Associate an already registered ID with an existing plan command |
| Execute | Persist an intent subject to current server authorization and dispatch rules |
| Verify | Evaluate the supported evidence/postcondition contract |
| Retry, cancel or compensate | A separate supported lifecycle operation with its own restrictions |

Do not invent action IDs, install a new target or broaden authority because a workflow needs it. Use the existing admission and release process for a new registered action. Record a concrete missing capability and continue independent authorized work; offer a precise manual human step only when needed.
